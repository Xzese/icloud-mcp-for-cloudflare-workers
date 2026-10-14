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
  const sharedDownload = /^\/ws\/com\.apple\.CloudDocs\/download\/by_id\/[A-Za-z0-9._-]{1,256}$/.test(value.pathname);
  if (value.protocol !== "https:" || !supportedHost || value.username || value.password || value.port || value.hash || !DRIVE_METADATA_PATHS.has(value.pathname) && !sharedDownload) return protocol("The iCloud Drive metadata address is outside the supported service endpoints.");
  if (value.hostname.endsWith("-drivews.icloud.com") && value.pathname.startsWith("/ws/")) return protocol("The iCloud Drive operation used an endpoint on the wrong service host.");
  if (value.hostname.endsWith("-docws.icloud.com") && !value.pathname.startsWith("/ws/com.apple.CloudDocs/")) return protocol("The iCloud Drive operation used an endpoint on the wrong service host.");
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

async function readBounded(response: Response, limit: number): Promise<Uint8Array> {
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) protocol("The Apple metadata response exceeded its byte budget.");
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > limit) protocol("The Apple metadata response exceeded its byte budget.");
      chunks.push(part.value);
    }
  } finally {
    try { await reader.cancel(); } catch { /* Body already closed. */ }
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

export class DriveHTTP {
  private readonly http: AppleHTTP;
  constructor(http: AppleHTTP) { this.http = http; }

  async metadata(url: URL, init: { method: "GET" | "POST"; body?: string; signal?: AbortSignal }): Promise<{ status: number; bytes: Uint8Array }> {
    url = validateDriveMetadataURL(url);
    const headers = new Headers({ Accept: "application/json", Origin: "https://www.icloud.com", Referer: "https://www.icloud.com/", "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3.1 Safari/605.1.15" });
    if (init.body !== undefined) headers.set("Content-Type", "application/json");
    headers.delete("authorization");
    headers.delete("cookie");
    const cookie = this.http.jar.header(url);
    if (cookie) headers.set("cookie", cookie);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const cancel = () => controller.abort(init.signal?.reason);
    if (init.signal?.aborted) cancel();
    else init.signal?.addEventListener("abort", cancel, { once: true });
    try {
      const response = await this.http.send(url, { method: init.method, headers, ...(init.body === undefined ? {} : { body: init.body }), redirect: "manual", signal: controller.signal });
      if (response.headers.has("set-cookie") && typeof response.headers.getSetCookie !== "function") throw new AppError("UNSUPPORTED_FEATURE", "This runtime cannot preserve separate Apple cookies.");
      for (const line of response.headers.getSetCookie?.() ?? []) this.http.jar.set(line, url);
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        throw new AppError("PROTOCOL_CHANGED", "iCloud Drive requested a redirect; the operation was stopped.");
      }
      return { status: response.status, bytes: await readBounded(response, DRIVE_MAX_METADATA_BYTES) };
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("UPSTREAM_UNAVAILABLE", "The iCloud Drive request could not complete within its request budget.", 503, true);
    } finally {
      clearTimeout(timer);
      init.signal?.removeEventListener("abort", cancel);
    }
  }

  async download(urlValue: string, signal?: AbortSignal): Promise<Response> {
    const url = driveContentURL(urlValue, "download");
    const budget = timeoutSignal(signal);
    try {
      const response = await this.http.send(url, { method: "GET", headers: { Accept: "*/*" }, redirect: "manual", signal: budget.signal });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        throw new AppError("PROTOCOL_CHANGED", "The iCloud Drive content server requested a redirect.");
      }
      if (response.status < 200 || response.status >= 300) {
        await response.body?.cancel();
        throw new AppError("UPSTREAM_UNAVAILABLE", "The iCloud Drive file content could not be downloaded.", 502, false);
      }
      const length = response.headers.get("content-length");
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > DRIVE_MAX_TRANSFER_BYTES)) {
        await response.body?.cancel();
        protocol("The iCloud Drive file exceeded the transfer byte budget.");
      }
      if (!response.body) { budget.dispose(); return new Response(null, { status: 200, headers: safeContentHeaders(response.headers) }); }
      const body = boundedStream(response.body, DRIVE_MAX_TRANSFER_BYTES, budget.signal, budget.dispose);
      return new Response(body, { status: 200, headers: safeContentHeaders(response.headers) });
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
      return await readBounded(response, DRIVE_MAX_METADATA_BYTES);
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
