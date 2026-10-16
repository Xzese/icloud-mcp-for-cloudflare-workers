import { DRIVE_FILE_BYTES } from "../src/drive/limits.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { classifyDriveRelayURL, localAppleContentHeaders, localAppleDownloadHeaders, summarizeAppleResponse, summarizeAppleFailure } from "../scripts/dev/local-icloud-observation.mjs";

test("local Drive relay accepts only the existing metadata and signed content URL shapes", () => {
  assert.equal(classifyDriveRelayURL(new URL("https://p01-drivews.icloud.com/retrieveItemDetailsInFolders?dsid=123")), "metadata");
  assert.equal(classifyDriveRelayURL(new URL("https://p01-docws.icloud.com/ws/com.apple.CloudDocs/download/by_id?dsid=123")), "metadata");
  assert.equal(classifyDriveRelayURL(new URL("https://p01-docws.icloud.com/v1/item/synthetic-item")), "metadata");
  assert.equal(classifyDriveRelayURL(new URL("https://p01-docws.icloud.com/v1/enumerate/synthetic-folder")), "metadata");
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
    "Content-Length": "2147483904",
    Cookie: "synthetic-apple-cookie",
    Authorization: "synthetic-apple-authorization",
    "Proxy-Authorization": "synthetic-proxy-authorization",
    "X-Apple-Session-Id": "synthetic-apple-session",
    Accept: "application/json",
  });
  assert.equal(headers.get("content-type"), "multipart/form-data; boundary=synthetic-boundary");
  assert.equal(headers.get("accept"), "application/json");
  assert.equal(headers.get("content-length"), "2147483904");
  assert.equal(headers.has("cookie"), false);
  assert.equal(headers.has("authorization"), false);
  assert.equal(headers.has("proxy-authorization"), false);
  assert.equal(headers.has("x-apple-session-id"), false);
});

test("local signed-content framing refuses malformed or oversized declared lengths", () => {
  for (const length of ["-1", "12.5", "abc", "9007199254740992", String(DRIVE_FILE_BYTES + 16_385)])
    assert.throws(() => localAppleContentHeaders({ "content-length": length }), /invalid declared length/);
});

test("local content relay preserves validated range framing and 330 destinations", () => {
  const first = new URL("/B/invented-signature/file", "https://cvws.icloud-content.com");
  first.searchParams.set("token", crypto.randomUUID());
  const destination = new URL(first); destination.pathname += "-redirected";
  const request = localAppleContentHeaders({ range: "bytes=1-2", cookie: "private", authorization: "private" });
  assert.deepEqual([...request], [["range", "bytes=1-2"]]);
  assert.equal(localAppleContentHeaders({ range: "bytes=1-2,3-4" }).has("range"), false);
  const response = localAppleDownloadHeaders({ location: destination.href, "retry-after": "1", "content-range": "bytes 1-2/4", "set-cookie": "private", authorization: "private" }, 330, first);
  assert.equal(response.get("location"), destination.href);
  assert.equal(response.get("retry-after"), "1");
  assert.equal(response.get("content-range"), "bytes 1-2/4");
  assert.equal(response.has("set-cookie"), false);
  assert.equal(response.has("authorization"), false);
  assert.equal(localAppleDownloadHeaders({ location: destination.href }, 302, first).has("location"), false);
  assert.throws(() => localAppleDownloadHeaders({ location: "https://attacker.example/collect" }, 330, first), { code: "PROTOCOL_CHANGED" });
});

test("shared docws diagnostics redact item identifiers on success and failure", () => {
  for (const kind of ["item", "enumerate"]) {
    const url = new URL(`https://p01-docws.icloud.com/v1/${kind}/private-document-identifier`);
    const response = summarizeAppleResponse(url, 200, {});
    const failure = summarizeAppleFailure(url, { stage: "headers", status: 503, bytesRead: 0, elapsedMs: 1, timeout: false, aborted: false, error: {} });
    assert.equal(response.path, `/v1/${kind}/[redacted]`);
    assert.equal(failure.path, response.path);
    assert.equal(JSON.stringify([response, failure]).includes("private-document-identifier"), false);
  }
});

test("authentication diagnostics retain only known error codes without account details", () => {
  const summary = summarizeAppleResponse(new URL("https://idmsa.apple.com/appleauth/auth/signin/complete"), 403, {
    accountName: "private@example.invalid", serviceErrors: [{ code: "-20101", message: "private detail" },
      { code: -22406, message: "private detail" }, { code: "private identifier", message: "private detail" }],
    token: "private token",
  });
  assert.deepEqual(JSON.parse(JSON.stringify(summary)).authenticationErrorCodes, [-20101, -22406, "other"]);
  assert.equal(JSON.stringify(summary).includes("private"), false);
  assert.equal(Object.hasOwn(summarizeAppleResponse(new URL("https://idmsa.apple.com/appleauth/auth/signin/init"), 200, {}), "authenticationErrorCodes"), false);
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
