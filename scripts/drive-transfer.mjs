// File bytes stay on disk/network. Transfer credentials arrive only on stdin,
// never in command arguments, files, progress output, or redirect requests.
import { createReadStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import { basename } from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { Readable } from "node:stream";
import WebSocket from "ws";
import { DRIVE_FILE_BYTES, DRIVE_FILE_LIMIT_LABEL } from "../src/drive/limits.ts";

const protocols = ["icloud-drive-upload-v1", "icloud-drive-upload-v2"], timeoutMs = 30 * 60_000;
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
  const url = new URL(plan.url), local = ["127.0.0.1", "localhost"].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || !new RegExp(`^/api/drive/transfers/${kind}/[a-f0-9-]{36}$`).test(url.pathname)
    || ![kind === "upload" ? "wss:" : "https:", ...(local ? [kind === "upload" ? "ws:" : "http:"] : [])].includes(url.protocol)
    || plan.method !== (kind === "upload" ? "WEBSOCKET" : "GET") || kind === "upload" && (!protocols.includes(plan.protocol) || !/^[a-f0-9]{64}$/.test(plan.sha256))) throw new Error("Use the exact secure transfer endpoint returned by MCP.");
  if (!plan.headers || typeof plan.headers !== "object" || Array.isArray(plan.headers) || !/^Bearer [A-Za-z0-9+/=]+$/.test(plan.headers.Authorization ?? "")) throw new Error("Transfer authorization is missing.");
  for (const [name, entry] of Object.entries(plan.headers)) {
    if (!["authorization", "oai-sites-authorization"].includes(name.toLowerCase()) || typeof entry !== "string" || entry.length > 8192 || /[\r\n]/.test(entry)) throw new Error("Unexpected transfer credential headers.");
  }
  return plan;
}
export async function uploadFile(path, value, report = () => {}) {
  const plan = validatePlan(value, "upload"), metadata = await fileMetadata(path);
  if (metadata.size !== plan.size || metadata.sha256 !== plan.sha256) throw new Error("The local file differs from the exact file authorized through MCP.");
  const chunkBytes = plan.protocol === protocols[0] ? 1024 * 1024 : 8 * 1024 * 1024;
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
      const timer = setTimeout(() => end(new Error("Transfer timed out. Inspect the original MCP operation; no automatic retry was made.")), timeoutMs);
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
  if (!["metadata", "upload", "download"].includes(action) || !path || extra.length) throw new Error("Usage: node scripts/drive-transfer.mjs metadata|upload|download /absolute/file (transfer response JSON on stdin for upload/download).");
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
  const result = action === "upload" ? await uploadFile(path, value, report) : await downloadFile(path, value, report);
  console.log(JSON.stringify(result));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error("Transfer did not complete. Inspect the original operation through MCP. No automatic retry was made."); process.exitCode = 1; });
}
