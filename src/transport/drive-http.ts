import { AppError } from "../errors.ts";
import type { AppleHTTP } from "./apple-http.ts";
import { DRIVE_FILE_BYTES, DRIVE_TRANSFER_TIMEOUT_MS } from "../drive/limits.ts";
export { DRIVE_TRANSFER_TIMEOUT_MS } from "../drive/limits.ts";

export const DRIVE_MAX_METADATA_BYTES = 1_048_576;
export const DRIVE_MAX_TRANSFER_BYTES = DRIVE_FILE_BYTES;

function protocol(message: string): never {
  throw new AppError("PROTOCOL_CHANGED", message);
}

export function driveServiceURL(value: string, service: "drivews" | "docws"): URL {
  let url: URL;
  try { url = new URL(value); } catch { return protocol("The saved iCloud Drive endpoint is invalid."); }
  const host = service === "drivews" ? /^p\d+-drivews\.icloud\.com$/ : /^p\d+-docws\.icloud\.com$/;
  if (url.protocol !== "https:" || !host.test(url.hostname) || url.username || url.password || url.port || url.pathname !== "/" || url.search || url.hash) {
    return protocol("The saved iCloud Drive endpoint is outside the supported Apple service origin.");
  }
  return url;
}

const DRIVE_METADATA_PATHS = new Set([
  "/retrieveItemDetailsInFolders", "/retrieveItemDetails", "/createFolders", "/renameItems", "/moveItems",
  "/ws/com.apple.CloudDocs/download/by_id", "/ws/com.apple.CloudDocs/upload/web", "/ws/com.apple.CloudDocs/update/documents",
]);

export function validateDriveMetadataURL(value: URL): URL {
  const supportedHost = /^p\d+-drivews\.icloud\.com$/.test(value.hostname) || /^p\d+-docws\.icloud\.com$/.test(value.hostname);
  const docwsRead = /^\/v1\/(?:item|enumerate)\/[A-Za-z0-9._:-]{1,512}$/.test(value.pathname);
  const sharedDownload = /^\/ws\/com\.apple\.CloudDocs\/download\/by_id\/[A-Za-z0-9._-]{1,256}$/.test(value.pathname);
  if (value.protocol !== "https:" || !supportedHost || value.username || value.password || value.port || value.hash || !DRIVE_METADATA_PATHS.has(value.pathname) && !sharedDownload && !docwsRead) return protocol("The iCloud Drive metadata address is outside the supported service endpoints.");
  if (value.hostname.endsWith("-drivews.icloud.com") && (value.pathname.startsWith("/ws/") || docwsRead)) return protocol("The iCloud Drive operation used an endpoint on the wrong service host.");
  if (value.hostname.endsWith("-docws.icloud.com") && !value.pathname.startsWith("/ws/com.apple.CloudDocs/") && !docwsRead) return protocol("The iCloud Drive operation used an endpoint on the wrong service host.");
  return value;
}

export function driveContentURL(value: unknown, kind: "download" | "upload", dsid?: string): URL {
  if (typeof value !== "string" || value.length < 1 || value.length > 8192 || value.trim() !== value || /[\u0000-\u0020\u007f]/.test(value)) {
    return protocol("Apple returned an invalid iCloud Drive content address.");
  }
  let url: URL;
  try { url = new URL(value); } catch { return protocol("Apple returned an invalid iCloud Drive content address."); }
  const download = url.hostname === "cvws.icloud-content.com" && /^\/B\/[A-Za-z0-9._~!$&'()*+,;=:@%-]+\/[A-Za-z0-9._~!$&'()*+,;=:@%-]+$/.test(url.pathname) && url.search.length > 0;
  // Apple's live allocation also uses this exact shared content-service host.
  // Both variants still require the account-bound path and signed token.
  const uploadHost = url.hostname === "cws.icloud-content.com" || /^p\d+-contentws\.icloud\.com$/.test(url.hostname);
  const upload = uploadHost && dsid !== undefined && /^\d{1,32}$/.test(dsid) && url.pathname === `/${dsid}/singleFileUpload` && !!url.searchParams.get("tk");
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash || (kind === "download" ? !download : !upload)) {
    return protocol("Apple returned an unsupported iCloud Drive content address.");
  }
  return url;
}

function timeoutSignal(signal?: AbortSignal): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException("Transfer timed out", "TimeoutError")), DRIVE_TRANSFER_TIMEOUT_MS);
  const cancel = () => controller.abort(signal?.reason);
  if (signal?.aborted) cancel();
  else signal?.addEventListener("abort", cancel, { once: true });
  return { signal: controller.signal, dispose: () => { clearTimeout(timer); signal?.removeEventListener("abort", cancel); } };
}

async function readBounded(response: Response, limit: number, signal?: AbortSignal): Promise<Uint8Array> {
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) {
    await response.body?.cancel(); protocol("The Apple metadata response exceeded its byte budget.");
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const abort = () => { void reader.cancel(signal?.reason).catch(() => {}); };
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (signal?.aborted) throw signal.reason;
      if (part.done) break;
      size += part.value.byteLength;
      if (size > limit) protocol("The Apple metadata response exceeded its byte budget.");
      chunks.push(part.value);
    }
  } finally {
    signal?.removeEventListener("abort", abort);
    try { await reader.cancel(); } catch { /* Body already closed. */ }
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

export interface DriveByteRange { start: number; end: number; total?: number; }
const READ_RETRY_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const METADATA_BUDGET_MS = 8000;

function delayFor(headers: Headers, attempt: number): number {
  const raw = headers.get("retry-after");
  if (raw !== null) {
    const ms = /^\d+(?:\.\d+)?$/.test(raw) ? Number(raw) * 1000 : Date.parse(raw) - Date.now();
    if (Number.isFinite(ms)) return Math.max(0, ms);
  }
  return 250 * 2 ** attempt;
}
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}
function readMetadata(url: URL, method: string): boolean {
  return method === "POST" && ["/retrieveItemDetails", "/retrieveItemDetailsInFolders"].includes(url.pathname) ||
    method === "GET" && (/^\/v1\/(?:item|enumerate)\//.test(url.pathname) || /^\/ws\/com\.apple\.CloudDocs\/download\/by_id(?:\/|$)/.test(url.pathname));
}

export class DriveHTTP {
  private readonly http: AppleHTTP;
  constructor(http: AppleHTTP) { this.http = http; }

  private nextReadAt = 0;
  async metadata(url: URL, init: { method: "GET" | "POST"; body?: string; signal?: AbortSignal }): Promise<{ status: number; bytes: Uint8Array }> {
    url = validateDriveMetadataURL(url);
    const readonly = readMetadata(url, init.method);
    const controller = new AbortController();
    const deadline = Date.now() + METADATA_BUDGET_MS;
    const timer = setTimeout(() => controller.abort(), METADATA_BUDGET_MS);
    const cancel = () => controller.abort(init.signal?.reason);
    if (init.signal?.aborted) cancel();
    else init.signal?.addEventListener("abort", cancel, { once: true });
    try {
      for (let attempt = 0; ; attempt++) {
        if (controller.signal.aborted) throw controller.signal.reason;
        if (readonly) {
          await pause(Math.max(0, this.nextReadAt - Date.now()), controller.signal);
          this.nextReadAt = Date.now() + 100;
        }
        const headers = new Headers({ Accept: "application/json", Origin: "https://www.icloud.com", Referer: "https://www.icloud.com/", "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3.1 Safari/605.1.15" });
        if (init.body !== undefined) headers.set("Content-Type", "application/json");
        const cookie = this.http.jar.header(url);
        if (cookie) headers.set("cookie", cookie);
        let response: Response;
        try { response = await this.http.send(url, { method: init.method, headers, ...(init.body === undefined ? {} : { body: init.body }), redirect: "manual", signal: controller.signal }); }
        catch (error) {
          // Permission/lease failures and aborts are never replayed. Only reads
          // may retry a transport failure, within the original request deadline.
          if (!readonly || error instanceof AppError || controller.signal.aborted || attempt >= 2) throw error;
          await pause(250 * 2 ** attempt, controller.signal); continue;
        }
        if (response.headers.has("set-cookie") && typeof response.headers.getSetCookie !== "function") throw new AppError("UNSUPPORTED_FEATURE", "This runtime cannot preserve separate Apple cookies.");
        for (const line of response.headers.getSetCookie?.() ?? []) this.http.jar.set(line, url);
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          await response.body?.cancel();
          throw new AppError("PROTOCOL_CHANGED", "iCloud Drive requested a redirect; the operation was stopped.");
        }
        const delay = delayFor(response.headers, attempt);
        if (readonly && attempt < 2 && READ_RETRY_STATUSES.has(response.status) && Date.now() + delay < deadline) {
          await response.body?.cancel(); await pause(delay, controller.signal); continue;
        }
        return { status: response.status, bytes: await readBounded(response, DRIVE_MAX_METADATA_BYTES, controller.signal) };
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("UPSTREAM_UNAVAILABLE", "The iCloud Drive request could not complete within its request budget.", 503, true);
    } finally { clearTimeout(timer); init.signal?.removeEventListener("abort", cancel); }
  }

  async download(urlValue: string, signal?: AbortSignal, range?: DriveByteRange): Promise<Response> {
    let url = driveContentURL(urlValue, "download");
    if (range && (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) || range.start < 0 || range.end < range.start || range.end >= DRIVE_MAX_TRANSFER_BYTES)) throw new AppError("VALIDATION_ERROR", "The Drive byte range is invalid.", 400);
    const budget = timeoutSignal(signal), deadline = Date.now() + METADATA_BUDGET_MS;
    const visited = new Set([url.href]);
    let attempt = 0, redirects = 0;
    try {
      let response: Response;
      for (;;) {
        if (budget.signal.aborted) throw budget.signal.reason;
        const headers = new Headers({ Accept: "*/*", ...(range ? { Range: `bytes=${range.start}-${range.end}` } : {}) });
        try { response = await this.http.send(url, { method: "GET", headers, redirect: "manual", signal: budget.signal }); }
        catch (error) {
          if (error instanceof AppError || budget.signal.aborted || attempt >= 2 || Date.now() + 250 * 2 ** attempt >= deadline) throw error;
          await pause(250 * 2 ** attempt++, budget.signal); continue;
        }
        // Apple's nonstandard 330 is the only supported redirect. Validate each
        // destination, bound the chain, and send neither cookies nor auth headers.
        if (response.status === 330) {
          const location = response.headers.get("location");
          await response.body?.cancel();
          if (!location || ++redirects > 3) protocol("The Apple download redirect chain is invalid.");
          let destination: URL;
          try { destination = new URL(location, url); } catch { return protocol("Apple returned an invalid download redirect address."); }
          url = driveContentURL(destination.href, "download");
          if (visited.has(url.href)) protocol("The Apple download redirect chain repeated an address.");
          visited.add(url.href); continue;
        }
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          await response.body?.cancel(); protocol("The iCloud Drive content server requested an unsupported redirect.");
        }
        const delay = delayFor(response.headers, attempt);
        if (attempt < 2 && READ_RETRY_STATUSES.has(response.status) && Date.now() + delay < deadline) {
          await response.body?.cancel(); await pause(delay, budget.signal); attempt++; continue;
        }
        break;
      }
      if (response.status !== 200 && response.status !== 206) {
        await response.body?.cancel();
        throw new AppError(response.status === 429 ? "RATE_LIMITED" : "UPSTREAM_UNAVAILABLE", "The iCloud Drive file content could not be downloaded.", response.status === 429 ? 429 : 502, READ_RETRY_STATUSES.has(response.status));
      }
      const limit = range ? range.end - range.start + 1 : DRIVE_MAX_TRANSFER_BYTES;
      const length = response.headers.get("content-length");
      try {
        if (range) {
          const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get("content-range") ?? "");
          if (response.status !== 206 || !match || Number(match[1]) !== range.start || Number(match[2]) !== range.end || !Number.isSafeInteger(Number(match[3])) || Number(match[3]) <= range.end || Number(match[3]) > DRIVE_MAX_TRANSFER_BYTES || range.total !== undefined && Number(match[3]) !== range.total) protocol("Apple returned a different or unsupported download byte range.");
        } else if (response.status === 206 || response.headers.has("content-range")) protocol("Apple returned an unsolicited partial download.");
        if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit || range && Number(length) !== limit)) protocol("The iCloud Drive file exceeded its transfer byte budget or range.");
      } catch (error) { await response.body?.cancel(); throw error; }
      if (!response.body) { budget.dispose(); return new Response(null, { status: response.status, headers: safeContentHeaders(response.headers) }); }
      return new Response(boundedStream(response.body, limit, budget.signal, budget.dispose), { status: response.status, headers: safeContentHeaders(response.headers) });
    } catch (error) {
      budget.dispose();
      if (error instanceof AppError) throw error;
      throw new AppError("UPSTREAM_UNAVAILABLE", "The iCloud Drive download could not complete within its transfer budget.", 503, true);
    }
  }

  async upload(urlValue: string, dsid: string, body: ReadableStream<Uint8Array>, expectedSize: number, filename: string, contentType: string, signal?: AbortSignal): Promise<Uint8Array> {
    const url = driveContentURL(urlValue, "upload", dsid);
    if (!Number.isSafeInteger(expectedSize) || expectedSize < 0 || expectedSize > DRIVE_MAX_TRANSFER_BYTES) throw new AppError("VALIDATION_ERROR", "The upload size is outside the supported byte budget.");
    const boundary = `----iCloudDrive${crypto.randomUUID().replace(/-/g, "")}`;
    const escapedName = filename.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
    const prefix = new TextEncoder().encode(`--${boundary}\r\nContent-Disposition: form-data; name="${escapedName}"; filename="${escapedName}"\r\nContent-Type: ${contentType}\r\n\r\n`);
    const suffix = new TextEncoder().encode(`\r\n--${boundary}--\r\n`);
    let total = 0;
    const reader = body.getReader();
    const multipart = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(prefix); },
      async pull(controller) {
        try {
          const chunk = await reader.read();
          if (chunk.done) {
            if (total !== expectedSize) throw new AppError("VALIDATION_ERROR", "The upload stream length did not match its declared size.");
            controller.enqueue(suffix);
            controller.close();
            reader.releaseLock();
            return;
          }
          total += chunk.value.byteLength;
          if (total > expectedSize || total > DRIVE_MAX_TRANSFER_BYTES) throw new AppError("VALIDATION_ERROR", "The upload stream exceeded its declared byte budget.");
          controller.enqueue(chunk.value);
        } catch (error) {
          await reader.cancel(error).catch(() => {});
          controller.error(error);
        }
      },
      async cancel(reason) { await reader.cancel(reason).catch(() => {}); },
    });
    const budget = timeoutSignal(signal);
    try {
      const response = await this.http.send(url, { method: "POST", headers: { "Content-Type": `multipart/form-data; boundary=${boundary}`, Accept: "application/json" }, body: multipart, redirect: "manual", signal: budget.signal, duplex: "half" } as RequestInit);
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        throw new AppError("PROTOCOL_CHANGED", "The iCloud Drive upload server requested a redirect.");
      }
      if (response.status < 200 || response.status >= 300) {
        await response.body?.cancel();
        throw new AppError("UPSTREAM_UNAVAILABLE", "The iCloud Drive upload server rejected the content transfer.", 502, false);
      }
      return await readBounded(response, DRIVE_MAX_METADATA_BYTES, budget.signal);
    } catch (error) {
      await reader.cancel(error).catch(() => {});
      if (error instanceof AppError) throw error;
      throw new AppError("UPSTREAM_UNAVAILABLE", "The iCloud Drive upload could not complete within its transfer budget.", 503, true);
    } finally { budget.dispose(); }
  }
}

function safeContentHeaders(headers: Headers): Headers {
  const safe = new Headers();
  for (const name of ["content-type", "content-length", "content-range", "etag", "last-modified"]) {
    const value = headers.get(name);
    if (value !== null) safe.set(name, value);
  }
  return safe;
}

function boundedStream(source: ReadableStream<Uint8Array>, max: number, signal: AbortSignal, dispose: () => void): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let total = 0;
  let ended = false;
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined;
  const finish = () => { signal.removeEventListener("abort", abort); dispose(); };
  const abort = () => {
    void reader.cancel(signal.reason).catch(() => {});
    finish();
    controllerRef?.error(new AppError("UPSTREAM_UNAVAILABLE", "The iCloud Drive download was cancelled or timed out.", 503, false));
  };
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    },
    async pull(controller) {
      if (signal.aborted) {
        await reader.cancel(signal.reason).catch(() => {});
        finish();
        controller.error(new AppError("UPSTREAM_UNAVAILABLE", "The iCloud Drive download was cancelled or timed out.", 503, false));
        return;
      }
      try {
        const next = await reader.read();
        if (next.done) { ended = true; reader.releaseLock(); finish(); controller.close(); return; }
        total += next.value.byteLength;
        if (total > max) {
          await reader.cancel().catch(() => {});
          finish();
          controller.error(new AppError("PROTOCOL_CHANGED", "The iCloud Drive file exceeded the transfer byte budget."));
          return;
        }
        controller.enqueue(next.value);
      } catch (error) { finish(); controller.error(error); }
    },
    async cancel(reason) { if (!ended) await reader.cancel(reason).catch(() => {}); finish(); },
  });
}
