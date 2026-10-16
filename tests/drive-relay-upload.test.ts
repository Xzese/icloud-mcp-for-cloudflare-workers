import test from "node:test";
import assert from "node:assert/strict";
import { createRelayUpload, bindRelayUpload, relayUploadProof } from "../src/drive/relay-upload.ts";
import { DRIVE_RELAY_CHUNK_BYTES } from "../src/drive/relay-state.ts";

class ExactStream extends TransformStream<Uint8Array, Uint8Array> {
  constructor(size: number) {
    let count = 0;
    super({ transform(bytes, controller) { count += bytes.length; if (count > size) throw new Error("overflow"); controller.enqueue(bytes); }, flush() { if (count !== size) throw new Error("underflow"); } });
  }
}

test("relay permits one verified prefetch before Apple drains, and requires complete framing before its receipt", async t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "FixedLengthStream");
  Object.defineProperty(globalThis, "FixedLengthStream", { configurable: true, value: ExactStream });
  t.after(() => { if (original) Object.defineProperty(globalThis, "FixedLengthStream", original); else Reflect.deleteProperty(globalThis, "FixedLengthStream"); });
  const size = DRIVE_RELAY_CHUNK_BYTES + 17, relay = createRelayUpload(size);
  let forwards = 0, resolve!: () => void;
  const prefetched = new Promise<void>(yes => { resolve = yes; });
  bindRelayUpload(relay.stream, { size, expiresAt: Date.now() + 60_000, forward: async bytes => ({ body: new Response(bytes as BodyInit).body!, complete: ++forwards === 2 }) });
  const first = relay.write(new Blob([new Uint8Array(DRIVE_RELAY_CHUNK_BYTES).fill(90)]), resolve);
  await prefetched;
  assert.equal(relayUploadProof(relay.stream)!.bytes(), 0, "credit may precede Apple consumption");
  assert.equal(relayUploadProof(relay.stream)!.complete(), false);
  let received = 0;
  const drain = (async () => { const reader = relay.stream.getReader(); for (;;) { const next = await reader.read(); if (next.done) break; received += next.value.length; } })();
  await first;
  await relay.write(new Uint8Array(17).fill(90));
  await relay.close(); await drain; await relayUploadProof(relay.stream)!.drained;
  assert.equal(received, size); assert.equal(forwards, 2); assert.equal(relayUploadProof(relay.stream)!.complete(), true);
});

test("relay rejects an inconsistent final verifier proof before releasing its bytes", async t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "FixedLengthStream");
  Object.defineProperty(globalThis, "FixedLengthStream", { configurable: true, value: ExactStream });
  t.after(() => { if (original) Object.defineProperty(globalThis, "FixedLengthStream", original); else Reflect.deleteProperty(globalThis, "FixedLengthStream"); });
  const relay = createRelayUpload(17);
  bindRelayUpload(relay.stream, { size: 17, expiresAt: Date.now() + 60_000, forward: async bytes => ({ body: new Response(bytes as BodyInit).body!, complete: false }) });
  await assert.rejects(relay.write(new Uint8Array(17)), { code: "PROTOCOL_CHANGED" });
  assert.equal(relayUploadProof(relay.stream)!.bytes(), 0);
  assert.equal(relayUploadProof(relay.stream)!.complete(), false);
  await assert.rejects(relayUploadProof(relay.stream)!.drained);
});
