import { z } from "zod";
import { AppleConnectionService } from "../auth/service.ts";
import { requireAppleEnabled } from "../auth/gates.ts";
import { AppError, publicError } from "../errors.ts";
import { accountScope, fingerprint, jsonBytes } from "../lib/canonical.ts";
import { AppleSessionRepository } from "../persistence/apple-sessions.ts";
import { ReminderJobRepository, type JobRow } from "../persistence/reminder-jobs.ts";
import type { RuntimeEnv } from "../platform/sites.ts";
import { buildCreateReminder } from "../reminders/writes.ts";
import { checkPreparation, createPreparation, preparationContext } from "../reminders/preparation.ts";
import { AppendJob, CreateJob, GetJob, JobIdentity, JobOutput, JobResult, JOB_LIMITS, PreviewJob, StartJob, type JobItemData } from "./schemas.ts";
import { isTerminalJob } from "./state.ts";
import { runJobSlice } from "./runner.ts";
import { jobExecutionMode } from "./execution.ts";

export const BULK_DELETE_NOTICE = "Bulk deletion soft-deletes each exact reminder version after a fresh subtask check. Parents, subtasks, recurring and alarmed reminders are refused. A subtask added in Apple Reminders after that check cannot be blocked; it is reported afterwards. No cascade or Recently Deleted recovery is promised.";
const parse = <Schema extends z.ZodTypeAny>(schema: Schema, value: unknown): z.output<Schema> => {
  const result = schema.safeParse(value);
  if (!result.success) throw new AppError("VALIDATION_ERROR", "Provide a strict, bounded reminder-job request.", 400);
  return result.data;
};
export function canonicalItem(value: JobItemData): JobItemData {
  if (value.kind === "bulk_delete") return value;
  return { ...value, input: { ...value.input, idempotencyKey: value.input.idempotencyKey.toLowerCase(), dueDate: value.input.dueDate === undefined || value.input.dueDate === null ? null : new Date(value.input.dueDate).toISOString(), timeZone: value.input.timeZone ?? null } };
}
export class ReminderJobService {
  readonly repository: ReminderJobRepository;
  readonly env: RuntimeEnv;
  readonly owner: string;
  constructor(env: RuntimeEnv, owner: string) { this.env = env; this.owner = owner; this.repository = new ReminderJobRepository(env, owner); }
  async binding(job?: JobRow, generation?: number) {
    requireAppleEnabled(this.env);
    const saved = await new AppleSessionRepository(this.env, this.owner).load();
    const account = await accountScope(this.owner, saved.session.connection.dsid);
    if (saved.state !== "READY") throw new AppError("DEVICE_APPROVAL_PENDING", "Complete Apple approval before executing a job.", 409);
    if ((job && (job.account_scope !== account || job.generation !== saved.fence.generation)) || (generation !== undefined && generation !== saved.fence.generation)) throw new AppError("CONFLICT", "This job is pinned to a different Apple account or session generation. It cannot be silently rebound.", 409);
    return { account, generation: saved.fence.generation, expiresAt: saved.session.login.expiresAt };
  }
  async output(job: JobRow, offset = 0, limit = 50, previewToken: string | null = null, previewExpiresAt: number | null = null) {
    const mode = jobExecutionMode(this.env);
    const items = await this.repository.items(job, offset, limit), counts = await this.repository.counts(job);
    const decoded = await Promise.all(items.map(async item => {
      const value = await this.repository.input(job, item);
      return { ordinal: item.ordinal, clientItemKey: value.clientItemKey, input: value.input, status: item.state, attempts: item.attempts,
        result: item.result_envelope ? JobResult.parse(await this.repository.decrypt(job, item.ordinal, "result", item.result_envelope)) : null };
    }));
    const results: typeof decoded = [];
    let bytes = 0;
    for (const result of decoded) {
      bytes += jsonBytes(result);
      if (bytes > 262_144) break;
      results.push(result);
    }
    const expired = job.expires_at <= Date.now() && !isTerminalJob(job.state);
    return JobOutput.parse({
      jobId: job.job_id, kind: job.kind, generation: job.generation,
      state: expired ? counts.unknown || counts.dispatching || counts.verifying ? "needs_attention" : "expired" : job.state,
      executionMode: mode, revision: job.revision, expiresAt: job.expires_at, nextRetryAt: job.next_eligible_at || null,
      cancellationRequested: !!job.cancel_requested, counts, results, nextOffset: offset + results.length < job.item_count ? offset + results.length : null,
      previewToken, previewExpiresAt, warnings: [
        mode === "queue" ? "Queue execution starts from the durable outbox, normally within a minute. Authentication pauses and unknown outcomes require review; status reads never execute work." :
          "Request-driven execution pauses unless continue_reminder_job is called. Status reads never execute work.",
        "Preview tokens are not authorization. Obtain user approval for the exact sealed manifest.",
        "Cancellation is not rollback; already dispatched operations may still complete.",
        ...(job.kind === "bulk_delete" ? [BULK_DELETE_NOTICE] : ["Creation execution order does not establish Apple's display order."]),
      ],
    });
  }
  async create(value: unknown) {
    jobExecutionMode(this.env);
    const input = parse(CreateJob, value), binding = await this.binding(undefined, input.expectedGeneration);
    await this.repository.expireUndispatched();
    await this.repository.purgeResolvedContent();
    const job = await this.repository.create(input.kind, input.idempotencyKey.toLowerCase(), binding.account, binding.generation, Math.min(binding.expiresAt, Date.now() + JOB_LIMITS.lifetimeMs));
    if (job.expires_at <= Date.now()) throw new AppError("JOB_EXPIRED", "This job key has expired and cannot be reused.", 410);
    return this.output(job);
  }
  async append(value: unknown) {
    const input = parse(AppendJob, value), job = await this.repository.get(input.jobId);
    await this.binding(job);
    if (jsonBytes(value) > JOB_LIMITS.chunkBytes) throw new AppError("VALIDATION_ERROR", "The complete ingestion request exceeds 64 KiB.", 400);
    await this.repository.append(job, input.chunkKey.toLowerCase(), input.expectedRevision, input.items.map(canonicalItem));
    return this.output(await this.repository.get(job.job_id));
  }
  private tokenContext(job: JobRow) { return preparationContext(this.owner, job.account_scope, job.generation, `job/${job.job_id}`); }
  private previewHash(job: JobRow) { return fingerprint({ jobId: job.job_id, kind: job.kind, manifest: job.manifest_hash, generation: job.generation }); }
  async preview(value: unknown) {
    const input = parse(PreviewJob, value), job = await this.repository.get(input.jobId);
    await this.binding(job);
    if (job.revision !== input.expectedRevision || !["draft", "ready"].includes(job.state) || job.cancel_requested || job.expires_at <= Date.now()) throw new AppError("CONFLICT", "Preview requires the current unexpired draft or ready revision.", 409);
    if (!job.item_count) throw new AppError("VALIDATION_ERROR", "Append at least one item before sealing a manifest.", 400);
    if (job.state === "draft") {
      const lease = await this.repository.claim(job);
      try {
        const rows = await this.repository.items(job);
        if (rows.length !== job.item_count || rows.some((row, index) => row.ordinal !== index)) throw new AppError("PROTOCOL_CHANGED", "The complete job manifest is inconsistent.", 503);
        const values = await Promise.all(rows.map(row => this.repository.input(job, row)));
        const hashes = await Promise.all(values.map(item => fingerprint(item.input)));
        if (rows.some((row, index) => row.input_hash !== hashes[index]) || jsonBytes(values) > JOB_LIMITS.inputBytes) throw new AppError("PROTOCOL_CHANGED", "The sealed input does not match the accepted manifest.", 503);
        const lists = [...new Set(values.filter(item => item.kind === "bulk_create").map(item => item.input.listId))];
        const connection = new AppleConnectionService(this.env, this.owner);
        if (lists.length) await connection.validateJobLists(job.generation, job.account_scope, lists);
        const deletes = values.flatMap((item, index) => item.kind === "bulk_delete" ? [{ index, input: item.input }] : []);
        const deleteChecks = new Map<number, AppError | null>();
        if (deletes.length) {
          const checks = await connection.preflightJobDeletes(job.generation, job.account_scope, deletes.map(item => item.input));
          deletes.forEach((item, position) => deleteChecks.set(item.index, checks[position]));
        }
        const now = Date.now();
        for (let index = 0; index < rows.length; index++) {
          let invalid: AppError | null = null;
          const value = values[index];
          if (value.kind === "bulk_delete") invalid = deleteChecks.get(index) ?? null;
          else {
            try { buildCreateReminder(value.input, now); }
            catch (error) {
              if (!(error instanceof AppError)) throw error;
              invalid = error;
            }
          }
          if (invalid) {
            const safe = publicError(invalid, crypto.randomUUID());
            await this.repository.setItem(job, lease, rows[index], { status: "failed", code: safe.code, message: safe.message,
              targetId: value.kind === "bulk_delete" ? value.input.reminderId : `Reminder/${value.input.idempotencyKey.toUpperCase()}`, operationConfirmed: false, desiredStateObserved: false }, "not_submitted");
          }
        }
        await this.repository.seal(job, lease, await fingerprint({ kind: job.kind, items: values }));
      } finally { await this.repository.release(job, lease); }
    }
    const sealed = await this.repository.get(job.job_id);
    if (sealed.cancel_requested || sealed.state !== "ready") throw new AppError("CONFLICT", "The sealed manifest was cancelled or changed before its preview token was issued.", 409);
    const expiresAt = Math.min(sealed.expires_at, Date.now() + 600_000);
    const token = await createPreparation(this.env, this.tokenContext(sealed), await this.previewHash(sealed), sealed.manifest_hash!, expiresAt);
    return this.output(sealed, 0, 50, token, expiresAt);
  }
  async start(value: unknown) {
    jobExecutionMode(this.env);
    const input = parse(StartJob, value), job = await this.repository.get(input.jobId);
    await this.binding(job);
    if (!job.manifest_hash) throw new AppError("CONFLICT", "Seal and review the complete manifest before start.", 409);
    await checkPreparation(this.env, this.tokenContext(job), input.previewToken, await this.previewHash(job), job.manifest_hash);
    if (job.state !== "ready") {
      if (job.state === "draft" || job.cancel_requested) throw new AppError("CONFLICT", "This job is not eligible to start.", 409);
      return this.output(job);
    }
    await this.repository.start(job);
    return this.output(await this.repository.get(job.job_id));
  }
  async get(value: unknown) { const input = parse(GetJob, value); return this.output(await this.repository.get(input.jobId), input.offset, input.limit); }
  async cancel(value: unknown) { const input = parse(JobIdentity, value); const job = await this.repository.get(input.jobId); await this.repository.cancel(job); return this.output(await this.repository.get(job.job_id)); }
  async resume(value: unknown) {
    const input = parse(JobIdentity, value), job = await this.repository.get(input.jobId);
    await this.binding(job);
    if (job.expires_at <= Date.now()) throw new AppError("JOB_EXPIRED", "The job authorization expired; it cannot be renewed implicitly.", 410);
    if (job.cancel_requested || isTerminalJob(job.state) || ["draft", "ready"].includes(job.state)) throw new AppError("CONFLICT", "This job cannot be resumed.", 409);
    if (job.next_eligible_at > Date.now()) throw new AppError("RATE_LIMITED", "Wait for the persisted account retry time.", 429, true);
    const lease = await this.repository.claim(job);
    try { await this.repository.finish(job, lease); } finally { await this.repository.release(job, lease); }
    return this.output(await this.repository.get(job.job_id));
  }
  async continue(value: unknown) {
    const input = parse(JobIdentity, value);
    await runJobSlice(this, await this.repository.get(input.jobId));
    return this.output(await this.repository.get(input.jobId));
  }
}
