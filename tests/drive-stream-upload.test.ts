import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { streamDriveFile, pendingDriveStreamUpload } from "../src/lib/drive-stream-upload.ts";
import { DRIVE_STREAM_CHUNK_BYTES, DRIVE_STREAM_PROTOCOL } from "../src/drive/limits.ts";
import { DRIVE_ROOT } from "../src/icloud/drive.ts";

const file = new File([new Uint8Array(2 * DRIVE_STREAM_CHUNK_BYTES + 17).fill(90)], "direct-test.bin", { type: "application/octet-stream" });
const context = { parentId: DRIVE_ROOT, expectedGeneration: 1 };
function browser(t: TestContext, onPrepare: (input: Record<string, unknown>) => string, exchange: (socket: Socket, bytes?: ArrayBuffer) => void) {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
  class Socket extends EventTarget {
    id = ""; closed = false;
    constructor(url: URL, protocol: string) {
      super(); assert.equal(url.protocol, "wss:"); assert.equal(protocol, DRIVE_STREAM_PROTOCOL);
      this.id = url.pathname.split("/").at(-2)!;
      queueMicrotask(() => exchange(this));
    }
    message(value: object) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ ...value, operationId: this.id }) })); }
    send(bytes: ArrayBuffer) { assert.ok(bytes instanceof ArrayBuffer); queueMicrotask(() => { if (!this.closed) exchange(this, bytes); }); }
    close() { if (this.closed) return; this.closed = true; this.dispatchEvent(new Event("close")); }
  }
  for (const [key, value] of Object.entries({ sessionStorage: storage, WebSocket: Socket, location: { origin: "https://stream.example.test" } })) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); });
  }
  t.mock.method(globalThis, "fetch", async (path: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(path, "/api/drive/prepare-stream-upload");
    const input = JSON.parse(String(init?.body));
    assert.equal(pendingDriveStreamUpload(), input.operationId, "persist intent before network dispatch");
    const phase = onPrepare(input);
    return Response.json({ operationId: input.operationId, phase, socketPath: `/api/drive/uploads/${input.operationId}/stream` });
  });
  return { storage, values };
}
interface Socket { id: string; message(value: object): void; close(): void; }

test("direct browser upload follows exact server credits and clears only a confirmed receipt", async t => {
  const sent = createHash("sha256"), expected = createHash("sha256").update(new Uint8Array(await file.arrayBuffer())).digest("hex");
  let offset = 0, frames = 0;
  browser(t, input => { assert.equal(input.sha256, expected); return "prepared"; }, (socket, bytes) => {
    if (bytes) { sent.update(new Uint8Array(bytes)); offset += bytes.byteLength; frames++; }
    if (offset === file.size) socket.message({ type: "result", operation: { operationId: socket.id, phase: "confirmed" } });
    else socket.message({ type: "pull", offset, bytes: Math.min(DRIVE_STREAM_CHUNK_BYTES, file.size - offset) });
  });
  assert.equal((await streamDriveFile(file, context, () => {})).phase, "confirmed");
  assert.equal(sent.digest("hex"), expected); assert.equal(frames, 3);
  assert.equal(pendingDriveStreamUpload(), null);
});

test("a dropped direct connection retains its UUID and an unknown outcome never reconnects or sends bytes", async t => {
  let phase = "prepared", id = "", connections = 0;
  browser(t, input => { id ||= String(input.operationId); assert.equal(input.operationId, id); return phase; }, socket => { connections++; phase = "unknown"; socket.close(); });
  await assert.rejects(streamDriveFile(file, context, () => {}), /outcome may be uncertain/);
  assert.equal(pendingDriveStreamUpload(), id);
  await assert.rejects(streamDriveFile(file, context, () => {}), /previous Apple outcome is unresolved/);
  assert.equal(connections, 1); assert.equal(pendingDriveStreamUpload(), id);
});

test("direct upload refuses changed file context, bad credits, or premature confirmation", async t => {
  let requests = 0, premature = false;
  browser(t, () => { requests++; return "prepared"; }, socket => socket.message(premature
    ? { type: "result", operation: { operationId: socket.id, phase: "confirmed" } }
    : { type: "pull", offset: 1, bytes: DRIVE_STREAM_CHUNK_BYTES }));
  await assert.rejects(streamDriveFile(file, context, () => {}), /invalid frame/);
  const id = pendingDriveStreamUpload(); assert.ok(id);
  await assert.rejects(streamDriveFile(file, { ...context, expectedGeneration: 2 }, () => {}), /original file and folder/);
  assert.equal(requests, 1);
  premature = true;
  await assert.rejects(streamDriveFile(file, context, () => {}), /complete, confirmed receipt/);
  assert.equal(pendingDriveStreamUpload(), id);
});

test("direct receipt recovery accepts a confirmed result without requesting any file bytes", async t => {
  browser(t, () => "uploaded", (socket, bytes) => {
    assert.equal(bytes, undefined);
    socket.message({ type: "result", operation: { operationId: socket.id, phase: "confirmed" } });
  });
  assert.equal((await streamDriveFile(file, context, () => {})).phase, "confirmed");
  assert.equal(pendingDriveStreamUpload(), null);
});

test("direct upload requires browser persistence before sending a new intent", async t => {
  const { storage } = browser(t, () => { assert.fail("Network must not be reached"); }, () => assert.fail("Socket must not be opened"));
  t.mock.method(storage, "setItem", () => { throw new Error("synthetic storage unavailable"); });
  await assert.rejects(streamDriveFile(file, context, () => {}), /storage unavailable/);
});
