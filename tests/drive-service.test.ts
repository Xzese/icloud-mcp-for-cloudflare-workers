import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { JobSQLiteD1 } from "./helpers/sqlite-d1.ts";
import { AppleSessionRepository, type AppleSession } from "../src/persistence/apple-sessions.ts";
import { ServiceSettingsRepository } from "../src/persistence/service-settings.ts";
import { DriveOperationRepository } from "../src/persistence/drive-operations.ts";
import { DriveService } from "../src/drive/service.ts";
import { TraversalResult } from "../src/drive/traversal.ts";
import { AppleConnectionService } from "../src/auth/service.ts";
import { DRIVE_ROOT } from "../src/icloud/drive.ts";
import { loginAssurance } from "../src/auth/apple/policy.ts";
import { b64, digest, hex } from "../src/crypto/bytes.ts";
import { DEFAULT_SERVICE_SETTINGS } from "../src/services/settings.ts";
import { accountScope } from "../src/lib/canonical.ts";
import { DRIVE_FILE_BYTES, DRIVE_TRANSFER_BLOCK_BYTES } from "../src/drive/limits.ts";
import { DriveBucket } from "./helpers/drive-bucket.ts";
import { authorizeDriveTransfer, driveTransferRoute, DriveTransferPlan } from "../src/drive/transfer-capability.ts";
import { applicationRoute } from "../src/api/router.ts";

function syntheticDownloadURL() {
  const url = new URL("/B/invented-signature/test.bin", "https://cvws.icloud-content.com");
  url.searchParams.set("token", crypto.randomUUID());
  return url.href;
}

const owner = "drive-service-owner";
const identity = { dsid: "123456789", clientId: "synthetic-drive-client", clientBuildNumber: "2534Project66", clientMasteringNumber: "2534B22" };
const connection = { ...identity, driveURL: "https://p01-drivews.icloud.com", documentsURL: "https://p01-docws.icloud.com" };
const root = { drivewsid: DRIVE_ROOT, docwsid: "root", zone: "com.apple.CloudDocs", name: "root", type: "FOLDER", etag: "root-version", parentId: null };
function file(name = "note.txt", id = "synthetic-file", parentId = DRIVE_ROOT, size = 3) {
  return { drivewsid: `FILE::com.apple.CloudDocs::${id}`, docwsid: id, zone: "com.apple.CloudDocs", name, type: "FILE", etag: "file-version", parentId, size, dateModified: 0 };
}
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
const stream = (bytes: Uint8Array) => new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } });
async function drain(body: ReadableStream<Uint8Array>) { const reader = body.getReader(); for (;;) { if ((await reader.read()).done) break; } }
async function fixture(t: TestContext, handler: (url: URL, init: RequestInit) => Promise<Response> | Response) {
  const db = new JobSQLiteD1();
  const env = { ...db.env(), APP_ORIGIN: "https://drive-service.example.test", REMINDERS_OWNER_ID: owner, ENCRYPTION_KEY_ID: "synthetic", ENCRYPTION_KEYS_JSON: JSON.stringify({ synthetic: b64(crypto.getRandomValues(new Uint8Array(32))) }), LIVE_APPLE_CONNECTION_APPROVED: "controlled-device-v2", APPLE_CRYPTO_REVIEW_APPROVED: "device-proof-v2", APPLE_SESSION_RETENTION_WRITES: "absolute-30d-v1" };
  const sessions = new AppleSessionRepository(env, owner), settings = new ServiceSettingsRepository(env, owner);
  const session: AppleSession = { connection: { ...identity, cloudKitURL: "https://p01-ckdatabasews.icloud.com/database/1/com.apple.reminders/production/private" }, login: loginAssurance(), pcs: { consentRequested: true, pcsAttempts: 1, consentChecks: 1, expiresAt: Date.now() + 300_000, nextAttemptAt: 0 }, auth: { clientId: identity.clientId, headers: {}, cookies: [{ name: "X-APPLE-WEBAUTH-VALIDATE", value: "v=1:t=synthetic-validation-token", domain: "icloud.com", hostOnly: false, path: "/", secure: true, expiresAt: null }] }, services: { version: 1, reminders: { state: "DEVICE_APPROVAL_PENDING", pcs: { consentRequested: true, pcsAttempts: 1, consentChecks: 1, expiresAt: Date.now() + 300_000, nextAttemptAt: 0 }, action: "wait-for-reminders-keys" }, drive: { state: "READY", connection } } };
  const begun = await sessions.begin((await sessions.status()).generation);
  await sessions.commit(begun, session, "DEVICE_APPROVAL_PENDING", "wait-for-reminders-keys");
  await settings.save({ expectedRevision: 0, settings: { ...structuredClone(DEFAULT_SERVICE_SETTINGS), drive: { enabled: true, browse: true, contents: true, upload: true, organize: true } } });
  const original = globalThis.fetch;
  globalThis.fetch = (async (input, init) => handler(new URL(input instanceof Request ? input.url : String(input)), init ?? {})) as typeof fetch;
  t.after(() => { globalThis.fetch = original; db.sqlite.close(); });
  return { db, env, sessions, settings, service: new DriveService(env, owner), generation: begun.generation };
}
async function uploadInput(name: string, bytes = new TextEncoder().encode("abc")) {
  return { parentId: DRIVE_ROOT, name, operationId: crypto.randomUUID(), size: bytes.length, sha256: hex(await digest(bytes)), contentType: "text/plain", contentBase64: b64(bytes) };
}

test("MCP metadata-only upload authorizes one large direct transfer without R2 or any Apple write, and cannot reauthorize unknown work", async t => {
  let reads = 0;
  const f = await fixture(t, url => {
    assert.equal(url.pathname, "/retrieveItemDetailsInFolders"); reads++;
    return json([{ ...root, items: [], directChildrenCount: 0 }]);
  });
  const input = { ...await uploadInput("capability-2GiB.bin"), contentBase64: "", size: 2 ** 31 };
  const prepared = await f.service.upload(input);
  assert.ok("transfer" in prepared && prepared.transfer);
  const transfer = DriveTransferPlan.parse(prepared.transfer);
  assert.equal(prepared.phase, "prepared"); assert.equal(transfer.size, 2 ** 31);
  const url = transfer.url.replace("wss:", "https:"), route = driveTransferRoute(new URL(url).pathname)!;
  const claim = await authorizeDriveTransfer(new Request(url, { headers: transfer.headers }), f.env, route);
  assert.equal((await f.service.streamUploadStatus(input.operationId, claim)).size, 2 ** 31);
  await assert.rejects(f.service.streamUploadStatus(input.operationId, { ...claim, inputHash: "0".repeat(64) }), { code: "CONFLICT" });
  f.db.sqlite.prepare("UPDATE drive_operations SET phase = 'unknown' WHERE operation_id = ?").run(input.operationId);
  const unresolved = await f.service.upload(input);
  assert.equal(unresolved.phase, "unknown"); assert.ok(!("transfer" in unresolved));
  await assert.rejects(f.service.streamUploadStatus(input.operationId, claim), { code: "WRITE_OUTCOME_UNKNOWN" });
  assert.equal(reads, 1);
  const settings = await f.settings.load();
  await f.settings.save({ expectedRevision: settings.revision, settings: { ...settings.settings, drive: { ...settings.settings.drive, upload: false } } });
  await assert.rejects(f.service.streamUploadStatus(input.operationId, claim), { code: "FORBIDDEN" });
});

test("MCP download capability streams without a browser identity, checks exact versions, consumes once and dies on settings/account change", async t => {
  let downloads = 0, current = file();
  const f = await fixture(t, url => {
    if (url.pathname === "/retrieveItemDetails") return json({ items: [current] });
    if (url.pathname.endsWith("/download/by_id")) return json({ document_id: current.docwsid, data_token: { url: syntheticDownloadURL() } });
    if (url.hostname === "cvws.icloud-content.com") { downloads++; return new Response("abc", { headers: { "content-length": "3" } }); }
    throw new Error("Unexpected synthetic download endpoint.");
  });
  const prepared = await f.service.downloadTransfer({ itemId: current.drivewsid });
  assert.ok(prepared.transfer);
  const response = (await applicationRoute(new Request(prepared.url, { headers: prepared.transfer.headers }), f.env))!;
  assert.equal(response.status, 200); assert.equal(await response.text(), "abc");
  assert.match(response.headers.get("x-robots-tag")!, /noindex.*nofollow/);
  assert.equal(downloads, 1);
  assert.equal((await applicationRoute(new Request(prepared.url, { headers: prepared.transfer.headers }), f.env))!.status, 409);
  const stale = await f.service.downloadTransfer({ itemId: current.drivewsid });
  current = { ...current, etag: "changed-version" };
  assert.equal((await applicationRoute(new Request(stale.url, { headers: stale.transfer!.headers }), f.env))!.status, 409);
  assert.equal(downloads, 1);
  const changedSettings = await f.service.downloadTransfer({ itemId: current.drivewsid });
  const settings = await f.settings.load();
  await f.settings.save({ expectedRevision: settings.revision, settings: { ...settings.settings, drive: { ...settings.settings.drive, organize: false } } });
  assert.equal((await applicationRoute(new Request(changedSettings.url, { headers: changedSettings.transfer!.headers }), f.env))!.status, 409);
  const changedAccount = await f.service.downloadTransfer({ itemId: current.drivewsid });
  await f.sessions.begin(f.generation);
  assert.notEqual((await applicationRoute(new Request(changedAccount.url, { headers: changedAccount.transfer!.headers }), f.env))!.status, 200);
  assert.equal(downloads, 1);
});

test("Drive readiness is independent of Reminders; a permission flip stops dispatch and result release", async t => {
  let metadata = 0, writes = 0;
  const f = await fixture(t, url => {
    if (url.pathname === "/createFolders") { writes++; return json({ folders: [] }); }
    metadata++; return json([{ ...root, items: [], directChildrenCount: 0 }]);
  });
  const listed = await f.service.list({});
  assert.equal(listed.folder.id, DRIVE_ROOT);
  assert.equal((await f.sessions.load()).state, "DEVICE_APPROVAL_PENDING");
  const id = crypto.randomUUID();
  f.db.afterStatement = async sql => {
    if (sql.startsWith("UPDATE drive_operations SET phase") && f.db.sqlite.prepare("SELECT phase FROM drive_operations WHERE operation_id = ?").get(id)?.phase === "committing") {
      f.db.afterStatement = null;
      const saved = await f.settings.load();
      await f.settings.save({ expectedRevision: saved.revision, settings: { ...saved.settings, drive: { ...saved.settings.drive, organize: false } } });
    }
  };
  await assert.rejects(f.service.createFolder({ parentId: DRIVE_ROOT, name: "New folder", operationId: id }), { code: "WRITE_OUTCOME_UNKNOWN" });
  assert.equal(writes, 0);
  assert.equal(metadata, 2);
  let flipped = false;
  f.db.afterStatement = async sql => {
    if (!flipped && (sql.startsWith("UPDATE apple_session_state SET version = version + 1, state") || sql.startsWith("UPDATE apple_session_state SET envelope = ?, updated_at"))) {
      flipped = true; f.db.afterStatement = null;
      const saved = await f.settings.load();
      await f.settings.save({ expectedRevision: saved.revision, settings: { ...saved.settings, drive: { ...saved.settings.drive, browse: false, contents: false, upload: false } } });
    }
  };
  await assert.rejects(f.service.list({}), { code: "FORBIDDEN" });
  assert.equal(f.db.sqlite.prepare("SELECT resume_id FROM apple_session_state WHERE owner_id = ?").get(owner)?.resume_id, null);
});

test("inline upload verifies content before allocation and confirmed/uncertain replay never duplicates writes", async t => {
  let allocations = 0, transfers = 0, commits = 0, uncertain = false;
  const files: ReturnType<typeof file>[] = [];
  const f = await fixture(t, async (url, init) => {
    if (["/retrieveItemDetailsInFolders", "/retrieveItemDetails"].includes(url.pathname)) {
      const payload = JSON.parse(String(init.body));
      const lookup = Array.isArray(payload) ? payload[0] : payload;
      const { drivewsid } = lookup.items?.[0] ?? lookup;
      return json([drivewsid === DRIVE_ROOT ? { ...root, items: files, directChildrenCount: files.length } : files.find(item => item.drivewsid === drivewsid)]);
    }
    if (url.pathname.endsWith("/upload/web")) { allocations++; return json([{ document_id: `upload-${allocations}`, url: `https://p01-contentws.icloud.com/123456789/singleFileUpload?tk=synthetic-token-${allocations}` }]); }
    if (url.hostname === "p01-contentws.icloud.com") {
      transfers++;
      assert.equal(new Headers(init.headers).has("cookie"), false);
      assert.equal(f.db.sqlite.prepare("SELECT resume_id FROM apple_session_state WHERE owner_id = ?").get(owner)?.resume_id, null);
      await drain(init.body as ReadableStream<Uint8Array>);
      return json({ singleFile: { referenceChecksum: "synthetic-reference", size: 3, fileChecksum: "synthetic-checksum", wrappingKey: "synthetic-wrapping-key" } });
    }
    if (url.pathname.endsWith("/update/documents")) {
      commits++;
      const payload = JSON.parse(String(init.body));
      assert.equal(payload.allow_conflict, true);
      const current = file(payload.path.path, payload.document_id, DRIVE_ROOT, 3);
      current.etag = "uploaded-version"; current.dateModified = payload.mtime; files.push(current);
      if (uncertain) throw new Error("synthetic connection closed after acceptance");
      return json({ status: { status_code: 0 }, results: [{ status: { status_code: 0 }, document: { document_id: payload.document_id, zone: "com.apple.CloudDocs", parent_id: DRIVE_ROOT, name: payload.path.path, type: "FILE", etag: current.etag, size: 3 } }] });
    }
    throw new Error(`Unexpected synthetic path ${url.pathname}`);
  });
  const input = await uploadInput("uploaded.txt");
  await assert.rejects(f.service.upload({ ...input, contentBase64: b64(new TextEncoder().encode("bad")) }), { code: "VALIDATION_ERROR" });
  assert.equal(allocations, 0);
  const result = await f.service.upload(input);
  assert.equal(result.phase, "confirmed");
  assert.equal(result.result?.item.documentId, "upload-1");
  assert.deepEqual(await f.service.upload(input), result);
  assert.deepEqual(await f.service.uploadContent(input.operationId.toUpperCase(), stream(new TextEncoder().encode("abc"))), result);
  assert.deepEqual([allocations, transfers, commits], [1, 1, 1]);
  const envelope = String(f.db.sqlite.prepare("SELECT envelope FROM drive_operations WHERE operation_id = ?").get(input.operationId)?.envelope);
  assert.equal(envelope.includes("uploaded.txt"), false);
  assert.equal(envelope.includes("synthetic-reference"), false);
  assert.equal(JSON.stringify(result).includes("wrapping"), false);
  const repository = new DriveOperationRepository(f.env, owner);
  const scope = { account: await accountScope(owner, identity.dsid), generation: f.generation, permissionRevision: 1, expiresAt: (await f.sessions.load()).session.login.expiresAt };
  const stored = await repository.data(await repository.get(input.operationId, scope));
  assert.equal("contentBase64" in stored.input, false);
  uncertain = true;
  const second = await uploadInput("uncertain.txt");
  await assert.rejects(f.service.upload(second), { code: "WRITE_OUTCOME_UNKNOWN" });
  await assert.rejects(f.service.upload({ ...second, operationId: second.operationId.toUpperCase() }), { code: "WRITE_OUTCOME_UNKNOWN" });
  await assert.rejects(f.service.uploadContent(second.operationId.toUpperCase(), stream(new TextEncoder().encode("abc"))), { code: "WRITE_OUTCOME_UNKNOWN" });
  assert.equal((await f.service.operation({ operationId: second.operationId.toUpperCase() })).phase, "unknown");
  assert.deepEqual([allocations, transfers, commits], [2, 2, 2]);
  await assert.rejects(f.service.uploadContent(crypto.randomUUID(), stream(new Uint8Array())), { code: "FORBIDDEN" });
  assert.equal((await f.service.list({})).items.length, 2); // Failed handles release the account lease.
});

test("multipart receipts resume safe finalization, but an uncertain content write is never replayed", async t => {
  let allocations = 0, transfers = 0, commits = 0, loseTransfer = false;
  const files: ReturnType<typeof file>[] = [], payload = new TextEncoder().encode("abc");
  const f = await fixture(t, async (url, init) => {
    if (url.hostname === "p01-drivews.icloud.com") {
      const body = JSON.parse(String(init.body)), id = (Array.isArray(body) ? body[0] : body.items[0]).drivewsid;
      return json([id === DRIVE_ROOT ? { ...root, items: files, directChildrenCount: files.length } : files.find(item => item.drivewsid === id)]);
    }
    if (url.pathname.endsWith("/upload/web")) {
      allocations++;
      return json([{ document_id: `staged-${allocations}`, url: `https://cws.icloud-content.com/123456789/singleFileUpload?tk=synthetic-staged-${allocations}` }]);
    }
    if (url.hostname === "cws.icloud-content.com") {
      transfers++; await drain(init.body as ReadableStream<Uint8Array>);
      if (loseTransfer) throw new Error("synthetic lost transfer acknowledgement");
      return json({ singleFile: { referenceChecksum: "synthetic-reference", fileChecksum: "synthetic-checksum", wrappingKey: "synthetic-key", size: payload.length } });
    }
    assert.ok(url.pathname.endsWith("/update/documents"));
    commits++;
    const body = JSON.parse(String(init.body)), item = file(body.path.path, body.document_id);
    files.push(item);
    return json({ status: { status_code: 0 }, results: [{ status: { status_code: 0 }, document: { document_id: item.docwsid, zone: item.zone, parent_id: "root", name: item.name, type: item.type, etag: item.etag, size: item.size } }] });
  });
  const bucket = new DriveBucket(), service = new DriveService({ ...f.env, BUCKET: bucket.binding() }, owner);
  async function stage(name: string) {
    const input = await uploadInput(name, payload);
    await service.prepareMultipartUpload(Object.fromEntries(Object.entries(input).filter(([key]) => key !== "contentBase64")));
    await service.uploadPart(input.operationId, 1, input.sha256, stream(payload));
    return input.operationId;
  }
  const id = await stage("staged-receipt.txt");
  f.db.afterStatement = async sql => {
    if (sql.startsWith("UPDATE drive_operations SET phase") && f.db.sqlite.prepare("SELECT phase FROM drive_operations WHERE operation_id = ?").get(id)?.phase === "uploaded") {
      f.db.afterStatement = null; throw new Error("synthetic lost durable receipt checkpoint");
    }
  };
  await assert.rejects(service.completeMultipartUpload({ operationId: id }), { code: "WRITE_OUTCOME_UNKNOWN" });
  assert.equal((await service.operation({ operationId: id })).phase, "uploaded");
  assert.deepEqual([allocations, transfers, commits], [1, 1, 0]);
  assert.equal((await service.completeMultipartUpload({ operationId: id })).phase, "confirmed");
  assert.equal((await service.completeMultipartUpload({ operationId: id })).phase, "confirmed");
  assert.deepEqual([allocations, transfers, commits], [1, 1, 1]);
  assert.equal(bucket.objects.size, 0);
  const uncertain = await stage("staged-uncertain.txt"); loseTransfer = true;
  await assert.rejects(service.completeMultipartUpload({ operationId: uncertain }), { code: "WRITE_OUTCOME_UNKNOWN" });
  await assert.rejects(service.completeMultipartUpload({ operationId: uncertain }), { code: "WRITE_OUTCOME_UNKNOWN" });
  assert.deepEqual([allocations, transfers, commits], [2, 2, 1]);
  assert.equal(bucket.objects.size, 1);
  assert.equal((await service.discardMultipartUpload({ operationId: uncertain })).phase, "unknown");
  assert.equal(bucket.objects.size, 0);
  assert.equal((await service.operation({ operationId: uncertain })).phase, "unknown");
  await assert.rejects(service.completeMultipartUpload({ operationId: uncertain }), { code: "CONFLICT" });
  assert.deepEqual([allocations, transfers, commits], [2, 2, 1]);
});

test("multipart requires private R2 while existing direct preparation remains available without it", async t => {
  let requests = 0;
  const f = await fixture(t, () => { requests++; return json([{ ...root, items: [], directChildrenCount: 0 }]); });
  const input = await uploadInput("synthetic-binding.txt");
  const metadata = Object.fromEntries(Object.entries(input).filter(([key]) => key !== "contentBase64"));
  await assert.rejects(f.service.prepareMultipartUpload(metadata), { code: "CONFIGURATION_REQUIRED" });
  assert.equal(requests, 0);
  assert.equal((await f.service.prepareUpload(metadata)).operationId, input.operationId);
});

test("inline read boundaries and text previews preserve UTF-8 and cancel unread bytes", async t => {
  let payload = new Uint8Array(64 * 1024).fill(65);
  let forwardedBytes = 0, cancelled = false, requests = 0;
  const f = await fixture(t, url => {
    requests++;
    if (url.pathname === "/retrieveItemDetails") return json({ items: [file("preview.txt", "preview", DRIVE_ROOT, payload.length)] });
    if (url.pathname.endsWith("/download/by_id")) return json({ data_token: { url: syntheticDownloadURL() } });
    if (url.hostname !== "cvws.icloud-content.com") throw new Error("No upload request should be sent for an oversized inline file");
    let offset = 0;
    forwardedBytes = 0; cancelled = false;
    return new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset === payload.length) { controller.close(); return; }
        const chunk = payload.subarray(offset, offset + 4096);
        offset += chunk.length; forwardedBytes += chunk.length; controller.enqueue(chunk);
      },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 }));
  });
  const full = await f.service.read({ itemId: file("preview.txt", "preview").drivewsid });
  assert.equal(full.bytesRead, 64 * 1024); assert.equal(full.content.length, 64 * 1024); assert.equal(full.truncated, false);
  payload = new Uint8Array(64 * 1024 + 1).fill(65);
  await assert.rejects(f.service.read({ itemId: full.item.id }), error => (error as Error).message.includes("previewBytes") && (error as Error).message.includes("Download"));
  const preview = await f.service.read({ itemId: full.item.id, previewBytes: 8192 });
  assert.equal(preview.bytesRead, 8192); assert.equal(preview.content.length, 8192); assert.equal(preview.truncated, true);
  assert.equal(cancelled, true); assert.ok(forwardedBytes < payload.length);
  const beforeInvalid = requests;
  await assert.rejects(f.service.read({ itemId: full.item.id, previewBytes: 8193 }), { code: "VALIDATION_ERROR" });
  await assert.rejects(f.service.read({ itemId: full.item.id, previewBytes: 8, encoding: "base64" }), { code: "VALIDATION_ERROR" });
  await assert.rejects(f.service.upload(await uploadInput("too-large.txt", payload)), error => (error as Error).message.includes("64 KiB") && (error as Error).message.includes("dashboard Upload"));
  assert.equal(requests, beforeInvalid);
  payload = new TextEncoder().encode("abc€suffix");
  const splitCharacter = await f.service.read({ itemId: full.item.id, previewBytes: 5 });
  assert.equal(splitCharacter.content, "abc"); assert.equal(splitCharacter.bytesRead, 5); assert.equal(splitCharacter.truncated, true);
  payload = new Uint8Array();
  const empty = await f.service.read({ itemId: full.item.id, previewBytes: 8192 });
  assert.equal(empty.content, ""); assert.equal(empty.bytesRead, 0); assert.equal(empty.truncated, false);
});

test("download handles are scoped and single use, pin exact versions, and deliver attachment content without cookies", async t => {
  const current = file("<résumé>.html");
  let downloads = 0, prepared = 0;
  const f = await fixture(t, (url, init) => {
    if (url.pathname === "/retrieveItemDetails") return json([{ ...current }]);
    if (url.pathname.endsWith("/download/by_id")) { prepared++; return json({ data_token: { url: syntheticDownloadURL() } }); }
    downloads++;
    assert.equal(new Headers(init.headers).has("cookie"), false);
    return new Response(new TextEncoder().encode("abc"), { headers: { "Content-Type": "text/html", "Set-Cookie": "evil=synthetic", "Location": "https://example.invalid" } });
  });
  const handle = await f.service.download({ itemId: current.drivewsid });
  assert.equal(handle.url, `/api/drive/downloads/${handle.handleId}`);
  assert.equal(JSON.stringify(handle).includes("icloud-content"), false);
  f.db.sqlite.prepare("UPDATE drive_handles SET generation = generation + 1 WHERE handle_id = ?").run(handle.handleId);
  await assert.rejects(f.service.downloadContent(handle.handleId), { code: "CONFLICT" });
  f.db.sqlite.prepare("UPDATE drive_handles SET generation = generation - 1 WHERE handle_id = ?").run(handle.handleId);
  const response = await f.service.downloadContent(handle.handleId);
  assert.match(response.headers.get("content-disposition")!, /^attachment;.*filename\*=UTF-8''%3Cr%C3%A9sum%C3%A9%3E.html$/);
  assert.equal(response.headers.get("set-cookie"), null);
  assert.equal(await response.text(), "abc");
  await assert.rejects(f.service.downloadContent(handle.handleId), { code: "CONFLICT" });
  assert.deepEqual([prepared, downloads], [1, 1]);
  const stale = await f.service.download({ itemId: current.drivewsid });
  current.etag = "changed-version";
  await assert.rejects(f.service.downloadContent(stale.handleId), { code: "CONFLICT" });
  assert.deepEqual([prepared, downloads], [1, 1]);
  assert.throws(() => new DriveService(f.env, "other-owner"), { code: "FORBIDDEN" });
});

test("streaming permission changes and bad digests prevent upload finalization and download byte release", async t => {
  let finalize = 0, disableDuringUpload = false;
  const f = await fixture(t, async (url, init) => {
    if (["/retrieveItemDetailsInFolders", "/retrieveItemDetails"].includes(url.pathname)) {
      const payload = JSON.parse(String(init.body));
      const lookup = Array.isArray(payload) ? payload[0] : payload;
      const { drivewsid } = lookup.items?.[0] ?? lookup;
      return json([drivewsid === DRIVE_ROOT ? { ...root, items: [], directChildrenCount: 0 } : file("note.txt", "synthetic-file", DRIVE_ROOT, 3)]);
    }
    if (url.pathname.endsWith("/upload/web")) return json([{ document_id: "streamed-upload", url: "https://p01-contentws.icloud.com/123456789/singleFileUpload?tk=synthetic-stream-token" }]);
    if (url.hostname === "p01-contentws.icloud.com") {
      if (disableDuringUpload) {
        const saved = await f.settings.load();
        await f.settings.save({ expectedRevision: saved.revision, settings: { ...saved.settings, drive: { ...saved.settings.drive, upload: false } } });
      }
      await drain(init.body as ReadableStream<Uint8Array>);
      return json({ singleFile: { referenceChecksum: "synthetic-ref", size: 3, fileChecksum: "synthetic-sum", wrappingKey: "synthetic-key" } });
    }
    if (url.pathname.endsWith("/update/documents")) { finalize++; throw new Error("Finalization must not run"); }
    if (url.pathname.endsWith("/download/by_id")) return json({ data_token: { url: syntheticDownloadURL() } });
    return new Response(new ReadableStream<Uint8Array>({ async pull(controller) {
      const saved = await f.settings.load();
      await f.settings.save({ expectedRevision: saved.revision, settings: { ...saved.settings, drive: { ...saved.settings.drive, contents: false } } });
      controller.enqueue(new TextEncoder().encode("abc")); controller.close();
    } }, { highWaterMark: 0 }));
  });
  const input = await uploadInput("digest.txt");
  const metadata = Object.fromEntries(Object.entries(input).filter(([key]) => key !== "contentBase64"));
  await f.service.prepareUpload(metadata);
  await assert.rejects(f.service.uploadContent(input.operationId, stream(new TextEncoder().encode("bad"))), { code: "VALIDATION_ERROR" });
  assert.equal(finalize, 0);
  const cancelled = await uploadInput("cancelled.txt");
  await f.service.prepareUpload(Object.fromEntries(Object.entries(cancelled).filter(([key]) => key !== "contentBase64")));
  const abort = new AbortController(); abort.abort();
  await assert.rejects(f.service.uploadContent(cancelled.operationId, stream(new TextEncoder().encode("abc")), abort.signal));
  assert.equal(finalize, 0);
  const changed = await uploadInput("permission.txt");
  const changedMetadata = Object.fromEntries(Object.entries(changed).filter(([key]) => key !== "contentBase64"));
  await f.service.prepareUpload(changedMetadata);
  disableDuringUpload = true;
  await assert.rejects(f.service.uploadContent(changed.operationId, stream(new TextEncoder().encode("abc"))), { code: "FORBIDDEN" });
  assert.equal(finalize, 0);
  const handle = await f.service.download({ itemId: file().drivewsid });
  const response = await f.service.downloadContent(handle.handleId);
  await assert.rejects(response.arrayBuffer(), { code: "FORBIDDEN" });
  assert.equal(finalize, 0);
});

test("a fragmented 10 GiB download uses byte windows without buffer copies or exceeding D1's query budget", async t => {
  const current = file("synthetic-maximum.bin", "maximum", DRIVE_ROOT, DRIVE_FILE_BYTES);
  const fragment = new Uint8Array(64 * 1024);
  let remaining = DRIVE_FILE_BYTES;
  const f = await fixture(t, url => {
    if (url.pathname === "/retrieveItemDetails") return json({ items: [current] });
    if (url.pathname.endsWith("/download/by_id")) return json({ data_token: { url: syntheticDownloadURL() } });
    return new Response(new ReadableStream<Uint8Array>({ pull(controller) {
      if (!remaining) { controller.close(); return; }
      const length = Math.min(fragment.length, remaining); remaining -= length;
      controller.enqueue(fragment.subarray(0, length));
    } }, { highWaterMark: 0 }));
  });
  const handle = await f.service.download({ itemId: current.drivewsid });
  let queries = 0, count = 0;
  f.db.afterStatement = async () => { assert.ok(++queries <= 1000, "D1 queries per download invocation"); };
  const response = await f.service.downloadContent(handle.handleId), reader = response.body!.getReader();
  for (;;) {
    const next = await reader.read(); if (next.done) break;
    assert.ok(next.value.length <= DRIVE_TRANSFER_BLOCK_BYTES);
    assert.equal(next.value.buffer, fragment.buffer, "Forward source slices without aggregate buffer copies");
    count += next.value.length;
  }
  reader.releaseLock();
  assert.equal(count, DRIVE_FILE_BYTES); assert.equal(remaining, 0);
  assert.ok(queries >= Math.ceil(DRIVE_FILE_BYTES / DRIVE_TRANSFER_BLOCK_BYTES) && queries < 1000);
});

test("transfer fencing revalidates a changed session and stops before releasing a revoked block", async t => {
  const current = file("synthetic-blocks.bin", "blocks", DRIVE_ROOT, DRIVE_TRANSFER_BLOCK_BYTES * 2);
  let offset = 0;
  const f = await fixture(t, url => {
    if (url.pathname === "/retrieveItemDetails") return json({ items: [current] });
    if (url.pathname.endsWith("/download/by_id")) return json({ data_token: { url: syntheticDownloadURL() } });
    return new Response(new ReadableStream<Uint8Array>({ pull(controller) {
      if (offset === current.size) { controller.close(); return; }
      offset += DRIVE_TRANSFER_BLOCK_BYTES; controller.enqueue(new Uint8Array(DRIVE_TRANSFER_BLOCK_BYTES));
    } }, { highWaterMark: 0 }));
  });
  const handle = await f.service.download({ itemId: current.drivewsid });
  const response = await f.service.downloadContent(handle.handleId), reader = response.body!.getReader();
  assert.equal((await reader.read()).value!.length, DRIVE_TRANSFER_BLOCK_BYTES);
  // A benign metadata operation changes the session version, not its account.
  await f.service.get({ itemId: current.drivewsid });
  const saved = await f.sessions.load(), fence = await f.sessions.claimRenewal(saved.fence.generation, saved.fence.version);
  await f.sessions.commitResume(fence, { ...saved.session, services: { ...saved.session.services!, drive: { state: "DEVICE_APPROVAL_PENDING", connection, pcs: saved.session.pcs, action: "approve-device-consent" } } }, saved.state, saved.action ?? undefined);
  await assert.rejects(reader.read(), { code: "DEVICE_APPROVAL_PENDING" });
  reader.releaseLock();
});

test("cancellation or expiry during a transfer fence query cannot release its buffered bytes", async t => {
  const f = await fixture(t, url => {
    if (url.pathname === "/retrieveItemDetails") return json({ items: [file()] });
    if (url.pathname.endsWith("/download/by_id")) return json({ data_token: { url: syntheticDownloadURL() } });
    return new Response("abc");
  });
  const abort = new AbortController(), handle = await f.service.download({ itemId: file().drivewsid });
  const response = await f.service.downloadContent(handle.handleId, abort.signal);
  f.db.afterStatement = async sql => {
    if (sql.includes("FROM apple_session_state a LEFT JOIN")) abort.abort(new Error("synthetic fence cancellation"));
  };
  await assert.rejects(response.arrayBuffer(), /synthetic fence cancellation/);
  f.db.afterStatement = null;
  const expiry = (await f.sessions.load()).session.login.expiresAt;
  const fresh = await f.service.download({ itemId: file().drivewsid }), expired = await f.service.downloadContent(fresh.handleId);
  let clock = Date.now();
  t.mock.method(Date, "now", () => clock);
  f.db.afterStatement = async sql => {
    if (sql.includes("FROM apple_session_state a LEFT JOIN")) clock = expiry;
  };
  await assert.rejects(expired.arrayBuffer(), { code: "AUTH_EXPIRED" });
});

test("expiry and cancellation stop small fragments inside an already authorized byte window", async t => {
  const f = await fixture(t, url => {
      if (url.pathname === "/retrieveItemDetails") return json({ items: [file()] });
      if (url.pathname.endsWith("/download/by_id")) return json({ data_token: { url: syntheticDownloadURL() } });
      return new Response(new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array([1])); } }, { highWaterMark: 0 }));
  });
  for (const kind of ["expiry", "abort"] as const) {
    const abort = new AbortController();
    const handle = await f.service.download({ itemId: file().drivewsid });
    const response = await f.service.downloadContent(handle.handleId, abort.signal), reader = response.body!.getReader();
    assert.equal((await reader.read()).value!.length, 1);
    if (kind === "abort") abort.abort(new Error("Synthetic fragment cancellation"));
    else {
      const expiry = (await f.sessions.load()).session.login.expiresAt;
      t.mock.method(Date, "now", () => expiry);
    }
    await assert.rejects(reader.read(), kind === "abort" ? /Synthetic fragment cancellation/ : { code: "AUTH_EXPIRED" });
    reader.releaseLock();
    t.mock.restoreAll();
  }
});

test("search uses bounded selected-tree continuations and refuses stale scope and filename collisions", async t => {
  let folderReads = 0;
  const folders = [1, 2, 3, 4].map(id => ({ drivewsid: `FOLDER::com.apple.CloudDocs::folder-${id}`, docwsid: `folder-${id}`, zone: "com.apple.CloudDocs", name: `Folder ${id}`, type: "FOLDER", etag: "folder-version", parentId: DRIVE_ROOT }));
  const f = await fixture(t, (url, init) => {
    assert.equal(url.pathname, "/retrieveItemDetailsInFolders");
    folderReads++;
    const [{ drivewsid }] = JSON.parse(String(init.body));
    const selected = folders.find(item => item.drivewsid === drivewsid);
    return json([drivewsid === DRIVE_ROOT ? { ...root, items: folders, directChildrenCount: folders.length } : { ...selected, items: [file("match.txt", `file-${selected!.docwsid}`, selected!.drivewsid)], directChildrenCount: 1 }]);
  });
  const first = await f.service.search({ query: "match" });
  assert.equal(folderReads, 3);
  assert.equal(first.items.length, 2);
  assert.equal(first.complete, false);
  assert.deepEqual(first.reasons, ["continuation_required"]);
  assert.equal(first.scope, "selected-folder-tree");
  const next = await f.service.search({ query: "match", continuation: first.continuation });
  assert.equal(folderReads, 5);
  assert.equal(next.items.length, 2);
  assert.equal(next.complete, true);
  assert.deepEqual(next.reasons, []);
  await assert.rejects(f.service.search({ query: "match", continuation: first.continuation }), { code: "CONFLICT" });
  await assert.rejects(f.service.createFolder({ operationId: crypto.randomUUID(), parentId: DRIVE_ROOT, name: "folder 1" }), { code: "CONFLICT" });
  const scoped = await f.service.search({ query: "match" });
  await assert.rejects(f.service.search({ query: "different", continuation: scoped.continuation }), { code: "CONFLICT" });
});

test("recursive traversal pages beyond 1000 items without rereading folders, survives cold clients and filters names", async t => {
  const folders = [0, 1, 2].map(index => ({ ...root, drivewsid: `FOLDER::com.apple.CloudDocs::wide-${index}`, docwsid: `wide-${index}`, name: `Folder ${index}`, parentId: DRIVE_ROOT }));
  const reads = new Map<string, number>();
  const f = await fixture(t, (_url, init) => {
    const [{ drivewsid }] = JSON.parse(String(init.body));
    reads.set(drivewsid, (reads.get(drivewsid) ?? 0) + 1);
    const folder = folders.find(item => item.drivewsid === drivewsid);
    const children = folder ? Array.from({ length: 600 }, (_, index) => file(`Match-${index}.txt`, `${folder.docwsid}-${index}`, folder.drivewsid)) : folders;
    return json([{ ...(folder ?? root), items: children, directChildrenCount: children.length }]);
  });
  const input = { limit: 150, maxItems: 5000 };
  let page = await f.service.traverse(input);
  assert.equal(page.items.length, 150);
  assert.equal(page.items[3]!.relativePath, "Folder 0/Match-0.txt");
  assert.equal(page.items[3]!.depth, 2);
  const first = page.continuation!;
  const before = [...reads];
  await assert.rejects(f.service.traverse({ ...input, query: "changed", continuation: first }), { code: "CONFLICT" });
  assert.deepEqual([...reads], before);
  const stored = f.db.sqlite.prepare("SELECT envelope FROM drive_handles WHERE handle_id = ?").get(first)!.envelope as string;
  assert.equal(stored.includes("Match-"), false);
  const items = [...page.items];
  while (page.continuation) {
    const previous = page.continuation;
    page = await new DriveService(f.env, owner).traverse({ ...input, continuation: previous });
    TraversalResult.parse(page);
    items.push(...page.items);
    assert.ok(page.foldersRead <= 3);
    assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) AS count FROM drive_handles WHERE kind = 'traversal'").get()!.count, page.continuation ? 1 : 0);
  }
  assert.equal(page.complete, true);
  assert.deepEqual(page.progress, { visited: 1803, foldersVisited: 4, returned: 1803, queuedFolders: 0 });
  assert.equal(new Set(items.map(item => item.id)).size, 1803);
  assert.deepEqual([...reads.values()], [1, 1, 1, 1]);
  await assert.rejects(f.service.traverse({ ...input, continuation: first }), { code: "CONFLICT" });
  reads.clear();
  let filtered = await f.service.traverse({ query: "mAtCh-599" });
  const matches = [...filtered.items];
  while (filtered.continuation) { filtered = await f.service.traverse({ query: "mAtCh-599", continuation: filtered.continuation }); matches.push(...filtered.items); }
  assert.equal(filtered.complete, true);
  assert.equal(matches.length, 3);
  assert.equal(filtered.progress.visited, 1803);
  assert.deepEqual([...reads.values()], [1, 1, 1, 1]);
  const stale = await f.service.traverse(input);
  const settings = await f.settings.load();
  await f.settings.save({ expectedRevision: settings.revision, settings: settings.settings });
  const dispatches = [...reads];
  await assert.rejects(f.service.traverse({ ...input, continuation: stale.continuation }), { code: "CONFLICT" });
  assert.deepEqual([...reads], dispatches);
});

test("recursive traversal explains item, folder and depth limits and upstream omissions, with cycle-safe walking", async t => {
  const folders = ["a", "b"].map(name => ({ ...root, name, drivewsid: `FOLDER::com.apple.CloudDocs::${name}`, docwsid: name, parentId: DRIVE_ROOT }));
  const f = await fixture(t, (_url, init) => {
    const [{ drivewsid }] = JSON.parse(String(init.body));
    const folder = folders.find(item => item.drivewsid === drivewsid);
    const items = folder ? [file("leaf.txt", `leaf-${folder.docwsid}`, folder.drivewsid), root] : folders;
    return json([{ ...(folder ?? root), items, directChildrenCount: items.length + (folder ? 1 : 0) }]);
  });
  const depth = await f.service.traverse({ maxDepth: 1 });
  assert.equal(depth.items.length, 2); assert.equal(depth.continuation, null);
  assert.deepEqual(depth.reasons, ["traversal_depth_limit"]);
  const width = await f.service.traverse({ maxFolders: 1 });
  assert.deepEqual(width.reasons, ["traversal_folder_limit"]);
  const limited = await f.service.traverse({ maxItems: 1, limit: 1 });
  assert.deepEqual(limited.reasons, ["traversal_item_limit"]); assert.equal(limited.continuation, null);
  const all = await f.service.traverse({});
  assert.equal(all.continuation, null); assert.equal(all.progress.foldersVisited, 3);
  assert.equal(all.incompleteFolders.length, 2);
  assert.deepEqual(all.reasons, ["upstream_count_mismatch"]);
  assert.equal(all.complete, false);
  await assert.rejects(f.service.traverse({ query: "" }), { code: "VALIDATION_ERROR" });
  await assert.rejects(f.service.traverse({ maxItems: 100_001 }), { code: "VALIDATION_ERROR" });
});

test("recursive traversal keeps the cursor after a failed Apple read or session checkpoint", async t => {
  const folders = [0, 1, 2, 3].map(index => ({ ...root, name: `Folder ${index}`, drivewsid: `FOLDER::com.apple.CloudDocs::resume-${index}`, docwsid: `resume-${index}`, parentId: DRIVE_ROOT }));
  let fail = false;
  const f = await fixture(t, (_url, init) => {
    const [{ drivewsid }] = JSON.parse(String(init.body));
    if (fail && drivewsid === folders[2]!.drivewsid) return new Response(null, { status: 400 });
    return json([{ ...(folders.find(item => item.drivewsid === drivewsid) ?? root), items: drivewsid === DRIVE_ROOT ? folders : [], directChildrenCount: drivewsid === DRIVE_ROOT ? 4 : 0 }]);
  });
  const first = await f.service.traverse({ query: "absent" });
  assert.equal(first.items.length, 0); assert.ok(first.continuation);
  fail = true;
  await assert.rejects(f.service.traverse({ query: "absent", continuation: first.continuation }));
  assert.ok(f.db.sqlite.prepare("SELECT 1 FROM drive_handles WHERE handle_id = ?").get(first.continuation));
  fail = false;
  f.db.afterStatement = async sql => {
    if (sql.startsWith("UPDATE apple_session_state SET version = version + 1, state")) {
      f.db.afterStatement = null;
      throw new Error("synthetic session checkpoint acknowledgement failure");
    }
  };
  await assert.rejects(f.service.traverse({ query: "absent", continuation: first.continuation }), /checkpoint acknowledgement/);
  assert.ok(f.db.sqlite.prepare("SELECT 1 FROM drive_handles WHERE handle_id = ?").get(first.continuation));
  const final = await new DriveService(f.env, owner).traverse({ query: "absent", continuation: first.continuation });
  assert.equal(final.complete, true); assert.equal(final.progress.foldersVisited, 5);
  const expired = await f.service.traverse({ query: "absent" });
  f.db.sqlite.prepare("UPDATE drive_handles SET expires_at = 0 WHERE handle_id = ?").run(expired.continuation!);
  await assert.rejects(f.service.traverse({ query: "absent", continuation: expired.continuation }), { code: "CONFLICT" });
});

test("recursive traversal bounds encrypted checkpoint growth for very wide trees with long paths", async t => {
  const f = await fixture(t, (_url, init) => {
    const [{ drivewsid }] = JSON.parse(String(init.body));
    const doc = drivewsid.split("::")[2];
    const children = Array.from({ length: 500 }, (_, index) => ({ ...root, drivewsid: `FOLDER::com.apple.CloudDocs::${doc}-${index}`, docwsid: `${doc}-${index}`, parentId: drivewsid, name: `${index}-`.padEnd(255, "x") }));
    return json([{ ...root, drivewsid, docwsid: doc, items: children, directChildrenCount: children.length }]);
  });
  const page = await f.service.traverse({ query: "absent", maxFolders: 5000, maxItems: 100_000 });
  assert.equal(page.continuation, null);
  assert.equal(page.complete, false);
  assert.deepEqual(page.reasons, ["traversal_state_limit"]);
  assert.equal(page.progress.visited, 1500);
  assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) AS count FROM drive_handles WHERE kind = 'traversal'").get()!.count, 0);
});

test("active recursive traversal retains queued shared contexts beyond their original inactivity deadline", async t => {
  const owned = Array.from({ length: 8 }, (_, index) => ({ ...root, drivewsid: `FOLDER::com.apple.CloudDocs::owned-${index}`, docwsid: `owned-${index}`, name: `Owned ${index}`, parentId: DRIVE_ROOT }));
  const shared = { ...root, drivewsid: "FOLDER::com.apple.CloudDocs::delayed-share", docwsid: "delayed-share", name: "Shared", parentId: DRIVE_ROOT, shareID: { recordName: "synthetic-delayed-share" } };
  const clock = Date.now, began = clock();
  try {
    Date.now = () => began;
    const f = await fixture(t, (_url, init) => {
      const [entry] = JSON.parse(String(init.body));
      const folder = [...owned, shared].find(item => item.drivewsid === entry.drivewsid);
      if (folder === shared) assert.deepEqual(entry.shareID, shared.shareID);
      const children = entry.drivewsid === DRIVE_ROOT ? [...owned, shared] : folder === shared ? [file("match.txt", "shared-leaf", shared.drivewsid)] : [];
      return json([{ ...(folder ?? root), items: children, directChildrenCount: children.length }]);
    });
    let page = await f.service.traverse({ query: "match" });
    assert.ok(page.continuation);
    for (const minutes of [5, 11, 16]) {
      Date.now = () => began + minutes * 60_000;
      page = await new DriveService(f.env, owner).traverse({ query: "match", continuation: page.continuation });
    }
    assert.equal(page.complete, true);
    assert.equal(page.items[0]!.relativePath, "Shared/match.txt");
    assert.equal(page.progress.foldersVisited, 10);
  } finally { Date.now = clock; }
});

test("folder path resolution walks named parents, supports shares, and explains malformed shared entries", async t => {
  const names = ["Documents", "Snap Heaven", "01", "FY 2026"];
  const folders = names.map((name, index) => ({ ...root, drivewsid: `FOLDER::com.apple.CloudDocs::path-${index}`, docwsid: `path-${index}`, name, parentId: index ? `FOLDER::com.apple.CloudDocs::path-${index - 1}` : DRIVE_ROOT }));
  const reads: string[] = [];
  let shared: false | "valid" | "invalid" = false, missing = false;
  const f = await fixture(t, (url, init) => {
    assert.equal(url.pathname, "/retrieveItemDetailsInFolders");
    const [{ drivewsid }] = JSON.parse(String(init.body));
    reads.push(drivewsid);
    const index = drivewsid === DRIVE_ROOT ? -1 : folders.findIndex(item => item.drivewsid === drivewsid);
    const parent = index < 0 ? root : folders[index]!;
    const child = folders[index + 1]!;
    return json([{ ...parent, directChildrenCount: 1, items: missing && index === 0 ? [] : [{ ...child, ...(shared && index === 0 ? { shareID: shared === "valid" ? { recordName: "synthetic-share" } : [] } : {}) }] }]);
  });
  const resolved = await f.service.resolveFolderPath({ path: "Documents/Snap Heaven/01/FY 2026", expectedGeneration: f.generation });
  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.folder?.id, folders[3]!.drivewsid);
  assert.equal(resolved.resolvedPath, names.join("/"));
  assert.equal(resolved.foldersRead, 4);
  assert.deepEqual(reads, [DRIVE_ROOT, ...folders.slice(0, 3).map(item => item.drivewsid)]);
  assert.equal(resolved.generation, f.generation);
  reads.length = 0;
  const relative = await f.service.resolveFolderPath({ folderId: folders[0]!.drivewsid, path: "snap heaven/01/fy 2026" });
  assert.equal(relative.status, "resolved");
  assert.equal(relative.resolvedPath, names.slice(1).join("/"));
  assert.equal(reads.length, 3);
  shared = "valid";
  const sharedPath = await f.service.resolveFolderPath({ path: names.join("/") });
  assert.equal(sharedPath.status, "resolved");
  assert.ok(sharedPath.folder?.shareContext);
  shared = "invalid";
  reads.length = 0;
  const excluded = await f.service.resolveFolderPath({ path: names.join("/") });
  assert.equal(excluded.status, "unresolved");
  assert.equal(excluded.resolvedPath, "Documents");
  assert.deepEqual(excluded.remainingSegments, names.slice(1));
  assert.deepEqual(excluded.parentListing.reasons, ["excluded_shared_entries"]);
  assert.equal(excluded.parentListing.counts.excludedShared, 1);
  assert.equal(reads.length, 2);
  missing = true;
  const omitted = await f.service.resolveFolderPath({ path: names.join("/") });
  assert.equal(omitted.status, "unresolved");
  assert.deepEqual(omitted.parentListing.reasons, ["upstream_count_mismatch"]);
  const before = reads.length;
  await assert.rejects(f.service.resolveFolderPath({ path: "Documents/../child" }), { code: "VALIDATION_ERROR" });
  await assert.rejects(f.service.resolveFolderPath({ path: "Documents", expectedGeneration: f.generation + 1 }), { code: "CONFLICT" });
  assert.equal(reads.length, before);
  const saved = await f.settings.load();
  await f.settings.save({ expectedRevision: saved.revision, settings: { ...saved.settings, drive: { ...saved.settings.drive, enabled: false } } });
  await assert.rejects(f.service.resolveFolderPath({ path: "Documents" }), { code: "FORBIDDEN" });
  assert.equal(reads.length, before);
});

test("large parent diagnostics survive search continuations and block resolution and upload allocation", async t => {
  let reads = 0;
  const children = Array.from({ length: 1001 }, (_, index) => file(`match-${index}.txt`, `large-${index}`));
  const f = await fixture(t, url => {
    assert.equal(url.pathname, "/retrieveItemDetailsInFolders", "an incomplete destination must never reach allocation");
    reads++;
    return json([{ ...root, directChildrenCount: 1001, items: children }]);
  });
  let result = await f.service.search({ query: "match" });
  let matches = result.items.length;
  assert.deepEqual(result.reasons, ["item_limit", "continuation_required"]);
  while (result.continuation) {
    result = await f.service.search({ query: "match", continuation: result.continuation });
    matches += result.items.length;
  }
  assert.equal(matches, 1000);
  assert.equal(result.complete, false);
  assert.deepEqual(result.reasons, ["item_limit"]);
  assert.equal(result.incompleteFolders.length, 1);
  assert.equal(result.incompleteFolders[0]?.counts.unprocessed, 1);
  assert.equal(reads, 1, "continuing only drains the discovered items; no guessed upstream pagination");
  const unresolved = await f.service.resolveFolderPath({ path: "Documents/Snap Heaven" });
  assert.equal(unresolved.status, "unresolved");
  assert.deepEqual(unresolved.parentListing.reasons, ["item_limit"]);
  const metadata = Object.fromEntries(Object.entries(await uploadInput("new.txt")).filter(([key]) => key !== "contentBase64"));
  await assert.rejects(f.service.prepareUpload(metadata), error => (error as Error).message.includes("destination listing is incomplete"));
  assert.equal(reads, 3);
});

test("search explains an exhausted tree budget separately from incomplete folder listings", async t => {
  const folders = Array.from({ length: 1000 }, (_, i) => ({ ...root, drivewsid: `FOLDER::com.apple.CloudDocs::budget-${i}`, docwsid: `budget-${i}`, name: `Folder ${i}`, parentId: DRIVE_ROOT }));
  const f = await fixture(t, () => json([{ ...root, directChildrenCount: 1000, items: folders }]));
  const result = await f.service.search({ query: "absent" });
  assert.equal(result.continuation, null);
  assert.equal(result.complete, false);
  assert.deepEqual(result.reasons, ["search_item_limit"]);
  assert.deepEqual(result.incompleteFolders, []);
});

test("shared folders remain scoped through nested paths, cold clients, search continuations and downloads", async t => {
  const descriptor = { recordName: "synthetic-share-record", zoneID: { zoneName: "com.apple.CloudDocs", ownerRecordName: "synthetic-share-owner" } };
  const shareRoot = { ...root, drivewsid: "FOLDER::com.apple.CloudDocs::shared-root", docwsid: "shared-root", name: "Snap Heaven", parentId: DRIVE_ROOT, shareID: descriptor, owner: { ownerRecordName: "synthetic-share-owner" } };
  const nested = ["01", "FY 2026", "Reports"].map((name, i) => ({ ...root, drivewsid: `FOLDER_IN_SHARED_FOLDER::com.apple.CloudDocs::shared-${i}`, docwsid: `shared-${i}`, name, parentId: i ? `FOLDER_IN_SHARED_FOLDER::com.apple.CloudDocs::shared-${i - 1}` : shareRoot.drivewsid }));
  const sharedFile = { ...file("budget.txt", "shared-file", nested[2]!.drivewsid), drivewsid: "FILE_IN_SHARED_FOLDER::com.apple.CloudDocs::shared-file" };
  let calls = 0, downloads = 0;
  const f = await fixture(t, (url, init) => {
    calls++;
    if (url.hostname === "cvws.icloud-content.com") { downloads++; return new Response(new TextEncoder().encode("abc")); }
    if (url.pathname === "/ws/com.apple.CloudDocs/download/by_id/synthetic-share-owner") {
      assert.equal(url.searchParams.get("document_id"), sharedFile.docwsid);
      return json({ document_id: sharedFile.docwsid, data_token: { url: syntheticDownloadURL() } });
    }
    assert.ok(["/retrieveItemDetailsInFolders", "/retrieveItemDetails"].includes(url.pathname), "shared reads must never send a mutation");
    const body = JSON.parse(String(init.body));
    const entry = Array.isArray(body) ? body[0] : body.items[0];
    if (entry.drivewsid === DRIVE_ROOT) return json([{ ...root, items: [shareRoot], directChildrenCount: 1 }]);
    if (entry.drivewsid === shareRoot.drivewsid) {
      if (entry.shareID) assert.deepEqual(entry.shareID, descriptor);
      return json([{ ...shareRoot, items: [nested[0]], directChildrenCount: 1 }]);
    }
    assert.deepEqual(entry.shareID, descriptor, "Apple does not repeat shareID below the root; the client must inherit it");
    if (entry.drivewsid === sharedFile.drivewsid) return json({ items: [sharedFile] });
    const index = nested.findIndex(folder => folder.drivewsid === entry.drivewsid);
    assert.ok(index >= 0);
    return json([{ ...nested[index], items: [index === 2 ? sharedFile : nested[index + 1]], directChildrenCount: 1 }]);
  });
  const listed = await f.service.list({});
  assert.equal(listed.complete, true);
  assert.deepEqual(listed.reasons, []);
  const ref = listed.items[0]!;
  assert.ok(ref.shareContext);
  assert.ok(!JSON.stringify(listed).includes("synthetic-share-owner"));
  assert.ok(!JSON.stringify(listed).includes("synthetic-share-record"));
  const resolved = await f.service.resolveFolderPath({ path: "Snap Heaven/01/FY 2026" });
  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.folder?.id, nested[1]!.drivewsid);
  assert.equal(resolved.folder?.shareContext, ref.shareContext);
  const cold = new DriveService(f.env, owner);
  const childListing = await cold.list({ folderId: nested[1]!.drivewsid, shareContext: ref.shareContext });
  assert.equal(childListing.items[0]?.shareContext, ref.shareContext);
  const search = await f.service.search({ query: "budget" });
  assert.ok(search.continuation);
  const continued = await cold.search({ query: "budget", continuation: search.continuation });
  assert.equal(continued.complete, true);
  assert.equal(continued.items[0]?.id, sharedFile.drivewsid);
  assert.equal(continued.items[0]?.shareContext, ref.shareContext);
  const read = await cold.read({ itemId: sharedFile.drivewsid, shareContext: ref.shareContext });
  assert.equal(read.content, "abc");
  const prepared = await cold.download({ itemId: sharedFile.drivewsid, shareContext: ref.shareContext });
  assert.equal(await (await new DriveService(f.env, owner).downloadContent(prepared.handleId)).text(), "abc");
  assert.equal(downloads, 2);
  const before = calls;
  await assert.rejects(cold.list({ folderId: nested[0]!.drivewsid }), { code: "VALIDATION_ERROR" });
  await assert.rejects(cold.list({ folderId: nested[0]!.drivewsid, shareContext: crypto.randomUUID() }), { code: "CONFLICT" });
  await assert.rejects(cold.rename({ itemId: nested[0]!.drivewsid, etag: "root-version", name: "refused", operationId: crypto.randomUUID() }), { code: "VALIDATION_ERROR" });
  assert.equal(calls, before);
  await assert.rejects(cold.rename({ itemId: ref.id, etag: ref.etag, name: "refused", operationId: crypto.randomUUID() }), { code: "UNSUPPORTED_FEATURE" });
  const metadata = Object.fromEntries(Object.entries(await uploadInput("refused.txt")).filter(([key]) => key !== "contentBase64"));
  await assert.rejects(cold.prepareUpload({ ...metadata, parentId: ref.id }), { code: "UNSUPPORTED_FEATURE" });
  const saved = await f.settings.load();
  await f.settings.save({ expectedRevision: saved.revision, settings: saved.settings });
  const scopedBefore = calls;
  await assert.rejects(cold.list({ folderId: nested[0]!.drivewsid, shareContext: ref.shareContext }), { code: "CONFLICT" });
  assert.equal(calls, scopedBefore);
});

test("concurrent searches preserve independent diagnostics and a rejected continuation remains usable", async t => {
  const branches = ["a", "b"].map(key => ({ ...root, drivewsid: `FOLDER::com.apple.CloudDocs::${key}`, docwsid: key, name: key }));
  let release: () => void = () => {};
  let entered: () => void = () => {};
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  let hold = false;
  const f = await fixture(t, async (_url, init) => {
    const [{ drivewsid }] = JSON.parse(String(init.body));
    const key = drivewsid.split("::")[2].split("-")[0];
    if (hold && drivewsid === `${branches[0]!.drivewsid}-2`) { entered(); await blocked; }
    const branch = branches.find(item => item.docwsid === key)!;
    if (drivewsid === branch.drivewsid) {
      const children = Array.from({ length: 4 }, (_, index) => ({ ...branch, drivewsid: `${branch.drivewsid}-${index}`, docwsid: `${key}-${index}`, parentId: branch.drivewsid, name: `Folder ${index}` }));
      return json([{ ...branch, directChildrenCount: key === "a" ? 5 : 4, items: key === "a" ? [...children, { ...file("shared.txt", "excluded", branch.drivewsid), shareID: [] }] : children }]);
    }
    return json([{ ...branch, drivewsid, docwsid: drivewsid.split("::")[2], items: [file(`${key}-match.txt`, `${key}-${drivewsid.split("::")[2]}-file`, drivewsid)], directChildrenCount: 1 }]);
  });
  const a = await f.service.search({ folderId: branches[0]!.drivewsid, query: "a-match" });
  const b = await f.service.search({ folderId: branches[1]!.drivewsid, query: "b-match" });
  assert.ok(a.continuation); assert.ok(b.continuation);
  hold = true;
  const active = f.service.search({ folderId: branches[0]!.drivewsid, query: "a-match", continuation: a.continuation });
  try {
    await started;
    await assert.rejects(new DriveService(f.env, owner).search({ folderId: branches[1]!.drivewsid, query: "b-match", continuation: b.continuation }), { code: "CONFLICT" });
  } finally { release(); }
  const aFinal = await active;
  const bFinal = await f.service.search({ folderId: branches[1]!.drivewsid, query: "b-match", continuation: b.continuation });
  assert.deepEqual(aFinal.reasons, ["excluded_shared_entries"]);
  assert.equal(aFinal.incompleteFolders[0]?.folderId, branches[0]!.drivewsid);
  assert.equal(aFinal.complete, false);
  assert.equal(bFinal.complete, true);
  assert.deepEqual(bFinal.reasons, []);
  assert.deepEqual(bFinal.incompleteFolders, []);
  assert.ok(aFinal.items.every(item => item.name === "a-match.txt"));
  assert.ok(bFinal.items.every(item => item.name === "b-match.txt"));
  await assert.rejects(f.service.search({ folderId: branches[0]!.drivewsid, query: "a-match", continuation: a.continuation }), { code: "CONFLICT" });
});

test("shared search branches with identical provider child IDs keep distinct share contexts", async t => {
  const shares = ["a", "b"].map(key => ({ ...root, drivewsid: `FOLDER::com.apple.CloudDocs::share-${key}`, docwsid: `share-${key}`, name: `Share ${key}`, parentId: DRIVE_ROOT, shareID: { recordName: `synthetic-share-${key}` } }));
  const sharedChildId = "FOLDER_IN_SHARED_FOLDER::com.apple.CloudDocs::same-child";
  const f = await fixture(t, (_url, init) => {
    const [entry] = JSON.parse(String(init.body));
    if (entry.drivewsid === DRIVE_ROOT) return json([{ ...root, items: shares, directChildrenCount: 2 }]);
    const selected = shares.find(share => share.drivewsid === entry.drivewsid);
    if (selected) {
      assert.deepEqual(entry.shareID, selected.shareID);
      return json([{ ...selected, items: [{ ...root, drivewsid: sharedChildId, docwsid: "same-child", name: "Child", parentId: selected.drivewsid }], directChildrenCount: 1 }]);
    }
    assert.equal(entry.drivewsid, sharedChildId);
    const parent = shares.find(share => share.shareID.recordName === entry.shareID.recordName)!;
    assert.ok(parent);
    const leaf = { ...file(`${parent.docwsid}-match.txt`, "same-file", sharedChildId), drivewsid: "FILE_IN_SHARED_FOLDER::com.apple.CloudDocs::same-file" };
    return json([{ ...root, drivewsid: sharedChildId, docwsid: "same-child", name: "Child", parentId: parent.drivewsid, items: [leaf], directChildrenCount: 1 }]);
  });
  const first = await f.service.search({ query: "match" });
  assert.ok(first.continuation);
  const next = await new DriveService(f.env, owner).search({ query: "match", continuation: first.continuation });
  assert.equal(next.complete, true);
  assert.deepEqual(next.items.map(item => item.name), ["share-a-match.txt", "share-b-match.txt"]);
  assert.equal(next.items[0]?.id, next.items[1]?.id);
  assert.notEqual(next.items[0]?.shareContext, next.items[1]?.shareContext);
  const traversed = await f.service.traverse({ query: "MATCH" });
  assert.ok(traversed.continuation);
  const continued = await new DriveService(f.env, owner).traverse({ query: "MATCH", continuation: traversed.continuation });
  assert.equal(continued.complete, true);
  assert.deepEqual(continued.items.map(item => item.relativePath), ["Share a/Child/share-a-match.txt", "Share b/Child/share-b-match.txt"]);
  assert.notEqual(continued.items[0]?.shareContext, continued.items[1]?.shareContext);
});

test("expired mutation leases never repeat a write, and exact retained post-write versions reconcile safely", async t => {
  let writes = 0;
  const current = file("after.txt");
  const f = await fixture(t, url => {
    if (url.pathname === "/renameItems") { writes++; throw new Error("A retained commit must never be dispatched"); }
    return json([{ ...current }]);
  });
  const scope = { account: await accountScope(owner, identity.dsid), generation: f.generation, permissionRevision: 1, expiresAt: (await f.sessions.load()).session.login.expiresAt };
  const operations = new DriveOperationRepository(f.env, owner), id = crypto.randomUUID();
  const input = { operationId: id, itemId: current.drivewsid, etag: "before-version", name: "after.txt" };
  let row = await operations.claim(await operations.create(id, "rename", input, scope), scope);
  row = await operations.checkpoint(row, "committing", { input, itemId: current.drivewsid });
  f.db.sqlite.prepare("UPDATE drive_operations SET lease_until = 1 WHERE operation_id = ?").run(id);
  await assert.rejects(operations.assertLease(row), { code: "CONFLICT" });
  await assert.rejects(f.service.rename(input), { code: "WRITE_OUTCOME_UNKNOWN" });
  assert.equal(writes, 0);
  const witnessedId = crypto.randomUUID(), witnessedInput = { ...input, operationId: witnessedId };
  row = await operations.claim(await operations.create(witnessedId, "rename", witnessedInput, scope), scope);
  const item = (await f.service.get({ itemId: current.drivewsid })).item;
  row = await operations.checkpoint(row, "committing", { input: witnessedInput, itemId: item.id, receipt: item });
  await operations.release(row);
  const recovered = await f.service.rename(witnessedInput);
  assert.equal(recovered.phase, "confirmed");
  assert.equal(recovered.result?.item.etag, current.etag);
  assert.equal(writes, 0);
});

test("organize journey verifies exact versions, rejects ancestor moves, and confirms create/rename/move identities", async t => {
  const target = { drivewsid: "FOLDER::com.apple.CloudDocs::target", docwsid: "target", zone: "com.apple.CloudDocs", name: "Target", type: "FOLDER", etag: "target-version", parentId: DRIVE_ROOT };
  const items = new Map<string, typeof target>([[target.drivewsid, target]]);
  let mutations = 0;
  const f = await fixture(t, (url, init) => {
    const payload = JSON.parse(String(init.body));
    if (url.pathname === "/retrieveItemDetailsInFolders") {
      const selected = payload[0].drivewsid === DRIVE_ROOT ? root : items.get(payload[0].drivewsid)!;
      const children = [...items.values()].filter(item => item.parentId === selected.drivewsid);
      return json([{ ...selected, items: children, directChildrenCount: children.length }]);
    }
    mutations++;
    if (url.pathname === "/createFolders") {
      const created = { ...target, drivewsid: "FOLDER::com.apple.CloudDocs::created", docwsid: "created", name: payload.folders[0].name, parentId: payload.destinationDrivewsId, etag: "created-version" };
      items.set(created.drivewsid, created);
      return json({ folders: [{ drivewsid: created.drivewsid, status: "OK" }] });
    }
    const selected = items.get(payload.items[0].drivewsid)!;
    assert.equal(payload.items[0].etag, selected.etag);
    if (url.pathname === "/renameItems") { selected.name = payload.items[0].name; selected.etag = "renamed-version"; }
    else if (url.pathname === "/moveItems") { selected.parentId = payload.destinationDrivewsId; selected.etag = "moved-version"; }
    else throw new Error(`Unexpected synthetic mutation ${url.pathname}`);
    return json({ items: [{ ...selected, status: "OK" }] });
  });
  const created = await f.service.createFolder({ parentId: DRIVE_ROOT, name: "New folder", operationId: crypto.randomUUID() });
  assert.equal(created.phase, "confirmed");
  const item = created.result!.item;
  await assert.rejects(f.service.rename({ itemId: item.id, etag: "stale-version", name: "Renamed", operationId: crypto.randomUUID() }), { code: "CONFLICT" });
  assert.equal(mutations, 1);
  const renamed = await f.service.rename({ itemId: item.id, etag: item.etag, name: "Renamed", operationId: crypto.randomUUID() });
  assert.equal(renamed.result?.item.name, "Renamed");
  const child = { ...target, drivewsid: "FOLDER::com.apple.CloudDocs::child", docwsid: "child", name: "Child", parentId: item.id };
  items.set(child.drivewsid, child);
  await assert.rejects(f.service.move({ itemId: item.id, etag: renamed.result!.item.etag, destinationId: child.drivewsid, operationId: crypto.randomUUID() }), { code: "CONFLICT" });
  assert.equal(mutations, 2);
  const moved = await f.service.move({ itemId: item.id, etag: renamed.result!.item.etag, destinationId: target.drivewsid, operationId: crypto.randomUUID() });
  assert.equal(moved.phase, "confirmed");
  assert.equal(moved.result?.item.parentId, target.drivewsid);
  await assert.rejects(f.service.rename({ itemId: DRIVE_ROOT, etag: root.etag, name: "Root", operationId: crypto.randomUUID() }), { code: "UNSUPPORTED_FEATURE" });
  assert.equal(mutations, 3);
});

test("denied Drive access requires explicit approval, preserves Reminders, and never replays a rejected mutation", async t => {
  const current = file("consent.txt");
  let denyRead = true, reads = 0, approvalRequests = 0, writes = 0;
  const f = await fixture(t, (url, init) => {
    if (url.pathname.endsWith("/requestWebAccessState")) { approvalRequests++; return json({ isICDRSDisabled: false }); }
    if (url.pathname === "/renameItems") { writes++; return new Response(null, { status: 450 }); }
    assert.ok(["/retrieveItemDetailsInFolders", "/retrieveItemDetails"].includes(url.pathname));
    reads++;
    if (denyRead) return new Response(null, { status: 450, headers: { "Set-Cookie": "X-APPLE-WEBAUTH-VALIDATE=v=1:t=synthetic-renewed-validation; Path=/; Secure" } });
    const payload = JSON.parse(String(init.body));
    const lookup = Array.isArray(payload) ? payload[0] : payload;
    const { drivewsid } = lookup.items?.[0] ?? lookup;
    return json([drivewsid === DRIVE_ROOT ? { ...root, items: [current], directChildrenCount: 1 } : current]);
  });
  const saved = await f.sessions.load(), fence = await f.sessions.claimRenewal(saved.fence.generation, saved.fence.version);
  await f.sessions.commitResume(fence, { ...saved.session, services: { ...saved.session.services!, reminders: { state: "READY" } } }, "READY");
  const before = await f.sessions.load(), auth = new AppleConnectionService(f.env, owner);
  await assert.rejects(f.service.list({}), { code: "REAUTH_REQUIRED" });
  const rejected = await f.sessions.load();
  assert.equal(rejected.session.services?.drive.state, "DEVICE_APPROVAL_PENDING");
  assert.deepEqual(rejected.session.services?.reminders, before.session.services?.reminders);
  assert.deepEqual(rejected.session.pcs, before.session.pcs);
  assert.equal(rejected.state, "READY");
  assert.ok(rejected.session.auth.cookies.some(cookie => cookie.name === "X-APPLE-WEBAUTH-VALIDATE" && cookie.value === "v=1:t=synthetic-renewed-validation"));
  const status = await auth.status();
  assert.equal(status.services.drive.ready, false);
  assert.equal(status.services.drive.action, "approve-device-consent");
  assert.equal(status.services.reminders.ready, true);
  await assert.rejects(f.service.list({}), { code: "DEVICE_APPROVAL_PENDING" });
  assert.deepEqual([reads, approvalRequests, writes], [1, 0, 0]);
  denyRead = false;
  const approved = await auth.approveDrive(f.generation);
  assert.equal(approved.services.drive.ready, true);
  assert.equal((await f.service.list({})).items[0]?.id, current.drivewsid);
  const operationId = crypto.randomUUID();
  const input = { operationId, itemId: current.drivewsid, etag: current.etag, name: "renamed.txt" };
  await assert.rejects(f.service.rename(input), { code: "WRITE_OUTCOME_UNKNOWN" });
  assert.equal((await auth.status()).services.drive.ready, false);
  assert.equal((await auth.status()).services.reminders.ready, true);
  await auth.approveDrive(f.generation);
  await assert.rejects(f.service.rename({ ...input, operationId: operationId.toUpperCase() }), { code: "WRITE_OUTCOME_UNKNOWN" });
  assert.equal((await f.service.operation({ operationId: operationId.toUpperCase() })).phase, "unknown");
  assert.equal(writes, 1);
  assert.equal(approvalRequests, 2);
});

test("docws shared identities survive cold clients, remain encrypted and keep enumeration completeness explicit", async t => {
  const shared = { ...root, drivewsid: "SHARED_FOLDER::com.apple.CloudDocs::participant", docwsid: "participant", name: "Shared", type: "SHARED_FOLDER", parentId: DRIVE_ROOT, shareID: { recordName: "synthetic-share", ownerRecordName: "synthetic-owner" } };
  const nested = { ...root, drivewsid: "FOLDER_IN_SHARED_FOLDER::com.apple.CloudDocs::nested", docwsid: "nested", item_id: "private-docws-nested", name: "Nested", parentId: shared.drivewsid };
  const raw = (item_id: string, name: string, type: string, version = "v1") => ({ item_id, item_info: { name, type, version, size: "3", modified_at: "0", urls: { url_download: syntheticDownloadURL() } } });
  let wrongIdentity = false;
  const f = await fixture(t, (url, init) => {
    if (url.hostname === "cvws.icloud-content.com") return new Response("abc");
    if (url.pathname === "/v1/item/private-docws-nested") return json(raw(wrongIdentity ? "wrong-document" : "private-docws-nested", "Nested", "FOLDER"));
    if (url.pathname === "/v1/item/private-docws-file") return json(raw("private-docws-file", "report.txt", "FILE"));
    if (url.pathname === "/v1/item/private-docws-deeper") return json(raw("private-docws-deeper", "Deeper", "FOLDER"));
    if (url.pathname === "/v1/enumerate/private-docws-nested") {
      assert.equal(url.searchParams.get("limit"), "1001");
      return json({ drive_item: [raw("private-docws-deeper", "Deeper", "FOLDER"), raw("private-docws-file", "report.txt", "FILE")] });
    }
    if (url.pathname === "/v1/enumerate/private-docws-deeper") return json({ drive_item: [] });
    const [entry] = JSON.parse(String(init.body));
    if (entry.drivewsid === DRIVE_ROOT) return json([{ ...root, items: [shared], directChildrenCount: 1 }]);
    assert.equal(entry.drivewsid, shared.drivewsid);
    return json([{ ...shared, items: [nested], directChildrenCount: 1 }]);
  });
  const first = await f.service.list({});
  const context = first.items[0]!.shareContext;
  const children = await f.service.list({ folderId: shared.drivewsid, shareContext: context });
  const cold = new DriveService(f.env, owner);
  const listed = await cold.list({ folderId: children.items[0]!.id, shareContext: context });
  assert.equal(listed.complete, false);
  assert.deepEqual(listed.reasons, ["missing_direct_children_count"]);
  assert.equal(listed.items.length, 2);
  assert.equal(listed.folder.shareContext, context);
  const report = listed.items.find(item => item.name === "report.txt")!;
  assert.equal(JSON.stringify(report).includes("private-docws"), false);
  assert.equal((await cold.read({ itemId: report.id, shareContext: context })).content, "abc");
  const deeper = listed.items.find(item => item.type === "folder")!;
  assert.equal((await cold.list({ folderId: deeper.id, shareContext: context })).items.length, 0);
  const rows = f.db.sqlite.prepare("SELECT envelope FROM drive_handles WHERE kind = 'share'").all();
  assert.equal(rows.length, 1, "All mapped descendants reuse one share context.");
  assert.equal(JSON.stringify(rows).includes("private-docws"), false);
  await assert.rejects(cold.get({ itemId: report.id }), { code: "VALIDATION_ERROR" });
  wrongIdentity = true;
  await assert.rejects(cold.list({ folderId: nested.drivewsid, shareContext: context }), { code: "PROTOCOL_CHANGED" });
});

test("Drive 423 requires explicit approval without prompting or changing Reminders", async t => {
  let calls = 0;
  const f = await fixture(t, () => { calls++; return new Response(null, { status: 423 }); });
  const before = await f.sessions.load();
  await assert.rejects(f.service.list({}), { code: "DEVICE_APPROVAL_PENDING" });
  assert.equal(calls, 1);
  const after = await f.sessions.load();
  assert.equal(after.session.services?.drive.state, "DEVICE_APPROVAL_PENDING");
  assert.deepEqual(after.session.services?.reminders, before.session.services?.reminders);
  await assert.rejects(f.service.list({}), { code: "DEVICE_APPROVAL_PENDING" });
  assert.equal(calls, 1, "Another read cannot prompt Apple or replay the rejected request.");
});

test("private download ranges use single-use handles and validate the exact file size", async t => {
  const current = file("range.txt", "range", DRIVE_ROOT, 6); let contentRequests = 0;
  const f = await fixture(t, (url, init) => {
    if (url.pathname.endsWith("/download/by_id")) return json({ data_token: { url: syntheticDownloadURL() } });
    if (url.hostname === "cvws.icloud-content.com") {
      contentRequests++;
      assert.equal(new Headers(init.headers).get("range"), "bytes=2-5");
      return new Response("cdef", { status: 206, headers: { "Content-Range": "bytes 2-5/6", "Content-Length": "4" } });
    }
    return json({ items: [current] });
  });
  for (const range of ["bytes=2-", "bytes=-4", "bytes=2-99"]) {
    const prepared = await f.service.download({ itemId: current.drivewsid });
    const response = await f.service.downloadContent(prepared.handleId, undefined, range);
    assert.equal(response.status, 206);
    assert.equal(response.headers.get("content-range"), "bytes 2-5/6");
    assert.equal(response.headers.get("content-length"), "4");
    assert.equal(await response.text(), "cdef");
    await assert.rejects(f.service.downloadContent(prepared.handleId, undefined, range), { code: "CONFLICT" });
  }
  for (const range of ["bytes=9-", "bytes=0-1,3-4", "bytes=-0", "invalid", "bytes=4-2"]) {
    const prepared = await f.service.download({ itemId: current.drivewsid });
    await assert.rejects(f.service.downloadContent(prepared.handleId, undefined, range), { status: 416 });
  }
  assert.equal(contentRequests, 3);
});

test("package tokens download bounded archives without using unpacked sizes as Content-Length", async t => {
  const current = { ...file("slides.key", "package", DRIVE_ROOT, 1), type: "PACKAGE" }; let contentRequests = 0;
  const f = await fixture(t, url => {
    if (url.hostname === "cvws.icloud-content.com") { contentRequests++; return new Response("synthetic archive", { headers: { "Content-Type": "application/zip" } }); }
    if (url.pathname.endsWith("/download/by_id")) return json({ package_token: { url: syntheticDownloadURL() } });
    return json({ items: [current] });
  });
  await assert.rejects(f.service.read({ itemId: current.drivewsid }), { code: "UNSUPPORTED_FEATURE" });
  const prepared = await f.service.download({ itemId: current.drivewsid });
  assert.equal(prepared.item.package, true);
  const response = await f.service.downloadContent(prepared.handleId);
  assert.equal(response.headers.has("content-length"), false);
  assert.ok(response.headers.get("content-disposition")!.includes("slides.key.zip"));
  assert.equal(await response.text(), "synthetic archive");
  const ranged = await f.service.download({ itemId: current.drivewsid });
  await assert.rejects(f.service.downloadContent(ranged.handleId, undefined, "bytes=0-0"), { code: "UNSUPPORTED_FEATURE" });
  assert.equal(contentRequests, 1);
});
