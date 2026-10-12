import { z } from "zod";
import { AppError } from "../errors.ts";
import { fingerprint, jsonBytes } from "../lib/canonical.ts";
import { JOB_LIMITS, JobItem, JobResult, type JobItemData, type JobResultData, type ItemStateData, type JobStateData } from "../jobs/schemas.ts";
import { aggregateState, type Counts } from "../jobs/state.ts";
import type { CloudKitWriteRecord } from "../reminders/writes.ts";
import type { RuntimeEnv } from "../platform/sites.ts";
import { configuredEnvelopes } from "./apple-sessions.ts";

export interface JobRow {
  owner_id: string; account_scope: string; job_id: string; job_key: string;
  kind: "bulk_create" | "bulk_delete"; generation: number; state: JobStateData; revision: number;
  manifest_hash: string | null; item_count: number; input_bytes: number; expires_at: number;
  cancel_requested: number; next_eligible_at: number; lease_id: string | null; lease_until: number;
  mutation_id: string | null; created_at: number; updated_at: number;
}
export interface ItemRow {
  ordinal: number; item_key_hash: string; input_hash: string; input_envelope: string | null;
  result_envelope: string | null; mutation_envelope: string | null;
  state: ItemStateData; attempts: number; dispatch_phase: string; next_attempt_at: number; reconciliation_status: string;
}
const EnvelopeSchema = z.object({ version: z.literal(1), keyId: z.string(), iv: z.string(), ciphertext: z.string() }).strict();
const conflict = (message: string) => new AppError("CONFLICT", message, 409);

export class ReminderJobRepository {
  readonly db: D1DatabaseSession;
  readonly owner: string;
  readonly envelopes: ReturnType<typeof configuredEnvelopes>;
  constructor(env: RuntimeEnv, owner: string) {
    if (!env.DB) throw new AppError("CONFIGURATION_REQUIRED", "Persistent job storage is required.", 503);
    if (!owner || owner.length > 256 || owner !== env.REMINDERS_OWNER_ID) throw new AppError("FORBIDDEN", "Jobs require the authenticated deployment owner.", 403);
    this.db = env.DB.withSession("first-primary"); this.owner = owner;
    this.envelopes = configuredEnvelopes(env);
  }
  async get(id: string): Promise<JobRow> {
    const job = await this.db.prepare("SELECT * FROM reminder_jobs WHERE owner_id = ? AND job_id = ?").bind(this.owner, id).first<JobRow>();
    if (!job) throw new AppError("FORBIDDEN", "The requested job is not available to this owner.", 403);
    return job;
  }
  private context(job: JobRow, ordinal: number, field: string) {
    return { ownerId: this.owner, accountId: job.account_scope, generation: job.generation, recordId: `reminder-job-v1/${job.job_id}/${ordinal}/${field}`, schemaVersion: 1 as const };
  }
  async encrypt(job: JobRow, ordinal: number, field: string, value: unknown) {
    return JSON.stringify(await this.envelopes.encrypt(value, this.context(job, ordinal, field)));
  }
  async decrypt(job: JobRow, ordinal: number, field: string, encoded: string | null): Promise<unknown> {
    if (!encoded) throw new AppError("JOB_EXPIRED", "Encrypted job content is no longer retained. This key cannot be reused.", 410);
    let value: unknown;
    try { value = JSON.parse(encoded); } catch { throw new AppError("PROTOCOL_CHANGED", "Encrypted job state is malformed.", 503); }
    const envelope = EnvelopeSchema.safeParse(value);
    if (!envelope.success) throw new AppError("PROTOCOL_CHANGED", "Encrypted job state is malformed.", 503);
    return this.envelopes.decrypt(envelope.data, this.context(job, ordinal, field));
  }
  async create(kind: JobRow["kind"], key: string, account: string, generation: number, expiresAt: number): Promise<JobRow> {
    const existing = await this.db.prepare("SELECT * FROM reminder_jobs WHERE owner_id = ? AND account_scope = ? AND job_key = ?").bind(this.owner, account, key).first<JobRow>();
    if (existing) {
      if (existing.kind !== kind || existing.generation !== generation) throw conflict("The job key is already bound to a different immutable request.");
      return existing;
    }
    const id = key, now = Date.now();
    const result = await this.db.prepare(`INSERT OR IGNORE INTO reminder_jobs (owner_id, account_scope, job_id, job_key, kind, generation, expires_at, created_at, updated_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM reminder_jobs WHERE owner_id = ? AND state NOT IN ('completed','completed_with_errors','cancelled','expired') AND
        (expires_at > ? OR EXISTS (SELECT 1 FROM reminder_job_items i WHERE i.owner_id = reminder_jobs.owner_id AND i.job_id = reminder_jobs.job_id AND i.state IN ('unknown','dispatching','verifying','preparing')))) < ?`)
      .bind(this.owner, account, id, key, kind, generation, expiresAt, now, now, this.owner, now, JOB_LIMITS.activeJobs).run();
    if (!result.meta.changes) {
      const replay = await this.db.prepare("SELECT * FROM reminder_jobs WHERE owner_id = ? AND account_scope = ? AND job_key = ?").bind(this.owner, account, key).first<JobRow>();
      if (replay && replay.kind === kind && replay.generation === generation) return replay;
      throw conflict("The owner already has five active jobs, or the job key changed concurrently.");
    }
    return this.get(id);
  }
  async items(job: JobRow, offset = 0, limit: number = JOB_LIMITS.items): Promise<ItemRow[]> {
    const result = await this.db.prepare("SELECT * FROM reminder_job_items WHERE owner_id = ? AND job_id = ? AND ordinal >= ? ORDER BY ordinal LIMIT ?").bind(this.owner, job.job_id, offset, limit).all<ItemRow>();
    return result.results;
  }
  async input(job: JobRow, item: ItemRow): Promise<JobItemData> {
    return JobItem.parse(await this.decrypt(job, item.ordinal, "input", item.input_envelope));
  }
  async append(job: JobRow, key: string, revision: number, values: JobItemData[]) {
    const chunkHash = await fingerprint({ revision, items: values });
    const replay = await this.db.prepare("SELECT chunk_hash FROM reminder_job_chunks WHERE owner_id = ? AND job_id = ? AND chunk_key = ?").bind(this.owner, job.job_id, key).first<{ chunk_hash: string }>();
    if (replay) {
      if (replay.chunk_hash !== chunkHash) throw conflict("The chunk key was reused with different content or revision.");
      return;
    }
    if (job.state !== "draft" || job.revision !== revision || job.cancel_requested || job.expires_at <= Date.now()) throw conflict("Append requires the current unexpired draft revision.");
    const bytes = jsonBytes(values);
    if (bytes > JOB_LIMITS.chunkBytes || job.input_bytes + bytes > JOB_LIMITS.inputBytes || job.item_count + values.length > JOB_LIMITS.items) throw new AppError("VALIDATION_ERROR", "The job exceeds its chunk, item or serialized-input budget.", 400);
    if (values.some(value => value.kind !== job.kind)) throw new AppError("VALIDATION_ERROR", "Every item must match its job kind.", 400);
    const itemHashes = await Promise.all(values.map(value => fingerprint(value.clientItemKey)));
    if (new Set(itemHashes).size !== itemHashes.length) throw conflict("Client item keys must be unique within a manifest.");
    const inputHashes = await Promise.all(values.map(value => fingerprint(value.input)));
    const keys = await Promise.all(values.map(value => fingerprint(value.kind === "bulk_create" ? ["create", value.input.idempotencyKey.toLowerCase()] : ["delete", value.input.listId, value.input.reminderId, value.input.recordChangeTag])));
    if (new Set(keys).size !== keys.length) throw conflict("Mutation keys must be unique within the manifest.");
    for (const hash of keys) {
      const receipt = await this.db.prepare("SELECT job_id FROM reminder_job_receipts WHERE owner_id = ? AND account_scope = ? AND key_hash = ?").bind(this.owner, job.account_scope, hash).first();
      if (receipt) throw conflict("A mutation key is already reserved. Inspect its original job; do not dispatch it through another manifest.");
    }
    const envelopes = await Promise.all(values.map((value, index) => this.encrypt(job, job.item_count + index, "input", value)));
    const nonce = crypto.randomUUID();
    const statements = [
      this.db.prepare("UPDATE reminder_jobs SET revision = revision + 1, item_count = item_count + ?, input_bytes = input_bytes + ?, mutation_id = ?, updated_at = ? WHERE owner_id = ? AND job_id = ? AND revision = ? AND state = 'draft' AND cancel_requested = 0 AND lease_until <= ? AND expires_at > ?")
        .bind(values.length, bytes, nonce, Date.now(), this.owner, job.job_id, revision, Date.now(), Date.now()),
      ...values.flatMap((_, index) => [
        this.db.prepare(`INSERT INTO reminder_job_items (owner_id, job_id, ordinal, item_key_hash, input_hash, input_envelope)
          SELECT owner_id, job_id, ?, ?, ?, ? FROM reminder_jobs WHERE owner_id = ? AND job_id = ? AND mutation_id = ?`)
          .bind(job.item_count + index, itemHashes[index], inputHashes[index], envelopes[index], this.owner, job.job_id, nonce),
        this.db.prepare(`INSERT INTO reminder_job_receipts (owner_id, account_scope, key_hash, input_hash, job_id)
          SELECT owner_id, account_scope, ?, ?, job_id FROM reminder_jobs WHERE owner_id = ? AND job_id = ? AND mutation_id = ?`)
          .bind(keys[index], inputHashes[index], this.owner, job.job_id, nonce),
      ]),
      this.db.prepare(`INSERT INTO reminder_job_chunks (owner_id, job_id, chunk_key, chunk_hash, accepted_revision)
        SELECT owner_id, job_id, ?, ?, revision FROM reminder_jobs WHERE owner_id = ? AND job_id = ? AND mutation_id = ?`)
        .bind(key, chunkHash, this.owner, job.job_id, nonce),
    ];
    try {
      const result = await this.db.batch(statements);
      if (!result[0].meta.changes) {
        const accepted = await this.db.prepare("SELECT chunk_hash FROM reminder_job_chunks WHERE owner_id = ? AND job_id = ? AND chunk_key = ?").bind(this.owner, job.job_id, key).first<{ chunk_hash: string }>();
        if (accepted?.chunk_hash === chunkHash) return;
        throw conflict("The draft changed before this chunk was appended.");
      }
    } catch (error) {
      if (error instanceof Error && /UNIQUE constraint failed/.test(error.message)) throw conflict("A chunk, client item or mutation key was already accepted.");
      throw error;
    }
  }
  async counts(job: JobRow): Promise<Counts> {
    const counts: Counts = { total: job.item_count, pending: 0, preparing: 0, dispatching: 0, verifying: 0, succeeded: 0, failed: 0, conflict: 0, unknown: 0, cancelled: 0 };
    const result = await this.db.prepare("SELECT state, COUNT(*) AS count FROM reminder_job_items WHERE owner_id = ? AND job_id = ? GROUP BY state").bind(this.owner, job.job_id).all<{ state: ItemStateData; count: number }>();
    for (const row of result.results) {
      if (!Object.hasOwn(counts, row.state)) throw new AppError("PROTOCOL_CHANGED", "The job ledger has an invalid item state.", 503);
      counts[row.state] = row.count;
    }
    if (Object.entries(counts).filter(([key]) => key !== "total").reduce((sum, [, count]) => sum + count, 0) !== job.item_count) throw new AppError("PROTOCOL_CHANGED", "The job ledger item count is inconsistent.", 503);
    return counts;
  }
  async claim(job: JobRow): Promise<string> {
    const now = Date.now(), lease = crypto.randomUUID(), until = now + JOB_LIMITS.leaseMs;
    await this.db.prepare("INSERT OR IGNORE INTO reminder_job_accounts (owner_id, account_scope) VALUES (?, ?)").bind(this.owner, job.account_scope).run();
    const account = await this.db.prepare("UPDATE reminder_job_accounts SET lease_id = ?, lease_until = ? WHERE owner_id = ? AND account_scope = ? AND lease_until <= ? AND cooldown_until <= ? RETURNING lease_id")
      .bind(lease, until, this.owner, job.account_scope, now, now).first();
    if (!account) throw new AppError("CONFLICT", "Another operation holds the account lease, or its cooldown has not elapsed.", 409, true);
    const claimed = await this.db.prepare("UPDATE reminder_jobs SET lease_id = ?, lease_until = ?, revision = revision + 1, updated_at = ? WHERE owner_id = ? AND job_id = ? AND lease_until <= ? AND revision = ? RETURNING job_id")
      .bind(lease, until, now, this.owner, job.job_id, now, job.revision).first();
    if (!claimed) { await this.release(job, lease); throw conflict("The job changed before its runner lease was acquired."); }
    return lease;
  }
  async release(job: JobRow, lease: string) {
    await this.db.batch([
      this.db.prepare("UPDATE reminder_jobs SET lease_id = NULL, lease_until = 0 WHERE owner_id = ? AND job_id = ? AND lease_id = ?").bind(this.owner, job.job_id, lease),
      this.db.prepare("UPDATE reminder_job_accounts SET lease_id = NULL, lease_until = 0 WHERE owner_id = ? AND account_scope = ? AND lease_id = ?").bind(this.owner, job.account_scope, lease),
    ]);
  }
  async assertLease(job: JobRow, lease: string, dispatch = false) {
    const current = await this.db.prepare(`SELECT j.cancel_requested, j.expires_at FROM reminder_jobs j JOIN reminder_job_accounts a ON a.owner_id = j.owner_id AND a.account_scope = j.account_scope
      WHERE j.owner_id = ? AND j.job_id = ? AND j.lease_id = ? AND a.lease_id = ? AND j.lease_until > ? AND a.lease_until > ?`)
      .bind(this.owner, job.job_id, lease, lease, Date.now(), Date.now()).first<{ cancel_requested: number; expires_at: number }>();
    if (!current) throw conflict("The durable job/account lease was lost.");
    if (dispatch && current.cancel_requested) throw new AppError("JOB_CANCELLED", "Cancellation prevented this dispatch.", 409);
    if (dispatch && current.expires_at <= Date.now()) throw new AppError("JOB_EXPIRED", "The authorized job lifetime expired before dispatch.", 410);
  }
  async transition(job: JobRow, lease: string, state: JobStateData, nextAt = 0) {
    const result = await this.db.prepare("UPDATE reminder_jobs SET state = ?, next_eligible_at = ?, revision = revision + 1, updated_at = ? WHERE owner_id = ? AND job_id = ? AND lease_id = ? AND lease_until > ?")
      .bind(state, nextAt, Date.now(), this.owner, job.job_id, lease, Date.now()).run();
    if (!result.meta.changes) throw conflict("The job lease was lost before durable progress was saved.");
  }
  async setItem(job: JobRow, lease: string, item: ItemRow, result: JobResultData, phase: string, nextAt = 0) {
    const envelope = await this.encrypt(job, item.ordinal, "result", JobResult.parse(result));
    const changed = await this.db.prepare(`UPDATE reminder_job_items SET state = ?, result_envelope = ?, dispatch_phase = ?, next_attempt_at = ?, reconciliation_status = ?
      WHERE owner_id = ? AND job_id = ? AND ordinal = ? AND EXISTS (SELECT 1 FROM reminder_jobs WHERE owner_id = ? AND job_id = ? AND lease_id = ? AND lease_until > ?)`)
      .bind(result.status, envelope, phase, nextAt, result.status === "unknown" ? "required" : result.desiredStateObserved ? "observed" : "not_needed", this.owner, job.job_id, item.ordinal, this.owner, job.job_id, lease, Date.now()).run();
    if (!changed.meta.changes) throw conflict("The job lease was lost before its item receipt was saved.");
  }
  async prepareItem(job: JobRow, lease: string, item: ItemRow) {
    await this.assertLease(job, lease, true);
    const result = await this.db.prepare(`UPDATE reminder_job_items SET state = 'preparing', attempts = attempts + 1
      WHERE owner_id = ? AND job_id = ? AND ordinal = ? AND state = 'pending' AND dispatch_phase IN ('not_submitted','rejected')
      AND EXISTS (SELECT 1 FROM reminder_jobs WHERE owner_id = ? AND job_id = ? AND lease_id = ? AND lease_until > ? AND cancel_requested = 0 AND expires_at > ?)`)
      .bind(this.owner, job.job_id, item.ordinal, this.owner, job.job_id, lease, Date.now(), Date.now()).run();
    if (!result.meta.changes) throw conflict("The selected job item is not eligible for preparation.");
    item.attempts += 1;
  }
  async dispatchIntent(job: JobRow, lease: string, item: ItemRow, write: CloudKitWriteRecord) {
    const envelope = await this.encrypt(job, item.ordinal, "mutation", write);
    await this.assertLease(job, lease, true);
    const result = await this.db.prepare(`UPDATE reminder_job_items SET state = 'dispatching', dispatch_phase = 'intent', mutation_envelope = ?
      WHERE owner_id = ? AND job_id = ? AND ordinal = ? AND state = 'preparing' AND EXISTS (SELECT 1 FROM reminder_jobs WHERE owner_id = ? AND job_id = ? AND lease_id = ? AND lease_until > ? AND cancel_requested = 0 AND expires_at > ?)`)
      .bind(envelope, this.owner, job.job_id, item.ordinal, this.owner, job.job_id, lease, Date.now(), Date.now()).run();
    if (!result.meta.changes) throw conflict("The job changed before dispatch intent was saved.");
    item.dispatch_phase = "intent"; item.state = "dispatching";
  }
  async seal(job: JobRow, lease: string, hash: string) {
    const result = await this.db.prepare("UPDATE reminder_jobs SET state = 'ready', manifest_hash = ?, revision = revision + 1, updated_at = ? WHERE owner_id = ? AND job_id = ? AND state = 'draft' AND lease_id = ? AND cancel_requested = 0 AND expires_at > ?")
      .bind(hash, Date.now(), this.owner, job.job_id, lease, Date.now()).run();
    if (!result.meta.changes) throw conflict("The draft changed before its manifest was sealed.");
  }
  async start(job: JobRow) {
    const nonce = crypto.randomUUID();
    const results = await this.db.batch([
      this.db.prepare("UPDATE reminder_jobs SET state = 'queued', revision = revision + 1, mutation_id = ?, updated_at = ? WHERE owner_id = ? AND job_id = ? AND state = 'ready' AND revision = ? AND cancel_requested = 0 AND expires_at > ? AND lease_until <= ?")
        .bind(nonce, Date.now(), this.owner, job.job_id, job.revision, Date.now(), Date.now()),
      this.db.prepare(`INSERT INTO reminder_job_outbox (owner_id, job_id, revision) SELECT owner_id, job_id, revision FROM reminder_jobs WHERE owner_id = ? AND job_id = ? AND mutation_id = ?
        ON CONFLICT(owner_id, job_id) DO UPDATE SET revision = excluded.revision, next_eligible_at = 0`).bind(this.owner, job.job_id, nonce),
    ]);
    if (!results[0].meta.changes) throw conflict("Start requires the reviewed, unexpired ready manifest.");
  }
  async cancel(job: JobRow) {
    await this.db.batch([
      this.db.prepare("UPDATE reminder_jobs SET cancel_requested = 1, revision = revision + 1, updated_at = ? WHERE owner_id = ? AND job_id = ? AND state NOT IN ('completed','completed_with_errors','cancelled','expired')").bind(Date.now(), this.owner, job.job_id),
      this.db.prepare(`UPDATE reminder_job_items SET state = 'cancelled' WHERE owner_id = ? AND job_id = ? AND state = 'pending'
        AND EXISTS (SELECT 1 FROM reminder_jobs WHERE owner_id = ? AND job_id = ? AND cancel_requested = 1)`).bind(this.owner, job.job_id, this.owner, job.job_id),
      this.db.prepare(`UPDATE reminder_jobs SET state = CASE WHEN EXISTS (SELECT 1 FROM reminder_job_items WHERE owner_id = ? AND job_id = ? AND state IN ('preparing','dispatching','verifying','unknown')) THEN 'needs_attention' ELSE 'cancelled' END
        WHERE owner_id = ? AND job_id = ? AND cancel_requested = 1`).bind(this.owner, job.job_id, this.owner, job.job_id),
    ]);
  }
  async cooldown(job: JobRow, nextAt: number) {
    await this.db.prepare("UPDATE reminder_job_accounts SET cooldown_until = MAX(cooldown_until, ?) WHERE owner_id = ? AND account_scope = ?").bind(nextAt, this.owner, job.account_scope).run();
  }
  async finish(job: JobRow, lease: string) {
    const current = await this.get(job.job_id), counts = await this.counts(current);
    const state = aggregateState(counts, !!current.cancel_requested);
    await this.transition(current, lease, state);
    await this.syncOutbox(await this.get(job.job_id));
  }
  async syncOutbox(job: JobRow) {
    await this.db.batch([
      this.db.prepare(`INSERT INTO reminder_job_outbox (owner_id, job_id, revision, next_eligible_at)
        SELECT owner_id, job_id, revision, next_eligible_at FROM reminder_jobs WHERE owner_id = ? AND job_id = ? AND state IN ('queued','running','waiting_retry')
        ON CONFLICT(owner_id, job_id) DO UPDATE SET revision = excluded.revision, next_eligible_at = excluded.next_eligible_at`)
        .bind(this.owner, job.job_id),
      this.db.prepare("DELETE FROM reminder_job_outbox WHERE owner_id = ? AND job_id = ? AND NOT EXISTS (SELECT 1 FROM reminder_jobs WHERE owner_id = ? AND job_id = ? AND state IN ('queued','running','waiting_retry'))")
        .bind(this.owner, job.job_id, this.owner, job.job_id),
    ]);
  }
  async deliveryNotBefore(job: JobRow) {
    const account = await this.db.prepare("SELECT lease_until, cooldown_until FROM reminder_job_accounts WHERE owner_id = ? AND account_scope = ?")
      .bind(this.owner, job.account_scope).first<{ lease_until: number; cooldown_until: number }>();
    return Math.max(job.next_eligible_at, job.lease_until, account?.lease_until ?? 0, account?.cooldown_until ?? 0);
  }
  async dueDeliveries() {
    const result = await this.db.prepare(`SELECT o.job_id, j.revision FROM reminder_job_outbox o
      JOIN reminder_jobs j ON j.owner_id = o.owner_id AND j.job_id = o.job_id
      LEFT JOIN reminder_job_accounts a ON a.owner_id = j.owner_id AND a.account_scope = j.account_scope
      WHERE o.owner_id = ? AND o.next_eligible_at <= ? AND j.next_eligible_at <= ? AND j.lease_until <= ?
        AND COALESCE(a.lease_until, 0) <= ? AND COALESCE(a.cooldown_until, 0) <= ? AND j.state IN ('queued','running','waiting_retry')
      ORDER BY j.created_at, j.job_id LIMIT ?`)
      .bind(this.owner, Date.now(), Date.now(), Date.now(), Date.now(), Date.now(), JOB_LIMITS.activeJobs).all<{ job_id: string; revision: number }>();
    return result.results;
  }
  async deferDelivery(jobId: string, revision: number, nextAt: number) {
    await this.db.prepare("UPDATE reminder_job_outbox SET revision = ?, next_eligible_at = ? WHERE owner_id = ? AND job_id = ? AND revision <= ? AND EXISTS (SELECT 1 FROM reminder_jobs WHERE owner_id = ? AND job_id = ? AND revision = ?)")
      .bind(revision, nextAt, this.owner, jobId, revision, this.owner, jobId, revision).run();
  }
  async purgeResolvedContent(now = Date.now()) {
    // Receipt keys remain reserved indefinitely. Unknown/in-flight content is
    // never purged, including after its authorization window has expired.
    await this.db.prepare(`UPDATE reminder_job_items SET input_envelope = NULL, result_envelope = NULL, mutation_envelope = NULL
      WHERE owner_id = ? AND EXISTS (SELECT 1 FROM reminder_jobs j WHERE j.owner_id = reminder_job_items.owner_id AND j.job_id = reminder_job_items.job_id
        AND j.state IN ('completed','completed_with_errors','cancelled','expired') AND j.updated_at < ?)
      AND NOT EXISTS (SELECT 1 FROM reminder_job_items i WHERE i.owner_id = reminder_job_items.owner_id AND i.job_id = reminder_job_items.job_id AND i.state IN ('unknown','dispatching','verifying','preparing'))`)
      .bind(this.owner, now - 7 * 86_400_000).run();
  }
  async expireUndispatched(now = Date.now()) {
    await this.db.batch([
      this.db.prepare(`UPDATE reminder_jobs SET state = 'expired', revision = revision + 1, updated_at = ?
        WHERE owner_id = ? AND expires_at <= ? AND lease_until <= ? AND state NOT IN ('completed','completed_with_errors','cancelled','expired')
        AND NOT EXISTS (SELECT 1 FROM reminder_job_items i WHERE i.owner_id = reminder_jobs.owner_id AND i.job_id = reminder_jobs.job_id AND (i.dispatch_phase = 'intent' OR i.state IN ('unknown','dispatching','verifying')))`)
        .bind(now, this.owner, now, now),
      this.db.prepare(`UPDATE reminder_job_items SET state = 'cancelled' WHERE owner_id = ? AND state IN ('pending','preparing') AND dispatch_phase <> 'intent'
        AND EXISTS (SELECT 1 FROM reminder_jobs j WHERE j.owner_id = reminder_job_items.owner_id AND j.job_id = reminder_job_items.job_id AND j.state = 'expired')`)
        .bind(this.owner),
      this.db.prepare(`DELETE FROM reminder_job_outbox WHERE owner_id = ? AND EXISTS (SELECT 1 FROM reminder_jobs j WHERE j.owner_id = reminder_job_outbox.owner_id AND j.job_id = reminder_job_outbox.job_id AND j.state = 'expired')`)
        .bind(this.owner),
    ]);
  }
}
