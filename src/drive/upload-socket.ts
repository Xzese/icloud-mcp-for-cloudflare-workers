import { AppError, publicError } from "../errors.ts";
import type { DriveService } from "./service.ts";
import type { RuntimeEnv } from "../platform/sites.ts";
import { DRIVE_STREAM_CHUNK_BYTES, DRIVE_STREAM_PROTOCOL, DRIVE_STREAM_LEGACY_PROTOCOL, DRIVE_TRANSFER_TIMEOUT_MS } from "./limits.ts";
import type { TransferClaim } from "./transfer-capability.ts";

// A control-only socket keeps final R2 delivery attached to a live request. No
// giant HTTP response wait, background waitUntil job, or file frames are used.
export async function driveStoredUploadSocket(request: Request, service: DriveService, claim: TransferClaim) {
  const protocol = "icloud-drive-upload-parts-v1";
  if (request.method !== "GET" || request.headers.get("upgrade")?.toLowerCase() !== "websocket" || request.headers.get("sec-websocket-protocol") !== protocol) throw new AppError("VALIDATION_ERROR", "Use the staged completion WebSocket protocol.", 426);
  const intent = await service.resumableTransfer(request, claim);
  if (!("phase" in intent) || !["prepared", "uploaded", "confirmed"].includes(intent.phase)) throw new AppError("WRITE_OUTCOME_UNKNOWN", "Inspect this operation; its Apple write cannot be retried.", 503);
  const [client, server] = Object.values(new WebSocketPair());
  const abort = new AbortController(); let closed = false;
  const send = (message: object) => server.send(JSON.stringify({ ...message, operationId: claim.id }));
  const stop = (reason?: unknown) => {
    if (closed) return;
    closed = true; clearInterval(heartbeat); clearTimeout(timer); abort.abort(reason);
  };
  const fail = (error: unknown) => {
    if (closed) return;
    try { send({ type: "failed", error: publicError(error, crypto.randomUUID()) }); } catch { /* Disconnected. */ }
    stop(error); try { server.close(1008, "Inspect the retained operation."); } catch { /* Disconnected. */ }
  };
  server.accept();
  const heartbeat = setInterval(() => { try { send({ type: "pending" }); } catch (error) { stop(error); } }, 15_000);
  const timer = setTimeout(() => fail(new AppError("AUTH_EXPIRED", "The stored delivery exceeded its transfer budget.", 409)), DRIVE_TRANSFER_TIMEOUT_MS);
  server.addEventListener("close", () => stop(new AppError("CONFLICT", "The completion connection closed; inspect the operation.", 409)));
  server.addEventListener("error", () => fail(new AppError("CONFLICT", "The completion connection failed; inspect the operation.", 409)));
  server.addEventListener("message", () => fail(new AppError("VALIDATION_ERROR", "No client frames are accepted during stored delivery.", 400)));
  void service.completeMultipartUpload({ operationId: claim.id, expectedGeneration: claim.scope.generation }, abort.signal, claim).then(operation => {
    if (closed) return;
    send({ type: "result", operation }); stop(); server.close(1000, "Upload receipt saved.");
  }).catch(fail);
  return new Response(null, { status: 101, webSocket: client, headers: { "sec-websocket-protocol": protocol, "cache-control": "private, no-store", "x-robots-tag": "noindex, nofollow, noarchive, nosnippet", "referrer-policy": "no-referrer" } });
}

// The browser sends exactly one frame per server credit. Credits follow reads
// by the existing Apple upload stream, bounding queued bytes without R2.
export async function driveUploadSocket(request: Request, env: RuntimeEnv, service: DriveService, operationId: string, claim?: TransferClaim) {
  if (request.method !== "GET" || request.headers.get("upgrade")?.toLowerCase() !== "websocket") throw new AppError("VALIDATION_ERROR", "A WebSocket upgrade is required.", 426);
  if ((!claim || request.headers.has("origin")) && request.headers.get("origin") !== env.APP_ORIGIN || request.headers.get("sec-fetch-site") === "cross-site") throw new AppError("FORBIDDEN", "Use this private Site's upload form or an authorized transfer client.", 403);
  const protocol = request.headers.get("sec-websocket-protocol");
  const chunkBytes = protocol === DRIVE_STREAM_LEGACY_PROTOCOL ? 1024 * 1024 : DRIVE_STREAM_CHUNK_BYTES;
  if (![DRIVE_STREAM_PROTOCOL, DRIVE_STREAM_LEGACY_PROTOCOL].includes(protocol ?? "") || new URL(request.url).search) throw new AppError("VALIDATION_ERROR", "Use the supported direct upload protocol.", 400);
  const intent = await service.streamUploadStatus(operationId, claim);
  const [client, server] = Object.values(new WebSocketPair());
  const abort = new AbortController();
  let received = 0, credit = false, finished = false, closed = false;
  const framed = new FixedLengthStream(intent.size);
  const source = framed.readable;
  let idle: ReturnType<typeof setTimeout> | undefined;
  const send = (message: object) => server.send(JSON.stringify({ ...message, operationId }));
  const stop = (reason: unknown) => {
    if (closed) return;
    closed = true; clearTimeout(idle); clearTimeout(lifetime);
    if (!finished) {
      abort.abort(reason);
      void framed.writable.abort(reason).catch(() => {});
    }
  };
  const fail = (error: unknown) => {
    if (closed) return;
    try { send({ type: "failed", error: publicError(error, crypto.randomUUID()) }); } catch { /* Peer disconnected. */ }
    stop(error);
    try { server.close(1008, "Inspect the retained upload operation before retrying."); } catch { /* Peer disconnected. */ }
  };
  const pull = () => {
    if (closed || received === intent.size) return;
    credit = true;
    idle = setTimeout(() => fail(new AppError("CONFLICT", "The direct upload stopped receiving data. Inspect its original operation ID.", 409)), 60_000);
    send({ type: "pull", offset: received, bytes: Math.min(chunkBytes, intent.size - received) });
  };
  const lifetime = setTimeout(() => fail(new AppError("AUTH_EXPIRED", "The direct upload exceeded its transfer budget. Inspect its operation.", 409)), DRIVE_TRANSFER_TIMEOUT_MS);
  // Blob-backed messages can pipe through the runtime without materializing
  // multi-megabyte ArrayBuffers in JS. Retain older runtime compatibility.
  try { server.binaryType = "blob"; } catch { server.binaryType = "arraybuffer"; }
  server.accept();
  server.addEventListener("close", event => {
    if (!closed && !finished) console.error({ event: "drive-upload-peer-closed", receivedBytes: received, expectedSize: intent.size, closeCode: event.code });
    stop(new AppError("CONFLICT", "The direct upload connection closed. Inspect its operation.", 409));
  });
  server.addEventListener("error", () => fail(new AppError("CONFLICT", "The direct upload connection failed. Inspect its operation.", 409)));
  server.addEventListener("message", event => {
    void (async () => {
      if (closed) return;
      const blob = event.data instanceof Blob ? event.data : event.data instanceof ArrayBuffer ? new Blob([event.data]) : null;
      if (!credit || !blob || blob.size !== Math.min(chunkBytes, intent.size - received)) throw new AppError("VALIDATION_ERROR", "Send only the exact binary frame requested by the server.", 400);
      credit = false; clearTimeout(idle);
      received += blob.size;
      await blob.stream().pipeTo(framed.writable, { preventClose: true, signal: abort.signal });
      if (received === intent.size) await framed.writable.close();
      else pull();
    })().catch(fail);
  });
  if (intent.size === 0) void framed.writable.close().catch(fail);
  void service.uploadStreamContent(operationId, source, abort.signal, claim, pull).then(result => {
    if (closed) return;
    send({ type: "result", operation: result });
    finished = true; stop(undefined);
    server.close(1000, "Upload result saved.");
  }).catch(fail);
  return new Response(null, { status: 101, webSocket: client, headers: { "sec-websocket-protocol": protocol!, "cache-control": "private, no-store" } });
}
