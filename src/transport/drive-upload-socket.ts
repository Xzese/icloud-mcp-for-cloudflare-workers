import { AppError } from "../errors.ts";
import { DRIVE_FILE_BYTES } from "../drive/limits.ts";

const RESPONSE_LIMIT = 1_048_576, HEADER_LIMIT = 16_384;
const protocol = () => new AppError("PROTOCOL_CHANGED", "The Apple upload socket returned an unsupported HTTP response.");
type UploadSocket = Pick<Socket, "readable" | "writable" | "opened" | "closed" | "close">;
type Connector = (address: SocketAddress, options: SocketOptions) => UploadSocket;

// The HTTP verifier owns these flags and withholds its last chunk until EOF
// and the full digest pass. Preserve that proof while piping native bytes to
// the socket without materializing them back into JavaScript buffers.
const verifiedBodies = new WeakMap<ReadableStream<Uint8Array>, { size: number; complete: () => boolean }>();
export function retainVerifiedUploadBody(body: ReadableStream<Uint8Array>, size: number, complete: () => boolean) {
  verifiedBodies.set(body, { size, complete });
  return () => verifiedBodies.delete(body);
}

// Only the bounded receipt is buffered. File bytes retain stream backpressure.
export function parseUploadSocketResponse(bytes: Uint8Array): Response;
export function parseUploadSocketResponse(bytes: Uint8Array, eof: boolean): Response | null;
export function parseUploadSocketResponse(bytes: Uint8Array, eof = true): Response | null {
  let offset = 0, status = 0, headers = new Headers();
  for (let interim = 0; ; interim++) {
    let end = -1;
    for (let i = offset; i + 3 < bytes.length && i - offset < HEADER_LIMIT; i++) {
      if (bytes[i] === 13 && bytes[i + 1] === 10 && bytes[i + 2] === 13 && bytes[i + 3] === 10) { end = i; break; }
    }
    if (interim > 4) throw protocol();
    if (end < 0) { if (!eof && bytes.length - offset < HEADER_LIMIT) return null; throw protocol(); }
    const lines = new TextDecoder().decode(bytes.subarray(offset, end)).split("\r\n");
    const match = /^HTTP\/1\.[01] ([1-5]\d\d)(?: [\x20-\x7e]*)?$/.exec(lines.shift() ?? "");
    if (!match) throw protocol();
    status = Number(match[1]); headers = new Headers();
    for (const line of lines) {
      const field = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+):[ \t]*([^\r\n]*)$/.exec(line);
      if (!field || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(field[2])) throw protocol();
      if (["content-length", "transfer-encoding", "content-encoding"].includes(field[1].toLowerCase()) && headers.has(field[1])) throw protocol();
      headers.append(field[1], field[2]);
    }
    offset = end + 4;
    if (status >= 200) break;
    if (![100, 102, 103].includes(status) || headers.has("transfer-encoding") || headers.has("content-length")) throw protocol();
  }
  let body = bytes.subarray(offset);
  if (headers.has("content-encoding") && headers.get("content-encoding") !== "identity") throw protocol();
  const encoding = headers.get("transfer-encoding"), length = headers.get("content-length");
  if (encoding && length !== null || encoding && encoding.toLowerCase() !== "chunked") throw protocol();
  if (encoding) {
    const chunks: Uint8Array[] = []; let cursor = 0, total = 0;
    const line = () => {
      const start = cursor;
      while (cursor + 1 < body.length && cursor - start <= HEADER_LIMIT) {
        if (body[cursor] === 13 && body[cursor + 1] === 10) {
          const value = new TextDecoder().decode(body.subarray(start, cursor)); cursor += 2; return value;
        }
        cursor++;
      }
      if (!eof && cursor - start <= HEADER_LIMIT) return null;
      throw protocol();
    };
    for (;;) {
      const value = line();
      if (value === null) return null;
      if (!/^[0-9a-fA-F]{1,8}(?:;[\x20-\x7e]*)?$/.test(value)) throw protocol();
      const size = parseInt(value, 16);
      if (size === 0) {
        const trailerStart = cursor;
        for (;;) {
          const trailer = line();
          if (cursor - trailerStart > HEADER_LIMIT) throw protocol();
          if (trailer === null) return null;
          if (trailer === "") break;
        }
        if (cursor !== body.length) throw protocol();
        break;
      }
      if (total + size > RESPONSE_LIMIT) throw protocol();
      if (cursor + size + 2 > body.length) { if (!eof) return null; throw protocol(); }
      if (body[cursor + size] !== 13 || body[cursor + size + 1] !== 10) throw protocol();
      chunks.push(body.subarray(cursor, cursor + size)); total += size; cursor += size + 2;
    }
    body = new Uint8Array(total); let at = 0;
    for (const chunk of chunks) { body.set(chunk, at); at += chunk.length; }
    headers.delete("transfer-encoding"); headers.set("content-length", String(total));
  } else if (length !== null) {
    if (!/^\d+$/.test(length) || Number(length) > RESPONSE_LIMIT) throw protocol();
    if (body.length < Number(length) && !eof) return null;
    if (Number(length) !== body.length) throw protocol();
  } else if (!eof && ![204, 205, 304].includes(status)) return null;
  if (body.length > RESPONSE_LIMIT || [204, 205, 304].includes(status) && body.length) throw protocol();
  return new Response([204, 205, 304].includes(status) ? null : new Uint8Array(body), { status, headers });
}

export async function uploadDriveSocket(url: URL, init: RequestInit, connector?: Connector): Promise<Response> {
  // Defense in depth: this sender is not a generic socket or arbitrary URL API.
  if (url.protocol !== "https:" || url.port || url.username || url.password || url.hash || !/^(?:cws\.icloud-content\.com|p\d+-contentws\.icloud\.com)$/.test(url.hostname)
    || !/^\/\d{1,32}\/singleFileUpload$/.test(url.pathname) || !url.searchParams.get("tk") || init.method !== "POST" || init.redirect !== "manual" || !(init.body instanceof ReadableStream)) throw protocol();
  const headers = new Headers(init.headers), length = headers.get("content-length"), type = headers.get("content-type");
  if (!length || !/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > DRIVE_FILE_BYTES || !type || !/^[\w.+-]+\/[\w.+-]+$/.test(type)
    || [...headers.keys()].some(key => !["content-length", "content-type", "accept"].includes(key))) throw protocol();
  const connect = connector ?? (await import("cloudflare:sockets")).connect;
  if (init.signal?.aborted) throw init.signal.reason;
  const socket = connect({ hostname: url.hostname, port: 443 }, { secureTransport: "on", allowHalfOpen: false });
  void socket.closed.catch(() => {});
  const retained = verifiedBodies.get(init.body);
  const nativePipe = retained?.size === Number(length);
  const source = nativePipe ? undefined : init.body.getReader();
  const reader = socket.readable.getReader(), writer = socket.writable.getWriter();
  const pumpAbort = new AbortController();
  let pump: Promise<void> | undefined, sent = 0, ended = false, sourceError: unknown;
  const stop = (reason?: unknown) => {
    void socket.close().catch(() => {});
    pumpAbort.abort(reason);
    void source?.cancel(reason).catch(() => {});
    void reader.cancel(reason).catch(() => {});
    void writer.abort(reason).catch(() => {});
  };
  const abort = () => stop(init.signal?.reason);
  init.signal?.addEventListener("abort", abort, { once: true });
  try {
    await socket.opened;
    if (init.signal?.aborted) throw init.signal.reason;
    await writer.write(new TextEncoder().encode(`POST ${url.pathname}${url.search} HTTP/1.1\r\nHost: ${url.hostname}\r\nContent-Type: ${type}\r\nContent-Length: ${length}\r\nAccept: application/json\r\nAccept-Encoding: identity\r\nConnection: close\r\n\r\n`));
    if (nativePipe) {
      writer.releaseLock();
      pump = init.body.pipeTo(socket.writable, { preventClose: true, signal: pumpAbort.signal }).then(() => { ended = true; }, error => {
        sourceError = error; stop(error); throw error;
      });
    } else {
      pump = (async () => {
        try {
          for (;;) {
            const next = await source!.read();
            if (init.signal?.aborted) throw init.signal.reason;
            if (next.done) break;
            sent += next.value.length;
            if (sent > Number(length)) throw protocol();
            await writer.write(next.value);
          }
          if (sent !== Number(length)) throw protocol();
          ended = true;
          // Do not close the writer: closing a TCP socket's writable side may
          // terminate its readable side before Apple's receipt has arrived.
        } catch (error) { sourceError = error; stop(error); throw error; }
      })();
    }
    void pump.catch(() => {});
    // HTTP framing, not a delayed TCP close, determines when a receipt is
    // complete. Close-delimited responses still require EOF. This buffer holds
    // only the bounded receipt and headers, never uploaded file bytes.
    const bytes = new Uint8Array(RESPONSE_LIMIT + HEADER_LIMIT * 6);
    let received = 0, response: Response | null = null;
    for (;;) {
      const next = await reader.read();
      if (init.signal?.aborted) throw init.signal.reason;
      if (next.done) { response = parseUploadSocketResponse(bytes.subarray(0, received)); break; }
      if (received + next.value.length > bytes.length) throw protocol();
      bytes.set(next.value, received); received += next.value.length;
      response = parseUploadSocketResponse(bytes.subarray(0, received), false);
      if (response) break;
    }
    if (response.ok) {
      if (!ended && (nativePipe ? !retained!.complete() : sent !== Number(length))) throw new AppError("PROTOCOL_CHANGED", "Apple responded before the complete upload was sent.");
      await pump;
    }
    return response;
  } catch (error) { throw sourceError ?? error; }
  finally {
    init.signal?.removeEventListener("abort", abort);
    stop(); await pump?.catch(() => {});
    source?.releaseLock(); reader.releaseLock();
    try { writer.releaseLock(); } catch { /* Native piping released the header writer. */ }
  }
}
