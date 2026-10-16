import { z } from "zod";
import { AppError } from "../errors.ts";
import { hex } from "../crypto/bytes.ts";
import type { DriveOperation, DriveOperationData, DriveOperationRepository, DriveScope } from "../persistence/drive-operations.ts";
import { DRIVE_FILE_BYTES, DRIVE_UPLOAD_PART_BYTES } from "./limits.ts";
import { CheckpointSHA256, HashCheckpoint } from "./hash-checkpoint.ts";

const Part = z.object({ partNumber: z.number().int().min(1).max(Math.ceil(DRIVE_FILE_BYTES / DRIVE_UPLOAD_PART_BYTES)), etag: z.string().max(256), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const UploadStaging = z.object({
  key: z.string().regex(/^drive-staging\/v1\/\d{13}\/[a-f0-9-]{36}$/),
  uploadId: z.string().min(1).max(2048), parts: z.array(Part).max(Math.ceil(DRIVE_FILE_BYTES / DRIVE_UPLOAD_PART_BYTES)),
  objectEtag: z.string().max(256).optional(), cancelled: z.boolean().default(false),
  verification: z.object({ hash: HashCheckpoint, sha256: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict().optional(),
}).strict();
export type UploadStagingData = z.infer<typeof UploadStaging>;
const conflict = (message: string) => new AppError("CONFLICT", message, 409);
const prefix = "drive-staging/v1/";

// Only a single bounded part is buffered. The complete file stays in R2 and
// goes to Apple as a backpressured stream; neither runtime needs a local disk.
async function readPart(source: ReadableStream<Uint8Array>, size: number, signal?: AbortSignal) {
  const reader = source.getReader(), bytes = new Uint8Array(size);
  const controller = new AbortController();
  const cancel = () => controller.abort(signal?.reason);
  const stop = () => { void reader.cancel(controller.signal.reason).catch(() => {}); };
  controller.signal.addEventListener("abort", stop, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("Upload part timed out.")), 60_000);
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  let count = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (controller.signal.aborted) throw new AppError("VALIDATION_ERROR", "The upload part was interrupted. Resume with the same operation ID and part.", 400);
      if (next.done) break;
      if (count + next.value.byteLength > size) throw new AppError("VALIDATION_ERROR", "The upload part exceeded its exact byte length.", 413);
      bytes.set(next.value, count); count += next.value.byteLength;
    }
    if (count !== size) throw new AppError("VALIDATION_ERROR", "The upload part did not match its exact byte length.", 400);
    return bytes;
  } finally {
    clearTimeout(timer); signal?.removeEventListener("abort", cancel);
    controller.signal.removeEventListener("abort", stop);
    await reader.cancel().catch(() => {}); reader.releaseLock();
  }
}

export class DriveStaging {
  private readonly bucket: R2Bucket;
  private readonly operations: DriveOperationRepository;
  private readonly scope: DriveScope;
  private readonly guard: () => Promise<unknown>;
  constructor(bucket: R2Bucket, operations: DriveOperationRepository, scope: DriveScope, guard: () => Promise<unknown>) {
    this.bucket = bucket; this.operations = operations; this.scope = scope; this.guard = guard;
  }

  private async locked<T>(id: string, run: (row: DriveOperation, data: DriveOperationData, save: (data: DriveOperationData) => Promise<void>) => Promise<T>) {
    let row = await this.operations.get(id, this.scope);
    if (!["upload", "resumable-upload"].includes(row.kind)) throw conflict("This operation is not a staged upload.");
    row = await this.operations.claim(row, this.scope, 120_000);
    try {
      const data = await this.operations.data(row);
      return await run(row, data, async next => {
        await this.guard();
        row = await this.operations.checkpoint(row, row.phase, next);
      });
    } finally { await this.operations.release(row); }
  }
  private active(row: DriveOperation, staging?: UploadStagingData) {
    if (row.phase !== "prepared" || staging?.cancelled) throw conflict("This upload has started its Apple transfer or was discarded. Inspect the retained operation; do not start another upload key.");
  }
  private state(row: DriveOperation, staging: UploadStagingData) {
    return { operationId: row.operation_id, phase: row.phase, partBytes: DRIVE_UPLOAD_PART_BYTES,
      uploadedParts: staging.parts.map(part => part.partNumber).sort((a, b) => a - b),
      staged: !!staging.objectEtag, cancelled: staging.cancelled, expiresAt: row.expires_at };
  }
  async prepare(id: string) {
    // Expired complete objects are swept on new upload requests. Multipart
    // orphans are also subject to R2's automatic incomplete-upload lifecycle.
    const expired = await this.bucket.list({ prefix, limit: 20 });
    const keys = expired.objects.filter(object => Number(object.key.slice(prefix.length, prefix.length + 13)) <= Date.now()).map(object => object.key);
    if (keys.length) await this.bucket.delete(keys);
    return this.locked(id, async (row, data, save) => {
      if (!data.staging) {
        this.active(row);
        const key = `${prefix}${row.expires_at}/${crypto.randomUUID()}`;
        const upload = await this.bucket.createMultipartUpload(key);
        data.staging = { key, uploadId: upload.uploadId, parts: [], cancelled: false,
          ...(row.kind === "resumable-upload" ? { verification: { hash: new CheckpointSHA256().checkpoint() } } : {}) };
        try { await save(data); } catch (error) { await upload.abort().catch(() => {}); throw error; }
      }
      return this.state(row, UploadStaging.parse(data.staging));
    });
  }
  async part(id: string, partNumber: number, checksum: string, source: ReadableStream<Uint8Array>, signal?: AbortSignal) {
    try {
      return await this.locked(id, async (row, data, save) => {
        if (!data.staging) throw conflict("Prepare this multipart upload before sending parts.");
        const staging = UploadStaging.parse(data.staging);
        this.active(row, staging);
        if (staging.objectEtag) throw conflict("All parts were already sealed.");
        const size = Number(data.input.size), total = Math.ceil(size / DRIVE_UPLOAD_PART_BYTES);
        if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > total || !/^[a-f0-9]{64}$/.test(checksum)) throw new AppError("VALIDATION_ERROR", "Use a valid part number and SHA-256 digest.", 400);
        const bytes = await readPart(source, Math.min(DRIVE_UPLOAD_PART_BYTES, size - (partNumber - 1) * DRIVE_UPLOAD_PART_BYTES), signal);
        if (hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))) !== checksum) throw new AppError("VALIDATION_ERROR", "The upload part SHA-256 digest did not match.", 400);
        const existing = staging.parts.find(part => part.partNumber === partNumber);
        if (existing) {
          if (existing.sha256 !== checksum) throw conflict("This part number already contains different bytes.");
          return this.state(row, staging);
        }
        if (row.kind === "resumable-upload") {
          if (!staging.verification || staging.verification.sha256 || partNumber !== staging.parts.length + 1
            || staging.verification.hash.bytes !== (partNumber - 1) * DRIVE_UPLOAD_PART_BYTES) throw conflict("Resume at the next unacknowledged part using the retained operation.");
          const hash = new CheckpointSHA256(staging.verification.hash);
          hash.update(bytes);
          if (partNumber === total) {
            const actual = hex(hash.digest());
            if (actual !== data.input.sha256) throw new AppError("VALIDATION_ERROR", "The full file SHA-256 did not match. No Apple upload was started.", 400);
            staging.verification.sha256 = actual;
          } else staging.verification.hash = hash.checkpoint();
          hash.destroy();
        }
        await this.guard(); await this.operations.assertLease(row);
        const part = await this.bucket.resumeMultipartUpload(staging.key, staging.uploadId).uploadPart(partNumber, bytes);
        staging.parts.push({ ...part, sha256: checksum });
        await save({ ...data, staging });
        return this.state(row, staging);
      });
    } finally { await source.cancel().catch(() => {}); }
  }
  async complete(id: string) {
    return this.locked(id, async (row, data, save) => {
      if (!data.staging) throw conflict("Prepare this multipart upload before completing it.");
      const staging = UploadStaging.parse(data.staging);
      if (row.phase === "confirmed") return staging;
      if (staging.cancelled) throw conflict("This staged upload was discarded.");
      if (row.kind === "resumable-upload" && (!staging.verification?.sha256 || staging.verification.sha256 !== data.input.sha256)) throw conflict("Upload and verify every part before completing this file.");
      if (!staging.objectEtag) {
        this.active(row, staging);
        const total = Math.ceil(Number(data.input.size) / DRIVE_UPLOAD_PART_BYTES);
        const parts = staging.parts.toSorted((a, b) => a.partNumber - b.partNumber);
        if (parts.length !== total || parts.some((part, i) => part.partNumber !== i + 1)) throw conflict("Upload every part before completing this file.");
        await this.guard();
        // A lost complete response can be reconciled using our unguessable,
        // server-owned key; no client can replace the object or its part list.
        const object = await this.bucket.head(staging.key) ?? await this.bucket.resumeMultipartUpload(staging.key, staging.uploadId).complete(parts);
        if (object.size !== Number(data.input.size)) throw conflict("The staged object has a different length.");
        staging.objectEtag = object.etag; await save({ ...data, staging });
      }
      return staging;
    });
  }
  async discard(id: string) {
    return this.locked(id, async (row, data, save) => {
      if (!data.staging) throw conflict("This upload has no staged data to discard.");
      const staging = UploadStaging.parse(data.staging);
      staging.cancelled = true; await save({ ...data, staging });
      if (!staging.objectEtag) {
        try { await this.bucket.resumeMultipartUpload(staging.key, staging.uploadId).abort(); }
        catch (error) {
          // A previous abort/complete may have succeeded before its response
          // was lost. Other storage failures must remain visible and retryable.
          if (!(error instanceof Error) || !/specified multipart upload does not exist.*\(10024\)/i.test(error.message)) throw error;
        }
      }
      await this.bucket.delete(staging.key);
      return this.state(row, staging);
    });
  }
}
