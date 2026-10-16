import { DRIVE_FILE_BYTES } from "../src/drive/limits.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { fileMetadata, uploadFile, downloadFile, validatePlan } from "../scripts/drive-transfer.mjs";

const { WebSocketServer } = createRequire(import.meta.url)("ws");
test("transfer clients accept the configured maximum and reject one byte above the limit before connecting", () => {
  for (const kind of ["upload", "download"]) {
    const plan = { url: `${kind === "upload" ? "wss" : "https"}://transfer.example.test/api/drive/transfers/${kind}/${crypto.randomUUID()}`,
      method: kind === "upload" ? "WEBSOCKET" : "GET", headers: { Authorization: "Bearer c3ludGhldGlj" },
      expiresAt: Date.now() + 60_000, size: DRIVE_FILE_BYTES, protocol: "icloud-drive-upload-v2", sha256: "a".repeat(64) };
    assert.equal(validatePlan(plan, kind).size, DRIVE_FILE_BYTES);
    assert.throws(() => validatePlan({ ...plan, size: DRIVE_FILE_BYTES + 1 }, kind), /invalid or expired/);
  }
});

for (const protocol of ["icloud-drive-upload-v1", "icloud-drive-upload-v2", "icloud-drive-upload-v3"]) test(`transfer client uses ${protocol} credits, verifies disk bytes, and never reconnects after loss`, async t => {
  const directory = await mkdtemp(join(tmpdir(), "drive-transfer-client-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "synthetic.bin"), bytes = Buffer.alloc(2 * (protocol.endsWith("v3") ? 16 : protocol.endsWith("v2") ? 8 : 1) * 1024 ** 2 + 17, 90);
  await writeFile(path, bytes);
  const metadata = await fileMetadata(path), id = crypto.randomUUID(), token = Buffer.from(crypto.randomUUID()).toString("base64");
  const server = createServer(), websocket = new WebSocketServer({ server });
  let connections = 0, dropped = false;
  websocket.on("connection", (socket: any, request: any) => {
    connections++; assert.equal(request.headers.authorization, `Bearer ${token}`);
    let offset = 0; const hash = createHash("sha256");
    const pull = () => socket.send(JSON.stringify({ type: "pull", operationId: id, offset, bytes: Math.min((protocol.endsWith("v3") ? 16 : protocol.endsWith("v2") ? 8 : 1) * 1024 ** 2, bytes.length - offset) }));
    socket.on("message", (chunk: Buffer) => {
      if (dropped) { socket.terminate(); return; }
      hash.update(chunk); offset += chunk.length;
      if (offset === bytes.length) {
        assert.equal(hash.digest("hex"), metadata.sha256);
        socket.send(JSON.stringify({ type: "result", operationId: id, operation: { operationId: id, phase: "confirmed", result: null } }));
      } else pull();
    });
    pull();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { for (const socket of websocket.clients) socket.terminate(); websocket.close(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const port = (server.address() as { port: number }).port;
  const transfer = { url: `ws://127.0.0.1:${port}/api/drive/transfers/upload/${crypto.randomUUID()}`, method: "WEBSOCKET", protocol, headers: { Authorization: `Bearer ${token}` }, expiresAt: Date.now() + 60_000, size: metadata.size, sha256: metadata.sha256 };
  const result = await uploadFile(path, { operationId: id, transfer });
  assert.equal(result.bytesSent, bytes.length); assert.equal(result.phase, "confirmed");
  await assert.rejects(uploadFile(path, { operationId: id, transfer: { ...transfer, sha256: "0".repeat(64) } }), /differs/);
  assert.equal(connections, 1);
  dropped = true;
  await assert.rejects(uploadFile(path, { operationId: id, transfer }), /outcome may be unknown/);
  assert.equal(connections, 2, "a disconnected transfer does not automatically reconnect");
});

test("download client uses header credentials without redirects and refuses overwriting local files", async t => {
  const directory = await mkdtemp(join(tmpdir(), "drive-transfer-download-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let redirected = false, requests = 0;
  const server = createServer((request, response) => {
    requests++;
    if (request.url === "/redirect-target") { assert.fail("Transfer credentials must never follow a redirect."); }
    assert.equal(request.headers.authorization, "Bearer c3ludGhldGlj");
    if (redirected) { response.writeHead(307, { location: "/redirect-target" }); response.end(); }
    else { response.writeHead(200, { "content-length": "3" }); response.end("abc"); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const port = (server.address() as { port: number }).port;
  const plan = { url: `http://127.0.0.1:${port}/api/drive/transfers/download/${crypto.randomUUID()}`, method: "GET", headers: { Authorization: "Bearer c3ludGhldGlj" }, expiresAt: Date.now() + 60_000, size: 3 };
  const path = join(directory, "received.bin"), result = await downloadFile(path, plan);
  assert.equal(result.sha256, createHash("sha256").update("abc").digest("hex"));
  assert.equal(await readFile(path, "utf8"), "abc");
  await assert.rejects(downloadFile(path, plan), { code: "EEXIST" }); assert.equal(requests, 1);
  redirected = true;
  await assert.rejects(downloadFile(join(directory, "redirect.bin"), plan), /HTTP 307/);
  assert.equal(requests, 2);
});

test("staged client resumes acknowledged parts after lost replies and uses a control-only completion socket", async t => {
  const directory = await mkdtemp(join(tmpdir(), "drive-resumable-client-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "synthetic.bin"), bytes = Buffer.alloc(8 * 1024 ** 2 + 17, 79), id = crypto.randomUUID();
  await writeFile(path, bytes);
  const metadata = await fileMetadata(path), parts: Buffer[] = [];
  let lostReply = true, unavailable = true, writes = 0, connections = 0, phase = "prepared", posts = 0;
  const server = createServer((request, response) => {
    assert.equal(request.headers.authorization, "Bearer c3ludGhldGlj");
    if (request.method === "GET") { response.end(JSON.stringify({ operationId: id, phase, staging: { uploadedParts: parts.map((_, i) => i + 1), cancelled: false } })); return; }
    void (async () => {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk);
      posts++;
      if (unavailable) { unavailable = false; response.writeHead(503); response.end(JSON.stringify({ error: { code: "UPSTREAM_UNAVAILABLE" } })); return; }
      const body = Buffer.concat(chunks), number = Number(request.headers["x-drive-part-number"]);
      assert.equal(number, parts.length + 1); assert.equal(request.headers["x-drive-transfer-action"], "part");
      assert.equal(createHash("sha256").update(body).digest("hex"), request.headers["x-content-sha256"]);
      parts.push(body); writes++;
      if (lostReply) { lostReply = false; response.destroy(); return; }
      response.end(JSON.stringify({ operationId: id, phase, uploadedParts: parts.map((_, i) => i + 1) }));
    })().catch(error => { response.destroy(error); });
  });
  const websocket = new WebSocketServer({ server });
  websocket.on("connection", (socket: any) => {
    connections++; socket.on("message", () => assert.fail("Completion accepts no client bytes"));
    assert.equal(createHash("sha256").update(Buffer.concat(parts)).digest("hex"), metadata.sha256);
    phase = "confirmed";
    socket.send(JSON.stringify({ type: "result", operationId: id, operation: { operationId: id, phase, result: null } }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { for (const socket of websocket.clients) socket.terminate(); websocket.close(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const port = (server.address() as { port: number }).port;
  const transfer = { url: `http://127.0.0.1:${port}/api/drive/transfers/staged-upload/${crypto.randomUUID()}`, method: "POST", protocol: "icloud-drive-upload-parts-v1", partBytes: 8 * 1024 ** 2, size: bytes.length, sha256: metadata.sha256, expiresAt: Date.now() + 30 * 60_000, headers: { Authorization: "Bearer c3ludGhldGlj" } };
  const recovery: Record<string, unknown>[] = [];
  const result = await uploadFile(path, { operationId: id, transfer }, event => recovery.push(event));
  assert.equal(result.phase, "confirmed"); assert.equal(result.bytesSent, bytes.length);
  assert.equal(writes, 2); assert.equal(connections, 1);
  assert.equal(posts, 3, "a pre-write 503 retries the exact part; a lost saved acknowledgment sends no duplicate bytes");
  assert.equal(recovery.filter(event => event.event === "inspect-staged-part").length, 2);
  assert.equal((await uploadFile(path, { operationId: id, transfer })).bytesSent, 0);
  assert.equal(writes, 2); assert.equal(connections, 1);
  phase = "unknown";
  await assert.rejects(uploadFile(path, { operationId: id, transfer }), /uncertain/);
  assert.equal(connections, 1);
});

test("staging yields before capability expiry and a later session sends only remaining parts", async t => {
  const directory = await mkdtemp(join(tmpdir(), "drive-staged-expiry-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "synthetic.bin"), bytes = Buffer.alloc(8 * 1024 ** 2 + 3, 71), id = crypto.randomUUID();
  await writeFile(path, bytes);
  const metadata = await fileMetadata(path), parts: number[] = [], realNow = Date.now;
  let now = realNow();
  t.mock.method(Date, "now", () => now);
  const server = createServer((request, response) => {
    if (request.method === "GET") { response.end(JSON.stringify({ operationId: id, phase: "prepared", staging: { uploadedParts: parts, cancelled: false } })); return; }
    void (async () => {
      for await (const chunk of request) void chunk;
      const part = Number(request.headers["x-drive-part-number"]);
      assert.equal(part, parts.length + 1); parts.push(part);
      now += 120_000;
      response.end(JSON.stringify({ operationId: id, phase: "prepared", uploadedParts: parts }));
    })().catch(error => response.destroy(error));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const port = (server.address() as { port: number }).port;
  const transfer = { url: `http://127.0.0.1:${port}/api/drive/transfers/staged-upload/${crypto.randomUUID()}`, method: "POST", protocol: "icloud-drive-upload-parts-v1", partBytes: 8 * 1024 ** 2, size: bytes.length, sha256: metadata.sha256, expiresAt: now + 180_000, headers: { Authorization: "Bearer c3ludGhldGlj" } };
  const yielded = await uploadFile(path, { operationId: id, transfer }, () => {}, true);
  assert.equal(yielded.phase, "prepared"); assert.equal(yielded.staged, false);
  assert.equal(yielded.bytesStaged, transfer.partBytes); assert.equal(yielded.needsFreshCapability, true);
  assert.deepEqual(parts, [1]);
  const resumed = await uploadFile(path, { operationId: id, transfer: { ...transfer, expiresAt: now + 30 * 60_000 } }, () => {}, true);
  assert.equal(resumed.staged, true); assert.equal(resumed.bytesSent, 3);
  assert.deepEqual(parts, [1, 2]);
});

test("staging recovery is bounded and stops before any replay when Apple dispatch becomes uncertain", async t => {
  const directory = await mkdtemp(join(tmpdir(), "drive-staged-stop-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "synthetic.bin"); await writeFile(path, "abc");
  const metadata = await fileMetadata(path);
  let id = crypto.randomUUID(), phase = "prepared", nextPhase = "prepared", posts = 0, retryAfter: string | undefined = "3600";
  const server = createServer((request, response) => {
    if (request.method === "GET") { response.end(JSON.stringify({ operationId: id, phase, staging: { uploadedParts: [], cancelled: false } })); return; }
    request.resume(); posts++; phase = nextPhase;
    response.writeHead(503, retryAfter ? { "retry-after": retryAfter } : {}); response.end(JSON.stringify({ error: { code: "UPSTREAM_UNAVAILABLE" } }));
  });
  server.on("upgrade", () => assert.fail("Failed staging must never start Apple delivery."));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const port = (server.address() as { port: number }).port;
  const transfer = { url: `http://127.0.0.1:${port}/api/drive/transfers/staged-upload/${crypto.randomUUID()}`, method: "POST", protocol: "icloud-drive-upload-parts-v1", partBytes: 8 * 1024 ** 2, size: metadata.size, sha256: metadata.sha256, expiresAt: Date.now() + 30 * 60_000, headers: { Authorization: "Bearer c3ludGhldGlj" } };
  await assert.rejects(uploadFile(path, { operationId: id, transfer }), /HTTP 503/);
  assert.equal(posts, 1, "a long Retry-After stops the client instead of retrying early");
  retryAfter = undefined; posts = 0;
  await assert.rejects(uploadFile(path, { operationId: id, transfer }), /HTTP 503/);
  assert.equal(posts, 3, "R2 retries are bounded even when progress remains prepared");
  for (nextPhase of ["allocating", "uploading", "committing", "unknown"]) {
    id = crypto.randomUUID(); phase = "prepared"; posts = 0;
    await assert.rejects(uploadFile(path, { operationId: id, transfer }), /Staging changed during recovery/);
    assert.equal(posts, 1, "no part is replayed after the operation starts Apple dispatch");
  }
});
