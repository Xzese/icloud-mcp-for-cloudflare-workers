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

for (const protocol of ["icloud-drive-upload-v1", "icloud-drive-upload-v2"]) test(`transfer client uses ${protocol} credits, verifies disk bytes, and never reconnects after loss`, async t => {
  const directory = await mkdtemp(join(tmpdir(), "drive-transfer-client-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "synthetic.bin"), bytes = Buffer.alloc(2 * (protocol.endsWith("v2") ? 8 : 1) * 1024 ** 2 + 17, 90);
  await writeFile(path, bytes);
  const metadata = await fileMetadata(path), id = crypto.randomUUID(), token = Buffer.from(crypto.randomUUID()).toString("base64");
  const server = createServer(), websocket = new WebSocketServer({ server });
  let connections = 0, dropped = false;
  websocket.on("connection", (socket: any, request: any) => {
    connections++; assert.equal(request.headers.authorization, `Bearer ${token}`);
    let offset = 0; const hash = createHash("sha256");
    const pull = () => socket.send(JSON.stringify({ type: "pull", operationId: id, offset, bytes: Math.min((protocol.endsWith("v2") ? 8 : 1) * 1024 ** 2, bytes.length - offset) }));
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
