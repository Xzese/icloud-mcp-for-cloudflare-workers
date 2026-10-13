import "../lib/sites-env.mjs";
import { Miniflare, Log, LogLevel, Response as WorkerResponse } from "miniflare";
import { fetch as nodeFetch } from "undici";
import { mkdir, readFile, readdir, writeFile, chmod, appendFile, stat, rename, cp, mkdtemp, rm } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { resolve, join } from "node:path";
import { localAppleHeaders, localAppleContentHeaders, classifyDriveRelayURL, DRIVE_MAX_METADATA_BYTES, DRIVE_MAX_TRANSFER_BYTES, DRIVE_TRANSFER_TIMEOUT_MS, summarizeAppleResponse, summarizeAppleFailure } from "./local-icloud-observation.mjs";
import { createLocalPushRelay } from "./local-icloud-push.mjs";

const root = resolve(new URL("../..", import.meta.url).pathname);
if (process.argv.length > 2) throw new Error("Use npm run dev:icloud.");
const state = process.env.LOCAL_ICLOUD_STATE_DIR ? resolve(process.env.LOCAL_ICLOUD_STATE_DIR) : join(root, ".sites-runtime/local-icloud");
if (process.env.LOCAL_ICLOUD_STATE_DIR) {
  const existing = await stat(join(state, "keys.json"));
  if (!existing.isFile()) throw new Error("The explicit local state directory must contain its existing keys.json; no replacement login will be created.");
}
await mkdir(state, { recursive: true, mode: 0o700 });
await chmod(state, 0o700);
const configPath = join(state, "keys.json");
try {
  await writeFile(configPath, JSON.stringify({ owner: `local-${randomBytes(16).toString("hex")}`, key: randomBytes(32).toString("base64") }), { flag: "wx", mode: 0o600 });
} catch (error) { if (error.code !== "EEXIST") throw error; }
await chmod(configPath, 0o600);
const keys = JSON.parse(await readFile(configPath, "utf8"));
if (!/^local-[a-f0-9]{32}$/.test(keys.owner) || Buffer.from(keys.key, "base64").length !== 32) throw new Error("Invalid local key configuration.");
const port = Number(process.env.LOCAL_ICLOUD_PORT ?? "5173");
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("LOCAL_ICLOUD_PORT must be an unprivileged TCP port.");
const origin = `http://127.0.0.1:${port}`;
// Miniflare indexes assets at startup. Keep its HTML/modules and indexed files
// together even when a verification build replaces the canonical dist directory.
const runtimeRoot = await mkdtemp(join(tmpdir(), "icloud-local-build-"));
try {
  await cp(join(root, "dist/server"), join(runtimeRoot, "server"), { recursive: true });
  await cp(join(root, "dist/client"), join(runtimeRoot, "client"), { recursive: true });
} catch (error) {
  await rm(runtimeRoot, { recursive: true, force: true });
  throw error;
}
process.once("exit", () => rmSync(runtimeRoot, { recursive: true, force: true }));
const serverRoot = join(runtimeRoot, "server");
const config = JSON.parse(await readFile(join(serverRoot, "wrangler.json"), "utf8"));
const files = await readdir(serverRoot, { recursive: true, withFileTypes: true });
const paths = files.filter(f => f.isFile() && /\.(js|mjs)$/.test(f.name)).map(f => join(f.parentPath, f.name));
const entrypoint = join(serverRoot, "index.js");
const observations = join(state, "observations.jsonl");
let logQueue = Promise.resolve();
async function observe(summary) {
  logQueue = logQueue.then(async () => {
    const size = await stat(observations).then(s => s.size).catch(() => 0);
    if (size > 1_048_576) await rename(observations, observations + ".previous");
    await appendFile(observations, JSON.stringify(summary) + "\n", { mode: 0o600 });
  }).catch(() => { console.warn("Local diagnostic storage unavailable."); });
  await logQueue;
}
function schemaStatements(sql) {
  const statements = [];
  let statement = "", quote = null, lineComment = false, blockComment = false;
  for (let i = 0; i < sql.length; i++) {
    const char = sql[i], next = sql[i + 1];
    if (lineComment) {
      if (char === "\n" || char === "\r") { lineComment = false; statement += char; }
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") { blockComment = false; i++; }
      continue;
    }
    if (quote) {
      statement += char;
      if (char === quote) {
        if (next === quote) { statement += next; i++; }
        else quote = null;
      }
      continue;
    }
    if (char === "-" && next === "-") { lineComment = true; i++; continue; }
    if (char === "/" && next === "*") { blockComment = true; statement += " "; i++; continue; }
    if (char === "'" || char === '"' || char === "`") { quote = char; statement += char; continue; }
    if (char === "[") { quote = "]"; statement += char; continue; }
    if (char === ";") {
      if (statement.trim()) statements.push(statement.trim());
      statement = "";
      continue;
    }
    statement += char;
  }
  if (blockComment) throw new Error("The local SQL schema contains an unterminated block comment.");
  if (statement.trim()) statements.push(statement.trim());
  return statements;
}
function localDeadline(signal, timeoutMs) {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(new DOMException("Local Apple request timed out.", "TimeoutError")), timeoutMs);
  return { signal: AbortSignal.any([signal, timeout.signal]), timedOut: () => timeout.signal.aborted, dispose: () => clearTimeout(timer) };
}
async function readLocalMetadata(response) {
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > DRIVE_MAX_METADATA_BYTES)) {
    await response.body?.cancel().catch(() => {});
    throw Object.assign(new Error("Local response byte budget exceeded."), { code: "LOCAL_RESPONSE_BYTE_BUDGET" });
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader(), chunks = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > DRIVE_MAX_METADATA_BYTES) throw Object.assign(new Error("Local response byte budget exceeded."), { code: "LOCAL_RESPONSE_BYTE_BUDGET" });
      chunks.push(next.value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}
function boundedLocalStream(source, max, signal, onFinish) {
  const reader = source.getReader();
  let total = 0, ended = false, controllerRef;
  const finish = () => { signal.removeEventListener("abort", abort); onFinish(); };
  const abort = () => {
    void reader.cancel(signal.reason).catch(() => {});
    finish();
    controllerRef?.error(signal.reason ?? new Error("Local content transfer aborted."));
  };
  return new ReadableStream({
    start(controller) {
      controllerRef = controller;
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    },
    async pull(controller) {
      if (signal.aborted) { await reader.cancel(signal.reason).catch(() => {}); finish(); controller.error(signal.reason); return; }
      try {
        const next = await reader.read();
        if (next.done) { ended = true; reader.releaseLock(); finish(); controller.close(); return; }
        total += next.value.byteLength;
        if (total > max) {
          await reader.cancel().catch(() => {});
          finish();
          controller.error(Object.assign(new Error("Local content transfer byte budget exceeded."), { code: "LOCAL_RESPONSE_BYTE_BUDGET" }));
          return;
        }
        controller.enqueue(next.value);
      } catch (error) { finish(); controller.error(error); }
    },
    async cancel(reason) { if (!ended) await reader.cancel(reason).catch(() => {}); finish(); },
  });
}
function boundedRequestStream(source, max) {
  const reader = source.getReader();
  let total = 0, ended = false;
  return new ReadableStream({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) { ended = true; reader.releaseLock(); controller.close(); return; }
        total += next.value.byteLength;
        if (total > max) {
          await reader.cancel().catch(() => {});
          controller.error(Object.assign(new Error("Local content request byte budget exceeded."), { code: "LOCAL_RESPONSE_BYTE_BUDGET" }));
          return;
        }
        controller.enqueue(next.value);
      } catch (error) { controller.error(error); }
    },
    async cancel(reason) { if (!ended) await reader.cancel(reason).catch(() => {}); },
  });
}
async function contentFailure(url, { status, bytesRead, startedAt, deadline, request, error }) {
  await observe({ at: new Date().toISOString(), host: url.hostname, event: "local-apple-content-failed", status: Number.isInteger(status) ? status : null,
    bytesRead, elapsedMs: Date.now() - startedAt, failure: error?.code === "LOCAL_RESPONSE_BYTE_BUDGET" ? "response-byte-budget" : deadline.timedOut() ? "timeout" : request.signal.aborted ? "incoming-abort" : "transport-failure" });
}
const push = createLocalPushRelay({ observe });
const worker = new Miniflare({
  host: "127.0.0.1", port, inspectorPort: 0, log: new Log(LogLevel.ERROR), d1Persist: join(state, "d1"),
  workers: [
    { name: "local-front-door", modules: true, scriptPath: join(root, "scripts/dev/local-icloud-gateway.mjs"), compatibilityDate: config.compatibility_date,
      bindings: { LOCAL_ORIGIN: origin, LOCAL_OWNER: keys.owner, LOCAL_ACCESS: randomBytes(32).toString("hex") }, serviceBindings: { APP: "local-reminders-app" } },
    { name: "local-reminders-app", modulesRoot: serverRoot,
      modules: [entrypoint, ...paths.filter(p => p !== entrypoint)].map(path => ({ type: "ESModule", path })),
      compatibilityDate: config.compatibility_date, compatibilityFlags: config.compatibility_flags,
      bindings: { APP_ORIGIN: origin, REMINDERS_OWNER_ID: keys.owner, ENCRYPTION_KEY_ID: "local-live", ENCRYPTION_KEYS_JSON: JSON.stringify({ "local-live": keys.key }), LIVE_APPLE_CONNECTION_APPROVED: "controlled-device-v2", APPLE_CRYPTO_REVIEW_APPROVED: "device-proof-v2",
        APPLE_SESSION_RETENTION_WRITES: process.env.APPLE_SESSION_RETENTION_WRITES ?? "absolute-30d-v1",
        APPLE_SESSION_RENEWAL_ENABLED: process.env.APPLE_SESSION_RENEWAL_ENABLED ?? "",
        LOCAL_REMINDER_EVIDENCE_ENABLED: process.env.LOCAL_REMINDER_EVIDENCE_ENABLED ?? "",
        APPLE_SESSION_CHECK_INTERVAL_MS: process.env.APPLE_SESSION_CHECK_INTERVAL_MS ?? "21600000" },
      d1Databases: { DB: "isolated-local-icloud" },
      assets: { directory: join(runtimeRoot, "client"), routerConfig: { has_user_worker: true } },
      outboundService: async request => {
        const url = new URL(request.url);
        if (request.headers.get("upgrade")) return push.fetch(request);
        const fixed = ["idmsa.apple.com", "setup.icloud.com", "www.icloud.com"].includes(url.hostname);
        const cloudkit = /^p\d{1,3}-ckdatabasews\.icloud\.com$/.test(url.hostname) && (/^\/database\/1\/com\.apple\.reminders\/production\/private(?:\/|$)/.test(url.pathname) || /^\/database\/1\/com\.apple\.reminders\/production\/shared\/(?:zones\/list|records\/lookup)$/.test(url.pathname));
        const driveKind = classifyDriveRelayURL(url);
        if (url.protocol !== "https:" || url.username || url.password || url.port || (!fixed && !cloudkit && !driveKind)) return new WorkerResponse("Unsupported local test endpoint.", { status: 403 });
        const content = driveKind === "download" || driveKind === "upload";
        if ((driveKind === "download" && request.method !== "GET") || (driveKind === "upload" && request.method !== "POST")) return new WorkerResponse("Unsupported local test method.", { status: 403 });
        const startedAt = Date.now(), deadline = localDeadline(request.signal, content ? DRIVE_TRANSFER_TIMEOUT_MS : 8000);
        let total = 0, stage = "headers", status = null, streamOwnsDeadline = false;
        try {
          const requestBody = content && driveKind === "upload" && request.body ? boundedRequestStream(request.body, DRIVE_MAX_TRANSFER_BYTES + 16_384) : request.body;
          const response = await nodeFetch(url, { method: request.method, headers: content ? localAppleContentHeaders(request.headers) : localAppleHeaders(request.headers), body: requestBody, duplex: "half", redirect: "manual", signal: deadline.signal });
          status = response.status; stage = "body";
          if (content && driveKind === "download") {
            const length = response.headers.get("content-length");
            if (length !== null && (!/^\d+$/.test(length) || Number(length) > DRIVE_MAX_TRANSFER_BYTES)) {
              await response.body?.cancel().catch(() => {});
              throw Object.assign(new Error("Local content transfer byte budget exceeded."), { code: "LOCAL_RESPONSE_BYTE_BUDGET" });
            }
            const headers = new Headers();
            for (const name of ["content-type", "content-length", "content-range", "etag", "last-modified"]) {
              const value = response.headers.get(name);
              if (value !== null) headers.set(name, value);
            }
            if (!response.body) { deadline.dispose(); return new WorkerResponse(null, { status: response.status, headers }); }
            const body = boundedLocalStream(response.body, DRIVE_MAX_TRANSFER_BYTES, deadline.signal, deadline.dispose);
            streamOwnsDeadline = true;
            return new WorkerResponse(body, { status: response.status, statusText: response.statusText, headers });
          }
          if (content && driveKind === "upload") {
            const bytes = await readLocalMetadata(response);
            await observe({ at: new Date().toISOString(), host: url.hostname, event: "local-apple-content-upload", status, bytesRead: bytes.byteLength, elapsedMs: Date.now() - startedAt });
            const headers = new Headers();
            const contentType = response.headers.get("content-type");
            if (contentType !== null) headers.set("content-type", contentType);
            return new WorkerResponse(bytes, { status, headers });
          }
          const reader = response.body?.getReader(); const chunks = [];
          try {
            if (reader) for (;;) { const next = await reader.read(); if (next.done) break; total += next.value.length; if (total > DRIVE_MAX_METADATA_BYTES) throw Object.assign(new Error("Local response byte budget exceeded."), { code: "LOCAL_RESPONSE_BYTE_BUDGET" }); chunks.push(next.value); }
          } finally { if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); } }
          const bytes = Buffer.concat(chunks);
          let body; if (response.headers.get("content-type")?.includes("json")) { try { body = JSON.parse(bytes.toString("utf8")); } catch { /* Only status is observed. */ } }
          stage = "observation";
          await observe({ ...summarizeAppleResponse(url, response.status, body), bytesRead: total, elapsedMs: Date.now() - startedAt });
          return new WorkerResponse(request.method === "HEAD" || [204, 205, 304].includes(response.status) ? null : bytes, { status: response.status, statusText: response.statusText, headers: response.headers });
        } catch (error) {
          if (content) await contentFailure(url, { status, bytesRead: total, startedAt, deadline, request, error });
          else await observe(summarizeAppleFailure(url, { stage, status, bytesRead: total, elapsedMs: Date.now() - startedAt, timeout: deadline.timedOut(), aborted: request.signal.aborted, error }));
          throw error;
        } finally { if (!streamOwnsDeadline) deadline.dispose(); }
      },
    },
  ],
});
try {
  const db = await worker.getD1Database("DB", "local-reminders-app");
  const schema = await readFile(join(root, "schema.sql"), "utf8");
  const statements = schemaStatements(schema);
  if (statements.length) await db.batch(statements.map(statement => db.prepare(statement)));
  await worker.ready;
  console.log(`Local Worker ready: ${origin}/`);
  console.log("Lists are retrieved directly on refresh; no historical or scheduled catalogue work.");
  console.log("Separate encrypted local session; reminder creation, editing, completion, reopening and deletion are available after sign-in. Diagnostics contain metadata and counts only.");
} catch (error) { push.close(); await worker.dispose(); throw error; }
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, async () => { push.close(); await worker.dispose(); await logQueue; process.exit(0); });
