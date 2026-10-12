import { z } from "zod";
import { CreateListInput, RenameListInput, DeleteListInput, buildCreateList, buildRenameList, buildDeleteList, requireMutableList, type ListOperation } from "../reminders/list-writes.ts";
import { AppError, WriteOutcomeUnknownError } from "../errors.ts";
import { omitField } from "../lib/omit-field.ts";
import type { RuntimeEnv } from "../platform/sites.ts";
import { AppleSessionRepository, mergeSavedLists, type AppleSession, type AllOpenScan, type ResumeFence } from "../persistence/apple-sessions.ts";
import { CloudKitRateLimitedError, CloudKitRemindersClient, normalizeList, normalizeReminder, type CloudKitPage, type CloudKitRecord, type CloudKitLookupResult } from "../icloud/cloudkit.ts";
import { CreateReminderInput, UpdateReminderInput, ReminderTargetInput, assertOwnedReminder, buildCreateReminder, buildReminderFieldUpdate, buildLifecycleReminder, matchesCreatedReminder, type CloudKitWriteRecord } from "../reminders/writes.ts";
import { decodeDocument } from "../reminders/crdt.ts";
import { AppleAuthHTTP } from "./apple/http.ts";
import { advancePcs, freshPcsCheckpoint } from "./apple/pcs.ts";
import { AppleSessionRenewal, appleRequestBudget, appleSuccess, renewalCheckpoint, type AppleRequestBudget } from "./apple/session-renewal.ts";
import { appleDisabledMessage, appleGates, requireAppleEnabled } from "./gates.ts";
import { accountScope, canonicalJSON, fingerprint, jsonBytes } from "../lib/canonical.ts";
import { attachEarlyReminderWitness, loadSchedulingGraph, type SchedulingGraph } from "../reminders/linked-records.ts";
import { earlyReminderPayload } from "../reminders/early-reminder.ts";
import { planReminderUpdate } from "../reminders/mutation-plan.ts";
import { PrepareUpdateInput, PreparedUpdateInput, createPreparation, checkPreparation, preparationContext } from "../reminders/preparation.ts";
import { JOB_TOOLS } from "../jobs/schemas.ts";
import { EvidenceInput, AtomicProtectionInput, captureEvidenceGraph, sanitizeEvidence, verifyAtomicProtection } from "../reminders/evidence.ts";
import { jobExecutionMode } from "../jobs/execution.ts";
import { verifySchedulingWrite, type SchedulingWrite } from "../reminders/scheduling-plan.ts";
import { CreateSubtaskInput, HAS_SUBTASKS_MESSAGE, SetReminderParentInput, buildCreateSubtask, buildSetReminderParent, listChildren, requireNoChildren, subtaskParents } from "../reminders/subtasks.ts";

export interface MutationHooks {
  expectedAccount: string;
  beforeDispatch(write: CloudKitWriteRecord): Promise<void>;
  assertDispatch(): Promise<void>;
}

export const ResumeRequest = z.object({ expectedGeneration: z.number().int().nonnegative().safe(), restartApproval: z.boolean().optional() }).strict();
export const ReminderMutation = z.discriminatedUnion("action", [
  CreateReminderInput.extend({ action: z.literal("create"), expectedGeneration: ResumeRequest.shape.expectedGeneration }).strict(),
  PreparedUpdateInput.extend({ action: z.literal("update"), expectedGeneration: ResumeRequest.shape.expectedGeneration }).strict(),
  ReminderTargetInput.extend({ action: z.literal("complete"), expectedGeneration: ResumeRequest.shape.expectedGeneration }).strict(),
  ReminderTargetInput.extend({ action: z.literal("reopen"), expectedGeneration: ResumeRequest.shape.expectedGeneration }).strict(),
  ReminderTargetInput.extend({ action: z.literal("delete"), expectedGeneration: ResumeRequest.shape.expectedGeneration }).strict(),
  CreateSubtaskInput.extend({ action: z.literal("create_subtask"), expectedGeneration: ResumeRequest.shape.expectedGeneration }).strict(),
  SetReminderParentInput.extend({ action: z.literal("set_parent"), expectedGeneration: ResumeRequest.shape.expectedGeneration }).strict(),
]);
const common = { expectedGeneration: z.number().int().nonnegative().safe(), continuation: z.string().min(1).max(8192).nullable().optional(), limit: z.number().int().min(1).max(200).default(200) };
const listIdSchema = z.string().min(6).max(512).regex(/^List\/[^/\u0000-\u0020\u007f]+$/);
const authenticationFailure = (error: unknown) => error instanceof AppError && ["REAUTH_REQUIRED", "AUTH_EXPIRED", "TERMS_ACTION_REQUIRED", "VERIFICATION_REQUIRED"].includes(error.code);
const EARLY_WITNESS_LIMITS = { pages: 5, records: 1_000, bytes: 1_044_480, durationMs: 10_000 } as const;
const EARLY_PAYLOAD_FIELD = "DueDateDeltaAlertsData";
type OperationMode = "read-only" | "mutation-preparation" | "cursor-progress" | "pcs" | "snapshot";
interface OperationStage { phase: OperationMode | "mutation-dispatch" | "mutation-confirmation"; dispatch(): void; confirm(): void; }
export const ControlledRead = z.discriminatedUnion("action", [
  z.object({ action: z.literal("discover"), expectedGeneration: common.expectedGeneration }).strict(),
  z.object({ action: z.literal("saved-lists"), expectedGeneration: common.expectedGeneration }).strict(),
  z.object({ action: z.literal("current-lists"), expectedGeneration: common.expectedGeneration }).strict(),
  z.object({ action: z.literal("refresh-saved-lists"), expectedGeneration: common.expectedGeneration }).strict(),
  z.object({ action: z.literal("probe-shared-lists"), expectedGeneration: common.expectedGeneration, listIds: z.array(z.string().min(6).max(512).startsWith("List/")).min(1).max(10) }).strict(),
  z.object({ action: z.literal("lookup-lists"), expectedGeneration: common.expectedGeneration, listIds: z.array(z.string().min(6).max(512).startsWith("List/")).min(1).max(10), expectedZoneOwner: z.string().min(1).max(256).optional() }).strict(),
  z.object({ action: z.literal("reminders-batch"), expectedGeneration: common.expectedGeneration, listIds: z.array(listIdSchema).min(1).max(2).refine(ids => new Set(ids).size === ids.length, "List IDs must be unique."), includeCompleted: z.boolean(), limit: common.limit }).strict(),
  z.object({ action: z.literal("reminders"), ...common, listId: listIdSchema, includeCompleted: z.boolean() }).strict(),
]);
type PageOptions = { action: "reminders"; listId: string; includeCompleted?: boolean };
interface MCPReadPage extends Record<string, unknown> {
  records: Record<string, unknown>[];
  recordErrors: { id: string | null; code: string }[];
  complete: boolean;
  paginationComplete: boolean;
  continuation: string | null;
  source: string;
  freshness: { mode: string; caughtUpAt?: number | null; retrievedAt?: number };
}
interface MCPReadResult { result: MCPReadPage; generation: number; liveReadValidated: boolean; writesEnabled: boolean; }
function normalizeReadPage(page: CloudKitPage, options: PageOptions, remindersZoneOwner?: string) {
  if (page.recordErrors.some(error => ["AUTHENTICATION_REQUIRED", "NOT_AUTHENTICATED", "INVALID_AUTH_TOKEN", "AUTHENTICATION_FAILED"].includes(error.serverErrorCode.toUpperCase()))) throw new AppError("REAUTH_REQUIRED", "Apple rejected the Reminders read. Reconnect your Apple account.", 409);
  const auxiliaryRecordCounts: Record<string, number> = {};
  const relatedRecords: { id: string; recordType: string; deleted: boolean; appleRecord: Record<string, unknown> }[] = [];
  const records = page.records.flatMap<Record<string, unknown>>(record => {
    const recordType = "recordType" in record ? record.recordType : record.recordName.split("/")[0];
    if (recordType !== "Reminder") {
      auxiliaryRecordCounts[recordType] = (auxiliaryRecordCounts[recordType] ?? 0) + 1;
      relatedRecords.push({ id: record.recordName, recordType, deleted: record.deleted === true, appleRecord: record.raw });
      return [];
    }
    if (record.deleted) return [{ id: record.recordName, deleted: true, appleRecord: record.raw }];
    if (!("recordType" in record)) throw new AppError("PROTOCOL_CHANGED", "Apple omitted the type of a returned record.");
    const normalized = normalizeReminder(record, remindersZoneOwner);
    if (!options.includeCompleted && normalized.completed === true) return [];
    const { raw, ...safe } = normalized;
    return [{ ...safe, appleRecord: raw }];
  });
  return { records, recordErrors: page.recordErrors.map(error => ({ id: error.recordName, code: error.serverErrorCode, reason: error.reason, appleRecord: error.raw })), complete: page.complete, paginationComplete: page.paginationComplete, continuation: page.continuation, pendingReason: page.pendingReason, scope: "controlled-page", auxiliaryRecordCounts, auxiliaryDetailsIncluded: true, relatedRecords, listId: options.listId };
}

function writeLookupRecord(result: CloudKitLookupResult, id: string, allowMissing: boolean): CloudKitRecord | null {
  if (result.unresolvedRecordNames.length || result.recordErrors.some(error => error.recordName === null)) throw new AppError("PROTOCOL_CHANGED", "Apple omitted an exact write-preparation lookup result.");
  const error = result.recordErrors.find(error => error.recordName === id);
  if (error) {
    const code = error.serverErrorCode.toUpperCase();
    if (["AUTHENTICATION_REQUIRED", "NOT_AUTHENTICATED", "INVALID_AUTH_TOKEN", "AUTHENTICATION_FAILED"].includes(code)) throw new AppError("REAUTH_REQUIRED", "Apple rejected the write-preparation lookup. Reconnect your Apple account.", 409);
    if (["ACCESS_DENIED", "PERMISSION_FAILURE", "PERMISSION_DENIED"].includes(code)) throw new AppError("FORBIDDEN", "Apple denied access to the target list or reminder.", 403);
    if (["THROTTLED", "REQUEST_RATE_LIMITED", "ZONE_BUSY"].includes(code)) throw new CloudKitRateLimitedError(null);
    if (["UNKNOWN_ITEM", "NOT_FOUND"].includes(code)) {
      if (allowMissing) return null;
      throw new AppError("CONFLICT", "The target list or reminder no longer exists.", 409);
    }
    throw new AppError("PROTOCOL_CHANGED", "Apple rejected the exact write-preparation lookup.");
  }
  const record = result.records.find(record => record.recordName === id);
  if (!record || !("recordType" in record) || record.deleted) throw new AppError("CONFLICT", "The target list or reminder is no longer available.", 409);
  return record;
}

function earlyPayloadAbsent(record: CloudKitRecord) {
  const field = record.fields[EARLY_PAYLOAD_FIELD];
  return field === undefined || field === null || typeof field === "object" && !Array.isArray(field) && "type" in field && field.type === "ENCRYPTED_BYTES" && "value" in field && field.value === null;
}

function bindToAuthenticatedReminderZone(record: CloudKitRecord, trustedZone: NonNullable<CloudKitRecord["zoneID"]>, owner: string): CloudKitRecord | null {
  const zone = record.zoneID;
  if (zone && (zone.zoneName !== trustedZone.zoneName ||
    zone.zoneType !== undefined && zone.zoneType !== "REGULAR_CUSTOM_ZONE" ||
    zone.ownerRecordName !== undefined && zone.ownerRecordName !== owner && zone.ownerRecordName !== "__defaultOwner__")) return null;
  return { ...record, zoneID: trustedZone };
}

function sameWitnessSnapshot(left: CloudKitRecord, right: CloudKitRecord) {
  return left.recordName === right.recordName && left.recordType === right.recordType &&
    left.recordChangeTag === right.recordChangeTag && left.deleted === right.deleted &&
    canonicalJSON(left.zoneID ?? null) === canonicalJSON(right.zoneID ?? null) &&
    canonicalJSON(left.fields) === canonicalJSON(right.fields);
}

function ownedListRecord(record: CloudKitRecord, owner: string): CloudKitRecord {
  const scoped = bindToAuthenticatedReminderZone(record, { zoneName: "Reminders", zoneType: "REGULAR_CUSTOM_ZONE", ownerRecordName: owner }, owner);
  if (!scoped || scoped.recordType !== "List") throw new AppError("FORBIDDEN", "The requested record is not an owned private Reminders list.", 403);
  return scoped;
}

function requireEmptyListMetadata(record: CloudKitRecord) {
  const list = normalizeList(record);
  if (list.count !== null && list.count !== 0 || list.reminderIds === null || list.reminderIds.length !== 0)
    throw new AppError("UNSUPPORTED_FEATURE", "Only lists with explicitly empty membership and no nonzero count can be deleted.");
}

function verifyWriteFields(write: CloudKitWriteRecord, confirmed: CloudKitRecord, current: CloudKitRecord, owner: string, listId: string) {
  const reminder = normalizeReminder(confirmed, owner);
  const before = normalizeReminder(current, owner);
  const expectedCompleted = write.fields.Completed ? write.fields.Completed.value === 1 : before.completed;
  const expectedDeleted = write.fields.Deleted ? write.fields.Deleted.value === 1 : before.deleted;
  if (reminder.listId !== listId || reminder.completed !== expectedCompleted || reminder.deleted !== expectedDeleted) throw new WriteOutcomeUnknownError(write.recordName);
  const values: Record<string, unknown> = { Completed: Number(reminder.completed), Deleted: Number(reminder.deleted), CompletionDate: reminder.completedDate === null ? null : Date.parse(reminder.completedDate), Priority: reminder.priority, Flagged: reminder.flagged === null ? null : Number(reminder.flagged), AllDay: reminder.allDay === null ? null : Number(reminder.allDay), TimeZone: reminder.timeZone, DueDate: reminder.dueDate === null ? null : Date.parse(reminder.dueDate) };
  for (const [key, field] of Object.entries(write.fields)) {
    if (key === "TitleDocument" || key === "NotesDocument") {
      const expected = decodeDocument(String(field.value)).text;
      if ((key === "TitleDocument" ? reminder.title : reminder.notes ?? "") !== expected) throw new WriteOutcomeUnknownError(write.recordName);
    } else if (Object.hasOwn(values, key)) {
      if (values[key] !== field.value) throw new WriteOutcomeUnknownError(write.recordName);
    } else if (key === "ParentReminder") {
      const expected = field.value && typeof field.value === "object" && "recordName" in field.value ? field.value.recordName : null;
      if (reminder.parentReminderId !== expected) throw new WriteOutcomeUnknownError(write.recordName);
    } else if (key !== "List") {
      const actual = confirmed.fields[key];
      if (field.value === null && !actual) continue;
      if (!actual || typeof actual !== "object" || Array.isArray(actual) || !("type" in actual) || !("value" in actual) || (actual.type !== field.type && !(field.type === "UNKNOWN_LIST" && actual.type === "STRING_LIST" && Array.isArray(actual.value) && actual.value.length === 0))) throw new WriteOutcomeUnknownError(write.recordName);
      if (key === "ResolutionTokenMap") {
        if (typeof actual.value !== "string" || typeof field.value !== "string") throw new WriteOutcomeUnknownError(write.recordName);
        let expected: unknown, returned: unknown;
        try { expected = JSON.parse(field.value); returned = JSON.parse(actual.value); }
        catch { throw new WriteOutcomeUnknownError(write.recordName); }
        if (canonicalJSON(expected) !== canonicalJSON(returned)) throw new WriteOutcomeUnknownError(write.recordName);
      } else if (field.type === "TIMESTAMP" ? Number(actual.value) !== Number(field.value) : canonicalJSON(actual.value) !== canonicalJSON(field.value)) {
        throw new WriteOutcomeUnknownError(write.recordName);
      }
    }
  }
  for (const [key, field] of Object.entries(current.fields)) {
    if (!Object.hasOwn(write.fields, key) && canonicalJSON(confirmed.fields[key] ?? null) !== canonicalJSON(field)) throw new WriteOutcomeUnknownError(write.recordName);
  }
}

export class AppleConnectionService {
  readonly env: RuntimeEnv; readonly owner: string;
  constructor(env: RuntimeEnv, owner: string) { this.env = env; this.owner = owner; }
  async status() {
    const gates = appleGates(this.env);
    const session = await new AppleSessionRepository(this.env, this.owner).status();
    const readsAvailable = gates.enabled && session.transportReady && !["apple-sign-in", "verify-device", "review-terms"].includes(session.requiredAction ?? "") && !(session.nextRetryAt && session.nextRetryAt > Date.now());
    const connection = omitField(session, "liveReadValidated");
    const writesAvailable = readsAvailable;
    const jobSchema = await this.env.DB?.withSession("first-primary").prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name IN ('reminder_jobs','reminder_job_items','reminder_job_receipts','reminder_job_chunks','reminder_job_outbox','reminder_job_accounts')").first<{ count: number }>();
    const jobsAvailable = jobSchema?.count === 6;
    const actionMessage = session.requiredAction === "local-retention-expired" ? "The fixed local retention window expired. Sign in and verify your device again."
      : session.requiredAction === "apple-sign-in" || session.requiredAction === "verify-device" ? "Sign in again or complete the required device verification to use this Apple connection."
      : session.requiredAction === "review-terms" ? "Review Apple's updated terms in the official iCloud interface."
      : session.requiredAction === "retry" && session.nextRetryAt && session.nextRetryAt > Date.now() ? "Apple or the network is temporarily unavailable. The saved connection is preserved; wait until the retry time."
      : null;
    return { ...connection, listDiscovery: { strategy: "direct", liveValidated: false, experimental: true }, gates,
      connected: gates.enabled && session.transportReady, writeEnabled: writesAvailable, phase: writesAvailable ? "read-write" : "read-only",
      capabilities: { liveRead: readsAvailable, controlledRead: readsAvailable, listReminders: readsAvailable, allOpenReminders: readsAvailable, search: false, create: writesAvailable, update: writesAvailable, complete: writesAvailable, reopen: writesAvailable, delete: writesAvailable,
        prepareUpdate: readsAvailable, linkedScheduling: writesAvailable, reminderJobs: jobsAvailable, bulkCreate: writesAvailable && jobsAvailable, bulkDelete: writesAvailable && jobsAvailable,
        autonomousJobs: jobsAvailable && jobExecutionMode(this.env) === "queue", jobExecutionMode: jobExecutionMode(this.env),
        subtasks: writesAvailable, createList: writesAvailable, renameList: writesAvailable, deleteList: writesAvailable },
      mcpTools: ["connection_status", "get_reminder_lists", "get_reminders", "get_reminder", "get_all_open_reminders", "create_reminder", "create_subtask", "set_reminder_parent", "get_reminder_list", "create_reminder_list", "rename_reminder_list", "delete_reminder_list", "update_reminder", "complete_reminder", "reopen_reminder", "delete_reminder", "prepare_reminder_update", ...JOB_TOOLS],
      message: !gates.enabled ? appleDisabledMessage(gates) : actionMessage ?? (session.state === "READY"
        ? "You can read, create, edit, complete, reopen and delete reminders. Use current IDs and version tags."
        : session.state === "DEVICE_APPROVAL_PENDING"
          ? session.action === "wait-for-reminders-keys" ? "Apple accepted device approval. Check again shortly while Apple makes the Reminders keys available." : "Approve Apple's web-access prompt on your device, then check approval again."
          : "Connect your Apple account through the private Site's secure connection form.") };
  }
  async disconnect() { return await new AppleSessionRepository(this.env, this.owner).disconnect(); }
  private requireLocalEvidence() {
    if (this.env.LOCAL_REMINDER_EVIDENCE_ENABLED !== "synthetic-v1" || !["http://127.0.0.1:5173", "http://localhost:5173"].includes(this.env.APP_ORIGIN ?? "")) {
      throw new AppError("FORBIDDEN", "Protocol evidence capture requires the explicitly enabled loopback-only synthetic test runtime.", 403);
    }
  }
  private async hydrateEarlyReminderWitness(
    client: CloudKitRemindersClient, graph: SchedulingGraph, changes: z.infer<typeof UpdateReminderInput>["changes"],
  ): Promise<SchedulingGraph> {
    if (!changes.earlyReminder || !earlyPayloadAbsent(graph.reminder)) return graph;
    const owner = client.remindersZoneOwner!;
    const trustedZone = graph.reminder.zoneID ?? { zoneName: "Reminders", ownerRecordName: owner };
    const listId = normalizeReminder(graph.reminder, owner).listId;
    const startedAt = Date.now();
    let continuation: string | null = null;
    let pages = 0, scannedRecords = 0, scannedBytes = 0;
    const seenContinuations = new Set<string>();
    while (pages < EARLY_WITNESS_LIMITS.pages) {
      if (Date.now() - startedAt > EARLY_WITNESS_LIMITS.durationMs) throw new AppError("UNSUPPORTED_FEATURE", "The same-list early reminder source scan exceeded its time budget.");
      const page = await client.queryRemindersPage({ listId, includeCompleted: false, limit: 200, continuation });
      pages++;
      scannedRecords += page.records.length;
      scannedBytes += jsonBytes(page.records);
      if (scannedRecords > EARLY_WITNESS_LIMITS.records || scannedBytes > EARLY_WITNESS_LIMITS.bytes) {
        throw new AppError("UNSUPPORTED_FEATURE", "The same-list early reminder source scan exceeded its record or byte budget.");
      }
      if (Date.now() - startedAt > EARLY_WITNESS_LIMITS.durationMs) throw new AppError("UNSUPPORTED_FEATURE", "The same-list early reminder source scan exceeded its time budget.");
      if (page.recordErrors.length) {
        const codes = page.recordErrors.map(error => error.serverErrorCode.toUpperCase());
        if (codes.some(code => ["AUTHENTICATION_REQUIRED", "NOT_AUTHENTICATED", "INVALID_AUTH_TOKEN", "AUTHENTICATION_FAILED"].includes(code))) {
          throw new AppError("REAUTH_REQUIRED", "Apple rejected the same-list early reminder source read. Reconnect your Apple account.", 409);
        }
        if (codes.some(code => ["ACCESS_DENIED", "PERMISSION_FAILURE", "PERMISSION_DENIED"].includes(code))) {
          throw new AppError("FORBIDDEN", "Apple denied access to the same-list early reminder source records.", 403);
        }
        if (codes.some(code => ["THROTTLED", "REQUEST_RATE_LIMITED", "ZONE_BUSY"].includes(code))) throw new CloudKitRateLimitedError(null);
        throw new AppError("UNSUPPORTED_FEATURE", "Apple did not return a complete same-list early reminder source page.");
      }
      const candidates = page.records.filter((record): record is CloudKitRecord => "recordType" in record && record.recordType === "Reminder" && !record.deleted)
        .sort((left, right) => left.recordName.localeCompare(right.recordName));
      for (const candidate of candidates) {
        const scopedCandidate = bindToAuthenticatedReminderZone(candidate, trustedZone, owner);
        if (!scopedCandidate || scopedCandidate.recordName === graph.reminder.recordName || !scopedCandidate.recordChangeTag || scopedCandidate.recordChangeTag.length > 512 ||
          scopedCandidate.zoneID?.zoneName !== "Reminders" || scopedCandidate.zoneID.ownerRecordName !== owner ||
          scopedCandidate.zoneID.zoneType !== undefined && scopedCandidate.zoneID.zoneType !== "REGULAR_CUSTOM_ZONE") continue;
        const normalized = normalizeReminder(scopedCandidate, owner);
        if (normalized.listId !== listId || normalized.completed !== false || normalized.deleted !== false || normalized.parentReminderId !== null) continue;
        try { earlyReminderPayload(scopedCandidate); }
        catch (error) {
          if (error instanceof AppError && error.code === "UNSUPPORTED_FEATURE") continue;
          throw error;
        }
        let reread: CloudKitRecord | null;
        try { reread = writeLookupRecord(await client.lookup([scopedCandidate.recordName]), scopedCandidate.recordName, true); }
        catch (error) {
          if (error instanceof AppError && error.code === "CONFLICT") continue;
          throw error;
        }
        const scopedReread = reread && bindToAuthenticatedReminderZone(reread, trustedZone, owner);
        if (!scopedReread || !sameWitnessSnapshot(scopedCandidate, scopedReread)) continue;
        const rereadReminder = normalizeReminder(scopedReread, owner);
        if (rereadReminder.listId !== listId || rereadReminder.completed !== false || rereadReminder.deleted !== false || rereadReminder.parentReminderId !== null) continue;
        try { earlyReminderPayload(scopedReread); }
        catch (error) {
          if (error instanceof AppError && error.code === "UNSUPPORTED_FEATURE") continue;
          throw error;
        }
        try {
          const sourceGraph = await loadSchedulingGraph(scopedReread, owner, ids => client.lookupSchedulingRecords(ids));
          if (!sourceGraph.complete || sourceGraph.unsupportedReason) continue;
        } catch (error) {
          if (error instanceof AppError && ["UNSUPPORTED_FEATURE", "CONFLICT"].includes(error.code)) continue;
          throw error;
        }
        if (Date.now() - startedAt > EARLY_WITNESS_LIMITS.durationMs) throw new AppError("UNSUPPORTED_FEATURE", "The same-list early reminder source scan exceeded its time budget.");
        return await attachEarlyReminderWitness(graph, scopedReread);
      }
      if (page.continuation === null) break;
      if (seenContinuations.has(page.continuation)) throw new AppError("PROTOCOL_CHANGED", "Apple repeated a same-list early reminder continuation.");
      seenContinuations.add(page.continuation);
      continuation = page.continuation;
    }
    return { ...graph, unsupportedReason: "No current reminder in this list has a valid early reminder payload to provide private account metadata. Create an early reminder in Apple Reminders, then retry." };
  }
  async verifyAtomicEvidence(value: unknown) {
    this.requireLocalEvidence();
    const parsed = AtomicProtectionInput.safeParse(value);
    if (!parsed.success) throw new AppError("VALIDATION_ERROR", "Confirm synthetic version-guard writes with exact case, list, target, dependency type and generation.", 400);
    const input = parsed.data;
    return this.operation(input.expectedGeneration, "mutation-preparation", async (http, saved, repository, fence, stage) => {
      const client = new CloudKitRemindersClient(http.http, saved.session.connection);
      await this.authorizeLists(client, [input.listId]);
      const current = writeLookupRecord(await client.lookup([input.reminderId]), input.reminderId, false)!;
      const owner = client.remindersZoneOwner!;
      const lookup = async (ids: string[]) => {
        const found = await client.lookupSchedulingRecords(ids);
        return { ...found, records: found.records.map(record => ({ ...record, zoneID: record.zoneID ?? { zoneName: "Reminders", ownerRecordName: owner } })) };
      };
      const graph = await captureEvidenceGraph({ ...current, zoneID: current.zoneID ?? { zoneName: "Reminders", ownerRecordName: owner } },
        owner, input.listId, input.caseId, lookup);
      const result = await verifyAtomicProtection(graph, owner, input.dependencyType, client, async () => {
        stage.dispatch();
        await repository.assertWriteLease(fence);
      });
      stage.confirm();
      await repository.commitResume(fence, appleSuccess({ ...omitField(saved.session, "allOpenScan"), connection: { ...saved.session.connection, remindersZoneOwner: owner }, auth: http.snapshot() }), "READY");
      return { schemaVersion: 1, caseId: input.caseId, generation: fence.generation, source: "live-apple-api", ...result, linkedSchedulingEnabled: true };
    });
  }
  async captureEvidence(value: unknown) {
    this.requireLocalEvidence();
    const parsed = EvidenceInput.safeParse(value);
    if (!parsed.success) throw new AppError("VALIDATION_ERROR", "Provide this synthetic case UUID, exact list/reminder IDs and current generation.", 400);
    const input = parsed.data;
    return this.operation(input.expectedGeneration, "read-only", async (http, saved, repository, fence) => {
      const client = new CloudKitRemindersClient(http.http, saved.session.connection);
      await this.authorizeLists(client, [input.listId]);
      const current = writeLookupRecord(await client.lookup([input.reminderId]), input.reminderId, false)!;
      const owner = client.remindersZoneOwner!;
      const lookup = async (ids: string[]) => {
        const found = await client.lookupSchedulingRecords(ids);
        return { ...found, records: found.records.map(record => ({ ...record, zoneID: record.zoneID ?? { zoneName: "Reminders", ownerRecordName: owner } })) };
      };
      const graph = await captureEvidenceGraph({ ...current, zoneID: current.zoneID ?? { zoneName: "Reminders", ownerRecordName: owner } }, owner, input.listId, input.caseId, lookup);
      const snapshot = await sanitizeEvidence(graph, input.caseId, fence.generation);
      await repository.commitResume(fence, appleSuccess({ ...saved.session, connection: { ...saved.session.connection, remindersZoneOwner: owner }, auth: http.snapshot() }), "READY");
      return snapshot;
    });
  }
  async readReminderForMCP(expectedGeneration: number, listId: string, reminderId: string) {
    const parsed = ReminderTargetInput.omit({ recordChangeTag: true }).safeParse({ listId, reminderId });
    if (!parsed.success) throw new AppError("VALIDATION_ERROR", "Provide exact canonical list and reminder IDs.", 400);
    return this.operation(expectedGeneration, "read-only", async (http, saved, repository, fence) => {
      const client = new CloudKitRemindersClient(http.http, saved.session.connection);
      if (client.remindersZoneOwner === undefined && !(await client.listZones()).available) throw new AppError("PROTOCOL_CHANGED", "Apple did not return an available private Reminders zone.");
      const found = await client.lookup([listId, reminderId]);
      const list = writeLookupRecord(found, listId, false)!;
      if (list.recordType !== "List" || normalizeList(list, false).deleted || normalizeList(list, false).isGroup) throw new AppError("CONFLICT", "The requested list is unavailable.", 409);
      const item = found.records.find(record => record.recordName === reminderId);
      const current = item?.deleted === true ? null : writeLookupRecord(found, reminderId, true);
      let record = null;
      if (current) {
        const normalized = omitField(normalizeReminder(current, client.remindersZoneOwner), "raw");
        if (normalized.listId !== listId) throw new AppError("FORBIDDEN", "The reminder does not belong to the requested list.", 403);
        record = normalized;
      }
      await repository.commitResume(fence, appleSuccess({ ...saved.session, connection: { ...saved.session.connection, remindersZoneOwner: client.remindersZoneOwner }, auth: http.snapshot() }), "READY");
      return { generation: fence.generation, record, missing: record === null };
    });
  }
  async prepareUpdate(value: unknown) {
    const parsed = PrepareUpdateInput.safeParse(value);
    if (!parsed.success) throw new AppError("VALIDATION_ERROR", "Provide an exact update request with its current generation and supported policy.", 400);
    const input = parsed.data;
    return this.operation(input.expectedGeneration, "read-only", async (http, saved, repository, fence) => {
      const client = new CloudKitRemindersClient(http.http, saved.session.connection);
      if (client.remindersZoneOwner === undefined && !(await client.listZones()).available) throw new AppError("PROTOCOL_CHANGED", "Apple did not return a private Reminders zone.");
      const found = await client.lookup([input.listId, input.reminderId]);
      const list = writeLookupRecord(found, input.listId, false)!;
      if (list.recordType !== "List" || normalizeList(list, false).deleted || normalizeList(list, false).isGroup) throw new AppError("CONFLICT", "The target list is unavailable.", 409);
      const current = writeLookupRecord(found, input.reminderId, false)!;
      let graph = await loadSchedulingGraph({ ...current, zoneID: current.zoneID ?? { zoneName: "Reminders", ownerRecordName: client.remindersZoneOwner! } }, client.remindersZoneOwner!, ids => client.lookupSchedulingRecords(ids));
      const request = UpdateReminderInput.parse({ listId: input.listId, reminderId: input.reminderId, recordChangeTag: input.recordChangeTag, changes: input.changes });
      graph = await this.hydrateEarlyReminderWitness(client, graph, request.changes);
      const plan = planReminderUpdate(graph, request, client.remindersZoneOwner!, Date.now());
      const expiresAt = Math.min(saved.session.login.expiresAt, Date.now() + 600_000);
      const token = plan.supported ? await createPreparation(this.env, preparationContext(this.owner, await accountScope(this.owner, saved.session.connection.dsid), input.expectedGeneration, input.reminderId), await fingerprint(request), graph.fingerprint, expiresAt) : null;
      await repository.commitResume(fence, appleSuccess({ ...saved.session, connection: { ...saved.session.connection, remindersZoneOwner: client.remindersZoneOwner }, auth: http.snapshot() }), "READY");
      const reminder = normalizeReminder(current, client.remindersZoneOwner);
      return { generation: input.expectedGeneration, supported: plan.supported, classification: plan.classification, before: plan.before, after: plan.after,
        linkedFeatures: { alarms: reminder.alarmIds?.length ?? 0, recurrenceRules: reminder.recurrenceRuleIds?.length ?? 0, graphComplete: graph.complete },
        unsupportedReason: plan.unsupportedReason, preparationToken: token, expiresAt: token ? expiresAt : null, operationCount: plan.operationCount,
        message: "Preparation is not user authorization. No reminder was modified. Supported scheduling recipes are validated against the exact current linked graph; unknown recipes are explicitly unsupported." };
    });
  }
  async validateJobLists(expectedGeneration: number, account: string, ids: string[]) {
    if (!ids.length || ids.length > 50) throw new AppError("UNSUPPORTED_FEATURE", "A job preview supports at most 50 distinct lists.");
    return this.operation(expectedGeneration, "read-only", async (http, saved, repository, fence) => {
      if (await accountScope(this.owner, saved.session.connection.dsid) !== account) throw new AppError("CONFLICT", "The job belongs to a different Apple account.", 409);
      const client = new CloudKitRemindersClient(http.http, saved.session.connection);
      if (client.remindersZoneOwner === undefined && !(await client.listZones()).available) throw new AppError("PROTOCOL_CHANGED", "Apple did not return a private Reminders zone.");
      const found = await client.lookup(ids);
      for (const id of ids) {
        const list = writeLookupRecord(found, id, false)!;
        if (list.recordType !== "List" || normalizeList(list, false).deleted || normalizeList(list, false).isGroup) throw new AppError("CONFLICT", "A manifest list is unavailable.", 409);
      }
      await repository.commitResume(fence, appleSuccess({ ...saved.session, connection: { ...saved.session.connection, remindersZoneOwner: client.remindersZoneOwner }, auth: http.snapshot() }), "READY");
    });
  }
  async observeJobCreate(expectedGeneration: number, account: string, input: z.infer<typeof CreateReminderInput>) {
    return this.operation(expectedGeneration, "read-only", async (http, saved, repository, fence) => {
      if (await accountScope(this.owner, saved.session.connection.dsid) !== account) throw new AppError("CONFLICT", "The job belongs to a different Apple account.", 409);
      const client = new CloudKitRemindersClient(http.http, saved.session.connection);
      if (client.remindersZoneOwner === undefined && !(await client.listZones()).available) throw new AppError("PROTOCOL_CHANGED", "Apple did not return a private Reminders zone.");
      const id = `Reminder/${input.idempotencyKey.toUpperCase()}`, found = await client.lookup([input.listId, id]);
      const list = writeLookupRecord(found, input.listId, false)!;
      if (list.recordType !== "List" || normalizeList(list, false).deleted || normalizeList(list, false).isGroup) throw new AppError("CONFLICT", "The target list is unavailable.", 409);
      const current = writeLookupRecord(found, id, true);
      const desiredStateObserved = current !== null && matchesCreatedReminder(input, current, client.remindersZoneOwner!);
      await repository.commitResume(fence, appleSuccess({ ...saved.session, auth: http.snapshot() }), "READY");
      return { desiredStateObserved, missing: current === null };
    });
  }
  async observeJobDelete(expectedGeneration: number, account: string, input: z.infer<typeof ReminderTargetInput>) {
    return this.operation(expectedGeneration, "read-only", async (http, saved, repository, fence) => {
      if (await accountScope(this.owner, saved.session.connection.dsid) !== account) throw new AppError("CONFLICT", "The job belongs to a different Apple account.", 409);
      const client = new CloudKitRemindersClient(http.http, saved.session.connection);
      if (client.remindersZoneOwner === undefined && !(await client.listZones()).available) throw new AppError("PROTOCOL_CHANGED", "Apple did not return a private Reminders zone.");
      const owner = client.remindersZoneOwner!, found = await client.lookup([input.listId, input.reminderId]);
      const list = writeLookupRecord(found, input.listId, false)!;
      if (list.recordType !== "List" || normalizeList(list, false).deleted || normalizeList(list, false).isGroup) throw new AppError("CONFLICT", "The target list is unavailable.", 409);
      let deleted: boolean;
      if (found.records.some(record => record.recordName === input.reminderId && record.deleted)) deleted = true;
      else {
        const current = writeLookupRecord(found, input.reminderId, true);
        if (current) assertOwnedReminder(current, owner);
        if (current && normalizeReminder(current, owner).listId !== input.listId) throw new AppError("CONFLICT", "The reminder is no longer in the approved list.", 409);
        deleted = current === null || normalizeReminder(current, owner).deleted === true;
      }
      const children = (await listChildren(client, owner, input.listId)).get(input.reminderId) ?? [];
      await repository.commitResume(fence, appleSuccess({ ...saved.session, auth: http.snapshot() }), "READY");
      return { deleted, remainingChildren: children.length };
    });
  }
  /** Read-only preview checks: exact current version, deletable shape and no current subtasks. */
  async preflightJobDeletes(expectedGeneration: number, account: string, inputs: z.infer<typeof ReminderTargetInput>[]) {
    const lists = [...new Set(inputs.map(input => input.listId))];
    if (!inputs.length || lists.length > 50) throw new AppError("UNSUPPORTED_FEATURE", "A job preview supports at most 50 distinct lists.");
    return this.operation(expectedGeneration, "read-only", async (http, saved, repository, fence) => {
      if (await accountScope(this.owner, saved.session.connection.dsid) !== account) throw new AppError("CONFLICT", "The job belongs to a different Apple account.", 409);
      const client = new CloudKitRemindersClient(http.http, saved.session.connection);
      if (client.remindersZoneOwner === undefined && !(await client.listZones()).available) throw new AppError("PROTOCOL_CHANGED", "Apple did not return a private Reminders zone.");
      const owner = client.remindersZoneOwner!, foundLists = await client.lookup(lists);
      for (const id of lists) {
        const list = writeLookupRecord(foundLists, id, false)!;
        if (list.recordType !== "List" || normalizeList(list, false).deleted || normalizeList(list, false).isGroup) throw new AppError("CONFLICT", "A manifest list is unavailable.", 409);
      }
      const results: (AppError | null)[] = inputs.map(() => null), seen = new Set<string>();
      const targets = [...new Set(inputs.map(input => input.reminderId))];
      const records = new Map<string, CloudKitRecord | null>();
      for (let start = 0; start < targets.length; start += 200) {
        const batch = targets.slice(start, start + 200), found = await client.lookup(batch);
        for (const id of batch) {
          try { records.set(id, found.records.some(record => record.recordName === id && record.deleted) ? null : writeLookupRecord(found, id, true)); }
          catch (error) {
            if (!(error instanceof AppError) || error.code !== "CONFLICT") throw error;
            records.set(id, null);
          }
        }
      }
      const now = Date.now();
      inputs.forEach((input, index) => {
        if (seen.has(input.reminderId)) { results[index] = new AppError("VALIDATION_ERROR", "This reminder already appears earlier in the manifest.", 400); return; }
        seen.add(input.reminderId);
        const current = records.get(input.reminderId);
        if (!current) { results[index] = new AppError("CONFLICT", "The reminder no longer exists or is already deleted.", 409); return; }
        try { buildLifecycleReminder("delete", input, current, owner, now); }
        catch (error) {
          if (!(error instanceof AppError)) throw error;
          results[index] = error;
        }
      });
      for (const listId of lists) {
        if (!inputs.some((input, index) => input.listId === listId && results[index] === null)) continue;
        const children = await listChildren(client, owner, listId);
        inputs.forEach((input, index) => {
          if (input.listId === listId && results[index] === null && children.has(input.reminderId)) results[index] = new AppError("UNSUPPORTED_FEATURE", HAS_SUBTASKS_MESSAGE);
        });
      }
      await repository.commitResume(fence, appleSuccess({ ...saved.session, connection: { ...saved.session.connection, remindersZoneOwner: owner }, auth: http.snapshot() }), "READY");
      return results;
    });
  }
  async mutate(value: unknown, hooks?: MutationHooks) {
    // Login availability precedes parsing, storage access and Apple requests.
    requireAppleEnabled(this.env);
    const parsed = ReminderMutation.safeParse(value);
    if (!parsed.success) throw new AppError("VALIDATION_ERROR", "Provide a bounded reminder mutation request with the current session generation.", 400);
    const input = parsed.data;
    if (input.action === "create_subtask" || input.action === "set_parent") {
      if (hooks) throw new AppError("UNSUPPORTED_FEATURE", "Subtask relationship mutations are not supported in bulk jobs.");
      return this.mutateSubtask(input);
    }
    const targetId = input.action === "create" ? `Reminder/${input.idempotencyKey.toUpperCase()}` : input.reminderId;
    let applied = false;
    try {
      return await this.operation(input.expectedGeneration, "mutation-preparation", async (http, saved, repository, fence, stage) => {
        if (hooks && await accountScope(this.owner, saved.session.connection.dsid) !== hooks.expectedAccount) throw new AppError("CONFLICT", "The job belongs to a different Apple account.", 409);
        const client = new CloudKitRemindersClient(http.http, saved.session.connection);
        let connection = saved.session.connection;
        if (client.remindersZoneOwner === undefined) {
          const zone = await client.listZones();
          if (!zone.available) throw new AppError("PROTOCOL_CHANGED", "Apple did not return an available private Reminders zone.");
          connection = { ...connection, remindersZoneOwner: client.remindersZoneOwner };
        }
        const owner = client.remindersZoneOwner!;
        // One exact lookup proves the list and target in this authenticated
        // private zone; a stale saved catalogue is never sufficient for a write.
        const found = await client.lookup([input.listId, targetId]);
        const list = writeLookupRecord(found, input.listId, false)!;
        if (list.recordType !== "List" || list.deleted || normalizeList(list, false).deleted === true || normalizeList(list, false).isGroup === true) throw new AppError("CONFLICT", "The target list is deleted or is a list group.", 409);
        const current = writeLookupRecord(found, targetId, input.action === "create");
        let write: CloudKitWriteRecord;
        let confirmed: CloudKitRecord;
        let replayed = false;
        const dispatch = async () => {
          stage.dispatch();
          if (hooks) await hooks.beforeDispatch(write);
          await repository.assertWriteLease(fence);
          await hooks?.assertDispatch();
        };
        if (input.action === "create") {
          const create = omitField(omitField(input, "action"), "expectedGeneration");
          write = buildCreateReminder(create);
          if (current) {
            if (!matchesCreatedReminder(create, current, owner) || !current.recordChangeTag) throw new AppError("CONFLICT", "The create ID already exists with different content or state. Read that reminder; do not reuse this key for another item.", 409);
            confirmed = current; replayed = true;
          } else {
            confirmed = await client.modifyReminder("create", write, dispatch);
            stage.confirm();
            applied = true;
            if (!matchesCreatedReminder(create, confirmed, owner)) throw new WriteOutcomeUnknownError(targetId, input.idempotencyKey);
            verifyWriteFields(write, confirmed, confirmed, owner, input.listId);
          }
        } else {
          const update = omitField(omitField(input, "action"), "expectedGeneration");
          let dependencies: SchedulingWrite[] = [], dependencyRecords: CloudKitRecord[] = [], guards: CloudKitRecord[] = [];
          if (input.action === "update") {
            write = buildReminderFieldUpdate({ listId: input.listId, reminderId: input.reminderId, recordChangeTag: input.recordChangeTag, changes: input.changes }, current!, owner);
            if (input.changes.locationAlarm !== undefined || input.changes.earlyReminder !== undefined || input.changes.recurrence !== undefined || ["DueDate", "TimeZone", "AllDay"].some(key => Object.hasOwn(write.fields, key))) {
              let graph = await loadSchedulingGraph({ ...current!, zoneID: current!.zoneID ?? { zoneName: "Reminders", ownerRecordName: owner } },
                owner, ids => client.lookupSchedulingRecords(ids));
              const request = UpdateReminderInput.parse({ listId: input.listId, reminderId: input.reminderId, recordChangeTag: input.recordChangeTag, changes: input.changes });
              graph = await this.hydrateEarlyReminderWitness(client, graph, request.changes);
              const plan = planReminderUpdate(graph, request, owner, Date.now());
              if (!plan.supported) throw new AppError("UNSUPPORTED_FEATURE", plan.unsupportedReason);
              if (input.preparationToken) await checkPreparation(this.env, preparationContext(this.owner, await accountScope(this.owner, saved.session.connection.dsid), input.expectedGeneration, input.reminderId),
                input.preparationToken, await fingerprint(request), graph.fingerprint);
              write = plan.write;
              dependencies = plan.dependencies; dependencyRecords = graph.records; guards = plan.guards;
            } else if (input.preparationToken) {
              const graph = await loadSchedulingGraph({ ...current!, zoneID: current!.zoneID ?? { zoneName: "Reminders", ownerRecordName: owner } }, owner, ids => client.lookupSchedulingRecords(ids));
              await checkPreparation(this.env, preparationContext(this.owner, await accountScope(this.owner, saved.session.connection.dsid), input.expectedGeneration, input.reminderId), input.preparationToken,
                await fingerprint(UpdateReminderInput.parse({ listId: input.listId, reminderId: input.reminderId, recordChangeTag: input.recordChangeTag, changes: input.changes })), graph.fingerprint);
            }
          } else {
            write = buildLifecycleReminder(input.action, update, current!, owner);
            await requireNoChildren(client, owner, input.listId, targetId);
          }
          const confirmations = dependencies.length || guards.length || ["AlarmIDs", "RecurrenceRuleIDs", "DueDateDeltaAlertsData"].some(key => Object.hasOwn(write.fields, key)) ? await client.modifyScheduling(write, dependencies, dispatch, guards) :
            [await client.modifyReminder("update", write, dispatch)];
          if (!("recordType" in confirmations[0])) throw new WriteOutcomeUnknownError(targetId);
          confirmed = confirmations[0];
          stage.confirm();
          applied = true;
          verifyWriteFields(write, confirmed, current!, owner, input.listId);
          for (const dependency of dependencies) {
            verifySchedulingWrite(dependency, dependencyRecords.find(record => record.recordName === dependency.recordName)!,
              confirmations.find(record => record.recordName === dependency.recordName)!, owner);
          }
        }
        const record = omitField(normalizeReminder(confirmed, owner), "raw");
        const session = omitField(saved.session, "allOpenScan");
        // A confirmation and cookie save share the existing owner/generation
        // fence. A lost fence after dispatch reports uncertainty, not success.
        await repository.commitResume(fence, appleSuccess({ ...session, connection, auth: http.snapshot() }), "READY");
        return { generation: fence.generation, operation: input.action, replayed, record, writesEnabled: true, ...(input.action === "create" ? { idempotencyKey: input.idempotencyKey } : {}) };
      });
    } catch (error) {
      if (applied || error instanceof WriteOutcomeUnknownError) throw new WriteOutcomeUnknownError(targetId, input.action === "create" ? input.idempotencyKey : undefined);
      throw error;
    }
  }
  private async mutateSubtask(input: Extract<z.infer<typeof ReminderMutation>, { action: "create_subtask" | "set_parent" }>) {
    const targetId = input.action === "create_subtask" ? `Reminder/${input.idempotencyKey.toUpperCase()}` : input.reminderId;
    let applied = false;
    try {
      return await this.operation(input.expectedGeneration, "mutation-preparation", async (http, saved, repository, fence, stage) => {
        const client = new CloudKitRemindersClient(http.http, saved.session.connection);
        await this.authorizeLists(client, [input.listId]);
        const current = writeLookupRecord(await client.lookup([targetId]), targetId, input.action === "create_subtask");
        const owner = client.remindersZoneOwner!;
        let write: CloudKitWriteRecord, replayed = false, confirmed: CloudKitRecord;
        if (input.action === "create_subtask") {
          const create = CreateSubtaskInput.parse(omitField(omitField(input, "action"), "expectedGeneration"));
          write = buildCreateSubtask(create);
          if (current) {
            if (!matchesCreatedReminder(omitField(create, "parentReminder"), current, owner, create.parentReminder.reminderId) || !current.recordChangeTag) {
              throw new AppError("CONFLICT", "The subtask create ID already exists with different content or parent. Retain its ID and reconcile; do not allocate a replacement.", 409);
            }
            replayed = true; confirmed = current;
          } else {
            const parents = await subtaskParents(client, owner, input.listId, null, input.parentReminder);
            confirmed = (await client.modifyRecords([{ operationType: "create", record: write }], async () => {
              stage.dispatch(); await repository.assertWriteLease(fence);
            }, parents))[0];
            stage.confirm(); applied = true;
            if (!matchesCreatedReminder(omitField(create, "parentReminder"), confirmed, owner, create.parentReminder.reminderId)) throw new WriteOutcomeUnknownError(targetId, input.idempotencyKey);
            verifyWriteFields(write, confirmed, confirmed, owner, input.listId);
          }
        } else {
          write = buildSetReminderParent(SetReminderParentInput.parse(omitField(omitField(input, "action"), "expectedGeneration")), current!, owner);
          const parents = await subtaskParents(client, owner, input.listId, current, input.parentReminder);
          confirmed = (await client.modifyRecords([{ operationType: "update", record: write }], async () => {
            stage.dispatch(); await repository.assertWriteLease(fence);
          }, parents))[0];
          stage.confirm(); applied = true;
          verifyWriteFields(write, confirmed, current!, owner, input.listId);
        }
        await repository.commitResume(fence, appleSuccess({ ...omitField(saved.session, "allOpenScan"),
          connection: { ...saved.session.connection, remindersZoneOwner: owner }, auth: http.snapshot() }), "READY");
        return { generation: fence.generation, operation: input.action, replayed, record: omitField(normalizeReminder(confirmed, owner), "raw"), writesEnabled: true,
          ...(input.action === "create_subtask" ? { idempotencyKey: input.idempotencyKey } : {}) };
      });
    } catch (error) {
      if (applied || error instanceof WriteOutcomeUnknownError) throw new WriteOutcomeUnknownError(targetId, input.action === "create_subtask" ? input.idempotencyKey : undefined);
      throw error;
    }
  }
  async readListForMutation(expectedGeneration: number, listId: string) {
    const valid = RenameListInput.shape.listId.safeParse(listId);
    if (!valid.success) throw new AppError("VALIDATION_ERROR", "Supply an exact listId.", 400);
    return this.operation(expectedGeneration, "read-only", async (http, saved, repository, fence) => {
      const client = new CloudKitRemindersClient(http.http, saved.session.connection);
      if (client.remindersZoneOwner === undefined && !(await client.listZones()).available)
        throw new AppError("PROTOCOL_CHANGED", "No owned Reminders zone is available.");
      const found = await client.lookup([listId]);
      const current = ownedListRecord(writeLookupRecord(found, listId, false)!, client.remindersZoneOwner!);
      const list = normalizeList(current, false);
      if (list.deleted !== true) requireMutableList(current, client.remindersZoneOwner!);
      else if (list.isGroup !== false || !list.title || !current.recordChangeTag)
        throw new AppError("UNSUPPORTED_FEATURE", "The retired list identity could not be verified.");
      await repository.commitResume(fence, appleSuccess({ ...saved.session,
        connection: { ...saved.session.connection, remindersZoneOwner: client.remindersZoneOwner },
        auth: http.snapshot() }), "READY");
      return { generation: fence.generation, list: {
        id: list.id, title: list.title, color: list.color, count: list.count,
        isGroup: list.isGroup, deleted: list.deleted, recordChangeTag: current.recordChangeTag!,
      } };
    });
  }

  async mutateList(action: ListOperation, value: unknown) {
    requireAppleEnabled(this.env);
    const generation = z.number().int().nonnegative().safe();
    const common = { expectedGeneration: generation };
    const schema = action === "create" ? CreateListInput.extend(common).strict() :
      action === "rename" ? RenameListInput.extend(common).strict() : DeleteListInput.extend(common).strict();
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new AppError("VALIDATION_ERROR", "Provide a valid list operation with current session generation.", 400);
    const input = parsed.data as Record<string, unknown>;
    const targetId = action === "create" ? `List/${String(input.idempotencyKey).toUpperCase()}` : String(input.listId);
    let applied = false;
    try {
      return await this.operation(Number(input.expectedGeneration), "mutation-preparation", async (http, saved, repository, fence, stage) => {
        const client = new CloudKitRemindersClient(http.http, saved.session.connection);
        if (client.remindersZoneOwner === undefined && !(await client.listZones()).available)
          throw new AppError("PROTOCOL_CHANGED", "No owned Reminders zone is available.");
        const owner = client.remindersZoneOwner!;
        const found = await client.lookup([targetId]);
        const observed = writeLookupRecord(found, targetId, action === "create");
        const current = observed ? ownedListRecord(observed, owner) : null;
        let replayed = false;
        let confirmed: CloudKitRecord;
        if (action === "create") {
          const create = CreateListInput.parse(omitField(input, "expectedGeneration"));
          if (current) {
            const existing = requireMutableList(current, owner);
            if (existing.title !== create.name) throw new AppError("CONFLICT", "This list creation key already belongs to a different list.", 409);
            confirmed = current;
            replayed = true;
          } else {
            const write = buildCreateList(create);
            confirmed = await client.modifyList("create", write, async () => {
              stage.dispatch(); await repository.assertWriteLease(fence);
            });
            stage.confirm(); applied = true;
          }
        } else {
          if (!current) throw new AppError("CONFLICT", "The requested list was not found.", 409);
          const write = action === "rename" ? buildRenameList(RenameListInput.parse(omitField(input, "expectedGeneration")), current, owner) :
            buildDeleteList(DeleteListInput.parse(omitField(input, "expectedGeneration")), current, owner);
          if (action === "delete") {
            // A list count alone is insufficient: query every page including completed reminders.
            requireEmptyListMetadata(current);
            let continuation: string | null = null;
            const seen = new Set<string>();
            for (let pageIndex = 0; pageIndex < 25; pageIndex++) {
              const page = await client.queryRemindersPage({ listId: targetId, includeCompleted: true, limit: 200, continuation });
              if (page.recordErrors.length) throw new AppError("UNSUPPORTED_FEATURE", "Could not verify that the list is empty.");
              if (page.records.some(record => "recordType" in record && record.recordType === "Reminder" && !record.deleted))
                throw new AppError("UNSUPPORTED_FEATURE", "Only completely empty lists can be deleted.");
              if (page.paginationComplete && page.continuation === null) { continuation = null; break; }
              if (!page.continuation || seen.has(page.continuation)) throw new AppError("UNSUPPORTED_FEATURE", "List contents could not be checked completely.");
              continuation = page.continuation; seen.add(continuation);
            }
            if (continuation) throw new AppError("UNSUPPORTED_FEATURE", "The list needs more than 25 pages to check.");
            // Check for concurrent list metadata changes directly before dispatch.
            const latest = ownedListRecord(writeLookupRecord(await client.lookup([targetId]), targetId, false)!, owner);
            requireMutableList(latest, owner, String(input.recordChangeTag));
            requireEmptyListMetadata(latest);
          }
          confirmed = await client.modifyList("update", write, async () => {
            stage.dispatch(); await repository.assertWriteLease(fence);
          });
          stage.confirm(); applied = true;
        }
        const result = normalizeList(confirmed, false);
        if (action === "delete" ? result.deleted !== true : result.title !== String(input.name) || result.deleted === true)
          throw new WriteOutcomeUnknownError(targetId, action === "create" ? String(input.idempotencyKey) : undefined);
        await repository.commitResume(fence, appleSuccess({
          ...omitField(saved.session, "allOpenScan"),
          savedLists: (saved.session.savedLists ?? []).filter(list => list.id !== targetId),
          directListSnapshot: undefined,
          connection: { ...saved.session.connection, remindersZoneOwner: owner },
          auth: http.snapshot(),
        }), "READY");
        return { generation: fence.generation, operation: action, replayed, list: {
          id: result.id, title: result.title, color: result.color, count: result.count,
          isGroup: result.isGroup, deleted: result.deleted, recordChangeTag: confirmed.recordChangeTag ?? null,
        }, writesEnabled: true, ...(action === "create" ? { idempotencyKey: input.idempotencyKey } : {}) };
      });
    } catch (error) {
      if (applied || error instanceof WriteOutcomeUnknownError)
        throw new WriteOutcomeUnknownError(targetId, action === "create" ? String(input.idempotencyKey) : undefined);
      throw error;
    }
  }

  private async operation<T>(expectedGeneration: number, mode: OperationMode, run: (http: AppleAuthHTTP, saved: Awaited<ReturnType<AppleSessionRepository["load"]>>, repository: AppleSessionRepository, fence: ResumeFence, stage: OperationStage) => Promise<T>, budget = appleRequestBudget()) {
    requireAppleEnabled(this.env);
    const repository = new AppleSessionRepository(this.env, this.owner);
    const renewal = new AppleSessionRenewal(this.env, repository);
    for (let attempt = 0; attempt < 2; attempt++) {
      const saved = mode === "snapshot" ? await repository.load() : await renewal.ensure(expectedGeneration, budget);
      if (saved.fence.generation !== expectedGeneration) throw new AppError("CONFLICT", "The Apple connection changed before this operation.", 409);
      if (budget.deadline <= Date.now()) throw new AppError("UPSTREAM_UNAVAILABLE", "The Apple request deadline was reached.", 503, true);
      if (mode === "pcs" && Date.now() < saved.session.pcs.nextAttemptAt) throw new AppError("RATE_LIMITED", "Wait until the displayed retry time before checking approval.", 429, true);
      const fence = mode === "pcs" ? await repository.claimResume(expectedGeneration, saved.fence.version) : await repository.claimRead(expectedGeneration, saved.fence.version);
      const http = AppleAuthHTTP.restore(saved.session.auth, fetch, AbortSignal.timeout(budget.deadline - Date.now()));
      const stage: OperationStage = {
        phase: mode,
        dispatch() {
          if (budget.deadline - Date.now() < 9000) throw new AppError("CONFLICT", "The complete request budget is too short for a write. No mutation was dispatched.", 409, true);
          this.phase = "mutation-dispatch";
        },
        confirm() { this.phase = "mutation-confirmation"; },
      };
      let recover = false;
      try { return await run(http, saved, repository, fence, stage); }
      catch (error) {
        const dispatched = stage.phase === "mutation-dispatch" || stage.phase === "mutation-confirmation";
        if (error instanceof AppError && error.code === "AUTH_EXPIRED") await repository.invalidate(fence, "local-retention-expired");
        if (!dispatched && error instanceof AppError && error.code === "REAUTH_REQUIRED" && appleGates(this.env).renewalEnabled && attempt === 0 && !budget.recoveryUsed) {
          recover = true;
        } else if (!dispatched && error instanceof AppError && error.code === "DEVICE_APPROVAL_PENDING") {
          await repository.releaseResume(fence);
          await renewal.requireDataApproval(expectedGeneration, budget);
        }
        if (!recover && !dispatched && error instanceof AppError && error.code === "REAUTH_REQUIRED" && appleGates(this.env).renewalEnabled) {
          const metadata = saved.session.renewal ?? renewalCheckpoint();
          const failures = Math.min(8, metadata.failures + 1);
          await repository.commitResume(fence, { ...saved.session, auth: { ...saved.session.auth, cookies: http.snapshot().cookies },
            renewal: { ...metadata, failures, requiredAction: "retry", lastErrorCode: "UPSTREAM_UNAVAILABLE",
              nextRetryAt: Date.now() + Math.min(3_600_000, 30_000 * 2 ** (failures - 1)) } }, saved.state, saved.action ?? undefined);
        }
        if (!recover) throw error;
        await repository.releaseResume(fence);
        await renewal.ensure(expectedGeneration, budget, true);
        // Cursor callbacks may have acknowledged progress. Never replay them,
        // even if authentication has now recovered.
        if (mode === "cursor-progress" || mode === "pcs") throw new AppError("RESTART_REQUIRED", "Apple authentication recovered. Resume using the current continuation or approval state; this callback was not replayed.", 409);
      } finally { await repository.releaseResume(fence); }
    }
    throw new AppError("REAUTH_REQUIRED", "Apple rejected the operation after one recovery cycle. No automatic retry remains.", 409);
  }
  async resume(expectedGeneration: number, restartApproval = false) {
    await this.operation(expectedGeneration, "pcs", async (http, saved, repository, fence) => {
      if (saved.session.pcs.expiresAt <= Date.now() && !restartApproval) throw new AppError("RESTART_REQUIRED", "This Reminders approval attempt expired. Use Check Apple approval to start a new bounded attempt; the Apple account connection is preserved.", 409);
      const checkpoint = saved.session.pcs.expiresAt <= Date.now() ? freshPcsCheckpoint() : saved.session.pcs;
      const result = await advancePcs(http, saved.session.connection.dsid, checkpoint);
      await repository.commitResume(fence, appleSuccess({ ...saved.session, auth: http.snapshot(), pcs: result.checkpoint,
        renewal: { ...(saved.session.renewal ?? renewalCheckpoint()), requiredAction: result.state === "READY" ? null : "approve-reminders", lastErrorCode: null } }), result.state, result.state === "DEVICE_APPROVAL_PENDING" ? result.action : undefined);
    });
    return this.status();
  }
  private async fetchDirectLists(http: AppleAuthHTTP, session: AppleSession) {
    const client = new CloudKitRemindersClient(http.http, session.connection);
    const found = await client.queryAllLists();
    if (!found.complete) throw new AppError("UNSUPPORTED_FEATURE", "Direct list discovery did not finish within its safe limits or returned record errors. The previous snapshot is preserved. Retry a refresh; if the error persists, direct discovery is not supported for this account or exceeds the current limits.", 409);
    const now = Date.now();
    const records = found.lists.map(list => omitField(list, "raw"));
    const savedLists = mergeSavedLists([], records, now);
    return { records, pagesRead: found.pagesRead, session: { ...session,
      connection: { ...session.connection, remindersZoneOwner: client.remindersZoneOwner },
      savedLists, directListSnapshot: { updatedAt: now },
      auth: http.snapshot() } };
  }
  async getCurrentLists(expectedGeneration: number): Promise<MCPReadResult> {
    return this.operation(expectedGeneration, "read-only", async (http, saved, repository, fence) => {
      const current = await this.fetchDirectLists(http, saved.session);
      await repository.commitResume(fence, appleSuccess(current.session), "READY");
      return { result: { records: current.records, recordErrors: [], complete: true, paginationComplete: true,
        continuation: null, pendingReason: null, source: "direct-cloudkit-query", freshness: { mode: "live", retrievedAt: current.session.directListSnapshot.updatedAt },
        listDiscovery: { strategy: "direct", experimental: true, retrievedAt: current.session.directListSnapshot.updatedAt }, pagesRead: current.pagesRead },
        generation: fence.generation, liveReadValidated: false, writesEnabled: appleGates(this.env).enabled };
    });
  }
  async readForMCP(input: z.infer<typeof ControlledRead>): Promise<MCPReadResult> {
    if (input.action !== "saved-lists" && input.action !== "reminders") throw new AppError("VALIDATION_ERROR", "This MCP read supports only lists or current reminders.", 400);
    if (input.action === "reminders") {
      const read = await this.controlledRead(input);
      return { ...read, result: { ...read.result as MCPReadPage, freshness: { mode: "live" }, source: "direct-known-list-query" } };
    }
    return this.getCurrentLists(input.expectedGeneration);
  }
  private async startAllOpenScan(expectedGeneration: number, continuation: string | null, budget: AppleRequestBudget) {
    if (continuation) {
      const repository = new AppleSessionRepository(this.env, this.owner);
      const saved = await repository.load();
      if (saved.fence.generation !== expectedGeneration || saved.session.allOpenScan?.token !== continuation) throw new AppError("CONFLICT", "The all-open continuation was replaced or already used.", 409);
      if (saved.session.allOpenScan.expiresAt <= Date.now()) {
        const fence = await repository.claimRead(expectedGeneration, saved.fence.version);
        try { await repository.commitResume(fence, omitField(saved.session, "allOpenScan"), "READY"); }
        finally { await repository.releaseResume(fence); }
        throw new AppError("RESTART_REQUIRED", "The ten-minute all-open read expired. Start a new all-open read; the Apple account is preserved.", 409);
      }
    }
    return this.operation(expectedGeneration, "cursor-progress", async (http, saved, repository, fence) => {
      let session = saved.session;
      if (!continuation) session = appleSuccess((await this.fetchDirectLists(http, session)).session);
      let scan: AllOpenScan;
      if (continuation) {
        if (!session.allOpenScan || session.allOpenScan.token !== continuation) throw new AppError("CONFLICT", "The all-open continuation was replaced or already used. Restart the all-open read.", 409);
        if (session.allOpenScan.expiresAt <= Date.now()) {
          await repository.commitResume(fence, { ...session, allOpenScan: undefined }, "READY");
          throw new AppError("RESTART_REQUIRED", "The ten-minute all-open read expired. Start a new all-open read.", 409);
        }
        scan = { ...session.allOpenScan, token: crypto.randomUUID() };
      } else {
        const lists = session.savedLists ?? [];
        scan = { source: "direct-cloudkit-query", lists: lists.filter(list => !list.deleted && !list.isGroup), token: crypto.randomUUID(), expiresAt: Math.min(Date.now() + 600_000, session.login.expiresAt), listIds: lists.filter(list => !list.deleted && !list.isGroup).map(list => list.id), index: 0, cursor: null, seen: [], listPages: 0, totalPages: 0, caughtUpAt: session.directListSnapshot!.updatedAt };
      }
      // Rotation is fenced before the first query, making the supplied token
      // single-use even when another instance resumes concurrently.
      await repository.commitResume(fence, { ...session, allOpenScan: scan.listIds.length ? scan : undefined }, "READY");
      return { scan, lists: scan.lists };
    }, budget);
  }
  private async allOpenPage(expectedGeneration: number, token: string, remainingBytes: number, remainingRecords: number, budget: AppleRequestBudget) {
    return this.operation(expectedGeneration, "cursor-progress", async (http, saved, repository, fence) => {
      const session = saved.session; const scan = session.allOpenScan;
      if (!scan || scan.token !== token) throw new AppError("CONFLICT", "The all-open read changed. Restart with the latest continuation.", 409);
      if (scan.expiresAt <= Date.now()) {
        await repository.commitResume(fence, { ...session, allOpenScan: undefined }, "READY");
        throw new AppError("RESTART_REQUIRED", "The ten-minute all-open read expired. Start a new all-open read.", 409);
      }
      if (scan.totalPages >= 10000 || scan.listPages >= 1000) throw new AppError("UNSUPPORTED_FEATURE", "The all-open read reached its safe pagination limit. Start a new read.", 409);
      const next: AllOpenScan = { ...scan, token: crypto.randomUUID() };
      const listId = scan.listIds[scan.index];
      let records: Record<string, unknown>[] = [];
      let recordErrors: { id: string | null; code: string }[] = [];
      let reason: string | null = null;
      let queried = false;
      {
        const client = new CloudKitRemindersClient(http.http, session.connection);
        const page = await client.queryRemindersPage({ listId, includeCompleted: false, limit: 200, continuation: scan.cursor });
        queried = true;
        records = page.records.flatMap(record => {
          if (!("recordType" in record) || record.recordType !== "Reminder" || record.deleted) return [];
          const reminder = omitField(normalizeReminder(record, client.remindersZoneOwner), "raw");
          return reminder.deleted || reminder.completed === true ? [] : [reminder];
        });
        if (records.length > 200) throw new AppError("PROTOCOL_CHANGED", "Apple returned more reminders than the all-open page budget.");
        recordErrors = page.recordErrors.map(error => ({ id: error.recordName, code: error.serverErrorCode }));
        if (recordErrors.some(error => ["AUTHENTICATION_REQUIRED", "NOT_AUTHENTICATED", "INVALID_AUTH_TOKEN", "AUTHENTICATION_FAILED"].includes(error.code))) throw new AppError("REAUTH_REQUIRED", "Apple rejected the all-open reminder read. Reconnect your Apple account.", 409);
        if (recordErrors.length) records = [];
        const bytes = new TextEncoder().encode(JSON.stringify({ records, recordErrors })).length;
        if (bytes > 1_048_576 - 4096) throw new AppError("UNSUPPORTED_FEATURE", "One current reminder page exceeds the all-open response budget. Read individual lists instead.", 409);
        if (bytes > remainingBytes || records.length > remainingRecords) {
          // Do not acknowledge a page that cannot fit. The next invocation
          // re-queries this exact input cursor rather than skipping its records.
          records = []; recordErrors = []; reason = "response-limit";
        } else if (recordErrors.length) {
          reason = "record_errors";
        } else {
          next.totalPages++; next.listPages++;
          if (page.continuation !== null) {
            const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(page.continuation));
            const fingerprint = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
            if (scan.seen.includes(fingerprint)) throw new AppError("PROTOCOL_CHANGED", "Apple repeated an all-open reminder continuation. Start a new read.");
            next.cursor = page.continuation; next.seen = [...scan.seen, fingerprint];
          } else {
            next.index++; next.cursor = null; next.seen = []; next.listPages = 0;
          }
        }
      }
      const complete = next.index >= next.listIds.length;
      await repository.commitResume(fence, appleSuccess({ ...session, allOpenScan: complete ? undefined : next, auth: http.snapshot() }), "READY");
      return { scan: next, records, recordErrors, reason, queried };
    }, budget);
  }
  async readAllOpenForMCP(expectedGeneration: number, continuation?: string | null) {
    const token = continuation ?? null;
    if (token !== null && !z.string().uuid().safeParse(token).success) throw new AppError("VALIDATION_ERROR", "The all-open continuation is invalid.", 400);
    const budget = appleRequestBudget();
    const until = Date.now() + 20_000;
    const started = await this.startAllOpenScan(expectedGeneration, token, budget);
    let scan = started.scan;
    const records: Record<string, unknown>[] = [];
    const recordErrors: { id: string | null; code: string }[] = [];
    const errors: { code: string; retryable: boolean; retryAfterSeconds?: number }[] = [];
    let pagesRead = 0;
    let reason: string | null = null;
    const resultFor = () => {
      const complete = scan.index >= scan.listIds.length && recordErrors.length === 0 && errors.length === 0;
      return { records, lists: started.lists, recordErrors, errors, complete, paginationComplete: complete, continuation: complete ? null : scan.token,
        pendingReason: complete ? null : reason ?? (Date.now() >= until ? "deadline" : "page-budget"),
        progress: { listsTotal: scan.listIds.length, listsCompleted: scan.index, pagesRead, totalPages: scan.totalPages },
        source: "direct-cloudkit-query", freshness: { mode: "live", retrievedAt: scan.caughtUpAt }, scope: "all-open-reminders" };
    };
    let bytesUsed = new TextEncoder().encode(JSON.stringify(resultFor())).length + 4096;
    if (bytesUsed > 1_048_576) throw new AppError("UNSUPPORTED_FEATURE", "The saved list summaries exceed the all-open response budget. Read individual lists instead.", 409);
    while (scan.index < scan.listIds.length && pagesRead < 20 && records.length < 5000 && Date.now() < until) {
      try {
        const page = await this.allOpenPage(expectedGeneration, scan.token, 1_048_576 - bytesUsed, 5000 - records.length, budget);
        scan = page.scan; if (page.queried) pagesRead++;
        records.push(...page.records); recordErrors.push(...page.recordErrors);
        bytesUsed += new TextEncoder().encode(JSON.stringify({ records: page.records, recordErrors: page.recordErrors })).length;
        if (page.reason) { reason = page.reason; break; }
      } catch (error) {
        if (error instanceof AppError && ["RATE_LIMITED", "UPSTREAM_UNAVAILABLE", "CONFLICT"].includes(error.code)) {
          // A failed query never acknowledges a page. Expose the rotated token
          // only after checking it is still the owner's current saved scan.
          const current = await new AppleSessionRepository(this.env, this.owner).load();
          if (current.fence.generation !== expectedGeneration || current.session.allOpenScan?.token !== scan.token || current.session.allOpenScan.expiresAt <= Date.now()) throw new AppError("CONFLICT", "The all-open scan changed during this request. Start a new all-open read.", 409);
          const retryAfterSeconds = error instanceof CloudKitRateLimitedError ? error.retryAfterSeconds : null;
          errors.push({ code: error.code, retryable: true, ...(retryAfterSeconds !== null && Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0 ? { retryAfterSeconds } : {}) }); reason = "read_error"; break;
        }
        throw error;
      }
    }
    return { result: resultFor(), generation: expectedGeneration, liveReadValidated: false, writesEnabled: appleGates(this.env).enabled };
  }
  private async authorizeLists(client: CloudKitRemindersClient, ids: string[]) {
    if (client.remindersZoneOwner === undefined && !(await client.listZones()).available) throw new AppError("PROTOCOL_CHANGED", "Apple did not return an available private Reminders zone.");
    const found = await client.lookup(ids, true);
    for (const error of found.recordErrors) {
      if (["AUTHENTICATION_REQUIRED", "NOT_AUTHENTICATED", "INVALID_AUTH_TOKEN", "AUTHENTICATION_FAILED"].includes(error.serverErrorCode.toUpperCase())) throw new AppError("REAUTH_REQUIRED", "Apple rejected the list lookup. Reconnect your Apple account.", 409);
      if (["ACCESS_DENIED", "PERMISSION_FAILURE", "PERMISSION_DENIED"].includes(error.serverErrorCode.toUpperCase())) throw new AppError("FORBIDDEN", "Apple denied access to the requested list.", 403);
      if (["THROTTLED", "REQUEST_RATE_LIMITED", "ZONE_BUSY"].includes(error.serverErrorCode.toUpperCase())) throw new CloudKitRateLimitedError(null);
      if (["UNKNOWN_ITEM", "NOT_FOUND"].includes(error.serverErrorCode.toUpperCase())) throw new AppError("FORBIDDEN", "The requested list is not accessible.", 403);
      throw new AppError("PROTOCOL_CHANGED", "Apple could not verify the requested list.");
    }
    if (!found.complete || found.records.length !== ids.length) throw new AppError("PROTOCOL_CHANGED", "Apple omitted a requested list authorization result.");
    for (const record of found.records) {
      if (!("recordType" in record) || record.recordType !== "List" || record.deleted) throw new AppError("FORBIDDEN", "The requested list is unavailable.", 403);
      const list = normalizeList(record, false);
      if (list.deleted || list.isGroup) throw new AppError("FORBIDDEN", "The requested list is unavailable or is a group.", 403);
    }
  }
  async read(input: z.infer<typeof ControlledRead>) {
    if (input.action === "current-lists") return this.getCurrentLists(input.expectedGeneration);
    return this.controlledRead(input);
  }
  private async controlledRead(input: z.infer<typeof ControlledRead>) {
    return this.operation(input.expectedGeneration, input.action === "saved-lists" ? "snapshot" : input.action === "reminders" && input.continuation ? "cursor-progress" : "read-only", async (http, saved, repository, fence) => {
      const client = new CloudKitRemindersClient(http.http, saved.session.connection);
      let result: unknown;
      let connection = saved.session.connection;
      let savedLists = saved.session.savedLists ?? [];
      if (input.action === "current-lists") throw new AppError("VALIDATION_ERROR", "Use current list discovery.", 400);
      if (input.action === "saved-lists") {
        result = { records: savedLists, recordErrors: [], complete: true, paginationComplete: true, continuation: null, pendingReason: null, scope: "saved-list-snapshot", auxiliaryRecordCounts: {}, auxiliaryDetailsIncluded: false, listDiscovery: { strategy: "direct", experimental: true, retrievedAt: saved.session.directListSnapshot?.updatedAt ?? null } };
      } else if (input.action === "discover") {
        const discovered = await client.listZones();
        if (client.remindersZoneOwner !== undefined) connection = { ...connection, remindersZoneOwner: client.remindersZoneOwner };
        // Do not expose unrelated private zone names or arbitrary Apple fields.
        result = { available: discovered.available, complete: discovered.complete, zoneDiagnostics: discovered.zones.map(zone => ({ category: zone.zoneID.zoneName === "Reminders" ? "primary-reminders" : zone.zoneID.zoneName.toLowerCase().includes("reminder") ? "other-reminders" : "other", type: zone.zoneID.zoneType ?? null, matchesPrimaryOwner: (zone.zoneID.ownerRecordName ?? "__defaultOwner__") === client.remindersZoneOwner, deleted: zone.deleted })), remindersZone: discovered.remindersZone ? { zoneID: { zoneName: discovered.remindersZone.zoneID.zoneName, ...(discovered.remindersZone.zoneID.zoneType ? { zoneType: discovered.remindersZone.zoneID.zoneType } : {}) }, deleted: discovered.remindersZone.deleted } : null };
      } else if (input.action === "probe-shared-lists") {
        result = await client.probeSharedLists(input.listIds);
      } else if (input.action === "lookup-lists" || input.action === "refresh-saved-lists") {
        if (client.remindersZoneOwner === undefined) {
          const discovered = await client.listZones();
          if (!discovered.available) throw new AppError("PROTOCOL_CHANGED", "Apple did not return an available private Reminders zone.");
          connection = { ...connection, remindersZoneOwner: client.remindersZoneOwner };
        }
        if (input.action === "lookup-lists" && input.expectedZoneOwner !== undefined && input.expectedZoneOwner !== client.remindersZoneOwner) throw new AppError("FORBIDDEN", "The supplied zone owner does not match this Apple session.", 403);
        const listIds = input.action === "lookup-lists" ? input.listIds : savedLists.slice(0, 100).map(list => list.id);
        if (!listIds.length) throw new AppError("VALIDATION_ERROR", "There are no saved lists to refresh.", 400);
        const found = await client.lookup(listIds, true);
        if (found.unresolvedRecordNames.length) throw new AppError("PROTOCOL_CHANGED", "Apple omitted a requested list from its lookup response.");
        const records = [...found.records.map(record => {
          if (record.deleted) return { id: record.recordName, deleted: true };
          if (!("recordType" in record) || record.recordType !== "List") throw new AppError("PROTOCOL_CHANGED", "Apple returned an unexpected record in the list lookup.");
          return omitField(normalizeList(record, false), "raw");
        }), ...found.recordErrors.flatMap(error => error.recordName && ["UNKNOWN_ITEM", "NOT_FOUND"].includes(error.serverErrorCode) ? [{ id: error.recordName, deleted: true }] : [])];
        savedLists = mergeSavedLists(savedLists, records);
        result = { records, recordErrors: found.recordErrors.map(error => ({ id: error.recordName, code: error.serverErrorCode })), complete: found.complete, paginationComplete: true, continuation: null, pendingReason: found.complete ? null : "record_errors", scope: "controlled-lookup", auxiliaryRecordCounts: {}, auxiliaryDetailsIncluded: false, unrefreshedLists: input.action === "refresh-saved-lists" ? Math.max(0, saved.session.savedLists!.length - listIds.length) : 0 };
      } else if (input.action === "reminders-batch") {
        // Drain every request while this operation still owns the lease and jar.
        // Prefer authentication recovery over an ordinary upstream error, but
        // do not equate a resource rejection with confirmed account revocation.
        await this.authorizeLists(client, input.listIds);
        connection = { ...connection, remindersZoneOwner: client.remindersZoneOwner };
        const pages = await Promise.allSettled(input.listIds.map(listId => client.queryRemindersPage({ listId, includeCompleted: input.includeCompleted, limit: input.limit })));
        const failures = pages.filter((page): page is PromiseRejectedResult => page.status === "rejected");
        if (failures.length) throw (failures.find(page => authenticationFailure(page.reason)) ?? failures[0]).reason;
        result = { pages: pages.map((page, index) => {
          if (page.status !== "fulfilled") throw new AppError("PROTOCOL_CHANGED", "Apple did not return a requested reminders page.");
          return normalizeReadPage(page.value, { action: "reminders", listId: input.listIds[index], includeCompleted: input.includeCompleted }, client.remindersZoneOwner);
        }) };
      } else {
        if (input.action === "reminders") await this.authorizeLists(client, [input.listId]);
        if (client.remindersZoneOwner !== undefined) connection = { ...connection, remindersZoneOwner: client.remindersZoneOwner };
        const page = await client.queryRemindersPage({ listId: input.listId, includeCompleted: input.includeCompleted, continuation: input.continuation, limit: input.limit });
        const normalized = normalizeReadPage(page, input, client.remindersZoneOwner);
        result = normalized;
      }
      // Cookie changes and the response share a generation/version fence. A
      // concurrent disconnect prevents both the save and a successful response.
      const session = { ...saved.session, connection, savedLists, auth: http.snapshot() };
      await repository.commitResume(fence, input.action === "saved-lists" ? session : appleSuccess(session), "READY");
      result = { ...(result as Record<string, unknown>), requestTrace: client.readTrace };
      return { result, generation: fence.generation, liveReadValidated: false, writesEnabled: appleGates(this.env).enabled };
    });
  }
}
