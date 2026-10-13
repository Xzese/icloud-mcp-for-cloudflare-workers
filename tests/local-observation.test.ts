import assert from "node:assert/strict";
import test from "node:test";
import { classifyDriveRelayURL, localAppleContentHeaders, summarizeAppleResponse } from "../scripts/dev/local-icloud-observation.mjs";

test("local Drive relay accepts only the existing metadata and signed content URL shapes", () => {
  assert.equal(classifyDriveRelayURL(new URL("https://p01-drivews.icloud.com/retrieveItemDetailsInFolders?dsid=123")), "metadata");
  assert.equal(classifyDriveRelayURL(new URL("https://p01-docws.icloud.com/ws/com.apple.CloudDocs/download/by_id?dsid=123")), "metadata");
  assert.equal(classifyDriveRelayURL(new URL("https://p01-drivews.icloud.com/unlisted")), null);
  assert.equal(classifyDriveRelayURL(new URL("https://p01-docws.icloud.com/retrieveItemDetailsInFolders")), null);
  const download = new URL("/B/invented-signature/test.bin", "https://cvws.icloud-content.com");
  download.searchParams.set("token", crypto.randomUUID());
  assert.equal(classifyDriveRelayURL(download), "download");
  assert.equal(classifyDriveRelayURL(new URL("https://cvws.icloud-content.com/B/signature/file")), null);
  assert.equal(classifyDriveRelayURL(new URL("https://p01-contentws.icloud.com/123/singleFileUpload?tk=synthetic")), "upload");
  assert.equal(classifyDriveRelayURL(new URL("https://p01-contentws.icloud.com/456/singleFileUpload?tk=synthetic")), "upload");
  assert.equal(classifyDriveRelayURL(new URL("https://cws.icloud-content.com/123/singleFileUpload?tk=synthetic")), "upload");
  assert.equal(classifyDriveRelayURL(new URL("https://cws.icloud-content.com.evil.invalid/123/singleFileUpload?tk=synthetic")), null);
  assert.equal(classifyDriveRelayURL(new URL("https://p01-contentws.icloud.com/123/other?tk=synthetic")), null);
  assert.equal(classifyDriveRelayURL(new URL("https://attacker.example/123/singleFileUpload?tk=synthetic")), null);
});

test("signed content headers preserve multipart framing without forwarding Apple credentials", () => {
  const headers = localAppleContentHeaders({
    "Content-Type": "multipart/form-data; boundary=synthetic-boundary",
    Cookie: "synthetic-apple-cookie",
    Authorization: "synthetic-apple-authorization",
    "Proxy-Authorization": "synthetic-proxy-authorization",
    "X-Apple-Session-Id": "synthetic-apple-session",
    Accept: "application/json",
  });
  assert.equal(headers.get("content-type"), "multipart/form-data; boundary=synthetic-boundary");
  assert.equal(headers.get("accept"), "application/json");
  assert.equal(headers.has("cookie"), false);
  assert.equal(headers.has("authorization"), false);
  assert.equal(headers.has("proxy-authorization"), false);
  assert.equal(headers.has("x-apple-session-id"), false);
});

test("upload allocation diagnostics retain structure without signed URLs or document identities", () => {
  const documentId = crypto.randomUUID(), token = crypto.randomUUID();
  const url = new URL("https://p01-contentws.icloud.com/123/singleFileUpload");
  url.searchParams.set("tk", token);
  const serialized = JSON.stringify(summarizeAppleResponse(new URL("https://p01-docws.icloud.com/ws/com.apple.CloudDocs/upload/web"), 200,
    [{ document_id: documentId, url: url.href, status: 0 }]));
  const summary = JSON.parse(serialized);
  assert.equal(summary.allocationShape, "array");
  assert.deepEqual(summary.allocations[0].target, { host: "p01-contentws.icloud.com", route: "account-single-file-upload", signedTokenPresent: true });
  for (const privateValue of [documentId, token, url.href, "/123/"]) assert.equal(serialized.includes(privateValue), false);
  const committed = JSON.stringify(summarizeAppleResponse(new URL("https://p01-docws.icloud.com/ws/com.apple.CloudDocs/update/documents"), 200,
    { status: { status_code: 0 }, results: [{ status: { status_code: 0 }, document: { document_id: documentId, parent_id: documentId, name: "private-document.txt", type: "FILE", size: 99 } }] }));
  assert.equal(JSON.parse(committed).documents[0].parentIdentityKind, "opaque");
  for (const privateValue of [documentId, "private-document.txt"]) assert.equal(committed.includes(privateValue), false);
});
