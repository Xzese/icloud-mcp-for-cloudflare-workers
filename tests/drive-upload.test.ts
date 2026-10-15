import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { uploadDriveFile, pendingDriveUpload, discardDriveUpload } from "../src/lib/drive-upload.ts";
import { DRIVE_DIRECT_UPLOAD_BYTES, DRIVE_UPLOAD_PART_BYTES } from "../src/drive/limits.ts";
import { DRIVE_ROOT } from "../src/icloud/drive.ts";

const file = new File([...Array<Uint8Array<ArrayBuffer>>(64).fill(new Uint8Array(1024 ** 2)), new Uint8Array([1])], "synthetic-large.bin", { type: "application/octet-stream" });
const context = { parentId: DRIVE_ROOT, expectedGeneration: 1 };
const partCount = Math.ceil(file.size / DRIVE_UPLOAD_PART_BYTES);
function browser(t: TestContext, route: (path: string, init: RequestInit) => Response | Promise<Response>) {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
  const original = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: storage });
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => route(String(input), init ?? {}));
  t.after(() => {
    if (original) Object.defineProperty(globalThis, "sessionStorage", original);
    else Reflect.deleteProperty(globalThis, "sessionStorage");
  });
  return { values, storage };
}

test("dashboard resumes acknowledged parts after interruption using the exact original intent", async t => {
  const intents: Array<Record<string, unknown>> = [], sent: number[] = [];
  let interrupted = false, completions = 0, operationId = "";
  browser(t, async (path, init) => {
    if (path.endsWith("/prepare-multipart-upload")) {
      const intent = JSON.parse(String(init.body)) as Record<string, unknown>;
      intents.push(intent); operationId ||= String(intent.operationId);
      assert.equal(pendingDriveUpload(), operationId, "intent is persisted before preparation");
      assert.equal(intent.size, file.size);
      return Response.json({ operationId, phase: "prepared", partBytes: DRIVE_UPLOAD_PART_BYTES, uploadedParts: interrupted ? [1] : [], cancelled: false });
    }
    if (path.endsWith("/complete-multipart-upload")) {
      completions++; assert.equal(JSON.parse(String(init.body)).operationId, operationId);
      return Response.json({ operationId, phase: "confirmed" });
    }
    const part = Number(path.split("/").at(-1)); sent.push(part);
    const bytes = init.body;
    assert.ok(bytes instanceof ArrayBuffer);
    assert.equal(bytes.byteLength, Math.min(DRIVE_UPLOAD_PART_BYTES, file.size - (part - 1) * DRIVE_UPLOAD_PART_BYTES));
    assert.equal(new Headers(init.headers).get("x-content-sha256"), createHash("sha256").update(new Uint8Array(bytes)).digest("hex"));
    if (part === 2 && !interrupted) { interrupted = true; throw new Error("synthetic disconnected part"); }
    return Response.json({});
  });
  await assert.rejects(uploadDriveFile(file, context, () => {}), /disconnected part/);
  assert.equal(completions, 0); assert.equal(pendingDriveUpload(), operationId);
  const progress: string[] = [];
  const result = await uploadDriveFile(file, context, (_text, id) => { if (id) progress.push(id); });
  assert.equal(result.phase, "confirmed"); assert.equal(pendingDriveUpload(), null);
  assert.deepEqual(intents[0], intents[1]);
  assert.deepEqual(sent, [1, 2, ...Array.from({ length: partCount - 1 }, (_, index) => index + 2)]);
  assert.ok(progress.every(id => id === operationId)); assert.equal(completions, 1);
});

test("uncertain completion and discard retain the operation and never resend Apple completion", async t => {
  let phase = "prepared", completions = 0, operationId = "";
  browser(t, (path, init) => {
    if (path.endsWith("/prepare-multipart-upload")) {
      operationId ||= JSON.parse(String(init.body)).operationId;
      return Response.json({ operationId, phase, partBytes: DRIVE_UPLOAD_PART_BYTES, uploadedParts: Array.from({ length: partCount }, (_, i) => i + 1), cancelled: false });
    }
    if (path.endsWith("/discard-multipart-upload")) return Response.json({ operationId, phase, cancelled: true });
    assert.ok(path.endsWith("/complete-multipart-upload"));
    completions++; phase = "unknown"; throw new Error("synthetic lost completion");
  });
  await assert.rejects(uploadDriveFile(file, context, () => {}), /lost completion/);
  await assert.rejects(uploadDriveFile(file, context, () => {}), /Inspect the retained operation/);
  assert.equal(completions, 1); assert.equal(pendingDriveUpload(), operationId);
  await assert.rejects(discardDriveUpload(operationId), /outcome is unresolved/);
  assert.equal(pendingDriveUpload(), operationId);
  phase = "confirmed";
  await discardDriveUpload(operationId);
  assert.equal(pendingDriveUpload(), null);
});

test("changed folder or account generation cannot replace a pending browser upload", async t => {
  let requests = 0, retainedId = "";
  browser(t, (_path, init) => {
    requests++; retainedId = JSON.parse(String(init.body)).operationId;
    throw new Error("synthetic prepare response lost");
  });
  await assert.rejects(uploadDriveFile(file, context, () => {}), /response lost/);
  for (const changed of [{ ...context, expectedGeneration: 2 }, { ...context, parentId: "FOLDER::com.apple.CloudDocs::other" }]) {
    let displayedId = "";
    await assert.rejects(uploadDriveFile(file, changed, (_text, id) => { if (id) displayedId = id; }), /original file and folder/);
    assert.equal(displayedId, retainedId); assert.equal(pendingDriveUpload(), retainedId);
  }
  assert.equal(requests, 1);
});

test("confirmed multipart replay clears browser state without uploading parts, even after discard", async t => {
  let operationId = "";
  browser(t, (path, init) => {
    if (path.endsWith("/prepare-multipart-upload")) {
      operationId = JSON.parse(String(init.body)).operationId;
      return Response.json({ operationId, phase: "confirmed", cancelled: true, partBytes: DRIVE_UPLOAD_PART_BYTES, uploadedParts: [] });
    }
    assert.ok(path.endsWith("/complete-multipart-upload"));
    return Response.json({ operationId, phase: "confirmed" });
  });
  assert.equal((await uploadDriveFile(file, context, () => {})).phase, "confirmed");
  assert.equal(pendingDriveUpload(), null);
});

test("storage corruption or unavailable persistence fails explicitly before a new staged request", async t => {
  let requests = 0;
  const { values, storage } = browser(t, () => { requests++; throw new Error("Network must not be reached"); });
  values.set("icloud-drive-staged-upload-v1", "{invalid");
  assert.throws(pendingDriveUpload, /retained upload record is invalid/);
  await assert.rejects(uploadDriveFile(file, context, () => {}), /retained upload record is invalid/);
  values.clear();
  t.mock.method(storage, "setItem", () => { throw new Error("synthetic storage denied"); });
  await assert.rejects(uploadDriveFile(file, context, () => {}), /storage denied/);
  assert.equal(requests, 0);
});

test("the 64 MiB boundary keeps the direct upload flow without requiring browser storage or R2", async t => {
  const direct = new File([file.slice(0, DRIVE_DIRECT_UPLOAD_BYTES)], "synthetic-direct.bin");
  let operationId = "", requests = 0;
  browser(t, (path, init) => {
    requests++;
    if (path.endsWith("/prepare-upload")) {
      const intent = JSON.parse(String(init.body)); operationId = intent.operationId;
      assert.equal(intent.size, DRIVE_DIRECT_UPLOAD_BYTES);
      return Response.json({ uploadPath: `/api/drive/uploads/${operationId}/content` });
    }
    assert.equal(path, `/api/drive/uploads/${operationId}/content`);
    assert.equal(init.body, direct);
    return Response.json({ operationId, phase: "confirmed" });
  });
  assert.equal((await uploadDriveFile(direct, context, () => {})).phase, "confirmed");
  assert.equal(requests, 2);
});
