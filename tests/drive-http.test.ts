import test from "node:test";
import assert from "node:assert/strict";
import { DriveHTTP, validateDriveMetadataURL, DRIVE_MAX_TRANSFER_BYTES, uploadResponseDiagnostics } from "../src/transport/drive-http.ts";
import { AppleHTTP } from "../src/transport/apple-http.ts";
import { CookieJar } from "../src/transport/cookie-jar.ts";
import { AppError } from "../src/errors.ts";

const metadata = new URL("https://p01-drivews.icloud.com/retrieveItemDetailsInFolders");
const content = () => {
  const url = new URL("/B/synthetic/file.bin", "https://cvws.icloud-content.com");
  url.searchParams.set("token", crypto.randomUUID());
  return url.href;
};
function transport(route: (url: URL, init: RequestInit) => Promise<Response> | Response) {
  const jar = new CookieJar();
  jar.set("synthetic-account=private; Domain=icloud.com; Path=/; Secure", new URL(metadata));
  return new DriveHTTP(new AppleHTTP(jar, ((url, init) => route(new URL(String(url)), init ?? {})) as typeof fetch));
}
const uploadURL = "https://cws.icloud-content.com/123/singleFileUpload?tk=synthetic";

test("upload rejection diagnostics classify the response without revealing headers or error-page secrets", () => {
  const secret = crypto.randomUUID();
  const headers = new Headers({ server: "AppleHttpServer/synthetic", "content-type": "text/html", "set-cookie": secret, "cf-ray": secret });
  const result = uploadResponseDiagnostics(headers, new TextEncoder().encode(`<html>Request body too large; quota exceeded. token=${secret}</html>`));
  assert.equal(result.responseServer, "apple"); assert.equal(result.responseFormat, "html");
  assert.equal(result.responseMentionsQuota, true); assert.equal(result.responseMentionsSize, true);
  assert.equal(result.responseHasCloudflareRay, true);
  assert.ok(!JSON.stringify(result).includes(secret));
});

test("upload posts only raw file bytes with an exact length and verifies EOF before the last bytes", async () => {
  for (const bytes of [new Uint8Array(), new Uint8Array([1, 2, 3])]) {
    let ended = false;
    const source = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } });
    const client = transport(async (_url, init) => {
      const headers = new Headers(init.headers);
      assert.equal(headers.get("content-type"), "application/octet-stream");
      assert.equal(headers.get("content-length"), String(bytes.length));
      assert.deepEqual(new Uint8Array(await new Response(init.body).arrayBuffer()), bytes);
      ended = true;
      return Response.json({ singleFile: { size: bytes.length } });
    });
    await client.upload(uploadURL, "123", source, bytes.length, "synthetic.bin", "application/octet-stream");
    assert.equal(ended, true);
  }
});

test("raw upload rejects truncation, extra bytes and final integrity failure before acceptance", async () => {
  for (const kind of ["short", "extra", "integrity"] as const) {
    let reads = 0, calls = 0, received = 0;
    const source = new ReadableStream<Uint8Array>({ pull(controller) {
      reads++;
      if (reads === 1) controller.enqueue(new Uint8Array(kind === "short" ? 2 : 3));
      else if (kind === "extra" && reads === 2) controller.enqueue(new Uint8Array([4]));
      else if (kind === "integrity") controller.error(new AppError("VALIDATION_ERROR", "Synthetic final checksum failure"));
      else controller.close();
    } }, { highWaterMark: 0 });
    const client = transport(async (_url, init) => {
      calls++;
      const reader = (init.body as ReadableStream<Uint8Array>).getReader();
      for (;;) { const next = await reader.read(); if (next.done) break; received += next.value.length; }
      return Response.json({ singleFile: { size: 3 } });
    });
    await assert.rejects(client.upload(uploadURL, "123", source, 3, "synthetic.bin", "application/octet-stream"), { code: "VALIDATION_ERROR" });
    assert.equal(calls, 1);
    if (kind !== "short") assert.equal(received, 0, "The last chunk is withheld until EOF and final integrity verification");
  }
});

test("an early success response cannot accept an unconsumed upload and always cancels its source", async () => {
  let cancelled = 0, calls = 0;
  const source = new ReadableStream<Uint8Array>({ cancel() { cancelled++; } }, { highWaterMark: 0 });
  const client = transport(() => { calls++; return Response.json({ singleFile: { size: 10 } }); });
  await assert.rejects(client.upload(uploadURL, "123", source, 10, "synthetic.bin", "application/octet-stream"), { code: "PROTOCOL_CHANGED" });
  assert.equal(cancelled, 1); assert.equal(calls, 1);
});

test("an upstream failure cancels a pending upload read without inventing a truncated input error", async () => {
  let cancelled = 0, pending: Promise<unknown> | undefined;
  const source = new ReadableStream<Uint8Array>({ cancel() { cancelled++; } }, { highWaterMark: 0 });
  const client = transport(async (_url, init) => {
    const reader = (init.body as ReadableStream<Uint8Array>).getReader();
    pending = reader.read().catch(error => error);
    throw new TypeError("Synthetic network interruption; no second request is allowed.");
  });
  await assert.rejects(client.upload(uploadURL, "123", source, 10, "synthetic.bin", "application/octet-stream"), { code: "UPSTREAM_UNAVAILABLE" });
  assert.equal(cancelled, 1);
  const error = await pending;
  assert.ok(error instanceof AppError); assert.equal(error.code, "UPSTREAM_UNAVAILABLE");
  assert.ok(!error.message.includes("length"));
});

test("a masked input authorization failure retains its original cause without repeating the upload", async () => {
  let calls = 0;
  const source = new ReadableStream<Uint8Array>({ pull(controller) { controller.error(new AppError("FORBIDDEN", "Synthetic permission revocation", 403)); } }, { highWaterMark: 0 });
  const client = transport(async (_url, init) => {
    calls++;
    try {
      const reader = (init.body as ReadableStream<Uint8Array>).getReader();
      while (!(await reader.read()).done) { /* Synthetic fetch consumes the body. */ }
    } catch { throw new TypeError("Synthetic fetch wrapped the input stream error."); }
    assert.fail("The revoked upload must not finish.");
  });
  await assert.rejects(client.upload(uploadURL, "123", source, 10, "synthetic.bin", "application/octet-stream"), { code: "FORBIDDEN" });
  assert.equal(calls, 1);
});

test("read retries cancel transient responses, preserve cookies, honor Retry-After and stop after three attempts", async () => {
  let calls = 0, cancelled = 0;
  const client = transport((_url, init) => {
    assert.ok(new Headers(init.headers).has("cookie"));
    calls++;
    if (calls === 3) return new Response(null, { status: 503 });
    return new Response(new ReadableStream({ cancel() { cancelled++; } }), { status: 503, headers: { "retry-after": "0" } });
  });
  assert.equal((await client.metadata(metadata, { method: "POST", body: "[]" })).status, 503);
  assert.equal(calls, 3);
  assert.equal(cancelled, 2);
  let rateCalls = 0;
  const limited = transport(() => { rateCalls++; return new Response(null, { status: 429, headers: { "Retry-After": "60" } }); });
  assert.equal((await limited.metadata(metadata, { method: "POST", body: "[]" })).status, 429);
  assert.equal(rateCalls, 1, "A delay outside the request budget is returned without sleeping or retrying early.");
});

test("read transport failures retry, but mutations, malformed responses and permission failures do not", async () => {
  let calls = 0;
  const client = transport(() => { if (++calls === 1) throw new TypeError("synthetic network failure"); return Response.json([]); });
  assert.equal((await client.metadata(metadata, { method: "POST", body: "[]" })).status, 200);
  assert.equal(calls, 2);
  for (const path of ["/createFolders", "/renameItems", "/moveItems", "/ws/com.apple.CloudDocs/upload/web", "/ws/com.apple.CloudDocs/update/documents"]) {
    calls = 0;
    const mutation = transport(() => { calls++; return new Response(null, { status: 503 }); });
    const host = path.startsWith("/ws/") ? "https://p01-docws.icloud.com" : metadata.origin;
    assert.equal((await mutation.metadata(new URL(path, host), { method: "POST", body: "{}" })).status, 503);
    assert.equal(calls, 1);
  }
  calls = 0;
  const denied = transport(() => { calls++; throw new AppError("FORBIDDEN", "Synthetic permission revocation", 403); });
  await assert.rejects(denied.metadata(metadata, { method: "POST" }), { code: "FORBIDDEN" });
  assert.equal(calls, 1);
});

test("aborting a read retry prevents another dispatch", async () => {
  const controller = new AbortController(); let calls = 0;
  const client = transport(() => { calls++; controller.abort(); return new Response(null, { status: 503 }); });
  await assert.rejects(client.metadata(metadata, { method: "POST", signal: controller.signal }), { code: "UPSTREAM_UNAVAILABLE" });
  assert.equal(calls, 1);
});

test("docws reads stay on the documents host and reject path traversal", () => {
  assert.equal(validateDriveMetadataURL(new URL("https://p01-docws.icloud.com/v1/enumerate/synthetic-id")).pathname, "/v1/enumerate/synthetic-id");
  for (const url of ["https://p01-drivews.icloud.com/v1/item/synthetic-id", "https://p01-docws.icloud.com/v1/item/id/extra", "https://p01-docws.icloud.com/v1/enumerate/id%2Fextra", "https://p01-docws.icloud.com/v1/item/..", "https://attacker.example/v1/item/id"]) assert.throws(() => validateDriveMetadataURL(new URL(url)), AppError);
});

test("download 330 redirects validate every hop, preserve ranges and never send account credentials", async () => {
  const first = content(), second = content(); let calls = 0;
  const client = transport((url, init) => {
    calls++;
    const headers = new Headers(init.headers);
    assert.equal(headers.has("cookie"), false); assert.equal(headers.has("authorization"), false);
    assert.equal(headers.get("range"), "bytes=1-2");
    if (url.href === first) return new Response(null, { status: 330, headers: { Location: second } });
    return new Response(new Uint8Array([2, 3]), { status: 206, headers: { "Content-Range": "bytes 1-2/4", "Content-Length": "2" } });
  });
  const response = await client.download(first, undefined, { start: 1, end: 2, total: 4 });
  assert.equal(response.status, 206);
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [2, 3]);
  assert.equal(calls, 2);
  for (const location of ["https://attacker.example/collect", first]) {
    calls = 0;
    const bad = transport(() => { calls++; return new Response(null, { status: 330, headers: { Location: location } }); });
    await assert.rejects(bad.download(first), { code: "PROTOCOL_CHANGED" }); assert.equal(calls, 1);
  }
  calls = 0;
  await assert.rejects(transport(() => { calls++; return new Response(null, { status: 330, headers: { Location: content() } }); }).download(first), { code: "PROTOCOL_CHANGED" });
  assert.equal(calls, 4);
});

test("partial downloads reject ignored, mismatched, oversized and unsolicited ranges", async () => {
  for (const [status, header] of [[200, null], [206, "bytes 0-1/4"], [206, "bytes 1-2/5"], [206, `bytes 1-2/${DRIVE_MAX_TRANSFER_BYTES + 1}`]] as const) {
    const client = transport(() => new Response("ab", { status, headers: header ? { "content-range": header } : {} }));
    await assert.rejects(client.download(content(), undefined, { start: 1, end: 2, total: 4 }), { code: "PROTOCOL_CHANGED" });
  }
  await assert.rejects(transport(() => new Response("ab", { status: 206, headers: { "content-range": "bytes 1-2/4" } })).download(content()), { code: "PROTOCOL_CHANGED" });
  const oversized = transport(() => new Response("abc", { status: 206, headers: { "content-range": "bytes 1-2/4" } }));
  const response = await oversized.download(content(), undefined, { start: 1, end: 2 });
  await assert.rejects(response.arrayBuffer(), { code: "PROTOCOL_CHANGED" });
});

test("known file sizes validate downloads even when the CDN omits Content-Length", async () => {
  const valid = transport(() => new Response("abc"));
  assert.equal(await (await valid.download(content(), undefined, undefined, 3)).text(), "abc");
  const short = await transport(() => new Response("ab")).download(content(), undefined, undefined, 3);
  await assert.rejects(short.text(), { code: "PROTOCOL_CHANGED" });
  await assert.rejects(transport(() => new Response("ab", { headers: { "content-length": "2" } })).download(content(), undefined, undefined, 3), { code: "PROTOCOL_CHANGED" });
});

test("download retries happen before streaming; a midstream failure is never replayed", async () => {
  let calls = 0;
  const client = transport(() => ++calls === 1 ? new Response(null, { status: 429, headers: { "retry-after": "0" } }) : new Response("abc"));
  assert.equal(await (await client.download(content())).text(), "abc"); assert.equal(calls, 2);
  calls = 0;
  const broken = transport(() => { calls++; return new Response(new ReadableStream({ pull(controller) { controller.error(new Error("synthetic stream failure")); } })); });
  await assert.rejects((await broken.download(content())).arrayBuffer(), /synthetic stream failure/);
  assert.equal(calls, 1);
});
