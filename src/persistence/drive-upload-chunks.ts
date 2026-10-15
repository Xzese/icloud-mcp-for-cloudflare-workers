import { z } from "zod";
import { sha256 } from "@noble/hashes/sha2.js";
import { AppError } from "../errors.ts";
import { b64, hex, unb64, concat } from "../crypto/bytes.ts";
import { DRIVE_FILE_BYTES, INLINE_FILE_BYTES } from "../drive/limits.ts";
import { DriveOperationRepository, type DriveOperation, type DriveScope } from "./drive-operations.ts";

interface Chunk { byte_offset: number; byte_length: number; content_hash: string; envelope: string; }
const Envelope = z.object({ version: z.literal(1), keyId: z.string(), iv: z.string(), ciphertext: z.string() }).strict();
const conflict = () => new AppError("CONFLICT", "This upload chunk changed, expired, or the upload has already started. Retain the operation ID.", 409);

// A maximum of two full-size files per owner, encrypted with offset-bound AAD.
// Ordinary HTTP uploads do not use this temporary staging table.
export class DriveUploadChunks {
  readonly operations: DriveOperationRepository;
  constructor(operations: DriveOperationRepository) { this.operations = operations; }
  async available() {
    return !!await this.operations.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'drive_upload_chunks'").first();
  }
  async requireSchema() {
    if (!await this.available()) throw new AppError("CONFIGURATION_REQUIRED", "Apply migration 0008_drive_upload_chunks before using MCP chunk uploads. Dashboard and HTTP uploads remain available.", 503);
  }
  private context(row: DriveOperation, offset: number) {
    return { ownerId: row.owner_id, accountId: row.account_scope, generation: row.generation, recordId: `icloud-drive-upload-chunk-v1/${row.operation_id}/${offset}`, schemaVersion: 1 as const };
  }
  async append(row: DriveOperation, scope: DriveScope, offset: number, bytes: Uint8Array) {
    await this.requireSchema();
    if (row.kind !== "upload" || row.phase !== "prepared" || row.permission_revision !== scope.permissionRevision) throw conflict();
    const now = Date.now();
    await this.operations.db.prepare("DELETE FROM drive_upload_chunks WHERE owner_id = ? AND expires_at <= ?").bind(row.owner_id, now).run();
    const hash = hex(sha256(bytes));
    const envelope = JSON.stringify(await this.operations.envelopes.encrypt({ contentBase64: b64(bytes) }, this.context(row, offset)));
    // Atomic phase/lease/quota check. An existing offset is immutable; identical
    // retries are acknowledged below, including when the quota is already full.
    await this.operations.db.prepare(`INSERT OR IGNORE INTO drive_upload_chunks (owner_id,operation_id,byte_offset,byte_length,content_hash,expires_at,envelope)
      SELECT ?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM drive_operations WHERE owner_id = ? AND operation_id = ? AND phase = 'prepared' AND lease_until <= ? AND permission_revision = ? AND expires_at > ?)
      AND (SELECT COALESCE(SUM(byte_length),0) FROM drive_upload_chunks WHERE owner_id = ?) + ? <= ?`)
      .bind(row.owner_id, row.operation_id, offset, bytes.length, hash, row.expires_at, envelope, row.owner_id, row.operation_id, now, scope.permissionRevision, now, row.owner_id, bytes.length, 2 * DRIVE_FILE_BYTES).run();
    const saved = await this.operations.db.prepare("SELECT content_hash FROM drive_upload_chunks WHERE owner_id = ? AND operation_id = ? AND byte_offset = ?")
      .bind(row.owner_id, row.operation_id, offset).first<{ content_hash: string }>();
    if (!saved) throw new AppError("CONFLICT", "The upload is running or temporary staging is full (128 MiB per owner). Complete existing uploads or wait for expiry.", 409);
    if (saved.content_hash !== hash) throw conflict();
    const progress = await this.operations.db.prepare("SELECT COUNT(*) AS chunks, COALESCE(SUM(byte_length),0) AS bytes FROM drive_upload_chunks WHERE owner_id = ? AND operation_id = ?")
      .bind(row.owner_id, row.operation_id).first<{ chunks: number; bytes: number }>();
    return { receivedChunks: progress!.chunks, receivedBytes: progress!.bytes };
  }
  stream(row: DriveOperation, size: number): ReadableStream<Uint8Array> {
    let offset = 0;
    return new ReadableStream<Uint8Array>({
      pull: async controller => {
        try {
          if (offset === size) { controller.close(); return; }
          // Batch database reads and output up to 4 MiB at a time. This keeps
          // finalization below Workers' binding-call budget without buffering a file.
          const rows = await this.operations.db.prepare("SELECT byte_offset,byte_length,content_hash,envelope FROM drive_upload_chunks WHERE owner_id = ? AND operation_id = ? AND byte_offset >= ? AND expires_at > ? ORDER BY byte_offset LIMIT 64")
            .bind(row.owner_id, row.operation_id, offset, Date.now()).all<Chunk>();
          if (!rows.results.length) throw new AppError("VALIDATION_ERROR", "Upload chunks are missing or expired. Append every chunk before completing.", 400);
          const parts: Uint8Array[] = [];
          for (const chunk of rows.results) {
            if (chunk.byte_offset !== offset || chunk.byte_length !== Math.min(INLINE_FILE_BYTES, size - offset)) throw new AppError("VALIDATION_ERROR", "The upload has a missing or invalid chunk.", 400);
            const data = z.object({ contentBase64: z.string() }).strict().parse(await this.operations.envelopes.decrypt(Envelope.parse(JSON.parse(chunk.envelope)), this.context(row, offset)));
            const bytes = unb64(data.contentBase64, INLINE_FILE_BYTES);
            if (bytes.length !== chunk.byte_length || hex(sha256(bytes)) !== chunk.content_hash) throw conflict();
            parts.push(bytes); offset += bytes.length;
          }
          controller.enqueue(concat(...parts));
        } catch (error) { controller.error(error); }
      },
    }, { highWaterMark: 0 });
  }
  async clear(row: DriveOperation) {
    await this.operations.db.prepare("DELETE FROM drive_upload_chunks WHERE owner_id = ? AND operation_id = ?").bind(row.owner_id, row.operation_id).run();
  }
}
