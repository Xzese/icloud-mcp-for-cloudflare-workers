import test from "node:test";
import assert from "node:assert/strict";
import { JobSQLiteD1 } from "./helpers/sqlite-d1.ts";
import { DriveOperationRepository } from "../src/persistence/drive-operations.ts";
import { b64 } from "../src/crypto/bytes.ts";

function fixture() {
  const db = new JobSQLiteD1();
  const env = { ...db.env(), REMINDERS_OWNER_ID: "test-owner", ENCRYPTION_KEY_ID: "test", ENCRYPTION_KEYS_JSON: JSON.stringify({ test: b64(crypto.getRandomValues(new Uint8Array(32))) }) };
  const repository = new DriveOperationRepository(env, "test-owner");
  const scope = { account: "synthetic-account", generation: 1, permissionRevision: 2, expiresAt: Date.now() + 60_000 };
  return { db, env, repository, scope };
}

test("shared Drive contexts are encrypted, reusable, bounded and account/settings/expiry scoped", async t => {
  const { db, repository, scope } = fixture();
  t.after(() => db.sqlite.close());
  const data = { shareID: { recordName: "synthetic-private-share" }, ownerRecordName: "synthetic-private-owner" };
  const id = await repository.saveSharedContext(data, scope);
  assert.equal(await repository.saveSharedContext(data, scope), id);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS count FROM drive_handles").get()?.count, 1);
  assert.deepEqual(await repository.loadSharedContext(id, scope), data);
  assert.deepEqual(await repository.loadSharedContext(id, scope), data, "share context reads do not consume the handle");
  const envelope = String(db.sqlite.prepare("SELECT envelope FROM drive_handles WHERE handle_id = ?").get(id)?.envelope);
  assert.ok(!envelope.includes("synthetic-private"));
  for (const other of [{ ...scope, account: "other" }, { ...scope, generation: 2 }, { ...scope, permissionRevision: 3 }]) {
    await assert.rejects(repository.loadSharedContext(id, other), { code: "CONFLICT" });
  }
  await assert.rejects(repository.consumeHandle(id, "download", scope), { code: "CONFLICT" });
  const download = await repository.handle("download", {}, scope);
  await assert.rejects(repository.loadSharedContext(download.id, scope), { code: "CONFLICT" });
  for (let index = 2; index < 128; index++) await repository.handle("search", {}, scope);
  assert.equal(await repository.saveSharedContext(data, scope), id, "repeated browsing works at the handle cap");
  await assert.rejects(repository.saveSharedContext({ ...data, ownerRecordName: "other" }, scope), { code: "RATE_LIMITED" });
  db.sqlite.prepare("UPDATE drive_handles SET expires_at = 0 WHERE handle_id = ?").run(id);
  await assert.rejects(repository.loadSharedContext(id, scope), { code: "CONFLICT" });
});

test("Drive operation keys retain encrypted input and never acquire a second live dispatch lease", async () => {
  const { db, repository, scope } = fixture(), id = crypto.randomUUID();
  const original = await repository.create(id, "upload", { name: "Invented file.txt", hash: "example" }, scope);
  assert.ok(!original.envelope!.includes("Invented file"));
  const same = await repository.create(id, "upload", { hash: "example", name: "Invented file.txt" }, scope);
  assert.equal(same.operation_id, original.operation_id);
  assert.equal((await repository.create(id.toUpperCase(), "upload", { hash: "example", name: "Invented file.txt" }, scope)).operation_id, id);
  assert.equal((await repository.get(id.toUpperCase(), scope)).operation_id, id);
  const keyedId = crypto.randomUUID();
  const keyed = await repository.create(keyedId.toUpperCase(), "upload", { operationId: keyedId.toUpperCase(), name: "Keyed file.txt" }, scope);
  assert.equal((await repository.create(keyedId, "upload", { operationId: keyedId, name: "Keyed file.txt" }, scope)).input_hash, keyed.input_hash);
  assert.equal((await repository.data(keyed)).input.operationId, keyedId);
  await assert.rejects(repository.create(id, "upload", { name: "different.txt" }, scope), { code: "CONFLICT" });
  const leased = await repository.claim(original, scope);
  await assert.rejects(repository.claim(same, scope), { code: "CONFLICT" });
  const checkpoint = await repository.checkpoint(leased, "committing", { input: { name: "Invented file.txt", hash: "example" }, itemId: "synthetic-file" });
  await repository.release(checkpoint);
  const retained = await repository.get(id, scope);
  assert.equal(retained.phase, "committing"); // A lost response does not reset the operation to prepared.
  assert.equal((await repository.data(retained)).itemId, "synthetic-file");
  await assert.rejects(repository.get(id, { ...scope, generation: 2 }), { code: "FORBIDDEN" });
  await assert.rejects(repository.claim(retained, { ...scope, permissionRevision: 3 }), { code: "CONFLICT" });
  // A five-minute transfer must retain exclusive ownership beyond the old
  // 150-second lease, with enough time left to save its acknowledgement.
  const clock = Date.now;
  const began = clock();
  try {
    Date.now = () => began;
    const longScope = { ...scope, expiresAt: began + 30 * 60_000 };
    const longUpload = await repository.create(crypto.randomUUID(), "upload", { name: "Long upload.bin" }, longScope);
    const longLease = await repository.claim(longUpload, longScope);
    Date.now = () => began + 160_000;
    await assert.rejects(repository.claim(longUpload, longScope), { code: "CONFLICT" });
    Date.now = () => began + 300_000;
    const uploaded = await repository.checkpoint(longLease, "uploaded", { input: { name: "Long upload.bin" } });
    assert.equal(uploaded.phase, "uploaded");
    await repository.release(uploaded);
    const shortScope = { ...scope, expiresAt: Date.now() + 10_000 };
    const shortUpload = await repository.create(crypto.randomUUID(), "upload", { name: "Expiring upload.bin" }, shortScope);
    const shortLease = await repository.claim(shortUpload, shortScope);
    await assert.rejects(repository.assertLease(shortLease, 305_000), { code: "CONFLICT" });
  } finally { Date.now = clock; }
  db.sqlite.close();
});

test("Drive handles are scoped to settings/session and consumed once; disconnect clears old state only", async () => {
  const { db, repository, scope } = fixture();
  const handle = await repository.handle("download", { itemId: "test-file" }, scope);
  await assert.rejects(repository.consumeHandle(handle.id, "search", scope), { code: "CONFLICT" });
  await assert.rejects(repository.consumeHandle(handle.id, "download", { ...scope, permissionRevision: 3 }), { code: "CONFLICT" });
  assert.deepEqual(await repository.consumeHandle(handle.id, "download", scope), { itemId: "test-file" });
  await assert.rejects(repository.consumeHandle(handle.id, "download", scope), { code: "CONFLICT" });
  const old = await repository.create(crypto.randomUUID(), "create", { name: "Folder" }, scope);
  const later = await repository.create(crypto.randomUUID(), "create", { name: "New folder" }, { ...scope, generation: 3 });
  await repository.clearBeforeGeneration(2);
  await assert.rejects(repository.get(old.operation_id, scope), { code: "FORBIDDEN" });
  assert.equal((await repository.get(later.operation_id, { ...scope, generation: 3 })).phase, "prepared");
  db.sqlite.close();
});

test("Expired operation keys remain tombstones and authenticated ciphertext cannot move between operations", async () => {
  const { db, repository, scope } = fixture();
  const a = await repository.create(crypto.randomUUID(), "create", { name: "A" }, scope);
  const b = await repository.create(crypto.randomUUID(), "create", { name: "B" }, scope);
  await assert.rejects(repository.data({ ...b, envelope: a.envelope }), { code: "PROTOCOL_CHANGED" });
  db.sqlite.prepare("UPDATE drive_operations SET expires_at = 1 WHERE operation_id = ?").run(a.operation_id);
  await assert.rejects(repository.create(a.operation_id, "create", { name: "A" }, scope), { code: "AUTH_EXPIRED" });
  assert.equal(db.sqlite.prepare("SELECT envelope FROM drive_operations WHERE operation_id = ?").get(a.operation_id)?.envelope, null);
  db.sqlite.close();
});
