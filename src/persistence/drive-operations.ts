import { z } from "zod";
import { AppError } from "../errors.ts";
import { configuredEnvelopes } from "./apple-sessions.ts";
import { fingerprint } from "../lib/canonical.ts";
import type { RuntimeEnv } from "../platform/sites.ts";
import { DRIVE_UPLOAD_LEASE_MS, DRIVE_RELAY_LEASE_MS } from "../drive/limits.ts";
import { DriveSharedContext } from "../drive/shared.ts";
import { UploadStaging, type UploadStagingData } from "../drive/staging.ts";
import { BatchState } from "../drive/batch.ts";

export interface DriveScope { account: string; generation: number; permissionRevision: number; expiresAt: number; }
export type DrivePhase = "prepared" | "allocating" | "allocated" | "uploading" | "uploaded" | "committing" | "confirmed" | "unknown" | "failed";
export interface DriveOperation {
  owner_id: string; operation_id: string; account_scope: string; generation: number; permission_revision: number;
  input_hash: string; kind: string; phase: DrivePhase; revision: number; lease_id: string | null;
  lease_until: number; expires_at: number; envelope: string | null;
}
export interface DriveOperationData { input: Record<string, unknown>; allocation?: unknown; receipt?: unknown; result?: unknown; itemId?: string; staging?: UploadStagingData; batch?: z.infer<typeof BatchState>; }
const EnvelopeSchema = z.object({ version: z.literal(1), keyId: z.string(), iv: z.string(), ciphertext: z.string() }).strict();
const DataSchema = z.object({ input: z.record(z.unknown()), allocation: z.unknown().optional(), receipt: z.unknown().optional(), result: z.unknown().optional(), itemId: z.string().optional(), staging: UploadStaging.optional(), batch: BatchState.optional() }).strict();
const conflict = () => new AppError("CONFLICT", "The Drive operation changed or is already running. Inspect its operation ID before retrying.", 409);
const canonicalOperationId = (value: string) => {
  const parsed = z.string().uuid().safeParse(value);
  if (!parsed.success) throw new AppError("VALIDATION_ERROR", "A valid Drive operation UUID is required.", 400);
  return parsed.data.toLowerCase();
};

// Single-file bodies are never stored. Bounded bulk inline manifests, inputs,
// Apple receipts and identifiers are sealed
// under the same key ring, with a distinct record context for every operation.
export class DriveOperationRepository {
  readonly db: D1DatabaseSession;
  readonly owner: string;
  readonly envelopes: ReturnType<typeof configuredEnvelopes>;
  constructor(env: RuntimeEnv, owner: string) {
    if (!env.DB) throw new AppError("CONFIGURATION_REQUIRED", "Drive requires persistent operation storage.", 503);
    if (!owner || owner !== env.REMINDERS_OWNER_ID) throw new AppError("FORBIDDEN", "Drive requires the configured owner.", 403);
    this.db = env.DB.withSession("first-primary"); this.owner = owner; this.envelopes = configuredEnvelopes(env);
  }
  async available() {
    const row = await this.db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name IN ('drive_operations','drive_handles')").first<{ count: number }>();
    return row?.count === 2;
  }
  private async requireSchema() {
    if (!await this.available()) throw new AppError("CONFIGURATION_REQUIRED", "Apply the Drive database migration before enabling Drive operations.", 503);
  }
  private context(id: string, account: string, generation: number, kind = "operation") {
    return { ownerId: this.owner, accountId: account, generation, recordId: `icloud-drive-v1/${kind}/${id}`, schemaVersion: 1 as const };
  }
  async get(id: string, scope: DriveScope): Promise<DriveOperation> {
    id = canonicalOperationId(id);
    await this.requireSchema();
    const row = await this.db.prepare("SELECT * FROM drive_operations WHERE owner_id = ? AND operation_id = ?").bind(this.owner, id).first<DriveOperation>();
    if (!row || row.account_scope !== scope.account || row.generation !== scope.generation) throw new AppError("FORBIDDEN", "This Drive operation does not belong to the current account session.", 403);
    if (row.expires_at <= Date.now() || !row.envelope) throw new AppError("AUTH_EXPIRED", "This operation receipt expired. Its key cannot be reused.", 410);
    return row;
  }
  async data(row: DriveOperation): Promise<DriveOperationData> {
    if (!row.envelope) throw new AppError("AUTH_EXPIRED", "The Drive operation receipt expired.", 410);
    let envelope;
    try { envelope = EnvelopeSchema.parse(JSON.parse(row.envelope)); }
    catch { throw new AppError("PROTOCOL_CHANGED", "The encrypted Drive operation is invalid.", 503); }
    const decoded = await this.envelopes.decrypt(envelope, this.context(row.operation_id, row.account_scope, row.generation));
    const parsed = DataSchema.safeParse(decoded);
    if (!parsed.success) throw new AppError("PROTOCOL_CHANGED", "The encrypted Drive operation is invalid.", 503);
    return parsed.data;
  }
  async create(id: string, kind: string, input: Record<string, unknown>, scope: DriveScope) {
    id = canonicalOperationId(id);
    if (input.operationId !== undefined) {
      if (typeof input.operationId !== "string" || canonicalOperationId(input.operationId) !== id) throw conflict();
      input = { ...input, operationId: id };
    }
    await this.requireSchema();
    const inputHash = await fingerprint({ kind, input });
    const expires = Math.min(scope.expiresAt, Date.now() + 86_400_000);
    const envelope = JSON.stringify(await this.envelopes.encrypt({ input }, this.context(id, scope.account, scope.generation)));
    await this.db.prepare("UPDATE drive_operations SET envelope = NULL WHERE owner_id = ? AND envelope IS NOT NULL AND expires_at <= ? AND lease_until <= ?").bind(this.owner, Date.now(), Date.now()).run();
    await this.db.prepare(`INSERT OR IGNORE INTO drive_operations (owner_id,operation_id,account_scope,generation,permission_revision,input_hash,kind,phase,expires_at,envelope)
      SELECT ?,?,?,?,?,?,?,'prepared',?,? WHERE (SELECT COUNT(*) FROM drive_operations WHERE owner_id = ? AND generation = ? AND envelope IS NOT NULL) < 1024`)
      .bind(this.owner, id, scope.account, scope.generation, scope.permissionRevision, inputHash, kind, expires, envelope, this.owner, scope.generation).run();
    const exists = await this.db.prepare("SELECT 1 FROM drive_operations WHERE owner_id = ? AND operation_id = ?").bind(this.owner, id).first();
    if (!exists) throw new AppError("RATE_LIMITED", "The active Drive receipt quota is full. Retain this key; wait for receipts to expire before continuing.", 429, true);
    const row = await this.get(id, scope);
    if (row.input_hash !== inputHash || row.kind !== kind) throw new AppError("CONFLICT", "This operation key was already used for different input. Retain the original key and input for recovery.", 409);
    return row;
  }
  async claim(row: DriveOperation, scope: DriveScope, leaseMs?: number) {
    if (row.permission_revision !== scope.permissionRevision) throw new AppError("CONFLICT", "Service settings changed after this operation began. Inspect the retained operation; do not replay it.", 409);
    const now = Date.now(), lease = crypto.randomUUID();
    const maximum = row.kind === "relay-upload" ? DRIVE_RELAY_LEASE_MS : DRIVE_UPLOAD_LEASE_MS;
    const duration = leaseMs ?? (row.kind === "relay-upload" ? maximum : ["upload", "stream-upload", "relay-upload", "resumable-upload", "bulk-upload"].includes(row.kind) ? DRIVE_UPLOAD_LEASE_MS : 150_000);
    if (!Number.isSafeInteger(duration) || duration < 10_000 || duration > maximum) throw conflict();
    const next = await this.db.prepare("UPDATE drive_operations SET lease_id = ?, lease_until = ?, revision = revision + 1 WHERE owner_id = ? AND operation_id = ? AND revision = ? AND lease_until <= ? AND expires_at > ? RETURNING *")
      .bind(lease, Math.min(now + duration, row.expires_at), this.owner, row.operation_id, row.revision, now, now).first<DriveOperation>();
    if (!next) throw conflict();
    return next;
  }
  async cancelBatch(row: DriveOperation) {
    // Invalidates a running coordinator's CAS without undoing its started file.
    // Keep the encrypted manifest and child keys for read-only reconciliation.
    const next = await this.db.prepare("UPDATE drive_operations SET phase = 'failed', revision = revision + 1 WHERE owner_id = ? AND operation_id = ? AND kind = 'bulk-upload' AND revision = ? AND phase NOT IN ('confirmed','failed') RETURNING *")
      .bind(this.owner, row.operation_id, row.revision).first<DriveOperation>();
    if (!next) throw conflict();
    return next;
  }
  async checkpoint(row: DriveOperation, phase: DrivePhase, data: DriveOperationData) {
    const envelope = JSON.stringify(await this.envelopes.encrypt(DataSchema.parse(data), this.context(row.operation_id, row.account_scope, row.generation)));
    const next = await this.db.prepare("UPDATE drive_operations SET phase = ?, envelope = ?, revision = revision + 1 WHERE owner_id = ? AND operation_id = ? AND revision = ? AND lease_id = ? AND lease_until > ? AND expires_at > ? RETURNING *")
      .bind(phase, envelope, this.owner, row.operation_id, row.revision, row.lease_id, Date.now(), Date.now()).first<DriveOperation>();
    if (!next) throw conflict();
    return next;
  }
  async assertLease(row: DriveOperation, minimumRemainingMs = 10_000) {
    const active = await this.db.prepare("SELECT 1 AS active FROM drive_operations WHERE owner_id = ? AND operation_id = ? AND revision = ? AND lease_id = ? AND lease_until > ? AND expires_at > ?")
      .bind(this.owner, row.operation_id, row.revision, row.lease_id, Date.now() + minimumRemainingMs, Date.now() + minimumRemainingMs).first<{ active: number }>();
    if (!active) throw conflict();
  }
  async release(row: DriveOperation) {
    await this.db.prepare("UPDATE drive_operations SET lease_id = NULL, lease_until = 0 WHERE owner_id = ? AND operation_id = ? AND lease_id = ?")
      .bind(this.owner, row.operation_id, row.lease_id).run();
  }
  async handle(kind: "search" | "download" | "traversal", data: unknown, scope: DriveScope) {
    await this.requireSchema();
    await this.db.prepare("DELETE FROM drive_handles WHERE owner_id = ? AND expires_at <= ?").bind(this.owner, Date.now()).run();
    const id = crypto.randomUUID(), expires = Math.min(scope.expiresAt, Date.now() + 10 * 60_000);
    const envelope = JSON.stringify(await this.envelopes.encrypt(data, this.context(id, scope.account, scope.generation, kind)));
    const result = await this.db.prepare(`INSERT INTO drive_handles (owner_id,handle_id,account_scope,generation,permission_revision,kind,expires_at,envelope)
      SELECT ?,?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM drive_handles WHERE owner_id = ?) < 128`)
      .bind(this.owner, id, scope.account, scope.generation, scope.permissionRevision, kind, expires, envelope, this.owner).run();
    if (!result.meta.changes) throw new AppError("RATE_LIMITED", "Too many active Drive continuations. Wait for older handles to expire.", 429, true);
    return { id, expiresAt: expires };
  }
  async loadTraversalHandle(id: string, scope: DriveScope) {
    await this.requireSchema();
    const row = await this.db.prepare("SELECT envelope FROM drive_handles WHERE owner_id = ? AND handle_id = ? AND kind = 'traversal' AND account_scope = ? AND generation = ? AND permission_revision = ? AND expires_at > ?")
      .bind(this.owner, id, scope.account, scope.generation, scope.permissionRevision, Date.now()).first<{ envelope: string }>();
    if (!row) throw new AppError("CONFLICT", "This traversal expired, was used, or belongs to different settings/session. Start a fresh traversal.", 409);
    try { return { data: await this.envelopes.decrypt(EnvelopeSchema.parse(JSON.parse(row.envelope)), this.context(id, scope.account, scope.generation, "traversal")), envelope: row.envelope }; }
    catch { throw new AppError("PROTOCOL_CHANGED", "The encrypted Drive traversal failed verification.", 503); }
  }
  async retainTraversalShares(values: (string | undefined)[], scope: DriveScope) {
    const ids = [...new Set(values.filter((value): value is string => value !== undefined))];
    if (!ids.length) return;
    // Keep only contexts referenced by this page/queue alive, with the same
    // inactivity deadline as its cursor. Never revive expired or foreign rows.
    const now = Date.now(), expires = Math.min(scope.expiresAt, now + 10 * 60_000);
    for (let offset = 0; offset < ids.length; offset += 50) {
      const group = ids.slice(offset, offset + 50);
      const rows = await this.db.prepare(`UPDATE drive_handles SET expires_at = MAX(expires_at, ?) WHERE owner_id = ? AND kind = 'share' AND account_scope = ? AND generation = ? AND permission_revision = ? AND expires_at > ? AND handle_id IN (${group.map(() => "?").join(",")}) RETURNING handle_id`)
        .bind(expires, this.owner, scope.account, scope.generation, scope.permissionRevision, now, ...group).all();
      if (rows.results.length !== group.length) throw new AppError("CONFLICT", "A required shared context expired or changed. Browse its parent again before restarting this traversal.", 409);
    }
  }
  // Rotate the cursor only after a successful read/session checkpoint. An Apple
  // failure leaves it available, and a compare-and-swap prevents double advance.
  async advanceTraversalHandle(id: string, previous: string, data: unknown | null, scope: DriveScope): Promise<string | null> {
    const next = data === null ? null : crypto.randomUUID();
    const args = [this.owner, id, scope.account, scope.generation, scope.permissionRevision, Date.now(), previous];
    let row;
    if (next) {
      const envelope = JSON.stringify(await this.envelopes.encrypt(data, this.context(next, scope.account, scope.generation, "traversal")));
      row = await this.db.prepare("UPDATE drive_handles SET handle_id = ?, expires_at = ?, envelope = ? WHERE owner_id = ? AND handle_id = ? AND kind = 'traversal' AND account_scope = ? AND generation = ? AND permission_revision = ? AND expires_at > ? AND envelope = ? RETURNING handle_id")
        .bind(next, Math.min(scope.expiresAt, Date.now() + 10 * 60_000), envelope, ...args).first();
    } else {
      row = await this.db.prepare("DELETE FROM drive_handles WHERE owner_id = ? AND handle_id = ? AND kind = 'traversal' AND account_scope = ? AND generation = ? AND permission_revision = ? AND expires_at > ? AND envelope = ? RETURNING handle_id")
        .bind(...args).first();
    }
    if (!row) throw new AppError("CONFLICT", "This traversal continuation was already advanced or expired. Use the latest successful page's continuation.", 409);
    return next;
  }
  async consumeHandle(id: string, kind: "search" | "download", scope: DriveScope): Promise<unknown> {
    await this.requireSchema();
    const row = await this.db.prepare("DELETE FROM drive_handles WHERE owner_id = ? AND handle_id = ? AND kind = ? AND account_scope = ? AND generation = ? AND permission_revision = ? AND expires_at > ? RETURNING envelope")
      .bind(this.owner, id, kind, scope.account, scope.generation, scope.permissionRevision, Date.now()).first<{ envelope: string }>();
    if (!row) throw new AppError("CONFLICT", "This Drive handle expired, was used, or belongs to different service settings/session. Start a fresh read.", 409);
    try { return await this.envelopes.decrypt(EnvelopeSchema.parse(JSON.parse(row.envelope)), this.context(id, scope.account, scope.generation, kind)); }
    catch { throw new AppError("PROTOCOL_CHANGED", "The Drive continuation failed verification.", 503); }
  }
  async saveSharedContext(data: unknown, scope: DriveScope): Promise<string> {
    await this.requireSchema();
    const context = DriveSharedContext.parse(data);
    const identity = { shareID: context.shareID, ...(context.ownerRecordName ? { ownerRecordName: context.ownerRecordName } : {}) };
    // Repeated listings reuse one encrypted context per share in this scope.
    const hash = await fingerprint(["drive-share-v1", this.owner, scope.account, scope.generation, scope.permissionRevision, identity]);
    const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
    await this.db.prepare("DELETE FROM drive_handles WHERE owner_id = ? AND expires_at <= ?").bind(this.owner, Date.now()).run();
    const expires = Math.min(scope.expiresAt, Date.now() + 10 * 60_000);
    const existing = await this.db.prepare("SELECT envelope FROM drive_handles WHERE owner_id = ? AND handle_id = ? AND kind = 'share' AND account_scope = ? AND generation = ? AND permission_revision = ? AND expires_at > ?")
      .bind(this.owner, id, scope.account, scope.generation, scope.permissionRevision, Date.now()).first<{ envelope: string }>();
    if (existing) {
      const previous = DriveSharedContext.parse(await this.envelopes.decrypt(EnvelopeSchema.parse(JSON.parse(existing.envelope)), this.context(id, scope.account, scope.generation, "share")));
      if (previous.references) context.references = { ...previous.references, ...context.references };
    }
    const envelope = JSON.stringify(await this.envelopes.encrypt(DriveSharedContext.parse(context), this.context(id, scope.account, scope.generation, "share")));
    const result = await this.db.prepare(`INSERT INTO drive_handles (owner_id,handle_id,account_scope,generation,permission_revision,kind,expires_at,envelope)
      SELECT ?,?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM drive_handles WHERE owner_id = ?) < 128 OR EXISTS (SELECT 1 FROM drive_handles WHERE owner_id = ? AND handle_id = ?)
      ON CONFLICT(owner_id,handle_id) DO UPDATE SET expires_at = excluded.expires_at, envelope = excluded.envelope`)
      .bind(this.owner, id, scope.account, scope.generation, scope.permissionRevision, "share", expires, envelope, this.owner, this.owner, id).run();
    if (!result.meta.changes) throw new AppError("RATE_LIMITED", "Too many active Drive contexts. Wait for older handles to expire.", 429, true);
    return id;
  }
  async loadSharedContext(id: string, scope: DriveScope): Promise<unknown> {
    await this.requireSchema();
    const row = await this.db.prepare("SELECT envelope FROM drive_handles WHERE owner_id = ? AND handle_id = ? AND kind = 'share' AND account_scope = ? AND generation = ? AND permission_revision = ? AND expires_at > ?")
      .bind(this.owner, id, scope.account, scope.generation, scope.permissionRevision, Date.now()).first<{ envelope: string }>();
    if (!row) throw new AppError("CONFLICT", "The shared Drive context expired or belongs to different settings/account. Browse its shared parent again.", 409);
    try { return await this.envelopes.decrypt(EnvelopeSchema.parse(JSON.parse(row.envelope)), this.context(id, scope.account, scope.generation, "share")); }
    catch { throw new AppError("PROTOCOL_CHANGED", "The shared Drive context failed verification.", 503); }
  }
  async clearBeforeGeneration(generation: number) {
    if (!await this.available()) return;
    await this.db.batch([
      this.db.prepare("DELETE FROM drive_handles WHERE owner_id = ? AND generation < ?").bind(this.owner, generation),
      this.db.prepare("DELETE FROM drive_operations WHERE owner_id = ? AND generation < ?").bind(this.owner, generation),
    ]);
  }
}
