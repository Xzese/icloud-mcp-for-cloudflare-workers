import test from "node:test";
import assert from "node:assert/strict";
import { JobSQLiteD1 } from "./helpers/sqlite-d1.ts";
import { DriveOperationRepository } from "../src/persistence/drive-operations.ts";
import { DriveUploadChunks } from "../src/persistence/drive-upload-chunks.ts";
import { b64 } from "../src/crypto/bytes.ts";

function fixture() {
  const db = new JobSQLiteD1();
  const env = { ...db.env(), REMINDERS_OWNER_ID: "chunk-owner", ENCRYPTION_KEY_ID: "synthetic", ENCRYPTION_KEYS_JSON: JSON.stringify({ synthetic: b64(crypto.getRandomValues(new Uint8Array(32))) }) };
  const operations = new DriveOperationRepository(env, env.REMINDERS_OWNER_ID);
  const scope = { account: "synthetic-account", generation: 1, permissionRevision: 2, expiresAt: Date.now() + 60_000 };
  return { db, operations, chunks: new DriveUploadChunks(operations), scope };
}

test("encrypted staging authenticates offsets, expires, bounds owner quota and cascades on disconnect", async t => {
  const { db, operations, chunks, scope } = fixture();
  t.after(() => db.sqlite.close());
  const row = await operations.create(crypto.randomUUID(), "upload", {}, scope);
  const bytes = new Uint8Array(65536).fill(42);
  await chunks.append(row, scope, 0, bytes);
  assert.deepEqual(new Uint8Array(await new Response(chunks.stream(row, bytes.length)).arrayBuffer()), bytes);
  await assert.rejects(chunks.append(row, { ...scope, permissionRevision: 3 }, 65536, bytes), { code: "CONFLICT" });
  const original = String(db.sqlite.prepare("SELECT envelope FROM drive_upload_chunks").get()?.envelope);
  db.sqlite.prepare("UPDATE drive_upload_chunks SET byte_offset = 65536").run();
  await assert.rejects(new Response(chunks.stream(row, bytes.length * 2)).arrayBuffer(), { code: "VALIDATION_ERROR" });
  db.sqlite.prepare("UPDATE drive_upload_chunks SET byte_offset = 0, envelope = ?").run(original.replace('"iv":"', '"iv":"A'));
  await assert.rejects(new Response(chunks.stream(row, bytes.length)).arrayBuffer());
  db.sqlite.prepare("UPDATE drive_upload_chunks SET envelope = ?, byte_length = ?").run(original, 128 * 1024 * 1024);
  await assert.rejects(chunks.append(row, scope, 65536, bytes), { code: "CONFLICT" });
  assert.equal((await chunks.append(row, scope, 0, bytes)).receivedChunks, 1, "identical retries work at the quota");
  db.sqlite.prepare("UPDATE drive_upload_chunks SET expires_at = 0").run();
  await chunks.append(row, scope, 0, bytes);
  assert.equal(db.sqlite.prepare("SELECT SUM(byte_length) AS size FROM drive_upload_chunks").get()?.size, bytes.length);
  await operations.clearBeforeGeneration(scope.generation + 1);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS count FROM drive_upload_chunks").get()?.count, 0);
});

test("staging rejects a concurrent upload lease and reports missing migration without affecting operations", async t => {
  const { db, operations, chunks, scope } = fixture();
  t.after(() => db.sqlite.close());
  const row = await operations.create(crypto.randomUUID(), "upload", {}, scope);
  const lease = await operations.claim(row, scope);
  await assert.rejects(chunks.append(row, scope, 0, new Uint8Array([42])), { code: "CONFLICT" });
  await operations.release(lease);
  await chunks.append(await operations.get(row.operation_id, scope), scope, 0, new Uint8Array([42]));
  db.sqlite.exec("DROP TABLE drive_upload_chunks");
  assert.equal(await chunks.available(), false);
  await assert.rejects(chunks.requireSchema(), { code: "CONFIGURATION_REQUIRED" });
  assert.equal((await operations.get(row.operation_id, scope)).phase, "prepared");
});
