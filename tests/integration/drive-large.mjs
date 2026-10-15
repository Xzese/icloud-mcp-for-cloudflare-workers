// Full production Worker, actual D1/R2 bindings, and synthetic Apple services.
// Payloads are generated and hashed incrementally, including beyond 2 GiB.
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import { Readable } from "node:stream";
import { fetch as nodeFetch } from "undici";
import { Miniflare, Log, LogLevel } from "miniflare";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { Envelopes } from "../../src/crypto/envelopes.ts";
import { loginAssurance } from "../../src/auth/apple/policy.ts";
import { DEFAULT_SERVICE_SETTINGS } from "../../src/services/settings.ts";
import { DRIVE_ROOT } from "../../src/icloud/drive.ts";
import { DRIVE_UPLOAD_PART_BYTES, DRIVE_FILE_BYTES, DRIVE_STREAM_CHUNK_BYTES, DRIVE_STREAM_PROTOCOL, DRIVE_STREAM_LEGACY_PROTOCOL } from "../../src/drive/limits.ts";
import { localAppleContentHeaders } from "../../scripts/dev/local-icloud-observation.mjs";

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
async function inspectRawUpload(request, size, expected, report, delayMs = 0) {
  assert.equal(request.headers.get("content-type"), "application/octet-stream");
  assert.equal(request.headers.get("content-length"), String(size), "Apple receives the exact raw file size without multipart overhead");
  assert.equal(request.headers.has("transfer-encoding"), false, "The local HTTP relay must preserve fixed framing");
  const reader = request.body.getReader(), digest = createHash("sha256");
  let count = 0, reported = 0;
  const began = Date.now();
  for (;;) {
    const next = await reader.read(); if (next.done) break;
    digest.update(next.value); count += next.value.length;
    assert.ok(count <= size);
    if (count - reported >= 32 * 1024 ** 2) {
      report(`Apple received ${count} of ${size} bytes in ${Date.now() - began} ms.`);
      reported = count;
      if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  assert.equal(count, size); assert.equal(digest.digest("hex"), expected);
}

export async function verifyMultipartDrive(options, { bytes = DRIVE_UPLOAD_PART_BYTES + 17, report = () => {}, transport = "multipart", fault, network = false, delayMs = 0, capability = false, legacyProtocol = false } = {}) {
  assert.ok(["multipart", "stream"].includes(transport));
  assert.ok([undefined, "disconnect", "frame", "checksum", "reject", "early-success"].includes(fault));
  assert.ok(Number.isInteger(delayMs) && delayMs >= 0 && delayMs <= 5000);
  const streaming = transport === "stream";
  const frameBytes = legacyProtocol ? 1024 * 1024 : DRIVE_STREAM_CHUNK_BYTES;
  assert.ok(Number.isSafeInteger(bytes) && bytes > DRIVE_UPLOAD_PART_BYTES && bytes <= DRIVE_FILE_BYTES);
  const hash = expectedHash(bytes), secret = randomBytes(32).toString("base64");
  const team = "https://multipart.cloudflareaccess.com", audience = "synthetic-multipart-audience";
  const { publicKey, privateKey } = await generateKeyPair("RS256"), kid = randomUUID();
  const jwk = { ...await exportJWK(publicKey), kid, use: "sig", alg: "RS256" };
  const assertion = await new SignJWT({ email: "synthetic@example.invalid" }).setProtectedHeader({ alg: "RS256", kid }).setIssuer(team).setAudience(audience).setSubject(owner).setIssuedAt().setExpirationTime("1h").sign(privateKey);
  const itemId = "FILE::com.apple.CloudDocs::synthetic-multigig", name = "synthetic-multigig.bin";
  const item = { drivewsid: itemId, docwsid: "synthetic-multigig", zone: "com.apple.CloudDocs", type: "FILE", name, etag: "synthetic-multigig-etag", parentId: DRIVE_ROOT, size: bytes, dateModified: 0 };
  let uploaded = false, allocations = 0, transfers = 0, commits = 0, upstreamFailure = null;
  let server, upstreamOrigin;
  if (network) {
    server = http.createServer((request, response) => {
      void (async () => {
        try {
          if (fault === "reject" || fault === "early-success") {
            // A real HTTP peer may return headers without consuming the body.
            request.resume();
            response.writeHead(fault === "reject" ? 413 : 200, { "content-type": "application/json", connection: "close" });
            response.end(JSON.stringify({ singleFile: { referenceChecksum: "synthetic-reference", fileChecksum: "synthetic-checksum", wrappingKey: "synthetic-key", size: bytes } }));
            return;
          }
          await inspectRawUpload({ headers: new Headers(request.headers), body: Readable.toWeb(request) }, bytes, hash, report, delayMs);
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ singleFile: { referenceChecksum: "synthetic-reference", fileChecksum: "synthetic-checksum", wrappingKey: "synthetic-key", size: bytes } }));
        } catch (error) {
          upstreamFailure = String(error); response.writeHead(400); response.end("Synthetic multipart validation failed.");
        }
      })();
    });
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    upstreamOrigin = `http://127.0.0.1:${server.address().port}`;
  }
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
      if (network) {
        const response = await nodeFetch(upstreamOrigin, { method: "POST", headers: localAppleContentHeaders(request.headers),
          body: request.body, duplex: "half", redirect: "manual", signal: request.signal });
        return new Response(await response.arrayBuffer(), { status: response.status, headers: response.headers });
      }
      if (fault === "reject") return new Response(null, { status: 413 });
      if (fault === "early-success") return json({ singleFile: { referenceChecksum: "synthetic-reference", fileChecksum: "synthetic-checksum", wrappingKey: "synthetic-key", size: bytes } });
      try { await inspectRawUpload(request, bytes, hash, report); } catch (error) { upstreamFailure = String(error); throw error; }
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
      return new Response(generated(size), { status: range ? 206 : 200, headers: range ? { "content-length": String(size), "content-range": `bytes ${range[1]}-${range[2]}/${bytes}` } : {} });
    }
    throw new Error("Unexpected synthetic multi-gigabyte upstream request.");
  };
  let worker;
  try {
    worker = new Miniflare({ ...options, name: "multipart-drive-acceptance", d1Databases: { DB: "multipart-drive-db" }, d1Persist: false, r2Buckets: streaming ? [] : ["BUCKET"], r2Persist: false,
      // Route synthetic uploads through the fake HTTP origin; socket wire tests are separate.
      bindings: { DRIVE_UPLOAD_TRANSPORT: "fetch", ...options.bindings, APP_ORIGIN: origin, REMINDERS_OWNER_ID: owner, TEAM_DOMAIN: team, POLICY_AUD: audience, ENCRYPTION_KEY_ID: "synthetic", ENCRYPTION_KEYS_JSON: JSON.stringify({ synthetic: secret }), LIVE_APPLE_CONNECTION_APPROVED: "controlled-device-v2", APPLE_CRYPTO_REVIEW_APPROVED: "device-proof-v2", APPLE_SESSION_RETENTION_WRITES: "absolute-30d-v1" }, outboundService, log: new Log(LogLevel.ERROR) });
    const db = await worker.getD1Database("DB"), bucket = streaming ? null : await worker.getR2Bucket("BUCKET");
    const statements = (await readFile(join(root, "schema.sql"), "utf8")).replace(/^\s*--.*$/gm, "").split(";").map(value => value.trim()).filter(Boolean);
    await db.batch(statements.map(sql => db.prepare(sql)));
    const settings = { ...structuredClone(DEFAULT_SERVICE_SETTINGS), drive: { enabled: true, browse: true, contents: true, upload: true, organize: false } };
    await db.prepare("INSERT INTO owner_service_settings (owner_id,revision,settings_json,updated_at) VALUES (?,1,?,?)").bind(owner, JSON.stringify(settings), Date.now()).run();
    const session = { login: loginAssurance(), auth: { clientId: identity.clientId, headers: {}, cookies: [{ name: "X-APPLE-WEBAUTH-VALIDATE", value: "v=1:t=synthetic-multigig", domain: "icloud.com", hostOnly: false, path: "/", secure: true, expiresAt: null }] }, connection: { ...identity, cloudKitURL: "https://p01-ckdatabasews.icloud.com/database/1/com.apple.reminders/production/private" }, pcs: { consentRequested: true, pcsAttempts: 1, consentChecks: 1, expiresAt: Date.now() + 300_000, nextAttemptAt: 0 }, services: { version: 1, reminders: { state: "DEVICE_APPROVAL_PENDING", action: "wait-for-reminders-keys", pcs: { consentRequested: true, pcsAttempts: 1, consentChecks: 1, expiresAt: Date.now() + 300_000, nextAttemptAt: 0 } }, drive: { state: "READY", connection } } };
    const envelope = await new Envelopes("synthetic", { synthetic: secret }).encrypt(session, { ownerId: owner, accountId: "apple-reminders", generation: 1, recordId: "apple-session", schemaVersion: 1 });
    await db.prepare("INSERT INTO apple_session_state (owner_id,account_id,generation,version,state,envelope,updated_at) VALUES (?,'apple-reminders',1,1,'READY',?,?)").bind(owner, JSON.stringify(envelope), Date.now()).run();
    const request = (path, { body, binary = false, checksum, range, wrongOrigin = false } = {}) => worker.dispatchFetch(origin + path, { method: body === undefined ? "GET" : "POST", headers: { "oai-authenticated-user-id": owner, "cf-access-jwt-assertion": assertion, origin: wrongOrigin ? "https://other.example.test" : origin, "content-type": binary ? "application/octet-stream" : "application/json", accept: "application/json, text/event-stream", ...(checksum ? { "x-content-sha256": checksum } : {}), ...(range ? { range } : {}) }, ...(body === undefined ? {} : { body }) });
    const post = async (path, input) => {
      const response = await request(path, { body: JSON.stringify(input) }), value = await response.json();
      assert.equal(response.status, 200, JSON.stringify({ value, allocations, transfers, commits, upstreamFailure })); return value;
    };
    const mcp = async (name, args) => {
      const value = await post("/mcp", { jsonrpc: "2.0", id: randomUUID(), method: "tools/call", params: { name, arguments: args } });
      assert.ok(!value.result.isError, JSON.stringify(value)); return value.result.structuredContent;
    };
    const operationId = randomUUID(), input = { operationId, parentId: DRIVE_ROOT, name, size: bytes, sha256: hash, contentType: "application/octet-stream" };
    if (fault === "checksum") input.sha256 = "0".repeat(64);
    if (streaming) {
      const authorized = capability ? await mcp("upload_icloud_drive_file", { ...input, contentBase64: "" }) : null;
      const prepared = capability ? { ...authorized, socketPath: new URL(authorized.transfer.url).pathname } : await post("/api/drive/prepare-stream-upload", input);
      assert.deepEqual([allocations, transfers, commits], [0, 0, 0]);
      const headers = { ...(capability ? authorized.transfer.headers : { "oai-authenticated-user-id": owner, "cf-access-jwt-assertion": assertion, origin }), upgrade: "websocket", "sec-websocket-protocol": legacyProtocol ? DRIVE_STREAM_LEGACY_PROTOCOL : DRIVE_STREAM_PROTOCOL };
      assert.equal((await worker.dispatchFetch(origin + prepared.socketPath, { headers: { ...headers, origin: "https://other.example.test" } })).status, 403);
      assert.equal((await worker.dispatchFetch(origin + prepared.socketPath, { headers: { ...headers, "sec-websocket-protocol": "invalid" } })).status, 400);
      assert.equal((await worker.dispatchFetch(origin + prepared.socketPath, { headers: { ...headers, upgrade: "" } })).status, 426);
      if (capability) {
        assert.equal((await worker.dispatchFetch(origin + prepared.socketPath, { headers: { upgrade: "websocket", "sec-websocket-protocol": legacyProtocol ? DRIVE_STREAM_LEGACY_PROTOCOL : DRIVE_STREAM_PROTOCOL } })).status, 403);
        assert.equal((await worker.dispatchFetch(origin + prepared.socketPath, { headers: { ...headers, Authorization: "Bearer guessed" } })).status, 403);
        assert.deepEqual([allocations, transfers, commits], [0, 0, 0]);
      }
      assert.equal((await request(`/api/drive/uploads/${operationId}/content`, { body: new Uint8Array(), binary: true })).status, 409);
      const sendFile = async replay => {
        const response = await worker.dispatchFetch(origin + prepared.socketPath, { headers });
        assert.equal(response.status, 101, response.status === 101 ? undefined : await response.text());
        const socket = response.webSocket, queue = [];
        let waiting, ended = false, offset = 0;
        socket.binaryType = "arraybuffer";
        socket.addEventListener("message", event => {
          const message = JSON.parse(event.data);
          if (waiting) { const next = waiting; waiting = null; next.resolve(message); } else queue.push(message);
        });
        socket.addEventListener("close", () => { ended = true; if (waiting) { waiting.reject(new Error("Stream closed without a saved result.")); waiting = null; } });
        socket.accept();
        try {
          for (;;) {
            const message = queue.length ? queue.shift() : await new Promise((resolve, reject) => {
              if (ended) { reject(new Error("Stream closed without a saved result.")); return; }
              const timer = setTimeout(() => reject(new Error("Direct upload message timed out.")), 60_000);
              waiting = { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } };
            });
            assert.equal(message.operationId, operationId);
            if (fault && message.type === "failed") {
              assert.equal(typeof message.error?.code, "string");
              assert.equal(typeof message.error?.message, "string");
              return;
            }
            assert.notEqual(message.type, "failed", JSON.stringify({ message, upstreamFailure }));
            if (message.type === "result") {
              assert.equal(message.operation.phase, "confirmed");
              assert.equal(message.operation.result.item.size, bytes);
              assert.equal(offset, replay ? 0 : bytes); break;
            }
            assert.equal(replay, false, "receipt replay never requests file bytes");
            assert.equal(message.type, "pull"); assert.equal(message.offset, offset);
            assert.equal(message.bytes, Math.min(frameBytes, bytes - offset));
            if (fault === "disconnect") { socket.close(); return; }
            if (fault === "frame") { socket.send(new Uint8Array(1)); continue; }
            socket.send(new Uint8Array(message.bytes).fill(90)); offset += message.bytes;
            if (offset % (256 * 1024 ** 2) === 0) report(`Streamed ${offset} of ${bytes} bytes without R2.`);
          }
        } finally { if (socket.readyState === 1) socket.close(); }
      };
      await sendFile(false);
      if (fault) {
        let operation;
        for (let attempt = 0; attempt < 40; attempt++) {
          operation = await post("/api/drive/operation", { operationId });
          if (operation.phase === "unknown") break;
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        assert.equal(operation.phase, "unknown");
        const beforeReplay = [allocations, transfers, commits];
        assert.equal((capability ? await mcp("upload_icloud_drive_file", { ...input, contentBase64: "" }) : await post("/api/drive/prepare-stream-upload", input)).phase, "unknown");
        const replay = await worker.dispatchFetch(origin + prepared.socketPath, { headers });
        assert.equal(replay.status, 503);
        assert.equal((await replay.json()).error.code, "WRITE_OUTCOME_UNKNOWN");
        assert.deepEqual([allocations, transfers, commits], beforeReplay);
        assert.equal(commits, 0);
        return { result: "passed", transport: "websocket", r2Bound: false, ...(network ? { upstream: "real-local-http" } : {}), fault, unsafeReplayPrevented: true };
      }
      await sendFile(true);
    } else {
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
    }
    assert.deepEqual([allocations, transfers, commits], [1, 1, 1]);
    report("Downloading the complete generated file through the production Worker.");
    const handle = capability ? await mcp("download_icloud_drive_file", { itemId }) : await post("/api/drive/download", { itemId });
    const download = capability ? await worker.dispatchFetch(handle.transfer.url, { headers: handle.transfer.headers }) : await request(handle.url);
    assert.equal(download.status, 200); assert.equal(download.headers.get("content-length"), String(bytes));
    assert.deepEqual(await hashStream(download.body), { size: bytes, sha256: hash });
    const fresh = capability ? await mcp("download_icloud_drive_file", { itemId }) : await post("/api/drive/download", { itemId });
    const start = bytes - 17, ranged = capability
      ? await worker.dispatchFetch(fresh.transfer.url, { headers: { ...fresh.transfer.headers, range: `bytes=${start}-${bytes - 1}` } })
      : await request(fresh.url, { range: `bytes=${start}-${bytes - 1}` });
    assert.equal(ranged.status, 206); assert.equal(ranged.headers.get("content-range"), `bytes ${start}-${bytes - 1}/${bytes}`);
    assert.deepEqual(await hashStream(ranged.body), { size: 17, sha256: expectedHash(17) });
    assert.equal((capability ? await worker.dispatchFetch(fresh.transfer.url, { headers: fresh.transfer.headers }) : await request(fresh.url)).status, 409);
    return { bytes, sha256: hash, appleUploads: transfers, ...(capability ? { mcpAuthorized: true, browserIdentityOnTransfers: false } : {}), ...(network ? { upstream: "real-local-http", exactContentLength: true, delayPer32MiBMs: delayMs } : {}), ...(streaming ? { transport: "websocket", r2Bound: false, confirmedReplayWithoutBytes: true } : { resumedParts: true }), rangeVerified: true };
  } finally {
    await worker?.dispose();
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = JSON.parse(await readFile(join(root, "dist/server/wrangler.json"), "utf8")), server = join(root, "dist/server");
  const paths = (await readdir(server, { recursive: true, withFileTypes: true })).filter(file => file.isFile() && /\.(?:js|mjs)$/.test(file.name)).map(file => join(file.parentPath, file.name));
  const entry = join(server, "index.js");
  const result = await verifyMultipartDrive({ modulesRoot: server, modules: [entry, ...paths.filter(path => path !== entry)].map(path => ({ type: "ESModule", path })), compatibilityDate: config.compatibility_date, compatibilityFlags: config.compatibility_flags, assets: { directory: join(root, "dist/client"), routerConfig: { has_user_worker: true } } }, { bytes: Number(process.env.DRIVE_LARGE_TEST_BYTES ?? DRIVE_FILE_BYTES), transport: process.env.DRIVE_LARGE_TEST_TRANSPORT ?? "multipart", network: process.env.DRIVE_LARGE_TEST_NETWORK === "1", delayMs: Number(process.env.DRIVE_LARGE_TEST_DELAY_MS ?? 0), fault: process.env.DRIVE_LARGE_TEST_FAULT, capability: process.env.DRIVE_LARGE_TEST_CAPABILITY === "1", report: console.log });
  console.log(JSON.stringify(result));
}
