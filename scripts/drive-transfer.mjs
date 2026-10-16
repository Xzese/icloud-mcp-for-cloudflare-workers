// File bytes stay on disk/network. Transfer credentials arrive only on stdin,
// never in command arguments, files, progress output, or redirect requests.
import { createReadStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import { basename } from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { Readable } from "node:stream";
import WebSocket from "ws";
import { DRIVE_FILE_BYTES, DRIVE_FILE_LIMIT_LABEL, DRIVE_RELAY_TIMEOUT_MS } from "../src/drive/limits.ts";

const protocols = ["icloud-drive-upload-v1", "icloud-drive-upload-v2", "icloud-drive-upload-v3"], timeoutMs = 30 * 60_000;
export async function fileMetadata(path) {
  const info = await stat(path);
  if (!info.isFile() || !Number.isSafeInteger(info.size) || info.size > DRIVE_FILE_BYTES) throw new Error(`Choose an ordinary file up to ${DRIVE_FILE_LIMIT_LABEL}.`);
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return { name: basename(path), size: info.size, sha256: hash.digest("hex"), contentType: "application/octet-stream" };
}
export function validatePlan(value, kind) {
  const plan = value?.transfer ?? value;
  if (!plan || !(kind === "download" && plan.size === null) && (!Number.isSafeInteger(plan.size) || plan.size < 0 || plan.size > DRIVE_FILE_BYTES) || !Number.isSafeInteger(plan.expiresAt) || plan.expiresAt <= Date.now()) throw new Error("The transfer plan is invalid or expired. Inspect the original operation through MCP.");
  const staged = kind === "upload" && plan.protocol === "icloud-drive-upload-parts-v1";
  const routeKind = staged ? "staged-upload" : kind;
  const url = new URL(plan.url), local = ["127.0.0.1", "localhost"].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || !new RegExp(`^/api/drive/transfers/${routeKind}/[a-f0-9-]{36}$`).test(url.pathname)
    || ![kind === "upload" && !staged ? "wss:" : "https:", ...(local ? [kind === "upload" && !staged ? "ws:" : "http:"] : [])].includes(url.protocol)
    || plan.method !== (staged ? "POST" : kind === "upload" ? "WEBSOCKET" : "GET") || kind === "upload" && ((!staged && !protocols.includes(plan.protocol) || staged && plan.partBytes !== 8 * 1024 ** 2) || !/^[a-f0-9]{64}$/.test(plan.sha256))) throw new Error("Use the exact secure transfer endpoint returned by MCP.");
  if (staged && plan.completionUrl !== undefined && plan.completionUrl !== plan.url.replace(/^https:/, "wss:").replace(/^http:/, "ws:")) throw new Error("The completion endpoint must be the same authorized transfer.");
  if (!plan.headers || typeof plan.headers !== "object" || Array.isArray(plan.headers) || !/^Bearer [A-Za-z0-9+/=]+$/.test(plan.headers.Authorization ?? "")) throw new Error("Transfer authorization is missing.");
  for (const [name, entry] of Object.entries(plan.headers)) {
    if (!["authorization", "oai-sites-authorization"].includes(name.toLowerCase()) || typeof entry !== "string" || entry.length > 8192 || /[\r\n]/.test(entry)) throw new Error("Unexpected transfer credential headers.");
  }
  return plan;
}
/** @param {(progress: Record<string, unknown>) => void} report */
export async function uploadFile(path, value, report = () => {}, stageOnly = false) {
  const plan = validatePlan(value, "upload"), metadata = await fileMetadata(path);
  if (metadata.size !== plan.size || metadata.sha256 !== plan.sha256) throw new Error("The local file differs from the exact file authorized through MCP.");
  if (plan.protocol === "icloud-drive-upload-parts-v1") return uploadParts(path, value, plan, report, stageOnly);
  if (stageOnly) throw new Error("This transfer does not support staging.");
  const chunkBytes = plan.protocol === protocols[0] ? 1024 * 1024 : plan.protocol === protocols[2] ? 16 * 1024 * 1024 : 8 * 1024 * 1024;
  const file = await open(path, "r");
  try {
    return await new Promise((resolve, reject) => {
      const socket = new WebSocket(plan.url, plan.protocol, { headers: plan.headers, followRedirects: false, handshakeTimeout: 30_000, perMessageDeflate: false, maxPayload: 16_384 });
      let offset = 0, busy = false, settled = false, operationId = value?.operationId ?? null, reported = 0;
      const began = Date.now();
      const end = (error, result) => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        if (error) report({ event: "transfer-failed", operationId, bytesSent: offset, size: plan.size, elapsedMs: Date.now() - began });
        if (error) socket.terminate(); else socket.close();
        if (error) reject(error); else resolve(result);
      };
      const timer = setTimeout(() => end(new Error("Transfer timed out. Inspect the original MCP operation; no automatic retry was made.")), plan.protocol === protocols[2] ? DRIVE_RELAY_TIMEOUT_MS : timeoutMs);
      socket.on("unexpected-response", (_request, response) => {
        response.resume(); end(new Error(`Transfer handshake returned HTTP ${response.statusCode}. Inspect the original operation before another request.`));
      });
      socket.on("message", (data, binary) => {
        void (async () => {
          if (settled) return;
          if (busy || binary || data.length > 16_384) throw new Error("The transfer protocol failed.");
          const message = JSON.parse(data.toString("utf8"));
          operationId ??= message.operationId;
          if (typeof operationId !== "string" || message.operationId !== operationId) throw new Error("The transfer operation changed.");
          if (message.type === "failed") throw new Error(`Transfer failed (${String(message.error?.code ?? "unknown")}). Inspect operation ${operationId} through MCP.`);
          if (message.type === "result") {
            const savedReceipt = offset === 0 && ["uploaded", "confirmed"].includes(value?.phase);
            if (message.operation?.operationId !== operationId || message.operation.phase !== "confirmed" || offset !== plan.size && !savedReceipt) throw new Error("The transfer has no complete confirmed receipt.");
            end(undefined, { operationId, phase: "confirmed", bytesSent: offset, sha256: metadata.sha256, result: message.operation.result }); return;
          }
          if (message.type !== "pull" || message.offset !== offset || message.bytes !== Math.min(chunkBytes, plan.size - offset) || !message.bytes) throw new Error("The transfer requested an invalid frame.");
          busy = true;
          const bytes = Buffer.allocUnsafe(message.bytes);
          let count = 0;
          while (count < bytes.length) {
            const next = await file.read(bytes, count, bytes.length - count, offset + count);
            if (!next.bytesRead) throw new Error("The local file was truncated during transfer.");
            count += next.bytesRead;
          }
          if (settled) return;
          socket.send(bytes, { binary: true }); offset += bytes.length; busy = false;
          if (offset - reported >= 32 * 1024 ** 2 || offset === plan.size) {
            reported = offset; report({ operationId, bytesSent: offset, size: plan.size, elapsedMs: Date.now() - began });
          }
        })().catch(error => end(error));
      });
      socket.on("close", () => end(new Error(`Transfer connection closed. Inspect operation ${operationId ?? "from the original MCP response"}; its Apple outcome may be unknown.`)));
      socket.on("error", () => end(new Error("Transfer connection failed. Inspect the original operation through MCP; no automatic retry was made.")));
    });
  } finally { await file.close(); }
}
async function uploadParts(path, value, plan, report, stageOnly) {
  const call = async (method, extra = {}, body) => {
    if (Date.now() >= plan.expiresAt) throw new Error("Refresh the same operation through MCP; staged parts are retained.");
    const response = await fetch(plan.url, { method, headers: { ...plan.headers, ...extra }, body, redirect: "manual", signal: AbortSignal.timeout(90_000) });
    const reader = response.body?.getReader(), chunks = []; let length = 0;
    if (!reader) throw new Error("Missing staged transfer response.");
    try {
      for (;;) {
        const next = await reader.read(); if (next.done) break;
        length += next.value.length;
        if (length > 65_536) throw new Error("Oversized staged transfer response.");
        chunks.push(next.value);
      }
      let value;
      try { value = JSON.parse(Buffer.concat(chunks, length).toString("utf8")); }
      catch (error) { if (response.ok) throw error; }
      if (!response.ok) {
        const code = /^[A-Z_]{1,64}$/.test(value?.error?.code ?? "") ? value.error.code : "HTTP_ERROR";
        const error = new Error(`Staged transfer returned HTTP ${response.status} (${code}); inspect the retained operation.`);
        const retryAfter = response.headers.get("retry-after");
        const retryAt = retryAfter === null ? NaN : /^\d+$/.test(retryAfter) ? Date.now() + Number(retryAfter) * 1000 : Date.parse(retryAfter);
        error.stagingRetryAfterMs = Number.isFinite(retryAt) ? Math.max(0, retryAt - Date.now()) : 0;
        error.stagingRetryable = [429, 500, 502, 503, 504].includes(response.status)
          && (retryAfter === null || Number.isFinite(retryAt)) && error.stagingRetryAfterMs <= 60_000;
        throw error;
      }
      return value;
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  };
  const status = await call("GET");
  const id = value.operationId ?? status.operationId;
  if (status.operationId !== id || !["prepared", "uploaded", "confirmed"].includes(status.phase)) throw new Error("Inspect the original operation; do not replay uncertain Apple writes.");
  if (status.phase === "confirmed") return { operationId: id, phase: "confirmed", bytesSent: 0, sha256: plan.sha256, result: status.result };
  let sent = 0;
  if (status.phase === "prepared") {
    const parts = status.staging?.uploadedParts, total = Math.ceil(plan.size / plan.partBytes);
    if (!Array.isArray(parts) || parts.length > total || parts.some((n, i) => n !== i + 1) || status.staging.cancelled) throw new Error("Invalid staged progress.");
    const file = await open(path, "r");
    try {
      for (let part = parts.length + 1; part <= total; part++) {
        // Yield before expiry rather than starting a part that can outlive its
        // authorization. A later MCP session resumes this exact retained input.
        if (plan.expiresAt - Date.now() < 120_000) return { operationId: id, phase: "prepared", staged: false,
          bytesSent: sent, bytesStaged: (part - 1) * plan.partBytes, sha256: plan.sha256, needsFreshCapability: true };
        const offset = (part - 1) * plan.partBytes, bytes = Buffer.allocUnsafe(Math.min(plan.partBytes, plan.size - offset));
        let read = 0;
        while (read < bytes.length) {
          const next = await file.read(bytes, read, bytes.length - read, offset + read);
          if (!next.bytesRead) throw new Error("The source was truncated during staging.");
          read += next.bytesRead;
        }
        let saved;
        const headers = { "content-type": "application/octet-stream", "x-drive-transfer-action": "part", "x-drive-part-number": String(part), "x-content-sha256": createHash("sha256").update(bytes).digest("hex") };
        for (let attempt = 0; attempt < 3; attempt++) {
          try { saved = await call("POST", headers, bytes); break; }
          catch (error) {
            const retryDelayMs = Math.max(1000 * (attempt + 1), error.stagingRetryAfterMs ?? 0);
            if (attempt === 2 || !(error.stagingRetryable || error instanceof TypeError || error.name === "TimeoutError") || plan.expiresAt - Date.now() < 120_000 + retryDelayMs) throw error;
            report({ operationId: id, event: "inspect-staged-part", partNumber: part, attempt: attempt + 1, retryDelayMs });
            await new Promise(resolve => setTimeout(resolve, retryDelayMs));
            const observed = await call("GET"), acknowledged = observed.staging?.uploadedParts;
            if (observed.operationId !== id || observed.phase !== "prepared" || observed.staging?.cancelled
              || !Array.isArray(acknowledged) || acknowledged.some((n, i) => n !== i + 1)
              || ![part - 1, part].includes(acknowledged.length)) throw new Error("Staging changed during recovery. Inspect the original operation; no Apple retry was made.");
            // Only R2 parts can be replayed here. If the acknowledgment was lost,
            // keep the durable hash checkpoint and do not send that part again.
            if (acknowledged.length === part) { saved = { ...observed, uploadedParts: acknowledged }; break; }
          }
        }
        if (saved.operationId !== id || saved.phase !== "prepared" || saved.uploadedParts?.length !== part || saved.uploadedParts.some((n, i) => n !== i + 1)) throw new Error("The staged receipt did not acknowledge this exact part.");
        sent += bytes.length;
        if (part % 8 === 0 || part === total) report({ operationId: id, bytesStaged: offset + bytes.length, size: plan.size });
      }
    } finally { await file.close(); }
  }
  if (stageOnly || plan.expiresAt - Date.now() < 15 * 60_000) return { operationId: id, phase: status.phase, staged: true, bytesSent: sent, sha256: plan.sha256, needsFreshCapability: true };
  const url = new URL(plan.url); url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, plan.protocol, { headers: plan.headers, followRedirects: false, handshakeTimeout: 30_000, perMessageDeflate: false, maxPayload: 16_384 });
    let settled = false;
    const end = (error, result) => {
      if (settled) return; settled = true; clearTimeout(timer);
      if (error) { socket.terminate(); reject(error); } else { socket.close(); resolve(result); }
    };
    const timer = setTimeout(() => end(new Error("Stored delivery timed out. Inspect the original operation; no retry was made.")), timeoutMs);
    socket.on("unexpected-response", (_request, response) => { response.resume(); end(new Error(`Completion handshake returned HTTP ${response.statusCode}. Inspect the operation.`)); });
    socket.on("message", (bytes, binary) => {
      try {
        if (binary || bytes.length > 16_384) throw new Error("Invalid completion response.");
        const message = JSON.parse(bytes.toString("utf8"));
        if (message.operationId !== id) throw new Error("The completion operation changed.");
        if (message.type === "pending") return;
        if (message.type !== "result" || message.operation?.operationId !== id || message.operation.phase !== "confirmed") throw new Error("Stored delivery has no confirmed receipt. Inspect the retained operation.");
        end(undefined, { operationId: id, phase: "confirmed", bytesSent: sent, sha256: plan.sha256, result: message.operation.result });
      } catch (error) { end(error); }
    });
    socket.on("close", () => end(new Error("Stored delivery disconnected; its Apple outcome may be unknown. No retry was made.")));
    socket.on("error", () => end(new Error("Stored delivery failed. Inspect the original operation.")));
  });
}
export async function downloadFile(path, value, report = () => {}) {
  const plan = validatePlan(value, "download");
  // Exclusive creation protects existing local files. Keep an incomplete file
  // after failure so partial data is visible; a used handle is never replayed.
  const file = await open(path, "wx", 0o600);
  const abort = new AbortController(), timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const response = await fetch(plan.url, { headers: plan.headers, redirect: "manual", signal: abort.signal });
    if (response.status !== 200 || !response.body) throw new Error(`Download returned HTTP ${response.status}. Request a new read handle through MCP; credentials were not forwarded.`);
    const hash = createHash("sha256"); let size = 0, reported = 0;
    for await (const bytes of Readable.fromWeb(response.body)) {
      if (size + bytes.length > (plan.size ?? DRIVE_FILE_BYTES)) throw new Error("Download exceeded the authorized file size.");
      hash.update(bytes);
      let offset = 0;
      while (offset < bytes.length) offset += (await file.write(bytes, offset, bytes.length - offset)).bytesWritten;
      size += bytes.length;
      if (size - reported >= 64 * 1024 ** 2) { reported = size; report({ bytesReceived: size, size: plan.size }); }
    }
    if (plan.size !== null && size !== plan.size) throw new Error("Download ended before the authorized file size was received.");
    await file.sync();
    return { size, sha256: hash.digest("hex") };
  } finally { clearTimeout(timer); abort.abort(); await file.close(); }
}
async function main() {
  const [action, path, ...extra] = process.argv.slice(2);
  if (!["metadata", "upload", "stage", "download"].includes(action) || !path || extra.length) throw new Error("Usage: node scripts/drive-transfer.mjs metadata|upload|stage|download /absolute/file (transfer response JSON on stdin for upload/download).");
  if (action === "metadata") { console.log(JSON.stringify(await fileMetadata(path))); return; }
  let raw = await new Promise((resolve, reject) => {
    let value = "", done = false;
    const terminal = process.stdin.isTTY;
    const finish = error => {
      if (done) return; done = true;
      process.stdin.removeListener("data", onData); process.stdin.removeListener("end", onEnd);
      if (terminal) process.stdin.setRawMode(false);
      process.stdin.pause();
      if (error) reject(error); else resolve(value);
    };
    const onData = chunk => {
      value += chunk;
      if (value.includes("\u0003")) finish(new Error("Transfer input cancelled."));
      else if (value.length > 65_536) finish(new Error("Transfer response exceeds the input budget."));
      else if (value.includes("\n") || value.includes("\r")) finish();
    };
    const onEnd = () => finish();
    if (terminal) { process.stdin.setRawMode(true); console.error("Ready for transfer response JSON on stdin (input is hidden)."); }
    process.stdin.setEncoding("utf8"); process.stdin.on("data", onData); process.stdin.once("end", onEnd); process.stdin.resume();
  });
  const value = JSON.parse(raw);
  raw = "";
  const report = value => console.error(JSON.stringify(value));
  const result = ["upload", "stage"].includes(action) ? await uploadFile(path, value, report, action === "stage") : await downloadFile(path, value, report);
  console.log(JSON.stringify(result));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error("Transfer did not complete. Inspect the original operation through MCP. No automatic Apple write retry was made."); process.exitCode = 1; });
}
