import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { initialRelayState, openRelayState, sealRelayState, DRIVE_RELAY_CHUNK_BYTES, type RelayAuthority } from "../src/drive/relay-state.ts";
import { CheckpointSHA256 } from "../src/drive/hash-checkpoint.ts";
import { relayCredentials } from "../src/drive/transfer-capability.ts";
import { b64 } from "../src/crypto/bytes.ts";
import { relayForwarder } from "../src/drive/relay-forward.ts";

function fixture(size = 17) {
  const env = { APP_ORIGIN: "https://relay.example.test", REMINDERS_OWNER_ID: "synthetic-owner", ENCRYPTION_KEY_ID: "synthetic", ENCRYPTION_KEYS_JSON: JSON.stringify({ synthetic: b64(randomBytes(32)) }) };
  const bytes = new Uint8Array(size).fill(90);
  const a: RelayAuthority = { owner: env.REMINDERS_OWNER_ID, operationId: crypto.randomUUID(), inputHash: "a".repeat(64), scope: { account: "synthetic-account", generation: 4, permissionRevision: 7, expiresAt: Date.now() + 300_000 }, leaseId: crypto.randomUUID(), leaseUntil: Date.now() + 300_000, size, sha256: createHash("sha256").update(bytes).digest("hex") };
  return { env, a, bytes };
}

test("relay checkpoints bind account, operation, input, permission revision and expiry", async () => {
  const { env, a } = fixture();
  const state = initialRelayState(a, 2), token = await sealRelayState(env, a, state);
  assert.deepEqual(await openRelayState(env, a, token), state);
  for (const changed of [{ ...a, owner: "different" }, { ...a, operationId: crypto.randomUUID() }, { ...a, inputHash: "b".repeat(64) }, ...["account", "generation", "permissionRevision"].map(key => ({ ...a, scope: { ...a.scope, [key]: key === "account" ? "different" : 99 } }))]) {
    await assert.rejects(openRelayState(env, changed, token), { code: "FORBIDDEN" });
  }
  await assert.rejects(openRelayState(env, a, token.slice(0, -20) + "A".repeat(20)), { code: "FORBIDDEN" });
  await assert.rejects(sealRelayState(env, a, { ...state, expiresAt: Date.now() - 1 }), { code: "FORBIDDEN" });
  await assert.rejects(sealRelayState(env, a, { ...state, offset: 1 }), { code: "FORBIDDEN" });
  await assert.rejects(sealRelayState(env, a, { ...state, complete: true }), { code: "FORBIDDEN" });
});

test("relay forwarder advances authenticated ordered checkpoints and returns the verified bytes", async () => {
  const { env, a, bytes } = fixture(DRIVE_RELAY_CHUNK_BYTES + 17);
  let requests = 0;
  const send: typeof fetch = async (_url, init) => {
    requests++; assert.equal(init?.redirect, "manual"); assert.equal(init?.method, "POST");
    const headers = new Headers(init?.headers), state = await openRelayState(env, a, relayCredentials(headers.get("authorization")).checkpoint);
    const body = init!.body as Uint8Array;
    const hash = new CheckpointSHA256(state.hash!); hash.update(body); state.offset += body.length;
    if (state.offset === state.size) { assert.equal(Buffer.from(hash.digest()).toString("hex"), state.sha256); state.complete = true; state.hash = null; }
    else state.hash = hash.checkpoint();
    hash.destroy();
    return new Response(body as BodyInit, { headers: { "content-type": "application/octet-stream", "content-length": String(body.length), "x-drive-relay-state": await sealRelayState(env, a, state) } });
  };
  const forward = await relayForwarder(env, a, 2, undefined, send);
  for (const part of [bytes.subarray(0, DRIVE_RELAY_CHUNK_BYTES), bytes.subarray(DRIVE_RELAY_CHUNK_BYTES)]) {
    const result = await forward(part); assert.deepEqual(new Uint8Array(await new Response(result.body).arrayBuffer()), part);
    assert.equal(result.complete, requests === 2);
  }
  await assert.rejects(forward(bytes.subarray(0, 17)), { code: "CONFLICT" });
  assert.equal(requests, 2);
});

test("relay forwarder refuses redirects, unrelated or repeated checkpoints without retrying", async () => {
  for (const mode of ["redirect", "repeated", "nonce", "length"]) {
    const { env, a, bytes } = fixture(); let requests = 0;
    const send: typeof fetch = async (_url, init) => {
      requests++;
      if (mode === "redirect") return new Response(null, { status: 307, headers: { location: "https://other.example.test" } });
      const state = await openRelayState(env, a, relayCredentials(new Headers(init?.headers).get("authorization")).checkpoint);
      if (mode !== "repeated") { state.offset = state.size; state.complete = true; state.hash = null; }
      if (mode === "nonce") state.nonce = crypto.randomUUID();
      return new Response(bytes as BodyInit, { headers: { "content-type": "application/octet-stream", "content-length": mode === "length" ? "18" : "17", "x-drive-relay-state": await sealRelayState(env, a, state) } });
    };
    const forward = await relayForwarder(env, a, 2, undefined, send);
    await assert.rejects(forward(bytes)); assert.equal(requests, 1);
  }
});

test("relay forwards native Blob frames without reading them into JavaScript", async () => {
  const { env, a, bytes } = fixture();
  class NativeFrame extends Blob {
    override arrayBuffer(): never { throw new Error("Coordinator must not copy Blob bytes"); }
    override stream(): never { throw new Error("Coordinator must pass the native Blob directly to fetch"); }
  }
  const frame = new NativeFrame([bytes as BlobPart]);
  const forward = await relayForwarder(env, a, 2, undefined, async (_url, init) => {
    assert.equal(init?.body, frame);
    const state = await openRelayState(env, a, relayCredentials(new Headers(init?.headers).get("authorization")).checkpoint);
    state.offset = state.size; state.complete = true; state.hash = null;
    return new Response(bytes as BodyInit, { headers: { "content-type": "application/octet-stream", "content-length": String(bytes.length), "x-drive-relay-state": await sealRelayState(env, a, state) } });
  });
  const result = await forward(frame); assert.equal(result.complete, true);
  assert.deepEqual(new Uint8Array(await new Response(result.body).arrayBuffer()), bytes);
});
