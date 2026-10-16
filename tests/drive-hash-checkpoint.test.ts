import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { CheckpointSHA256, HashCheckpoint } from "../src/drive/hash-checkpoint.ts";
import { hex } from "../src/crypto/bytes.ts";

test("sealed SHA-256 checkpoints resume independently at block boundaries and preserve final padding", () => {
  for (const tail of [0, 1, 55, 56, 63, 64, 65, 127]) {
    const bytes = randomBytes(4096 + tail);
    let hash = new CheckpointSHA256();
    for (let offset = 0; offset < 4096; offset += 64) {
      hash.update(bytes.subarray(offset, offset + 64));
      const state = JSON.parse(JSON.stringify(hash.checkpoint())); hash.destroy();
      hash = new CheckpointSHA256(state);
    }
    hash.update(bytes.subarray(4096));
    if (tail % 64) assert.throws(() => hash.checkpoint(), /aligned/);
    assert.equal(hex(hash.digest()), createHash("sha256").update(bytes).digest("hex"));
    assert.throws(() => hash.checkpoint(), /unfinished/);
  }
  const state = new CheckpointSHA256().checkpoint();
  assert.equal(HashCheckpoint.safeParse({ ...state, bytes: 1 }).success, false);
  assert.equal(HashCheckpoint.safeParse({ ...state, words: [2 ** 40, ...state.words.slice(1)] }).success, false);
});
