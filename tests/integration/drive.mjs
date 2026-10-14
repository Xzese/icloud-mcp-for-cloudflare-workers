// One production-bundle Drive journey in workerd, backed only by synthetic Apple responses.
import assert from "node:assert/strict";
import { randomBytes, createHash, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Miniflare, Log, LogLevel } from "miniflare";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { Envelopes } from "../../src/crypto/envelopes.ts";
import { loginAssurance } from "../../src/auth/apple/policy.ts";
import { DRIVE_ROOT } from "../../src/icloud/drive.ts";
import { DEFAULT_SERVICE_SETTINGS } from "../../src/services/settings.ts";

const root = resolve(new URL("../..", import.meta.url).pathname);
const origin = "https://drive-private.example.test";
const owner = "synthetic-drive-owner";
const dsid = "123456789";
const driveConnection = {
  dsid, clientId: "synthetic-drive-client", clientBuildNumber: "2534Project66", clientMasteringNumber: "2534B22",
  driveURL: "https://p01-drivews.icloud.com", documentsURL: "https://p01-docws.icloud.com",
};
const uploadedId = "FILE::com.apple.CloudDocs::synthetic-upload";
const uploadedDocId = "synthetic-upload";
const uploadedName = "synthetic-large.bin";
const sharedDescriptor = { recordName: "synthetic-shared-record" };
const sharedFolder = { drivewsid: "FOLDER::com.apple.CloudDocs::shared-root", docwsid: "shared-root", zone: "com.apple.CloudDocs", name: "Shared Fixture", type: "FOLDER", etag: "shared-etag", parentId: DRIVE_ROOT, shareID: sharedDescriptor, owner: { ownerRecordName: "synthetic-owner" } };
const sharedChild = { drivewsid: "FOLDER_IN_SHARED_FOLDER::com.apple.CloudDocs::shared-child", docwsid: "shared-child", item_id: "private-docws-child", zone: "com.apple.CloudDocs", name: "01", type: "FOLDER", etag: "child-etag", parentId: sharedFolder.drivewsid };
const fileItem = (size, etag = "synthetic-upload-etag") => ({
  drivewsid: uploadedId, docwsid: uploadedDocId, zone: "com.apple.CloudDocs", name: uploadedName, type: "FILE", etag,
  parentId: DRIVE_ROOT, size, dateModified: 1_800_000_000_000,
});
const json = value => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
async function bytesOf(stream) {
  const chunks = []; let length = 0;
  const reader = stream.getReader();
  for (;;) { const { value, done } = await reader.read(); if (done) break; chunks.push(value); length += value.byteLength; }
  const result = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

export async function verifyDrive(options) {
  const secret = randomBytes(32).toString("base64");
  const payloadBytes = randomBytes(300 * 1024);
  payloadBytes.fill(65, 0, 8192); // A valid text prefix; the preview never validates its unread suffix.
  const payloadHash = createHash("sha256").update(payloadBytes).digest("hex");
  const syntheticUrl = new URL("/B/invented-signature/file", "https://cvws.icloud-content.com");
  syntheticUrl.searchParams.set("token", randomUUID());
  const teamDomain = "https://synthetic.cloudflareaccess.com";
  const audience = "synthetic-drive-acceptance-audience";
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const kid = randomUUID();
  const jwk = { ...await exportJWK(publicKey), kid, use: "sig", alg: "RS256" };
  const assertion = await new SignJWT({ email: "synthetic@example.invalid" })
    .setProtectedHeader({ alg: "RS256", kid }).setIssuer(teamDomain).setAudience(audience).setSubject(owner)
    .setIssuedAt().setExpirationTime("5m").sign(privateKey);
  let allocations = 0, transfers = 0, finalizations = 0, downloads = 0;
  let transferError = null;
  let finalizationPayload = null;
  let uploaded = false;
  let packageDownload = false, redirectDownload = false;
  let observedUpload = null;
  const outboundService = async request => {
    const url = new URL(request.url);
    if (url.origin === teamDomain && url.pathname === "/cdn-cgi/access/certs") return json({ keys: [jwk] });
    if (url.hostname === "p01-drivews.icloud.com" && ["/retrieveItemDetailsInFolders", "/retrieveItemDetails"].includes(url.pathname)) {
      const payload = await request.clone().json();
      const lookup = Array.isArray(payload) ? payload[0] : payload;
      const entry = lookup.items?.[0] ?? lookup;
      const { drivewsid } = entry;
      assert.equal(url.pathname, drivewsid === uploadedId ? "/retrieveItemDetails" : "/retrieveItemDetailsInFolders");
      if (drivewsid === DRIVE_ROOT) return json([{ drivewsid: DRIVE_ROOT, docwsid: "root", zone: "com.apple.CloudDocs", name: "root", type: "FOLDER", etag: "synthetic-root-etag", parentId: null, items: [sharedFolder, ...(uploaded ? [fileItem(payloadBytes.length)] : [])], directChildrenCount: uploaded ? 2 : 1 }]);
      if (drivewsid === sharedFolder.drivewsid || drivewsid === sharedChild.drivewsid) {
        assert.deepEqual(entry.shareID, sharedDescriptor);
        return json([{ ...(drivewsid === sharedFolder.drivewsid ? sharedFolder : sharedChild), items: drivewsid === sharedFolder.drivewsid ? [sharedChild] : [], directChildrenCount: drivewsid === sharedFolder.drivewsid ? 1 : 0 }]);
      }
      assert.equal(drivewsid, uploadedId, "post-commit and metadata reads must look up the exact uploaded identity");
      assert.equal(uploaded, true, "the exact file lookup is available only after the synthetic commit");
      return json({ items: [fileItem(payloadBytes.length)] });
    }
    if (url.hostname === "p01-docws.icloud.com" && url.pathname === "/v1/item/private-docws-child") {
      return json({ item_id: "private-docws-child", item_info: { name: "01", type: "FOLDER", version: "child-etag", size: "0" } });
    }
    if (url.hostname === "p01-docws.icloud.com" && url.pathname === "/v1/enumerate/private-docws-child") {
      return json({ drive_item: [] });
    }
    if (url.hostname === "p01-docws.icloud.com" && url.pathname === "/ws/com.apple.CloudDocs/upload/web") {
      allocations++;
      assert.equal(request.headers.has("cookie"), true, "allocation uses the authenticated Apple session");
      const body = await request.clone().json();
      assert.deepEqual(body, { filename: uploadedName, type: "FILE", content_type: "application/octet-stream", size: payloadBytes.length });
      assert.equal(url.searchParams.get("token"), "synthetic-validation-token");
      return json([{ document_id: uploadedDocId, url: "https://cws.icloud-content.com/123456789/singleFileUpload?tk=synthetic-upload-token" }]);
    }
    if (url.hostname === "cws.icloud-content.com") {
      transfers++;
      assert.equal(request.headers.has("cookie"), false, "Apple upload content requests carry no Apple cookies");
      let body, binaryOffset;
      try {
        body = await bytesOf(request.body);
        binaryOffset = Buffer.from(body).indexOf(Buffer.from(payloadBytes.subarray(0, 32)));
        assert.notEqual(binaryOffset, -1, "the multipart transfer body must be consumed and contain the exact uploaded bytes");
        assert.ok(binaryOffset + payloadBytes.length <= body.length);
        assert.ok(Buffer.from(body.subarray(binaryOffset, binaryOffset + payloadBytes.length)).equals(Buffer.from(payloadBytes)));
        observedUpload = { byteLength: body.length, fileByteLength: payloadBytes.length, fileHash: createHash("sha256").update(body.subarray(binaryOffset, binaryOffset + payloadBytes.length)).digest("hex") };
      } catch (error) { transferError = String(error); throw error; }
      return json({ singleFile: { referenceChecksum: "synthetic-reference-checksum", size: payloadBytes.length, fileChecksum: "synthetic-file-checksum", wrappingKey: "synthetic-wrapping-key" } });
    }
    if (url.hostname === "p01-docws.icloud.com" && url.pathname === "/ws/com.apple.CloudDocs/update/documents") {
      finalizations++;
      const body = await request.clone().json();
      finalizationPayload = body;
      assert.equal(body.command, "add_file");
      assert.equal(body.document_id, uploadedDocId);
      assert.equal(body.path.path, uploadedName);
      assert.equal(body.path.starting_document_id, "root");
      uploaded = true;
      return json({ status: { status_code: 0 }, results: [{ status: { status_code: 0 }, document: { document_id: uploadedDocId, zone: "com.apple.CloudDocs", parent_id: "root", name: uploadedName, type: "FILE", etag: "synthetic-upload-etag", size: payloadBytes.length } }] });
    }
    if (url.hostname === "p01-docws.icloud.com" && url.pathname === "/ws/com.apple.CloudDocs/download/by_id") {
      assert.equal(url.searchParams.get("document_id"), uploadedDocId, "download preparation pins the exact document ID");
      return json({ document_id: uploadedDocId, [packageDownload ? "package_token" : "data_token"]: { url: syntheticUrl.href } });
    }
    if (url.hostname === "cvws.icloud-content.com") {
      downloads++;
      assert.equal(request.headers.has("cookie"), false, "signed content download carries no Apple cookies");
      if (redirectDownload && url.pathname.endsWith("/file")) {
        const destination = new URL(syntheticUrl); destination.pathname += "-redirected";
        return new Response(null, { status: 330, headers: { location: destination.href } });
      }
      const range = request.headers.get("range");
      if (range) {
        assert.equal(range, "bytes=2-5");
        return new Response(payloadBytes.subarray(2, 6), { status: 206, headers: { "Content-Range": `bytes 2-5/${payloadBytes.length}`, "Content-Length": "4" } });
      }
      return new Response(packageDownload ? new TextEncoder().encode("synthetic zip") : payloadBytes, { headers: { "content-type": packageDownload ? "application/zip" : "application/octet-stream", "set-cookie": "synthetic=private", location: "https://example.invalid" } });
    }
    throw new Error(`Unexpected synthetic Drive request: ${request.method} ${url.hostname}${url.pathname}`);
  };

  let worker;
  try {
    worker = new Miniflare({
      ...options,
      name: "drive-acceptance",
      d1Persist: false,
      d1Databases: { DB: "drive-acceptance-db" },
      bindings: {
        ...options.bindings,
        APP_ORIGIN: origin,
        REMINDERS_OWNER_ID: owner,
        TEAM_DOMAIN: teamDomain,
        POLICY_AUD: audience,
        ENCRYPTION_KEY_ID: "synthetic",
        ENCRYPTION_KEYS_JSON: JSON.stringify({ synthetic: secret }),
        LIVE_APPLE_CONNECTION_APPROVED: "controlled-device-v2",
        APPLE_CRYPTO_REVIEW_APPROVED: "device-proof-v2",
        APPLE_SESSION_RETENTION_WRITES: "absolute-30d-v1",
      },
      outboundService,
      log: new Log(LogLevel.ERROR),
    });
    const db = await worker.getD1Database("DB");
    const rawSchema = await readFile(join(root, "schema.sql"), "utf8");
    const statements = rawSchema.replace(/^\s*--.*$/gm, "").split(";").map(part => part.trim()).filter(Boolean);
    await db.batch(statements.map(statement => db.prepare(statement)));

    const settings = { ...structuredClone(DEFAULT_SERVICE_SETTINGS), drive: { enabled: true, browse: true, contents: true, upload: true, organize: false } };
    await db.prepare("INSERT INTO owner_service_settings (owner_id, revision, settings_json, updated_at) VALUES (?, 1, ?, ?)").bind(owner, JSON.stringify(settings), Date.now()).run();
    const generation = 1;
    const session = {
      login: loginAssurance(),
      auth: { clientId: driveConnection.clientId, headers: {}, cookies: [{ name: "X-APPLE-WEBAUTH-VALIDATE", value: "v=1:t=synthetic-validation-token", domain: "icloud.com", hostOnly: false, path: "/", secure: true, expiresAt: null }] },
      connection: { dsid, clientId: driveConnection.clientId, clientBuildNumber: driveConnection.clientBuildNumber, clientMasteringNumber: driveConnection.clientMasteringNumber, cloudKitURL: "https://p01-ckdatabasews.icloud.com/database/1/com.apple.reminders/production/private" },
      pcs: { consentRequested: true, pcsAttempts: 1, consentChecks: 1, expiresAt: Date.now() + 300_000, nextAttemptAt: 0 },
      services: { version: 1, reminders: { state: "DEVICE_APPROVAL_PENDING", pcs: { consentRequested: true, pcsAttempts: 1, consentChecks: 1, expiresAt: Date.now() + 300_000, nextAttemptAt: 0 }, action: "wait-for-reminders-keys" }, drive: { state: "READY", connection: driveConnection } },
    };
    const context = { ownerId: owner, accountId: "apple-reminders", generation, recordId: "apple-session", schemaVersion: 1 };
    const envelope = await new Envelopes("synthetic", { synthetic: secret }).encrypt(session, context);
    await db.prepare("INSERT INTO apple_session_state (owner_id, account_id, generation, version, state, envelope, updated_at) VALUES (?, 'apple-reminders', ?, 1, 'READY', ?, ?)")
      .bind(owner, generation, JSON.stringify(envelope), Date.now()).run();

    const request = async (path, { method = "GET", body, binary = false, user = owner, range } = {}) => {
      const headers = { "cf-access-jwt-assertion": assertion, "oai-authenticated-user-id": user, "oai-authenticated-user-email": "synthetic@example.invalid" };
      if (range) headers.range = range;
      if (method === "POST") Object.assign(headers, binary ? { origin, "content-type": "application/octet-stream" } : { origin, "content-type": "application/json", accept: "application/json, text/event-stream" });
      return worker.dispatchFetch(origin + path, { method, headers, ...(body === undefined ? {} : { body }) });
    };
    const mcp = async (method, params) => {
      const response = await request("/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method, params }) });
      const value = await response.json();
      assert.equal(response.status, 200, JSON.stringify(value));
      return value;
    };
    const listedTools = await mcp("tools/list", {});
    assert.ok(listedTools.result.tools.some(tool => tool.name === "list_icloud_drive_items" && tool.outputSchema.properties.items));
    assert.ok(listedTools.result.tools.some(tool => tool.name === "get_icloud_drive_item" && tool.outputSchema.properties.item));
    assert.ok(listedTools.result.tools.some(tool => tool.name === "resolve_icloud_drive_folder_path" && tool.outputSchema.properties.parentListing));
    const missingPath = await mcp("tools/call", { name: "resolve_icloud_drive_folder_path", arguments: { expectedGeneration: generation, path: "Documents/Snap Heaven/01/FY 2026" } });
    assert.equal(missingPath.result.isError, undefined, JSON.stringify(missingPath));
    assert.equal(missingPath.result.structuredContent.status, "not_found");
    assert.equal(missingPath.result.structuredContent.reason, "folder_not_found");
    assert.equal(missingPath.result.structuredContent.parentListing.complete, true);
    const httpPath = await request("/api/drive/resolve-folder-path", { method: "POST", body: JSON.stringify({ expectedGeneration: generation, path: "Documents" }) });
    assert.equal(httpPath.status, 200);
    assert.equal((await httpPath.json()).status, "not_found");
    const resolvedShare = await mcp("tools/call", { name: "resolve_icloud_drive_folder_path", arguments: { expectedGeneration: generation, path: "Shared Fixture/01" } });
    assert.equal(resolvedShare.result.isError, undefined, JSON.stringify(resolvedShare));
    const sharedItem = resolvedShare.result.structuredContent.folder;
    assert.equal(resolvedShare.result.structuredContent.status, "resolved");
    assert.equal(sharedItem.id, sharedChild.drivewsid);
    assert.ok(sharedItem.shareContext);
    assert.ok(!JSON.stringify(resolvedShare.result.structuredContent).includes("synthetic-shared-record"));
    const sharedListing = await request("/api/drive/list", { method: "POST", body: JSON.stringify({ folderId: sharedItem.id, shareContext: sharedItem.shareContext }) });
    assert.equal(sharedListing.status, 200);
    const sharedPage = await sharedListing.json();
    assert.equal(sharedPage.complete, false);
    assert.deepEqual(sharedPage.reasons, ["missing_direct_children_count"]);
    assert.equal(sharedPage.folder.id, sharedChild.drivewsid);
    assert.equal(sharedPage.folder.shareContext, sharedItem.shareContext);
    assert.equal(JSON.stringify(sharedPage).includes("private-docws"), false);

    const limitIntent = { operationId: randomUUID(), parentId: DRIVE_ROOT, name: "limit-boundary.bin", size: 64 * 1024 * 1024, sha256: "a".repeat(64), contentType: "application/octet-stream" };
    const acceptedLimit = await request("/api/drive/prepare-upload", { method: "POST", body: JSON.stringify(limitIntent) });
    assert.equal(acceptedLimit.status, 200);
    const rejectedLimit = await request("/api/drive/prepare-upload", { method: "POST", body: JSON.stringify({ ...limitIntent, operationId: randomUUID(), size: limitIntent.size + 1 }) });
    assert.equal(rejectedLimit.status, 400);
    assert.equal(allocations, 0, "Preparing the boundary or refusing oversize must not allocate Apple storage");

    const operationId = randomUUID();
    const metadataResponse = await request("/api/drive/prepare-upload", { method: "POST", body: JSON.stringify({ operationId, parentId: DRIVE_ROOT, name: uploadedName, size: payloadBytes.length, sha256: payloadHash, contentType: "application/octet-stream" }) });
    const prepared = await metadataResponse.json();
    assert.equal(metadataResponse.status, 200, JSON.stringify(prepared));
    assert.equal(prepared.operationId, operationId);
    const uploadResponse = await request(`/api/drive/uploads/${operationId}/content`, { method: "POST", body: payloadBytes, binary: true });
    const confirmed = await uploadResponse.json();
    assert.equal(uploadResponse.status, 200, JSON.stringify({ confirmed, allocations, transfers, finalizations, uploaded, finalizationPayload, observedUpload, transferError }));
    assert.equal(confirmed.phase, "confirmed");
    assert.equal(confirmed.result.item.id, uploadedId);
    assert.equal(confirmed.result.item.documentId, uploadedDocId);
    assert.equal(confirmed.result.item.size, payloadBytes.length);
    assert.deepEqual(observedUpload && { fileByteLength: observedUpload.fileByteLength, fileHash: observedUpload.fileHash }, { fileByteLength: payloadBytes.length, fileHash: payloadHash });
    const replay = await (await request("/api/drive/operation", { method: "POST", body: JSON.stringify({ operationId }) })).json();
    assert.equal(replay.phase, "confirmed");
    assert.equal(replay.result.item.id, uploadedId);
    assert.deepEqual([allocations, transfers, finalizations], [1, 1, 1], "repeating the same operation key must not dispatch a second Apple upload or commit");

    const listCall = await mcp("tools/call", { name: "list_icloud_drive_items", arguments: { expectedGeneration: generation, folderId: DRIVE_ROOT } });
    assert.equal(listCall.result.isError, undefined, JSON.stringify(listCall));
    assert.deepEqual(listCall.result.structuredContent.reasons, []);
    assert.equal(listCall.result.structuredContent.counts.returned, 2);
    const typedItem = listCall.result.structuredContent.items.find(item => item.id === uploadedId);
    assert.equal(typedItem.documentId, uploadedDocId);
    assert.equal(typedItem.size, payloadBytes.length);
    assert.equal(Object.hasOwn(typedItem, "raw"), false);
    const getCall = await mcp("tools/call", { name: "get_icloud_drive_item", arguments: { expectedGeneration: generation, itemId: typedItem.id } });
    assert.equal(getCall.result.structuredContent.item.documentId, uploadedDocId);
    assert.equal(getCall.result.structuredContent.item.etag, "synthetic-upload-etag");

    const preparedDownload = await mcp("tools/call", { name: "download_icloud_drive_file", arguments: { expectedGeneration: generation, itemId: typedItem.id } });
    assert.equal(preparedDownload.result.structuredContent.item.documentId, uploadedDocId);
    assert.equal(preparedDownload.result.structuredContent.url, `/api/drive/downloads/${preparedDownload.result.structuredContent.handleId}`);
    assert.equal(JSON.stringify(preparedDownload.result.structuredContent).includes("icloud-content"), false);
    const downloadResponse = await request(preparedDownload.result.structuredContent.url);
    assert.equal(downloadResponse.status, 200);
    assert.equal(downloadResponse.headers.get("set-cookie"), null);
    assert.match(downloadResponse.headers.get("content-disposition"), /attachment/);
    assert.ok(Buffer.from(await downloadResponse.arrayBuffer()).equals(Buffer.from(payloadBytes)));
    assert.equal((await request(preparedDownload.result.structuredContent.url)).status, 409, "download handles are single-use");
    assert.equal(downloads, 1);

    const oversizedRead = await mcp("tools/call", { name: "read_icloud_drive_file", arguments: { expectedGeneration: generation, itemId: typedItem.id } });
    assert.equal(oversizedRead.result.isError, true);
    assert.match(oversizedRead.result.structuredContent.error.message, /64 KiB.*previewBytes/);
    assert.equal(downloads, 1, "oversized full reads are refused before requesting Apple content");
    const previewCall = await mcp("tools/call", { name: "read_icloud_drive_file", arguments: { expectedGeneration: generation, itemId: typedItem.id, previewBytes: 8192 } });
    assert.equal(previewCall.result.isError, undefined, JSON.stringify(previewCall));
    assert.equal(previewCall.result.structuredContent.bytesRead, 8192);
    assert.equal(previewCall.result.structuredContent.truncated, true);
    assert.equal(previewCall.result.structuredContent.content, Buffer.from(payloadBytes.subarray(0, 8192)).toString("utf8"));
    assert.equal(downloads, 2);

    const rangeHandle = await mcp("tools/call", { name: "download_icloud_drive_file", arguments: { itemId: typedItem.id } });
    redirectDownload = true;
    const rangeResponse = await request(rangeHandle.result.structuredContent.url, { range: "bytes=2-5" });
    assert.equal(rangeResponse.status, 206);
    assert.equal(rangeResponse.headers.get("content-range"), `bytes 2-5/${payloadBytes.length}`);
    assert.ok(Buffer.from(await rangeResponse.arrayBuffer()).equals(Buffer.from(payloadBytes.subarray(2, 6))));
    assert.equal((await request(rangeHandle.result.structuredContent.url, { range: "bytes=2-5" })).status, 409);
    redirectDownload = false; packageDownload = true;
    const packageHandle = await mcp("tools/call", { name: "download_icloud_drive_file", arguments: { itemId: typedItem.id } });
    const archive = await request(packageHandle.result.structuredContent.url);
    assert.equal(archive.status, 200);
    assert.equal(archive.headers.get("content-length"), null);
    assert.ok(archive.headers.get("content-disposition").includes(".zip"));
    assert.equal(await archive.text(), "synthetic zip");
    packageDownload = false;
    const downloadsBeforeRevocation = downloads;

    const settingsRow = await db.prepare("SELECT revision, settings_json FROM owner_service_settings WHERE owner_id = ?").bind(owner).first();
    const revoked = JSON.parse(settingsRow.settings_json);
    revoked.drive.contents = false;
    await db.prepare("UPDATE owner_service_settings SET revision = revision + 1, settings_json = ? WHERE owner_id = ?").bind(JSON.stringify(revoked), owner).run();
    const staleRead = await mcp("tools/call", { name: "read_icloud_drive_file", arguments: { expectedGeneration: generation, itemId: typedItem.id, encoding: "base64" } });
    assert.equal(staleRead.result.isError, true, JSON.stringify(staleRead));
    const revokedRead = await request("/api/drive/read", { method: "POST", body: JSON.stringify({ expectedGeneration: generation, itemId: typedItem.id, encoding: "base64" }) });
    const revokedReadBody = await revokedRead.json();
    assert.equal(revokedRead.status, 403, JSON.stringify(revokedReadBody));
    assert.equal(revokedReadBody.error.code, "FORBIDDEN");
    assert.equal(downloads, downloadsBeforeRevocation, "revoked content access must not issue another Apple content request");
    return {
      checks: ["signed-owner-origin", "300-KiB-streaming-upload", "exact-document-commit-and-idempotent-replay", "typed-MCP-metadata", "shared-path-and-persisted-private-context", "private-single-use-download", "docws-shared-fallback", "validated-330-and-byte-ranges", "bounded-package-archive", "64-KiB-inline-guidance-and-8-KiB-preview", "contents-permission-revocation"],
      uploadedBytes: payloadBytes.length, operationId, metadataTools: 2,
      outboundTransferBytes: observedUpload?.byteLength ?? 0, appleUploadRequests: allocations + transfers + finalizations, downloads,
    };
  } finally {
    await worker?.dispose();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = JSON.parse(await readFile(join(root, "dist/server/wrangler.json"), "utf8"));
  const serverRoot = join(root, "dist/server");
  const files = await readdir(serverRoot, { recursive: true, withFileTypes: true });
  const paths = files.filter(entry => entry.isFile() && /\.(?:js|mjs)$/.test(entry.name)).map(entry => join(entry.parentPath, entry.name));
  const entrypoint = join(serverRoot, "index.js");
  const result = await verifyDrive({
    modulesRoot: serverRoot, unsafeTriggerHandlers: true,
    modules: [entrypoint, ...paths.filter(path => path !== entrypoint)].map(path => ({ type: "ESModule", path })),
    compatibilityDate: config.compatibility_date, compatibilityFlags: config.compatibility_flags,
    bindings: { APP_ORIGIN: origin, REMINDERS_OWNER_ID: owner },
    assets: { directory: join(root, "dist/client"), routerConfig: { has_user_worker: true } },
    log: new Log(LogLevel.ERROR),
  });
  console.log(`Drive production-bundle journey passed (${result.uploadedBytes} bytes streamed).`);
}
