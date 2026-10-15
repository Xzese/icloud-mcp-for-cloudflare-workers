import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DriveHTTP } from "../src/transport/drive-http.ts";
import { AppleHTTP } from "../src/transport/apple-http.ts";
import { uploadDriveSocket, parseUploadSocketResponse, retainVerifiedUploadBody } from "../src/transport/drive-upload-socket.ts";

const encode = (value: string) => new TextEncoder().encode(value);
const url = new URL("https://cws.icloud-content.com/123/singleFileUpload?tk=synthetic");
function socketFor(reply: string, inspect?: (bytes: Uint8Array) => void) {
  let controller: ReadableStreamDefaultController<Uint8Array>, closed = false;
  const readable = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
  return { readable, writable: new WritableStream<Uint8Array>({ write(bytes) { inspect?.(bytes); } }), opened: Promise.resolve({}), closed: Promise.resolve(),
    respond() { if (!closed) { closed = true; controller.enqueue(encode(reply)); controller.close(); } },
    close: async () => { if (!closed) { closed = true; controller.close(); } },
  };
}

test("the large TLS upload sends exact raw bytes beyond 2 GiB, verifies framing and buffers only the receipt", async () => {
  const size = 2 ** 31 + 17, chunk = new Uint8Array(1024 ** 2).fill(90);
  const expected = createHash("sha256"), actual = createHash("sha256");
  for (let left = size; left > 0; left -= chunk.length) expected.update(chunk.subarray(0, Math.min(left, chunk.length)));
  let remaining = size, count = 0, header = false, ended = false;
  const source = new ReadableStream<Uint8Array>({ pull(controller) {
    if (!remaining) { ended = true; controller.close(); return; }
    const length = Math.min(remaining, chunk.length); remaining -= length; controller.enqueue(chunk.subarray(0, length));
  } }, { highWaterMark: 0 });
  const socket = socketFor('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n2\r\n{}\r\n0\r\n\r\n', bytes => {
    if (!header) {
      header = true;
      const text = new TextDecoder().decode(bytes);
      assert.match(text, /^POST \/123\/singleFileUpload\?tk=synthetic HTTP\/1.1\r\nHost: cws.icloud-content.com\r\n/);
      assert.ok(text.includes(`Content-Length: ${size}\r\n`));
      assert.ok(text.includes('Content-Type: application/octet-stream\r\n'));
      assert.ok(!/cookie|authorization|multipart/i.test(text)); return;
    }
    count += bytes.length; actual.update(bytes);
    if (count === size) queueMicrotask(() => socket.respond());
  });
  const connector = (address: SocketAddress, options: SocketOptions) => {
    assert.deepEqual(address, { hostname: "cws.icloud-content.com", port: 443 });
    assert.deepEqual(options, { secureTransport: "on", allowHalfOpen: false });
    return socket as unknown as Socket;
  };
  const http = new DriveHTTP(new AppleHTTP(undefined, (async (_input, init) => uploadDriveSocket(url, init ?? {}, connector)) as typeof fetch));
  const response = await http.upload(url.href, "123", source, size, "synthetic.bin", "application/octet-stream");
  assert.equal(count, size); assert.equal(ended, true); assert.equal(actual.digest("hex"), expected.digest("hex"));
  assert.equal(new TextDecoder().decode(response), "{}");
});

test("native body piping retains pre-final-byte verification and rejects early success without a retry", async () => {
  for (const early of [false, true]) {
    let complete = false, calls = 0, count = 0;
    const source = early ? new ReadableStream<Uint8Array>({ cancel() {} }, { highWaterMark: 0 }) : new ReadableStream<Uint8Array>({ start(controller) {
      complete = true; controller.enqueue(new Uint8Array([1, 2, 3])); controller.close();
    } });
    const release = retainVerifiedUploadBody(source, 3, () => complete);
    let header = false;
    const socket = socketFor('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}', bytes => {
      if (!header) { header = true; if (early) queueMicrotask(() => socket.respond()); return; }
      count += bytes.length; queueMicrotask(() => socket.respond());
    });
    const request = uploadDriveSocket(url, { method: "POST", redirect: "manual", headers: { "content-length": "3", "content-type": "application/octet-stream" }, body: source }, () => { calls++; return socket as unknown as Socket; });
    if (early) await assert.rejects(request, { code: "PROTOCOL_CHANGED" });
    else { assert.equal(await (await request).text(), "{}"); assert.equal(count, 3); }
    assert.equal(calls, 1); release();
  }
});

test("socket receipt parser rejects ambiguous framing, truncation, oversized bodies and unexpected encoding", async () => {
  const valid = parseUploadSocketResponse(encode('HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}'));
  assert.equal(await valid.text(), '{}');
  for (const response of [
    'HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\n{}',
    'HTTP/1.1 200 OK\r\nContent-Length: 2\r\nContent-Length: 2\r\n\r\n{}',
    'HTTP/1.1 200 OK\r\nContent-Length: 2\r\nTransfer-Encoding: chunked\r\n\r\n{}',
    'HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\n\r\n{}',
    'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\n{}\r\n0\r\n\r\nextra',
    'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3\r\n{}\r\n0\r\n\r\n',
    'HTTP/1.1 200 OK\r\n\r\n' + 'a'.repeat(1_048_577),
  ]) assert.throws(() => parseUploadSocketResponse(encode(response)), { code: 'PROTOCOL_CHANGED' });
});

test("an early socket rejection cancels pending input and never opens a replacement connection", async () => {
  let calls = 0, cancelled = 0;
  const socket = socketFor('HTTP/1.1 413 Payload Too Large\r\nContent-Length: 0\r\n\r\n', () => queueMicrotask(() => socket.respond()));
  const source = new ReadableStream<Uint8Array>({ cancel() { cancelled++; } }, { highWaterMark: 0 });
  const response = await uploadDriveSocket(url, { method: 'POST', redirect: 'manual', headers: { 'content-length': '10', 'content-type': 'application/octet-stream' }, body: source }, () => { calls++; return socket as unknown as Socket; });
  assert.equal(response.status, 413); assert.equal(calls, 1); assert.equal(cancelled, 1);
});

test("socket uploads refuse arbitrary origins, account headers, redirects and malformed sizes before connecting", async () => {
  for (const [target, extra] of [[new URL('https://attacker.example/123/singleFileUpload?tk=synthetic'), {}], [url, { cookie: 'synthetic' }], [url, { 'content-length': '2147483648junk' }]] as const) {
    await assert.rejects(uploadDriveSocket(target, { method: 'POST', redirect: 'manual', body: new ReadableStream(), headers: { 'content-length': '10', 'content-type': 'application/octet-stream', ...extra } }, () => { assert.fail('Invalid requests must not open a socket'); }), { code: 'PROTOCOL_CHANGED' });
  }
});
