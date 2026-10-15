import { DRIVE_DIRECT_UPLOAD_BYTES, DRIVE_UPLOAD_PART_BYTES } from "../drive/limits.ts";
import { UploadDriveMetadata } from "../drive/schemas.ts";
import { sha256Stream } from "./file-digest.ts";

const pendingKey = "icloud-drive-staged-upload-v1";
type Metadata = ReturnType<typeof UploadDriveMetadata.parse>;
interface Operation { operationId: string; phase: string; }
interface Progress extends Operation { partBytes: number; uploadedParts: number[]; cancelled: boolean; }
function retainedUpload(): Metadata | null {
  let raw: string | null;
  try { raw = sessionStorage.getItem(pendingKey); }
  catch { throw new Error("Browser storage is unavailable. Restore access before resuming or starting a staged upload."); }
  if (raw === null) return null;
  try { return UploadDriveMetadata.parse(JSON.parse(raw)); }
  catch { throw new Error("The retained upload record is invalid. Inspect its original operation ID before starting another staged upload; do not clear it blindly."); }
}
async function json<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const result = await response.json() as T & { error?: { message?: string } };
  if (!response.ok) throw new Error(result.error?.message ?? "The upload was interrupted. Retain its operation ID.");
  return result;
}
export function pendingDriveUpload(): string | null {
  return retainedUpload()?.operationId ?? null;
}
export async function discardDriveUpload(operationId: string) {
  const retained = retainedUpload();
  const result = await json<Operation>("/api/drive/discard-multipart-upload", { operationId, expectedGeneration: retained?.expectedGeneration });
  // Discarding bytes is not evidence that an uncertain Apple write failed.
  if (!["prepared", "confirmed"].includes(result.phase)) throw new Error("Staged data discarded, but the Apple outcome is unresolved. The original operation ID is still retained; inspect it before starting another upload.");
  if (retained?.operationId === operationId) sessionStorage.removeItem(pendingKey);
}
export async function uploadDriveFile(file: File, context: { parentId: string; expectedGeneration?: number }, progress: (text: string, operationId?: string) => void): Promise<Operation> {
  progress("Calculating the file checksum…");
  const sha256 = await sha256Stream(file.stream());
  const validated = UploadDriveMetadata.safeParse({ ...context, name: file.name, size: file.size, sha256,
    contentType: /^[\w.+-]+\/[\w.+-]+$/.test(file.type) ? file.type : "application/octet-stream", operationId: crypto.randomUUID() });
  if (!validated.success) throw new Error("Choose a file within the supported size limit with a simple filename, without path separators or control characters.");
  let metadata: Metadata = validated.data;
  if (file.size <= DRIVE_DIRECT_UPLOAD_BYTES) {
    progress("Uploading file…", metadata.operationId);
    const prepared = await json<{ uploadPath: string }>("/api/drive/prepare-upload", metadata);
    const response = await fetch(prepared.uploadPath, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: file });
    const result = await response.json() as Operation & { error?: { message?: string } };
    if (!response.ok) throw new Error(result.error?.message ?? "Upload interrupted. Inspect the retained operation before trying again.");
    return result;
  }
  const previous = retainedUpload();
  if (previous) {
    progress("Checking the retained upload…", previous.operationId);
    if ((["parentId", "expectedGeneration", "name", "size", "sha256", "contentType"] as const).some(key => previous[key] !== metadata[key])) throw new Error("A staged upload is pending. Reselect its original file and folder to resume, or discard its staged data first.");
    metadata = previous;
  }
  progress("Preparing resumable upload…", metadata.operationId);
  // Persist the original intent before any network request. Reselecting the
  // same file resumes this key; Apple writes are never retried automatically.
  sessionStorage.setItem(pendingKey, JSON.stringify(metadata));
  const prepared = await json<Progress>("/api/drive/prepare-multipart-upload", metadata);
  if (prepared.cancelled && prepared.phase !== "confirmed") throw new Error("This staged upload was discarded. Inspect its operation before starting another upload.");
  if (!["prepared", "allocated", "uploaded", "confirmed"].includes(prepared.phase)) throw new Error("The Apple transfer started previously. Inspect the retained operation before continuing; do not create another operation ID.");
  if (prepared.partBytes !== DRIVE_UPLOAD_PART_BYTES) throw new Error("The upload part size changed. Refresh the application before continuing.");
  const completed = new Set(prepared.uploadedParts), total = Math.ceil(file.size / prepared.partBytes);
  for (let part = 1; prepared.phase === "prepared" && part <= total; part++) {
    if (completed.has(part)) continue;
    progress(`Uploading part ${part} of ${total}. Reselect this file to resume after an interruption.`, metadata.operationId);
    const bytes = await file.slice((part - 1) * prepared.partBytes, part * prepared.partBytes).arrayBuffer();
    const checksum = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), byte => byte.toString(16).padStart(2, "0")).join("");
    const response = await fetch(`/api/drive/uploads/${metadata.operationId}/parts/${part}`, { method: "POST", headers: { "content-type": "application/octet-stream", "x-content-sha256": checksum }, body: bytes });
    const result = await response.json() as { error?: { message?: string } };
    if (!response.ok) throw new Error(result.error?.message ?? "Upload part interrupted. Reselect this file to resume.");
  }
  progress("Sending the staged file to iCloud. Keep this page open; inspect the operation if interrupted.", metadata.operationId);
  const result = await json<Operation>("/api/drive/complete-multipart-upload", { operationId: metadata.operationId, expectedGeneration: context.expectedGeneration });
  if (result.phase === "confirmed") sessionStorage.removeItem(pendingKey);
  return result;
}
