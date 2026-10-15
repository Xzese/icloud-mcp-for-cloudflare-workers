// Full production Worker, actual D1/R2 bindings, and synthetic Apple services.
// Payloads are generated and hashed incrementally, including beyond 2 GiB.
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Miniflare, Log, LogLevel } from "miniflare";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { Envelopes } from "../../src/crypto/envelopes.ts";
import { loginAssurance } from "../../src/auth/apple/policy.ts";
import { DEFAULT_SERVICE_SETTINGS } from "../../src/services/settings.ts";
import { DRIVE_ROOT } from "../../src/icloud/drive.ts";
import { DRIVE_UPLOAD_PART_BYTES, DRIVE_FILE_BYTES } from "../../src/drive/limits.ts";

const root = resolve(new URL("../..", import.meta.url).pathname);
const owner = "synthetic-multipart-owner", origin = "https://multipart.example.test";
const identity = { dsid: "123456789", clientId: "synthetic-multipart-client", clientBuildNumber: "2534Project66", clientMasteringNumber: "2534B22" };
const connection = { ...identity, driveURL: "https://p01-drivews.icloud.com", documentsURL: "https://p01-docws.icloud.com" };
const json = value => Response.json(value);
const chunk = new Uint8Array(1024 * 1024).fill(90);
function generated(size) {
  let remaining = size;
  return new ReadableStream({ pull(controller) {
    if (!remaining) { controller.close(); return; }
    const length = Math.min(remaining, chunk.length); remaining -= length;
    controller.enqueue(chunk.subarray(0, length));
  } }, { highWaterMark: 0 });
}
function expectedHash(size) {
  const digest = createHash("sha256");
  for (let remaining = size; remaining > 0; remaining -= chunk.length) digest.update(chunk.subarray(0, Math.min(remaining, chunk.length)));
  return digest.digest("hex");
}
async function hashStream(body) {
  const hash = createHash("sha256"), reader = body.getReader(); let count = 0;
  for (;;) { const next = await reader.read(); if (next.done) break; count += next.value.length; hash.update(next.value); }
  return { size: count, sha256: hash.digest("hex") };
}
async function inspectMultipart(request, size, expected, report) {
  const boundary = request.headers.get("content-type").split("boundary=")[1];
  const reader = request.body.getReader(), digest = createHash("sha256");
  let header = Buffer.alloc(0), trailer = Buffer.alloc(0), started = false, count = 0, reported = 0;
  const began = Date.now();
  for (;;) {
    const next = await reader.read(); if (next.done) break;
    let bytes = Buffer.from(next.value);
    if (!started) {
      header = Buffer.concat([header, bytes]);
      const offset = header.indexOf("\r\n\r\n");
      if (offset < 0) { assert.ok(header.length < 4096); continue; }
      assert.ok(header.subarray(0, offset).toString().includes("synthetic-multigig.bin"));
      bytes = header.subarray(offset + 4); header = Buffer.alloc(0); started = true;
    }
    const take = Math.min(size - count, bytes.length);
    digest.update(bytes.subarray(0, take)); count += take;
    if (count - reported >= 32 * 1024 ** 2) {
      report(`Apple received ${count} of ${size} bytes in ${Date.now() - began} ms.`);
      reported = count;
    }
    if (take < bytes.length) trailer = Buffer.concat([trailer, bytes.subarray(take)]);
    assert.ok(trailer.length < 256);
  }
  assert.equal(count, size); assert.equal(digest.digest("hex"), expected);
  assert.equal(trailer.toString(), `\r\n--${boundary}--\r\n`);
}

export async function verifyMultipartDrive(options, { bytes = DRIVE_UPLOAD_PART_BYTES + 17, report = () => {} } = {}) {
  assert.ok(Number.isSafeInteger(bytes) && bytes > DRIVE_UPLOAD_PART_BYTES && bytes <= DRIVE_FILE_BYTES);
  const hash = expectedHash(bytes), secret = randomBytes(32).toString("base64");
  const team = "https://multipart.cloudflareaccess.com", audience = "synthetic-multipart-audience";
  const { publicKey, privateKey } = await generateKeyPair("RS256"), kid = randomUUID();
  const jwk = { ...await exportJWK(publicKey), kid, use: "sig", alg: "RS256" };
  const assertion = await new SignJWT({ email: "synthetic@example.invalid" }).setProtectedHeader({ alg: "RS256", kid }).setIssuer(team).setAudience(audience).setSubject(owner).setIssuedAt().setExpirationTime("1h").sign(privateKey);
  const itemId = "FILE::com.apple.CloudDocs::synthetic-multigig", name = "synthetic-multigig.bin";
  const item = { drivewsid: itemId, docwsid: "synthetic-multigig", zone: "com.apple.CloudDocs", type: "FILE", name, etag: "synthetic-multigig-etag", parentId: DRIVE_ROOT, size: bytes, dateModified: 0 };
  let uploaded = false, allocations = 0, transfers = 0, commits = 0, upstreamFailure = null;
  const content = new URL("/B/synthetic-multigig/file", "https://cvws.icloud-content.com"); content.searchParams.set("token", randomUUID());
  const outboundService = async request => {
    const url = new URL(request.url);
    if (url.origin === team) return json({ keys: [jwk] });
    if (url.hostname === "p01-drivews.icloud.com") {
      const body = await request.json();
      const id = (Array.isArray(body) ? body[0] : body.items[0]).drivewsid;
      if (id === DRIVE_ROOT) return json([{ drivewsid: DRIVE_ROOT, docwsid: "root", zone: "com.apple.CloudDocs", type: "FOLDER", name: "root", etag: "root-v1", parentId: null, items: uploaded ? [item] : [], directChildrenCount: uploaded ? 1 : 0 }]);
      assert.equal(id, itemId); assert.ok(uploaded); return json({ items: [item] });
    }
    if (url.pathname.endsWith("/upload/web")) { allocations++; assert.equal((await request.json()).size, bytes); return json([{ document_id: "synthetic-multigig", url: "https://cws.icloud-content.com/123456789/singleFileUpload?tk=synthetic-multigig" }]); }
    if (url.hostname === "cws.icloud-content.com") {
      transfers++; assert.equal(request.headers.has("cookie"), false);
      try { await inspectMultipart(request, bytes, hash, report); } catch (error) { upstreamFailure = String(error); throw error; }
      return json({ singleFile: { referenceChecksum: "synthetic-reference", fileChecksum: "synthetic-checksum", wrappingKey: "synthetic-key", size: bytes } });
    }
    if (url.pathname.endsWith("/update/documents")) {
      commits++; assert.equal((await request.json()).document_id, "synthetic-multigig"); uploaded = true;
      return json({ status: { status_code: 0 }, results: [{ status: { status_code: 0 }, document: { document_id: "synthetic-multigig", zone: "com.apple.CloudDocs", parent_id: "root", name, type: "FILE", etag: item.etag, size: bytes } }] });
    }
    if (url.pathname.endsWith("/download/by_id")) return json({ document_id: "synthetic-multigig", data_token: { url: content.href } });
    if (url.hostname === "cvws.icloud-content.com") {
      assert.equal(request.headers.has("cookie"), false);
      const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.get("range") ?? "");
      const size = range ? Number(range[2]) - Number(range[1]) + 1 : bytes;
      return new Response(generated(size), { status: range ? 206 : 200, headers: { "content-length": String(size), ...(range ? { "content-range": `bytes ${range[1]}-${range[2]}/${bytes}` } : {}) } });
    }
    throw new Error("Unexpected synthetic multi-gigabyte upstream request.");
  };
  const worker = new Miniflare({ ...options, name: "multipart-drive-acceptance", d1Databases: { DB: "multipart-drive-db" }, d1Persist: false, r2Buckets: ["BUCKET"], r2Persist: false,
    bindings: { ...options.bindings, APP_ORIGIN: origin, REMINDERS_OWNER_ID: owner, TEAM_DOMAIN: team, POLICY_AUD: audience, ENCRYPTION_KEY_ID: "synthetic", ENCRYPTION_KEYS_JSON: JSON.stringify({ synthetic: secret }), LIVE_APPLE_CONNECTION_APPROVED: "controlled-device-v2", APPLE_CRYPTO_REVIEW_APPROVED: "device-proof-v2", APPLE_SESSION_RETENTION_WRITES: "absolute-30d-v1" }, outboundService, log: new Log(LogLevel.ERROR) });
  try {
    const db = await worker.getD1Database("DB"), bucket = await worker.getR2Bucket("BUCKET");
    const statements = (await readFile(join(root, "schema.sql"), "utf8")).replace(/^\s*--.*$/gm, "").split(";").map(value => value.trim()).filter(Boolean);
    await db.batch(statements.map(sql => db.prepare(sql)));
    const settings = { ...structuredClone(DEFAULT_SERVICE_SETTINGS), drive: { enabled: true, browse: true, contents: true, upload: true, organize: false } };
    await db.prepare("INSERT INTO owner_service_settings (owner_id,revision,settings_json,updated_at) VALUES (?,1,?,?)").bind(owner, JSON.stringify(settings), Date.now()).run();
    const session = { login: loginAssurance(), auth: { clientId: identity.clientId, headers: {}, cookies: [{ name: "X-APPLE-WEBAUTH-VALIDATE", value: "v=1:t=synthetic-multigig", domain: "icloud.com", hostOnly: false, path: "/", secure: true, expiresAt: null }] }, connection: { ...identity, cloudKitURL: "https://p01-ckdatabasews.icloud.com/database/1/com.apple.reminders/production/private" }, pcs: { consentRequested: true, pcsAttempts: 1, consentChecks: 1, expiresAt: Date.now() + 300_000, nextAttemptAt: 0 }, services: { version: 1, reminders: { state: "DEVICE_APPROVAL_PENDING", action: "wait-for-reminders-keys", pcs: { consentRequested: true, pcsAttempts: 1, consentChecks: 1, expiresAt: Date.now() + 300_000, nextAttemptAt: 0 } }, drive: { state: "READY", connection } } };
    const envelope = await new Envelopes("synthetic", { synthetic: secret }).encrypt(session, { ownerId: owner, accountId: "apple-reminders", generation: 1, recordId: "apple-session", schemaVersion: 1 });
    await db.prepare("INSERT INTO apple_session_state (owner_id,account_id,generation,version,state,envelope,updated_at) VALUES (?,'apple-reminders',1,1,'READY',?,?)").bind(owner, JSON.stringify(envelope), Date.now()).run();
    const request = (path, { body, binary = false, checksum, range, wrongOrigin = false } = {}) => worker.dispatchFetch(origin + path, { method: body === undefined ? "GET" : "POST", headers: { "oai-authenticated-user-id": owner, "cf-access-jwt-assertion": assertion, origin: wrongOrigin ? "https://other.example.test" : origin, "content-type": binary ? "application/octet-stream" : "application/json", ...(checksum ? { "x-content-sha256": checksum } : {}), ...(range ? { range } : {}) }, ...(body === undefined ? {} : { body }) });
    const post = async (path, input) => {
      const response = await request(path, { body: JSON.stringify(input) }), value = await response.json();
      assert.equal(response.status, 200, JSON.stringify({ value, allocations, transfers, commits, upstreamFailure })); return value;
    };
    const operationId = randomUUID(), input = { operationId, parentId: DRIVE_ROOT, name, size: bytes, sha256: hash, contentType: "application/octet-stream" };
    const prepared = await post("/api/drive/prepare-multipart-upload", input);
    assert.equal(prepared.partBytes, DRIVE_UPLOAD_PART_BYTES);
    assert.deepEqual([allocations, transfers, commits], [0, 0, 0]);
    const first = new Uint8Array(DRIVE_UPLOAD_PART_BYTES).fill(90), firstHash = expectedHash(first.length);
    const rejected = await request(`/api/drive/uploads/${operationId}/parts/1`, { body: first, binary: true, checksum: firstHash, wrongOrigin: true }); assert.equal(rejected.status, 403);
    const direct = await request(`/api/drive/uploads/${operationId}/content`, { body: new Uint8Array(), binary: true }); assert.equal(direct.status, 413);
    for (let offset = 0, part = 1; offset < bytes; offset += DRIVE_UPLOAD_PART_BYTES, part++) {
      const partBytes = Math.min(DRIVE_UPLOAD_PART_BYTES, bytes - offset), body = first.subarray(0, partBytes), checksum = expectedHash(partBytes);
      const response = await request(`/api/drive/uploads/${operationId}/parts/${part}`, { body, binary: true, checksum });
      assert.equal(response.status, 200, await response.text());
      if (part === 1) {
        const resumed = await post("/api/drive/prepare-multipart-upload", input); assert.deepEqual(resumed.uploadedParts, [1]);
        const replay = await request(`/api/drive/uploads/${operationId}/parts/1`, { body: first, binary: true, checksum: firstHash }); assert.equal(replay.status, 200, await replay.text());
      }
      if (part % 32 === 0) report(`Staged ${offset + partBytes} of ${bytes} bytes.`);
    }
    report("Staging complete; streaming R2 to the synthetic Apple server.");
    const completed = await post("/api/drive/complete-multipart-upload", { operationId }); assert.equal(completed.phase, "confirmed"); assert.equal(completed.result.item.size, bytes);
    await post("/api/drive/complete-multipart-upload", { operationId });
    assert.deepEqual([allocations, transfers, commits], [1, 1, 1]);
    assert.equal((await bucket.list()).objects.length, 0, "confirmed staged bytes are deleted");
    report("Downloading the complete generated file through the production Worker.");
    const handle = await post("/api/drive/download", { itemId }), download = await request(handle.url);
    assert.equal(download.status, 200); assert.equal(download.headers.get("content-length"), String(bytes));
    assert.deepEqual(await hashStream(download.body), { size: bytes, sha256: hash });
    const fresh = await post("/api/drive/download", { itemId });
    const start = bytes - 17, ranged = await request(fresh.url, { range: `bytes=${start}-${bytes - 1}` });
    assert.equal(ranged.status, 206); assert.equal(ranged.headers.get("content-range"), `bytes ${start}-${bytes - 1}/${bytes}`);
    assert.deepEqual(await hashStream(ranged.body), { size: 17, sha256: expectedHash(17) });
    assert.equal((await request(fresh.url)).status, 409);
    return { bytes, sha256: hash, appleUploads: transfers, resumedParts: true, rangeVerified: true };
  } finally { await worker.dispose(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = JSON.parse(await readFile(join(root, "dist/server/wrangler.json"), "utf8")), server = join(root, "dist/server");
  const paths = (await readdir(server, { recursive: true, withFileTypes: true })).filter(file => file.isFile() && /\.(?:js|mjs)$/.test(file.name)).map(file => join(file.parentPath, file.name));
  const entry = join(server, "index.js");
  const result = await verifyMultipartDrive({ modulesRoot: server, modules: [entry, ...paths.filter(path => path !== entry)].map(path => ({ type: "ESModule", path })), compatibilityDate: config.compatibility_date, compatibilityFlags: config.compatibility_flags, assets: { directory: join(root, "dist/client"), routerConfig: { has_user_worker: true } } }, { bytes: Number(process.env.DRIVE_LARGE_TEST_BYTES ?? 2 ** 31 + 17), report: console.log });
  console.log(JSON.stringify(result));
}
