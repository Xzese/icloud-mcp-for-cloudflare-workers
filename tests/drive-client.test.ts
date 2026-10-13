import test from "node:test";
import assert from "node:assert/strict";
import { AppError } from "../src/errors.ts";
import { DriveClient, DRIVE_ROOT, UploadReceiptSchema, type DriveConnection } from "../src/icloud/drive.ts";
import { AppleHTTP } from "../src/transport/apple-http.ts";
import { CookieJar } from "../src/transport/cookie-jar.ts";
import { driveContentURL, validateDriveMetadataURL } from "../src/transport/drive-http.ts";
import { sha256Stream } from "../src/lib/file-digest.ts";
import { createHash } from "node:crypto";

function syntheticDownloadURL() {
  const url = new URL("/B/invented-signature/test.bin", "https://cvws.icloud-content.com");
  url.searchParams.set("token", crypto.randomUUID());
  return url.href;
}

const connection: DriveConnection = {
  dsid: "123456789",
  clientId: "synthetic-client",
  clientBuildNumber: "2534Project66",
  clientMasteringNumber: "2534B22",
  driveURL: "https://p01-drivews.icloud.com/",
  documentsURL: "https://p01-docws.icloud.com/",
};
const folder = { drivewsid: "FOLDER::com.apple.CloudDocs::D5AA0425-E84F-4501-AF5D-60F1D92648CF", docwsid: "D5AA0425-E84F-4501-AF5D-60F1D92648CF", zone: "com.apple.CloudDocs", name: "Test", type: "FOLDER", etag: "2z", directChildrenCount: 2, items: [] };
const file = { drivewsid: "FILE::com.apple.CloudDocs::516C896C-6AA5-4A30-B30E-5502C2333DAE", docwsid: "516C896C-6AA5-4A30-B30E-5502C2333DAE", zone: "com.apple.CloudDocs", name: "Scanned document 1", extension: "pdf", type: "FILE", etag: "32::2x", size: 21644358, parentId: "FOLDER::com.apple.CloudDocs::D5AA0425-E84F-4501-AF5D-60F1D92648CF", dateModified: "2020-05-03T00:15:17Z" };
const rootItem = { drivewsid: DRIVE_ROOT, docwsid: "root", zone: "com.apple.CloudDocs", name: "", type: "FOLDER", etag: "31", directChildrenCount: 3, numberOfItems: 5, items: [] };

function makeClient(route: (url: URL, init: RequestInit) => Response | Promise<Response>) {
  const jar = new CookieJar();
  jar.set("X-APPLE-WEBAUTH-VALIDATE=t=synthetic-token:expiry; Path=/; Secure", new URL(connection.documentsURL));
  const http = new AppleHTTP(jar, ((input: RequestInfo | URL, init?: RequestInit) => route(new URL(input instanceof Request ? input.url : input.toString()), init ?? {})) as typeof fetch);
  return new DriveClient(http, connection);
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

test("Drive reads normalize exact owned identities and report count mismatches as incomplete", async () => {
  const client = makeClient((url, init) => {
    assert.equal(url.hostname, "p01-drivews.icloud.com");
    if (url.pathname === "/retrieveItemDetails") {
      assert.deepEqual(JSON.parse(String(init.body)), { items: [{ drivewsid: file.drivewsid, partialData: false, includeHierarchy: false }] });
      return json({ items: [{ ...file, status: 0 }] });
    }
    if (url.pathname.endsWith("retrieveItemDetailsInFolders")) {
      assert.equal(url.pathname, "/retrieveItemDetailsInFolders");
      const requested = JSON.parse(String(init.body)) as Array<{ drivewsid: string }>;
      return requested[0]?.drivewsid === DRIVE_ROOT
        ? json([{ ...rootItem }])
        : requested[0]?.drivewsid === file.drivewsid
        ? json([{ ...file, status: 0 }])
        : json([{ ...folder, items: [file], numberOfItems: 2 }]);
    }
    return json([{ ...file, status: 0 }]);
  });
  const listed = await client.listItems(folder.drivewsid);
  assert.equal(listed.folder.id, folder.drivewsid);
  assert.equal(listed.items[0]?.name, "Scanned document 1.pdf");
  assert.equal(listed.complete, false);
  assert.equal((await client.getItem(file.drivewsid)).documentId, file.docwsid);
  const root = await client.getItem(DRIVE_ROOT);
  assert.equal(root.name, "root");
  assert.equal(root.documentId, "root");

  const completeClient = makeClient(() => json([{ ...folder, directChildrenCount: 1, numberOfItems: 3, items: [file] }]));
  assert.equal((await completeClient.listItems(folder.drivewsid)).complete, true);
  const rootChild = { ...folder, drivewsid: "FOLDER::com.apple.CloudDocs::11223344-5566-7788-99AA-BBCCDDEEFF00", docwsid: "11223344-5566-7788-99AA-BBCCDDEEFF00", parentId: DRIVE_ROOT };
  const mixedRoot = makeClient(() => json([{ ...rootItem, directChildrenCount: 2, items: [{ drivewsid: "FOLDER::com.apple.Keynote::documents", docwsid: "documents", zone: "com.apple.Keynote", name: "Keynote", type: "APP_LIBRARY", etag: "app1", parentId: DRIVE_ROOT }, rootChild] }]));
  const rootListing = await mixedRoot.listItems(DRIVE_ROOT);
  assert.deepEqual(rootListing.items.map((entry) => entry.id), [rootChild.drivewsid]);
  assert.equal(rootListing.complete, false);
});

test("Drive refuses per-item errors, shared IDs, unsupported hosts, and redirects", async () => {
  const failed = makeClient(() => json([{ ...file, status: "ITEM_NOT_FOUND" }]));
  await assert.rejects(failed.getItem(file.drivewsid), AppError);
  const shared = makeClient(() => json([{ ...file, shareID: "synthetic-share" }]));
  await assert.rejects(shared.getItem(file.drivewsid), AppError);
  const prefixedDocumentId = makeClient(() => json([{ ...file, docwsid: `DOCUMENT::com.apple.CloudDocs::${file.docwsid}` }]));
  await assert.rejects(prefixedDocumentId.getItem(file.drivewsid), AppError);
  const mismatchedIdentity = makeClient(() => json({ items: [{ ...file, drivewsid: "FILE::com.apple.CloudDocs::516C896C-6AA5-4A30-B30E-5502C2333DAF" }] }));
  await assert.rejects(mismatchedIdentity.getItem(file.drivewsid), (error: unknown) => error instanceof AppError && error.code === "PROTOCOL_CHANGED");

  const wrongHost = makeClient((url) => url.pathname.endsWith("download/by_id")
    ? json({ data_token: { url: "https://attacker.example/B/synthetic?signature=secret" } })
    : json([{ ...file }]));
  await assert.rejects(wrongHost.download({ id: file.drivewsid, documentId: file.docwsid, zone: "com.apple.CloudDocs", name: "note.txt", type: "file", etag: file.etag, size: file.size, parentId: file.parentId, modifiedAt: "2026-10-13T12:00:00.000Z" }), AppError);

  const redirect = makeClient(() => new Response(null, { status: 302, headers: { location: "https://p02-drivews.icloud.com/elsewhere" } }));
  await assert.rejects(redirect.getItem(file.drivewsid), AppError);
});

test("Drive download streams bounded bytes without forwarding the Apple cookie", async () => {
  const client = makeClient((url, init) => {
    if (url.hostname === "p01-docws.icloud.com") return json({ data_token: { url: syntheticDownloadURL() } });
    assert.equal(url.hostname, "cvws.icloud-content.com");
    assert.equal(new Headers(init.headers).has("cookie"), false);
    return new Response(new Uint8Array([1, 2, 3]));
  });
  const response = await client.download({ id: file.drivewsid, documentId: file.docwsid, zone: "com.apple.CloudDocs", name: "note.txt", type: "file", etag: file.etag, size: 3, parentId: folder.drivewsid, modifiedAt: null });
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [1, 2, 3]);

  const redirected = makeClient((url) => url.hostname === "p01-docws.icloud.com"
    ? json({ data_token: { url: syntheticDownloadURL() } })
    : new Response(null, { status: 302, headers: { location: "https://attacker.example/collect" } }));
  await assert.rejects(redirected.download({ id: file.drivewsid, documentId: file.docwsid, zone: "com.apple.CloudDocs", name: "note.txt", type: "file", etag: file.etag, size: 3, parentId: folder.drivewsid, modifiedAt: null }), AppError);

  const emptyResponse = makeClient((url) => url.hostname === "p01-docws.icloud.com"
    ? json({ data_token: { url: syntheticDownloadURL() } })
    : new Response(null, { status: 200, headers: { "content-type": "application/octet-stream" } }));
  const noBody = await emptyResponse.download({ id: file.drivewsid, documentId: file.docwsid, zone: "com.apple.CloudDocs", name: "note.txt", type: "file", etag: file.etag, size: 3, parentId: folder.drivewsid, modifiedAt: null });
  assert.equal(noBody.body, null);
  assert.equal(noBody.headers.get("content-type"), "application/octet-stream");

  const limit = 64 * 1024 * 1024, chunk = new Uint8Array(64 * 1024).fill(65);
  let remaining = limit, requests = 0;
  const largeClient = makeClient(url => {
    requests++;
    if (url.hostname === "p01-docws.icloud.com") return json({ data_token: { url: syntheticDownloadURL() } });
    return new Response(new ReadableStream<Uint8Array>({ pull(controller) {
      if (!remaining) { controller.close(); return; }
      remaining -= chunk.length; controller.enqueue(chunk);
    } }, { highWaterMark: 0 }), { headers: { "content-length": String(limit) } });
  });
  const largeItem = { id: file.drivewsid, documentId: file.docwsid, zone: "com.apple.CloudDocs" as const, name: "large.bin", type: "file" as const, etag: file.etag, size: limit, parentId: folder.drivewsid, modifiedAt: null };
  const largeResponse = await largeClient.download(largeItem);
  const expected = createHash("sha256");
  for (let i = 0; i < limit / chunk.length; i++) expected.update(chunk);
  assert.equal(await sha256Stream(largeResponse.body!), expected.digest("hex"));
  assert.equal(remaining, 0);
  const beforeOversize = requests;
  await assert.rejects(largeClient.download({ ...largeItem, size: limit + 1 }), { code: "UNSUPPORTED_FEATURE" });
  assert.equal(requests, beforeOversize, "64 MiB plus one is refused before contacting Apple");
});

test("streamed browser hashing handles empty files, split bytes and source failures", async () => {
  const bytes = new TextEncoder().encode("abc€def");
  const source = new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(bytes.subarray(0, 4)); controller.enqueue(bytes.subarray(4)); controller.close();
  } });
  assert.equal(await sha256Stream(source), createHash("sha256").update(bytes).digest("hex"));
  assert.equal(await sha256Stream(new Blob([]).stream()), createHash("sha256").digest("hex"));
  const failed = new ReadableStream<Uint8Array>({ pull(controller) { controller.error(new Error("Synthetic file read failed")); } });
  await assert.rejects(sha256Stream(failed), /Synthetic file read failed/);
  assert.equal(failed.locked, false);
});

test("synthetic create, upload, finalize, rename and move journey uses observed response wrappers", async () => {
  const seen: Array<{ url: URL; init: RequestInit }> = [];
  let returnedParentId = folder.docwsid;
  const client = makeClient(async (url, init) => {
    seen.push({ url, init });
    if (url.pathname.endsWith("createFolders")) return json({ folders: [{ drivewsid: "FOLDER::com.apple.CloudDocs::created-1", status: "OK" }] });
    if (url.pathname.endsWith("renameItems") || url.pathname.endsWith("moveItems")) return json({ items: [{ ...file, status: "OK" }] });
    if (url.pathname.endsWith("upload/web")) {
      assert.equal(url.searchParams.get("token"), "synthetic-token");
      assert.deepEqual(JSON.parse(String(init.body)), { filename: "empty.bin", type: "FILE", content_type: "application/octet-stream", size: 0 });
      return json([{ document_id: "opaque-upload-doc-1", url: "https://p01-contentws.icloud.com/123456789/singleFileUpload?tk=synthetic-upload-token&ref=synthetic" }]);
    }
    if (url.hostname === "p01-contentws.icloud.com") {
      const headers = new Headers(init.headers);
      assert.equal(headers.has("cookie"), false);
      assert.equal(headers.has("authorization"), false);
      assert.match(headers.get("content-type") ?? "", /^multipart\/form-data; boundary=/);
      const reader = (init.body as ReadableStream<Uint8Array>).getReader();
      let body = "";
      for (;;) { const part = await reader.read(); if (part.done) break; body += new TextDecoder().decode(part.value); }
      assert.match(body, /name="empty\.bin"; filename="empty\.bin"/);
      assert.match(body, /Content-Type: application\/octet-stream\r\n\r\n\r\n--/);
      return json({ singleFile: { referenceChecksum: "synthetic-reference", size: 0, fileChecksum: "synthetic-checksum", wrappingKey: "synthetic-wrap", receipt: "synthetic-receipt" } });
    }
    if (url.pathname.endsWith("update/documents")) {
      const payload = JSON.parse(String(init.body)) as { allow_conflict: boolean; document_id: string; path: { starting_document_id: string; path: string }; data: { size: number } };
      assert.equal(payload.allow_conflict, true);
      assert.equal(payload.document_id, "opaque-upload-doc-1");
      assert.equal(payload.path.path, "empty.bin");
      assert.equal(payload.data.size, 0);
      return json({ status: { status_code: 0, error_message: "" }, results: [{ status: { status_code: 0, error_message: "" }, operation_id: "synthetic-op", document: { document_id: "opaque-upload-doc-1", item_id: "opaque-item", etag: "new-etag", parent_id: returnedParentId, name: "empty.bin", type: "FILE", size: 0, zone: "com.apple.CloudDocs" } }] });
    }
    throw new Error(`unexpected request ${url.pathname}`);
  });

  const created = await client.createFolder(DRIVE_ROOT, "Uploads", "synthetic-client-id");
  assert.deepEqual(created, { id: "FOLDER::com.apple.CloudDocs::created-1" });
  const selected = { id: file.drivewsid, documentId: file.docwsid, zone: "com.apple.CloudDocs" as const, name: "Scanned document 1.pdf", type: "file" as const, etag: file.etag, size: file.size, parentId: folder.drivewsid, modifiedAt: "2020-05-03T00:15:17.000Z" };
  const allocation = await client.allocateUpload({ name: "empty.bin", size: 0, contentType: "application/octet-stream" });
  assert.equal(allocation.documentId, "opaque-upload-doc-1");
  const receipt = await client.uploadBytes(allocation, new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } }), { name: "empty.bin", size: 0 });
  assert.equal(receipt.size, 0);
  const finalizeInput = { parent: { id: folder.drivewsid, documentId: folder.docwsid, zone: "com.apple.CloudDocs" as const, name: "Test", type: "folder" as const, etag: "2z", size: null, parentId: null, modifiedAt: null }, name: "empty.bin", documentId: allocation.documentId, receipt, mtime: 1_760_000_000_000 };
  const finalized = await client.finalizeUpload(finalizeInput);
  assert.equal(finalized.id, "FILE::com.apple.CloudDocs::opaque-upload-doc-1");
  assert.equal(finalized.parentId, folder.drivewsid);
  assert.equal((await client.renameItem(selected, "renamed.txt")).id, file.drivewsid);
  assert.equal((await client.moveItem(selected, { id: folder.drivewsid, documentId: folder.docwsid, zone: "com.apple.CloudDocs", name: "Test", type: "folder", etag: "2z", size: null, parentId: "FOLDER::com.apple.CloudDocs::1C7F1760-D940-480F-8C4F-005824A4E05B", modifiedAt: null })).id, file.drivewsid);
  assert.equal(seen.length, 6);
  returnedParentId = "different-parent-document";
  await assert.rejects(client.finalizeUpload(finalizeInput), { code: "WRITE_OUTCOME_UNKNOWN" });
});

test("upload URL must bind the exact contentws host and connection DSID; byte count is enforced", async () => {
  assert.equal(driveContentURL("https://cws.icloud-content.com/123456789/singleFileUpload?tk=synthetic", "upload", connection.dsid).hostname, "cws.icloud-content.com");
  for (const address of ["https://cws.icloud-content.com/999999/singleFileUpload?tk=synthetic", "https://cws.icloud-content.com.evil.invalid/123456789/singleFileUpload?tk=synthetic", "https://cws.icloud-content.com/123456789/singleFileUpload"]) {
    assert.throws(() => driveContentURL(address, "upload", connection.dsid), AppError);
  }
  let sentContent = 0;
  const wrong = makeClient((url) => url.pathname.endsWith("upload/web")
    ? json([{ document_id: "opaque-upload-doc-2", url: "https://p01-contentws.icloud.com/999999/singleFileUpload?tk=synthetic-token" }])
    : json([]));
  await assert.rejects(wrong.allocateUpload({ name: "x.bin", size: 1, contentType: "application/octet-stream" }), AppError);

  const mismatch = makeClient(async (url, init) => {
    if (url.pathname.endsWith("upload/web")) return json([{ document_id: "opaque-upload-doc-3", url: "https://p01-contentws.icloud.com/123456789/singleFileUpload?tk=synthetic-token" }]);
    if (url.hostname === "p01-contentws.icloud.com") {
      sentContent++;
      const reader = (init.body as ReadableStream<Uint8Array>).getReader();
      for (;;) { const part = await reader.read(); if (part.done) break; }
      return json({ singleFile: { referenceChecksum: "ref", size: 0, fileChecksum: "sum", wrappingKey: "key" } });
    }
    throw new Error(`unexpected request ${url.pathname}`);
  });
  const allocation = await mismatch.allocateUpload({ name: "x.bin", size: 0, contentType: "application/octet-stream" });
  await assert.rejects(mismatch.uploadBytes(allocation, new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([1])); controller.close(); } }), { name: "x.bin", size: 0 }), AppError);
  assert.equal(sentContent, 1);
});

test("a fresh Drive client restores a validated durable allocation without allocating again", async () => {
  let requests = 0;
  const resumed = makeClient(async (url, init) => {
    requests++;
    assert.equal(url.hostname, "cws.icloud-content.com");
    assert.equal(url.pathname, "/123456789/singleFileUpload");
    assert.equal(new Headers(init.headers).has("cookie"), false);
    const reader = (init.body as ReadableStream<Uint8Array>).getReader();
    for (;;) { const part = await reader.read(); if (part.done) break; }
    return json({ singleFile: { referenceChecksum: "synthetic-ref", size: 1, fileChecksum: "synthetic-sum", wrappingKey: "synthetic-key" } });
  });
  const durableAllocation = { documentId: "opaque-upload-doc-resume", url: "https://cws.icloud-content.com/123456789/singleFileUpload?tk=synthetic-resume-token&ref=synthetic" };
  resumed.restoreUploadAllocation(durableAllocation, { name: "resume.bin", size: 1, contentType: "application/octet-stream" });
  const receipt = await resumed.uploadBytes(durableAllocation, new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([7])); controller.close(); } }), { name: "resume.bin", size: 1 });
  assert.equal(receipt.size, 1);
  assert.equal(requests, 1);
  assert.throws(() => resumed.restoreUploadAllocation({ ...durableAllocation, url: "https://attacker.example/123456789/singleFileUpload?tk=synthetic" }, { name: "resume.bin", size: 1, contentType: "application/octet-stream" }), AppError);
  resumed.restoreUploadAllocation(durableAllocation, { name: "resume.bin", size: 2, contentType: "application/octet-stream" });
  await assert.rejects(resumed.uploadBytes(durableAllocation, new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } }), { name: "resume.bin", size: 1 }), AppError);
  assert.equal(requests, 1);
});

test("exported metadata transport URL validator accepts only named Apple service endpoints", () => {
  assert.equal(validateDriveMetadataURL(new URL("https://p01-drivews.icloud.com/retrieveItemDetailsInFolders")).hostname, "p01-drivews.icloud.com");
  assert.throws(() => validateDriveMetadataURL(new URL("https://attacker.example/retrieveItemDetailsInFolders")), AppError);
  assert.throws(() => validateDriveMetadataURL(new URL("https://p01-drivews.icloud.com/ws/com.apple.CloudDocs/upload/web")), AppError);
});

test("upload receipt schema validates the exact private receipt shape including zero-byte receipts", () => {
  assert.equal(UploadReceiptSchema.safeParse({ referenceChecksum: "ref", size: 0, fileChecksum: "sum", wrappingKey: "key" }).success, true);
  assert.equal(UploadReceiptSchema.safeParse({ referenceChecksum: "ref", size: -1, fileChecksum: "sum", wrappingKey: "key", url: "https://example.com" }).success, false);
});

test("folder create returns uncertainty when Apple's fixture shape contains no exact identity", async () => {
  const client = makeClient(() => json({ folders: [{ name: "New Folder" }] }));
  await assert.rejects(client.createFolder(DRIVE_ROOT, "New Folder", "synthetic-create-id"), (error: unknown) => error instanceof AppError && error.code === "WRITE_OUTCOME_UNKNOWN");
});

test("zero-byte downloads avoid Apple fetch and mutation calls never follow redirects", async () => {
  let sent = 0;
  const client = makeClient((url) => {
    sent++;
    if (url.pathname.endsWith("renameItems")) return new Response(null, { status: 307, headers: { location: "https://p01-drivews.icloud.com/renameItems" } });
    if (url.pathname.endsWith("retrieveItemDetails")) return json([{ ...file, size: 0 }]);
    return json([{ ...file, size: 0 }]);
  });
  const zero = { id: file.drivewsid, documentId: file.docwsid, zone: "com.apple.CloudDocs" as const, name: "note.txt", type: "file" as const, etag: file.etag, size: 0, parentId: folder.drivewsid, modifiedAt: "2026-10-13T12:00:00.000Z" };
  const response = await client.download(zero);
  assert.equal(await response.text(), "");
  await assert.rejects(client.renameItem(zero, "renamed.txt"), AppError);
  assert.equal(sent, 1);
});
