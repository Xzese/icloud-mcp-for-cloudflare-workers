import { AppError, publicError } from "../errors.ts";
import type { DriveService } from "./service.ts";
import type { RuntimeEnv } from "../platform/sites.ts";
import { DRIVE_STREAM_CHUNK_BYTES, DRIVE_STREAM_PROTOCOL, DRIVE_TRANSFER_TIMEOUT_MS } from "./limits.ts";

// The browser sends exactly one frame per server credit. Credits follow reads
// by the existing Apple upload stream, bounding queued bytes without R2.
export async function driveUploadSocket(request: Request, env: RuntimeEnv, service: DriveService, operationId: string) {
  if (request.method !== "GET" || request.headers.get("upgrade")?.toLowerCase() !== "websocket") throw new AppError("VALIDATION_ERROR", "A WebSocket upgrade is required.", 426);
  if (request.headers.get("origin") !== env.APP_ORIGIN || request.headers.get("sec-fetch-site") === "cross-site") throw new AppError("FORBIDDEN", "Use this private Site's upload form.", 403);
  if (request.headers.get("sec-websocket-protocol") !== DRIVE_STREAM_PROTOCOL || new URL(request.url).search) throw new AppError("VALIDATION_ERROR", "Use the supported direct upload protocol.", 400);
  const intent = await service.streamUploadStatus(operationId);
  const [client, server] = Object.values(new WebSocketPair());
  const abort = new AbortController();
  let received = 0, credit = false, finished = false, closed = false;
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let idle: ReturnType<typeof setTimeout> | undefined;
  const send = (message: object) => server.send(JSON.stringify({ ...message, operationId }));
  const stop = (reason: unknown) => {
    if (closed) return;
    closed = true; clearTimeout(idle); clearTimeout(lifetime);
    if (!finished) {
      abort.abort(reason);
      try { controller.error(reason); } catch { /* Stream already ended. */ }
    }
  };
  const fail = (error: unknown) => {
    if (closed) return;
    try { send({ type: "failed", ...publicError(error, crypto.randomUUID()) }); } catch { /* Peer disconnected. */ }
    stop(error);
    try { server.close(1008, "Inspect the retained upload operation before retrying."); } catch { /* Peer disconnected. */ }
  };
  const source = new ReadableStream<Uint8Array>({
    start(value) { controller = value; if (intent.size === 0) value.close(); },
    pull() {
      if (closed || received === intent.size) return;
      credit = true;
      idle = setTimeout(() => fail(new AppError("CONFLICT", "The direct upload stopped receiving data. Inspect its original operation ID.", 409)), 60_000);
      send({ type: "pull", offset: received, bytes: Math.min(DRIVE_STREAM_CHUNK_BYTES, intent.size - received) });
    },
    // Receipt recovery intentionally cancels the unused byte stream. Keep
    // the socket alive so that a saved result can still reach the browser.
    cancel() { credit = false; clearTimeout(idle); },
  }, { highWaterMark: 0 });
  const lifetime = setTimeout(() => fail(new AppError("AUTH_EXPIRED", "The direct upload exceeded its transfer budget. Inspect its operation.", 409)), DRIVE_TRANSFER_TIMEOUT_MS);
  server.binaryType = "arraybuffer";
  server.accept();
  server.addEventListener("close", () => stop(new AppError("CONFLICT", "The direct upload connection closed. Inspect its operation.", 409)));
  server.addEventListener("error", () => fail(new AppError("CONFLICT", "The direct upload connection failed. Inspect its operation.", 409)));
  server.addEventListener("message", event => {
    try {
      if (closed) return;
      if (!credit || !(event.data instanceof ArrayBuffer) || event.data.byteLength !== Math.min(DRIVE_STREAM_CHUNK_BYTES, intent.size - received)) throw new AppError("VALIDATION_ERROR", "Send only the exact binary frame requested by the server.", 400);
      credit = false; clearTimeout(idle);
      received += event.data.byteLength;
      controller.enqueue(new Uint8Array(event.data));
      if (received === intent.size) controller.close();
    } catch (error) { fail(error); }
  });
  void service.uploadStreamContent(operationId, source, abort.signal).then(result => {
    if (closed) return;
    send({ type: "result", operation: result });
    finished = true; stop(undefined);
    server.close(1000, "Upload result saved.");
  }).catch(fail);
  return new Response(null, { status: 101, webSocket: client, headers: { "sec-websocket-protocol": DRIVE_STREAM_PROTOCOL, "cache-control": "private, no-store" } });
}
