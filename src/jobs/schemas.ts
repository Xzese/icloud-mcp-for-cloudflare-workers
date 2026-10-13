import { z } from "zod";
import { CreateReminderInput, ReminderTargetInput, UpdateReminderInput } from "../reminders/writes.ts";
import { PreparationToken } from "../reminders/preparation.ts";

export const JOB_LIMITS = { items: 1000, chunkItems: 50, chunkBytes: 65_536, inputBytes: 2_097_152, activeJobs: 5, sliceItems: 3, lifetimeMs: 86_400_000, leaseMs: 120_000, attempts: 5, pageItems: 50 } as const;
export const JobState = z.enum(["draft", "ready", "queued", "running", "waiting_retry", "paused_auth", "needs_attention", "completed", "completed_with_errors", "cancelled", "expired"]);
export const ItemState = z.enum(["pending", "preparing", "dispatching", "verifying", "succeeded", "failed", "conflict", "unknown", "cancelled"]);
const BulkUpdateChanges = UpdateReminderInput.shape.changes.pick({ title: true, notes: true, priority: true, flagged: true, dueDate: true, timeZone: true, allDay: true })
  .strict().refine(changes => Object.keys(changes).length > 0, "At least one simple reminder change is required.")
  .describe("Nonempty changes to title, notes, priority, flagged, dueDate, timeZone or allDay. Omitted fields remain untouched.");
export const BulkUpdateInput = UpdateReminderInput.extend({ changes: BulkUpdateChanges }).strict();
export type BulkUpdateInputData = z.infer<typeof BulkUpdateInput>;
export const JobKind = z.enum(["bulk_create", "bulk_delete", "bulk_update", "bulk_complete"]).describe("Immutable request-driven job kind. Bulk changes target exact simple reminder versions; parents, subtasks, recurring, alarmed and other linked reminders are refused.");
export const JobItem = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("bulk_create"), clientItemKey: z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/), input: CreateReminderInput }).strict(),
  z.object({ kind: z.literal("bulk_delete"), clientItemKey: z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/), input: ReminderTargetInput }).strict(),
  z.object({ kind: z.literal("bulk_update"), clientItemKey: z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/), input: BulkUpdateInput }).strict(),
  z.object({ kind: z.literal("bulk_complete"), clientItemKey: z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/), input: ReminderTargetInput }).strict(),
]);
export const JobIdentity = z.object({ jobId: z.string().uuid().toLowerCase().describe("Exact job UUID; equal to the normalized UUID job idempotency key, including after a lost acceptance response.") }).strict();
export const CreateJob = z.object({ kind: JobKind, idempotencyKey: z.string().uuid().describe("Stable UUID for this job. Retain it; changed reuse conflicts and expired keys are never fresh requests."), expectedGeneration: z.number().int().nonnegative().safe().describe("Required session generation from connection_status; the job never adopts a replacement session.") }).strict();
export const AppendJob = JobIdentity.extend({ chunkKey: z.string().uuid().describe("Stable UUID for this exact chunk and revision; identical replay does not append twice."), expectedRevision: z.number().int().nonnegative().safe().describe("Current draft revision. Out-of-order or concurrent changed appends conflict."), items: z.array(JobItem).min(1).max(JOB_LIMITS.chunkItems).describe("1-50 ordered items, each with kind, unique clientItemKey and strict input. The entire ingestion request must fit 64 KiB.") }).strict();
export const PreviewJob = JobIdentity.extend({ expectedRevision: z.number().int().nonnegative().safe().describe("Current draft or ready revision to seal and preview.") }).strict();
export const StartJob = JobIdentity.extend({ previewToken: PreparationToken.describe("Unexpired owner/account/session-bound token from preview_reminder_job for the exact sealed manifest. Not user authorization.") }).strict();
export const GetJob = JobIdentity.extend({ offset: z.number().int().min(0).max(1000).default(0).describe("Original zero-based item ordinal where the result page starts."), limit: z.number().int().min(1).max(50).default(50).describe("Maximum result count, 1-50. Byte budgets may shorten the page; use nextOffset.") }).strict();
export type JobItemData = z.infer<typeof JobItem>;
export type BulkChangeItemData = Extract<JobItemData, { kind: "bulk_update" | "bulk_complete" }>;
export type JobStateData = z.infer<typeof JobState>;
export type ItemStateData = z.infer<typeof ItemState>;

const counter = z.number().int().nonnegative().safe();
export const JobResult = z.object({
  status: ItemState,
  code: z.string().nullable(),
  message: z.string(),
  targetId: z.string().nullable(),
  operationConfirmed: z.boolean(),
  desiredStateObserved: z.boolean(),
}).strict();
export type JobResultData = z.infer<typeof JobResult>;
export const JobOutput = z.object({
  jobId: z.string().uuid(), kind: JobKind, generation: counter, state: JobState,
  executionMode: z.literal("request-driven"),
  revision: counter, expiresAt: counter, nextRetryAt: counter.nullable(), cancellationRequested: z.boolean(),
  counts: z.object({ total: counter, pending: counter, preparing: counter, dispatching: counter, verifying: counter, succeeded: counter, failed: counter, conflict: counter, unknown: counter, cancelled: counter }).strict(),
  results: z.array(z.object({ ordinal: counter, clientItemKey: z.string(), input: z.union([CreateReminderInput, ReminderTargetInput, BulkUpdateInput]), status: ItemState, attempts: counter, result: JobResult.nullable() }).strict()),
  nextOffset: counter.nullable(),
  previewToken: PreparationToken.nullable(),
  previewExpiresAt: counter.nullable(),
  warnings: z.array(z.string()),
}).strict();
export const JOB_TOOLS = ["create_reminder_job", "append_reminder_job_items", "preview_reminder_job", "start_reminder_job", "get_reminder_job", "cancel_reminder_job", "resume_reminder_job", "continue_reminder_job"] as const;
