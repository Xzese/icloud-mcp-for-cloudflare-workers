import { UploadDriveMetadata } from "../drive/schemas.ts";
import { DRIVE_STREAM_CHUNK_BYTES, DRIVE_STREAM_FILE_BYTES, DRIVE_STREAM_PROTOCOL, DRIVE_TRANSFER_TIMEOUT_MS } from "../drive/limits.ts";
import { sha256Stream } from "./file-digest.ts";

const key = "icloud-drive-stream-upload-v1";
type Metadata = ReturnType<typeof UploadDriveMetadata.parse>;
interface Operation { operationId: string; phase: string; }
function retained(): Metadata | null {
  const raw = sessionStorage.getItem(key);
  if (raw === null) return null;
  try { return UploadDriveMetadata.parse(JSON.parse(raw)); }
  catch { throw new Error("The retained direct upload is invalid. Inspect its original operation ID before starting another upload."); }
}
export function pendingDriveStreamUpload() { return retained()?.operationId ?? null; }

export async function streamDriveFile(file: File, context: { parentId: string; expectedGeneration?: number }, progress: (text: string, id?: string) => void): Promise<Operation> {
  if (file.size > DRIVE_STREAM_FILE_BYTES) throw new Error("Direct streaming allows up to 4 GiB; use an MCP resumable transfer for larger files.");
  const previous = retained();
  if (previous) progress("Checking the retained direct upload…", previous.operationId);
  progress("Calculating the file checksum…", previous?.operationId);
  let metadata = UploadDriveMetadata.parse({ ...context, name: file.name, size: file.size, sha256: await sha256Stream(file.stream()),
    contentType: /^[\w.+-]+\/[\w.+-]+$/.test(file.type) ? file.type : "application/octet-stream", operationId: crypto.randomUUID() });
  if (previous) {
    if ((["parentId", "expectedGeneration", "name", "size", "sha256", "contentType"] as const).some(field => previous[field] !== metadata[field])) throw new Error("A direct upload is pending. Reselect its original file and folder to inspect or continue that operation.");
    metadata = previous;
  }
  sessionStorage.setItem(key, JSON.stringify(metadata));
  progress("Preparing direct upload…", metadata.operationId);
  const response = await fetch("/api/drive/prepare-stream-upload", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(metadata) });
  const prepared = await response.json() as Operation & { socketPath?: string; error?: { message?: string } };
  if (!response.ok) throw new Error(prepared.error?.message ?? "Direct upload preparation failed. Retain its original operation ID.");
  if (prepared.operationId !== metadata.operationId || prepared.socketPath !== `/api/drive/uploads/${metadata.operationId}/stream`) throw new Error("The direct upload response did not match its retained operation.");
  if (!["prepared", "allocated", "uploaded", "confirmed"].includes(prepared.phase)) throw new Error("The previous Apple outcome is unresolved. Inspect its original operation ID; do not restart with a new key.");
  const url = new URL(prepared.socketPath, location.origin); url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return new Promise<Operation>((resolve, reject) => {
    const socket = new WebSocket(url, DRIVE_STREAM_PROTOCOL);
    let offset = 0, busy = false, settled = false;
    const finish = (error?: Error, result?: Operation) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      try { socket.close(); } catch { /* The handshake may already have failed. */ }
      if (error) reject(error); else resolve(result!);
    };
    const timer = setTimeout(() => finish(new Error("Direct upload timed out. Inspect its retained operation before retrying.")), DRIVE_TRANSFER_TIMEOUT_MS + 10_000);
    socket.addEventListener("message", event => {
      void (async () => {
        if (settled) return;
        if (busy || typeof event.data !== "string" || event.data.length > 16_384) throw new Error("The direct upload protocol failed. Inspect its operation.");
        const message = JSON.parse(event.data) as { type: string; operationId: string; offset?: number; bytes?: number; operation?: Operation; error?: { message?: string } };
        if (message.operationId !== metadata.operationId) throw new Error("The direct upload operation changed unexpectedly.");
        if (message.type === "failed") throw new Error(message.error?.message ?? "Direct upload failed. Inspect its retained operation.");
        if (message.type === "result") {
          const result = message.operation;
          if (!result || result.operationId !== metadata.operationId || result.phase !== "confirmed" || !["uploaded", "confirmed"].includes(prepared.phase) && offset !== file.size) throw new Error("The direct upload did not return a complete, confirmed receipt.");
          sessionStorage.removeItem(key); finish(undefined, result); return;
        }
        if (message.type !== "pull" || message.offset !== offset || message.bytes !== Math.min(DRIVE_STREAM_CHUNK_BYTES, file.size - offset) || !message.bytes) throw new Error("The direct upload requested an invalid frame. Inspect its operation.");
        busy = true;
        const bytes = await file.slice(offset, offset + message.bytes).arrayBuffer();
        if (settled) return;
        offset += bytes.byteLength;
        busy = false;
        socket.send(bytes);
        progress(`Streaming directly to iCloud: ${offset} of ${file.size} bytes. Keep this page open.`, metadata.operationId);
      })().catch(error => finish(error instanceof Error ? error : new Error("Direct upload failed. Inspect its retained operation.")));
    });
    socket.addEventListener("close", () => finish(new Error("Direct upload connection closed. Its Apple outcome may be uncertain; inspect the original operation ID.")));
    socket.addEventListener("error", () => finish(new Error("Direct upload connection failed. Inspect its retained operation before retrying.")));
  });
}
