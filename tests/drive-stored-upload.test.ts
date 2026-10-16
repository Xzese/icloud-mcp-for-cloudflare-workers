import test from "node:test";
import assert from "node:assert/strict";
import { storedUpload, storedUploadProof } from "../src/drive/stored-upload.ts";
import { CheckpointSHA256 } from "../src/drive/hash-checkpoint.ts";
import { createHash } from "node:crypto";

// Native FixedLengthStream and R2 are covered by the full production Worker
// journeys. This exact-framing shim permits deterministic fault injection.
class ExactStream extends TransformStream<Uint8Array, Uint8Array> {
  constructor(size: number) {
    let count = 0;
    super({ transform(bytes, controller) { count += bytes.length; if (count > size) throw new Error("overflow"); controller.enqueue(bytes); }, flush() { if (count !== size) throw new Error("underflow"); } });
  }
}

test("stored delivery pins every range, withholds its last byte on revocation, and rejects changed or truncated storage", async t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "FixedLengthStream");
  Object.defineProperty(globalThis, "FixedLengthStream", { configurable: true, value: ExactStream });
  t.after(() => { if (original) Object.defineProperty(globalThis, "FixedLengthStream", original); else Reflect.deleteProperty(globalThis, "FixedLengthStream"); });
  const bytes = new Uint8Array(65537).fill(23), sha256 = createHash("sha256").update(bytes).digest("hex");
  const staging = { key: `drive-staging/v1/${Date.now()}/${crypto.randomUUID()}`, uploadId: crypto.randomUUID(), parts: [], cancelled: false, objectEtag: "immutable", verification: { hash: new CheckpointSHA256().checkpoint(), sha256 } };
  for (const fault of ["none", "revoked", "etag", "short", "long"]) {
    let guards = 0, reads = 0, received = 0;
    const bucket = { async get(key: string, options: { onlyIf: { etagMatches: string }; range: { offset: number; length: number } }) {
      reads++; assert.equal(key, staging.key); assert.equal(options.onlyIf.etagMatches, staging.objectEtag);
      const { offset, length } = options.range;
      let part = bytes.slice(offset, offset + length);
      if (fault === "short") part = part.subarray(1);
      if (fault === "long") part = new Uint8Array(part.length + 1);
      return { size: bytes.length, etag: fault === "etag" ? "replaced" : staging.objectEtag, range: options.range, body: new Response(part).body };
    } } as unknown as R2Bucket;
    const source = storedUpload(bucket, staging, bytes.length, sha256, async () => { if (++guards === 2 && fault === "revoked") throw new Error("revoked"); });
    const drain = async () => { const reader = source.stream.getReader(); for (;;) { const next = await reader.read(); if (next.done) break; received += next.value.length; } };
    if (fault === "none") { await drain(); assert.ok(source.verified()); assert.equal(received, bytes.length); assert.equal(reads, 2); }
    else { await assert.rejects(drain()); assert.equal(source.verified(), false); if (fault === "revoked") assert.equal(received, bytes.length - 1); if (fault === "etag") assert.equal(received, 0); }
    assert.equal(storedUploadProof(source.stream)?.complete(), fault === "none");
  }
  assert.equal(storedUploadProof(new ReadableStream()), undefined, "ordinary caller streams cannot claim stored verification");
});
