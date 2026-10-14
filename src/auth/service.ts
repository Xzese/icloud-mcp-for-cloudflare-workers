import { z } from "zod";
import { ListId } from "../reminders/identifiers.ts";
import { ReminderCollectionInput, collectReminders, exportReminderCollection, ReminderCollectionError, type CollectedReminder } from "../reminders/collection.ts";
import { ServiceSettingsRepository } from "../persistence/service-settings.ts";
import { requireServicePermission, type ServicePermission } from "../services/settings.ts";
import { enabledToolNames } from "../services/tool-registry.ts";
import { effectiveServiceStatus, requireDriveConnection, requireRemindersConnection, requireServiceReady, sessionServices, type AppleServices } from "./apple/services.ts";
import { CreateListInput, RenameListInput, DeleteListInput, buildCreateList, buildRenameList, buildDeleteList, buildUpdateListAppearance, requireMutableList, type ListOperation, type ListWrite } from "../reminders/list-writes.ts";
import { canonicalNativeJSONField, readListAppearance, UpdateListAppearanceRequest } from "../reminders/list-appearance.ts";
import { AppError, InspectionReadError, WriteOutcomeUnknownError } from "../errors.ts";
import { omitField } from "../lib/omit-field.ts";
import { stableNativePresentation } from "../lib/native-presentation.ts";
import type { RuntimeEnv } from "../platform/sites.ts";
import { AppleSessionRepository, mergeSavedLists, type AppleSession, type AllOpenScan, type SearchScan, type ResumeFence } from "../persistence/apple-sessions.ts";
import { CloudKitRateLimitedError, CloudKitRemindersClient, intrinsicParentIdentity, isKnownEmptyDeletionCollection, stableDeletionFields, normalizeList, normalizeReminder, referenceField, type CloudKitPage, type CloudKitRecord, type CloudKitLookupResult } from "../icloud/cloudkit.ts";
import { CreateReminderInput, UpdateReminderInput, ReminderTargetInput, assertOwnedReminder, buildCreateReminder, buildReminderFieldUpdate, buildLifecycleReminder, matchesCreatedReminder, type CloudKitWriteRecord } from "../reminders/writes.ts";
import { decodeDocument } from "../reminders/crdt.ts";
import { AppleAuthHTTP, AppleRetryError } from "./apple/http.ts";
import { advancePcs, freshPcsCheckpoint } from "./apple/pcs.ts";
import { AppleSessionRenewal, appleRequestBudget, appleSuccess, renewalCheckpoint, type AppleRequestBudget } from "./apple/session-renewal.ts";
import { appleDisabledMessage, appleGates, requireAppleEnabled } from "./gates.ts";
import { accountScope, canonicalJSON, fingerprint, jsonBytes } from "../lib/canonical.ts";
import { attachEarlyReminderWitness, loadSchedulingGraph, type SchedulingGraph } from "../reminders/linked-records.ts";
import { absoluteDatePairShape } from "../reminders/linked-date.ts";
import { earlyReminderPayload } from "../reminders/early-reminder.ts";
import { planReminderUpdate } from "../reminders/mutation-plan.ts";
import { PrepareUpdateInput, PreparedUpdateInput, createPreparation, checkPreparation, preparationContext } from "../reminders/preparation.ts";
import { type BulkChangeItemData } from "../jobs/schemas.ts";
import { planBulkChange, observeBulkChange } from "../reminders/bulk-operations.ts";
import { InspectReminderInput, inspectReminder } from "../reminders/inspection.ts";
import { EvidenceInput, AtomicProtectionInput, captureEvidenceGraph, sanitizeEvidence, verifyAtomicProtection } from "../reminders/evidence.ts";
import { verifySchedulingWrite, type SchedulingWrite } from "../reminders/scheduling-plan.ts";
import { CreateSubtaskInput, HAS_SUBTASKS_MESSAGE, SetReminderParentInput, buildCreateSubtask, buildSetReminderParent, inspectListChildren, requireNoChildren, subtaskParents } from "../reminders/subtasks.ts";
import { inspectLifecycleFamily, planLifecycle, type LifecyclePlan, type LifecycleFamily } from "../reminders/lifecycle.ts";
import { planRecurringCompletion, verifyRecurringExpected } from "../reminders/recurring-lifecycle.ts";
import { RecurrenceCalendarTimeZone } from "../reminders/recurrence-calendar.ts";
import { RecurringDeletionScope, planRecurringDeletion } from "../reminders/recurring-deletion.ts";
import { loadScheduledFamilyPairs, planScheduledFamilyLifecycle } from "../reminders/scheduled-family-lifecycle.ts";
import { matchesReminderOrganizationSearch, matchesReminderSearch, SearchFilterFieldsSchema, SearchFilters, validateSearchFilterConstraints, type ReminderSearchFilters } from "../reminders/search.ts";
import { URLChanges, TagChanges, planURLChange, planTagChange, readReminderOrganization, readReminderOrganizationSelection, reminderOrganizationIds, type OrganizationFilterSelection } from "../reminders/organization.ts";
import { MoveReminderInput, CopyReminderInput, planReminderTransfer } from "../reminders/transfers.ts";
import { GetShoppingCategoriesRequest, SetShoppingCategoryRequest } from "../reminders/shopping-categories.ts";
import { requireShoppingList, categorySummary, loadShoppingAssets, planShoppingCategory, verifyShoppingPreservation } from "../reminders/shopping-plan.ts";
import { GetReminderListSectionsRequest, readStandardSectionsPage } from "../reminders/sections.ts";

export interface MutationHooks {
  expectedAccount: string;
  beforeDispatch(write: CloudKitWriteRecord): Promise<void>;
  assertDispatch(): Promise<void>;
}

export const ResumeRequest = z.object({ expectedGeneration: z.number().int().nonnegative().safe(), restartApproval: z.boolean().optional() }).strict();
export const ReminderMutation = z.discriminatedUnion("action", [
  CreateReminderInput.extend({ action: z.literal("create"), expectedGeneration: ResumeRequest.shape.expectedGeneration }).strict(),
  PreparedUpdateInput.extend({ action: z.literal("update"), expectedGeneration: ResumeRequest.shape.expectedGeneration }).strict(),
  ReminderTargetInput.extend({ action: z.literal("complete"), expectedGeneration: ResumeRequest.shape.expectedGeneration, recurrenceCalendarTimeZone: RecurrenceCalendarTimeZone.optional() }).strict(),
  ReminderTargetInput.extend({ action: z.literal("reopen"), expectedGeneration: ResumeRequest.shape.expectedGeneration, recurrenceCalendarTimeZone: RecurrenceCalendarTimeZone.optional() }).strict(),
  ReminderTargetInput.extend({ action: z.literal("delete"), expectedGeneration: ResumeRequest.shape.expectedGeneration, recurringDeletionScope: RecurringDeletionScope.optional(), recurrenceCalendarTimeZone: RecurrenceCalendarTimeZone.optional() }).strict(),
  CreateSubtaskInput.extend({ action: z.literal("create_subtask"), expectedGeneration: ResumeRequest.shape.expectedGeneration }).strict(),
  SetReminderParentInput.extend({ action: z.literal("set_parent"), expectedGeneration: ResumeRequest.shape.expectedGeneration }).strict(),
  ReminderTargetInput.merge(URLChanges).extend({ action: z.literal("set_url"), expectedGeneration: ResumeRequest.shape.expectedGeneration }).strict(),
  ReminderTargetInput.merge(TagChanges).extend({ action: z.literal("set_tags"), expectedGeneration: ResumeRequest.shape.expectedGeneration }).strict(),
  MoveReminderInput.extend({ action: z.literal("move"), expectedGeneration: ResumeRequest.shape.expectedGeneration }).strict(),
  CopyReminderInput.extend({ action: z.literal("copy"), expectedGeneration: ResumeRequest.shape.expectedGeneration }).strict(),
]);
const common = { expectedGeneration: z.number().int().nonnegative().safe(), continuation: z.string().min(1).max(8192).nullable().optional(), limit: z.number().int().min(1).max(200).default(200) };
export const ListReadIdInput = ListId;
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
  z.object({ action: z.literal("reminders-batch"), expectedGeneration: common.expectedGeneration, listIds: z.array(ListReadIdInput).min(1).max(2).refine(ids => new Set(ids).size === ids.length, "List IDs must be unique."), includeCompleted: z.boolean(), limit: common.limit }).strict(),
  z.object({ action: z.literal("reminders"), ...common, listId: ListReadIdInput, includeCompleted: z.boolean() }).strict(),
]);
export const SearchReminderInputFieldsSchema = SearchFilterFieldsSchema.extend({
  expectedGeneration: z.number().int().nonnegative().safe().describe("Optional current Apple session generation for stale-session protection.").optional(),
  continuation: z.string().uuid().nullable().describe("Single-use continuation from this search; repeat the same filters to continue.").optional(),
  limit: z.number().int().min(1).max(200).default(200).describe("Maximum Apple page size, 1–200. Use 20 or 50 if dense history pages exceed the response budget."),
}).strict();
export const SearchReminderInput = SearchReminderInputFieldsSchema.superRefine((request, ctx) => {
  validateSearchFilterConstraints(request, ctx);
});
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

function stableListAppearanceFields(record: CloudKitRecord) {
  return Object.fromEntries(Object.entries(stableNativePresentation(record.fields)).map(([key, value]) => [key, canonicalNativeJSONField(key, value)]));
}

function verifyListAppearanceUpdate(write: ReturnType<typeof buildUpdateListAppearance>, before: CloudKitRecord, confirmed: CloudKitRecord, owner: string) {
  const previous = ownedListRecord(before, owner), current = ownedListRecord(confirmed, owner);
  if (previous.recordName !== write.recordName || current.recordName !== write.recordName || current.recordType !== "List" ||
    !current.recordChangeTag || current.recordChangeTag === write.recordChangeTag ||
    canonicalJSON(previous.raw.parent ?? null) !== canonicalJSON(current.raw.parent ?? null)) {
    throw new WriteOutcomeUnknownError(write.recordName);
  }
  requireMutableList(current, owner);
  const expectedKeys = new Set([...Object.keys(previous.fields), ...Object.keys(write.fields)]);
  if (expectedKeys.size !== Object.keys(current.fields).length || Object.keys(current.fields).some(key => !expectedKeys.has(key))) {
    throw new WriteOutcomeUnknownError(write.recordName);
  }
  for (const [key, submitted] of Object.entries(write.fields)) {
    const actual = current.fields[key];
    if (!actual || typeof actual !== "object" || Array.isArray(actual) ||
      canonicalJSON(canonicalNativeJSONField(key, actual)) !== canonicalJSON(canonicalNativeJSONField(key, submitted))) {
      throw new WriteOutcomeUnknownError(write.recordName);
    }
  }
  const beforeFields = stableListAppearanceFields(previous), afterFields = stableListAppearanceFields(current);
  for (const [key, field] of Object.entries(beforeFields)) {
    if (!Object.hasOwn(write.fields, key) && canonicalJSON(afterFields[key]) !== canonicalJSON(field)) {
      throw new WriteOutcomeUnknownError(write.recordName);
    }
  }
}

async function organizationRecords(client: CloudKitRemindersClient, root: CloudKitRecord, owner: string, selected?: "url" | "tags") {
  const normalized = normalizeReminder(root, owner);
  const load = async (ids: string[], type: "Attachment" | "Hashtag") => {
    if (ids.length > 31) throw new AppError("UNSUPPORTED_FEATURE", "The organization relationships exceed the atomic lookup budget.");
    if (!ids.length) return [];
    const found = type === "Attachment" ? await client.lookupAttachments(ids) : await client.lookupHashtags(ids);
    return ids.map(id => writeLookupRecord(found, id, false)!);
  };
  return {
    attachments: selected === "tags" ? [] : await load(normalized.attachmentIds ?? [], "Attachment"),
    hashtags: selected === "url" ? [] : await load(normalized.hashtagIds ?? [], "Hashtag"),
  };
}

function copyContents(root: CloudKitRecord, organization: ReturnType<typeof readReminderOrganization>, owner: string, listId: string) {
  const record = normalizeReminder(root, owner);
  return { listId, title: record.title ?? "", notes: record.notes ?? "", priority: record.priority ?? 0, flagged: record.flagged ?? false,
    url: organization.url?.url ?? null, tags: organization.tags.map(tag => tag.name), completed: record.completed,
    deleted: record.deleted, parentReminderId: record.parentReminderId, dueDate: record.dueDate, startDate: record.startDate,
    timeZone: record.timeZone, allDay: record.allDay ?? false, alarmIds: record.alarmIds ?? [], recurrenceRuleIds: record.recurrenceRuleIds ?? [],
    otherAttachmentIds: organization.otherAttachmentIds };
}

function requireEmptyListMetadata(record: CloudKitRecord) {
  const list = normalizeList(record);
  if (list.count !== null && list.count !== 0 || list.reminderIds === null || list.reminderIds.length !== 0)
    throw new AppError("UNSUPPORTED_FEATURE", "Only lists with explicitly empty membership and no nonzero count can be deleted.");
}

function verifyWriteFields(write: CloudKitWriteRecord, confirmed: CloudKitRecord, current: CloudKitRecord, owner: string, listId: string | null) {
  confirmed = { ...confirmed, fields: stableNativePresentation(confirmed.fields) };
  current = { ...current, fields: stableNativePresentation(current.fields) };
  const reminder = normalizeReminder(confirmed, owner, true);
  const before = normalizeReminder(current, owner, true);
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

function verifyOrganizationPreservation(before: CloudKitRecord, after: CloudKitRecord, changed: Record<string, unknown>) {
  if (!after || after.recordType !== before.recordType) throw new WriteOutcomeUnknownError(before.recordName);
  for (const [key, field] of Object.entries(before.fields)) {
    if (!Object.hasOwn(changed, key) && canonicalJSON(after.fields[key] ?? null) !== canonicalJSON(field)) throw new WriteOutcomeUnknownError(before.recordName);
  }
}

export class AppleConnectionService {
  readonly env: RuntimeEnv; readonly owner: string;
  constructor(env: RuntimeEnv, owner: string) { this.env = env; this.owner = owner; }
  async status() {
    const gates = appleGates(this.env);
    const session = await new AppleSessionRepository(this.env, this.owner).status();
    const preferences = await new ServiceSettingsRepository(this.env, this.owner).load();
    const accountAvailable = gates.enabled && session.accountAuthenticated && !["apple-sign-in", "verify-device", "review-terms"].includes(session.requiredAction ?? "") && !(session.nextRetryAt && session.nextRetryAt > Date.now());
    const serviceStatus = effectiveServiceStatus(session.services ? { services: session.services } as AppleSession : null,
      session.accountAuthenticated ? session.state as "READY" | "DEVICE_APPROVAL_PENDING" : null, preferences.settings, accountAvailable, session.action);
    const readsAvailable = serviceStatus.reminders.read;
    const connection = omitField(session, "liveReadValidated");
    const writesAvailable = serviceStatus.reminders.write;
    const jobSchema = await this.env.DB?.withSession("first-primary").prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name IN ('reminder_jobs','reminder_job_items','reminder_job_receipts','reminder_job_chunks','reminder_job_accounts')").first<{ count: number }>();
    const jobsAvailable = jobSchema?.count === 5;
    const jobDefinition = jobsAvailable ? await this.env.DB?.withSession("first-primary").prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'reminder_jobs'").first<{ sql: string }>() : null;
    const duplicationSchema = await this.env.DB?.withSession("first-primary").prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'reminder_list_duplications'").first<{ name: string }>();
    const workflowSchema = await this.env.DB?.withSession("first-primary").prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'reminder_create_workflows'").first<{ name: string }>();
    const filterSchema = await this.env.DB?.withSession("first-primary").prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'connector_filters'").first<{ name: string }>();
    const bulkChangesAvailable = !!jobDefinition && ["'bulk_update'", "'bulk_complete'"].every(kind => jobDefinition.sql.includes(kind));
    const actionMessage = session.requiredAction === "local-retention-expired" ? "The fixed local retention window expired. Sign in and verify your device again."
      : session.requiredAction === "apple-sign-in" || session.requiredAction === "verify-device" ? "Sign in again or complete the required device verification to use this Apple connection."
      : session.requiredAction === "review-terms" ? "Review Apple's updated terms in the official iCloud interface."
      : session.requiredAction === "retry" && session.nextRetryAt && session.nextRetryAt > Date.now() ? "Apple or the network is temporarily unavailable. The saved connection is preserved; wait until the retry time."
      : null;
    return { ...connection, services: serviceStatus, serviceSettings: preferences, accountConnected: accountAvailable, listDiscovery: { strategy: "direct", liveValidated: false, experimental: true }, gates,
      connected: accountAvailable, writeEnabled: writesAvailable, phase: writesAvailable ? "read-write" : "read-only",
      capabilities: { liveRead: readsAvailable, controlledRead: readsAvailable, listReminders: readsAvailable, allOpenReminders: readsAvailable, search: readsAvailable && session.state === "READY", connectorCollections: readsAvailable && session.state === "READY", boundedExport: readsAvailable && session.state === "READY", savedFilters: readsAvailable && !!filterSchema, compoundCreate: writesAvailable && !!workflowSchema, listDuplication: writesAvailable && !!duplicationSchema, create: writesAvailable, update: writesAvailable, complete: writesAvailable, reopen: writesAvailable, delete: writesAvailable,
        prepareUpdate: readsAvailable, reminderInspection: readsAvailable, linkedScheduling: writesAvailable, reminderJobs: jobsAvailable && readsAvailable, bulkCreate: writesAvailable && jobsAvailable, bulkDelete: writesAvailable && jobsAvailable,
        bulkUpdate: writesAvailable && bulkChangesAvailable, bulkComplete: writesAvailable && bulkChangesAvailable,
        autonomousJobs: false as const, jobExecutionMode: "request-driven" as const,
        subtasks: writesAvailable, urls: writesAvailable, tags: writesAvailable, moveCopy: writesAvailable, createList: writesAvailable, renameList: writesAvailable, deleteList: writesAvailable,
        listAppearanceRead: readsAvailable, listAppearanceUpdate: writesAvailable, shoppingCategoriesRead: readsAvailable, shoppingCategoriesUpdate: writesAvailable, standardSectionsRead: readsAvailable },
      mcpTools: enabledToolNames(preferences.settings),
      message: !gates.enabled ? appleDisabledMessage(gates) : actionMessage ?? (!session.accountAuthenticated
        ? "Connect your Apple account through the private Site's secure connection form."
        : [preferences.settings.reminders.enabled ? `Reminders: ${serviceStatus.reminders.ready ? "approved" : "Apple approval or service discovery required"}.` : "Reminders is disabled.",
          preferences.settings.drive.enabled ? `Drive: ${serviceStatus.drive.ready ? "approved" : "use Approve Drive to check Apple access"}.` : "Drive is disabled."].join(" ")) };
  }
  async disconnect() { return await new AppleSessionRepository(this.env, this.owner).disconnect(); }
  private async requirePermission(permission: ServicePermission) {
    const snapshot = await new ServiceSettingsRepository(this.env, this.owner).load();
    requireServicePermission(snapshot.settings, permission);
    return snapshot;
  }
  private async assertRemindersWrite(repository: AppleSessionRepository, fence: ResumeFence) {
    await repository.assertWriteLease(fence);
    await this.requirePermission("reminders.write");
  }
  // Local inspection never renews or requests PCS.
  async loadDriveState(expectedGeneration?: number) {
    const saved = await new AppleSessionRepository(this.env, this.owner).load();
    if (expectedGeneration !== undefined && saved.fence.generation !== expectedGeneration) throw new AppError("CONFLICT", "The Apple connection changed.", 409);
    return { ...saved, drive: sessionServices(saved.session, saved.state, saved.action).drive };
  }
  // Explicit owner action; enabled intent and status polling never call this.
  async approveDrive(expectedGeneration: number, restartApproval = false) {
    requireAppleEnabled(this.env);
    const preferences = await new ServiceSettingsRepository(this.env, this.owner).load();
    if (!preferences.settings.drive.enabled) throw new AppError("FORBIDDEN", "Enable Drive in Services before approving Apple access.", 403);
    const repository = new AppleSessionRepository(this.env, this.owner);
    const initial = await repository.load();
    const saved = await new AppleSessionRenewal(this.env, repository).ensure(expectedGeneration, appleRequestBudget(), !initial.session.services?.drive.connection);
    requireDriveConnection(saved.session);
    const services = sessionServices(saved.session, saved.state, saved.action);
    if (services.drive.state === "READY" && !restartApproval) return this.status();
    if (services.drive.pcs && Date.now() < services.drive.pcs.nextAttemptAt) throw new AppError("RATE_LIMITED", "Wait until the displayed retry time before checking Drive approval.", 429, true);
    if (services.drive.pcs && services.drive.pcs.expiresAt <= Date.now() && !restartApproval) throw new AppError("RESTART_REQUIRED", "The Drive approval attempt expired. Start a new explicit approval attempt.", 409);
    const checkpoint = restartApproval || !services.drive.pcs ? freshPcsCheckpoint() : services.drive.pcs;
    const fence = await repository.claimRenewal(expectedGeneration, saved.fence.version);
    const http = AppleAuthHTTP.restore(saved.session.auth);
    try {
      const current = await new ServiceSettingsRepository(this.env, this.owner).load();
      if (!current.settings.drive.enabled) throw new AppError("FORBIDDEN", "Drive was disabled before approval.", 403);
      const result = await advancePcs(http, saved.session.connection.dsid, checkpoint, Date.now(), "drive", async () => {
        if (!(await new ServiceSettingsRepository(this.env, this.owner).load()).settings.drive.enabled) throw new AppError("FORBIDDEN", "Drive was disabled before Apple approval.", 403);
        await repository.assertAccountLease(fence);
      }, requireDriveConnection(saved.session).driveURL);
      await repository.commitResume(fence, appleSuccess({ ...saved.session, auth: http.snapshot(), services: {
        ...services, drive: { connection: services.drive.connection, state: result.state, pcs: result.checkpoint,
          ...(result.state === "DEVICE_APPROVAL_PENDING" ? { action: result.action } : {}) } } }), saved.state, saved.action ?? undefined);
    } catch (error) {
      const parsed = ["DEVICE_APPROVAL_PENDING", "AUTH_EXPIRED", "RATE_LIMITED", "UPSTREAM_UNAVAILABLE", "PROTOCOL_CHANGED", "FORBIDDEN"].includes(error instanceof AppError ? error.code : "");
      if (parsed) await repository.commitResume(fence, { ...saved.session, auth: { ...saved.session.auth, cookies: http.snapshot().cookies },
        services: { ...services, drive: { ...services.drive, state: "ERROR", action: undefined,
          pcs: { ...checkpoint, nextAttemptAt: Math.max(checkpoint.nextAttemptAt, Date.now() + (error instanceof AppleRetryError ? error.retryAfterMs : 5000)) },
          lastErrorCode: (error as AppError).code as AppleServices["drive"]["lastErrorCode"] } } }, saved.state, saved.action ?? undefined);
      throw error;
    } finally { await repository.releaseResume(fence); }
    return this.status();
  }
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
      const client = new CloudKitRemindersClient(http.http, requireRemindersConnection(saved.session));
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
        await this.assertRemindersWrite(repository, fence);
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
      const client = new CloudKitRemindersClient(http.http, requireRemindersConnection(saved.session));
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
      const client = new CloudKitRemindersClient(http.http, requireRemindersConnection(saved.session));
      if (client.remindersZoneOwner === undefined && !(await client.listZones()).available) throw new AppError("PROTOCOL_CHANGED", "Apple did not return an available private Reminders zone.");
      const found = await client.lookup([listId, reminderId]);
      const list = writeLookupRecord(found, listId, false)!;
      if (list.recordType !== "List" || normalizeList(list, false).deleted || normalizeList(list, false).isGroup) throw new AppError("CONFLICT", "The requested list is unavailable.", 409);
      const item = found.records.find(record => record.recordName === reminderId);
      const current = item?.deleted === true ? null : writeLookupRecord(found, reminderId, true);
      let record = null;
      if (current) {
        const normalized = omitField(normalizeReminder(current, client.remindersZoneOwner, true), "raw");
        if (normalized.listId !== listId && !(normalized.deleted === true && normalized.listId === null)) throw new AppError("FORBIDDEN", "The reminder does not belong to the requested list.", 403);
        record = normalized;
      }
      await repository.commitResume(fence, appleSuccess({ ...saved.session, connection: { ...saved.session.connection, remindersZoneOwner: client.remindersZoneOwner }, auth: http.snapshot() }), "READY");
      return { generation: fence.generation, record, missing: record === null };
    });
  }
  async inspectReminder(value: unknown) {
    const parsed = InspectReminderInput.safeParse(value);
    if (!parsed.success) throw new AppError("VALIDATION_ERROR", "Provide exact list and reminder IDs and the current session generation.", 400);
    const input = parsed.data;
    return this.operation(input.expectedGeneration, "read-only", async (http, saved, repository, fence) => {
      const client = new CloudKitRemindersClient(http.http, requireRemindersConnection(saved.session));
      if (client.remindersZoneOwner === undefined && !(await client.listZones()).available) throw new AppError("PROTOCOL_CHANGED", "Apple did not return an available private Reminders zone.");
      const found = await client.lookup([input.listId, input.reminderId]);
      const list = ownedListRecord(writeLookupRecord(found, input.listId, false)!, client.remindersZoneOwner!);
      if (normalizeList(list).deleted !== false || normalizeList(list).isGroup) throw new AppError("CONFLICT", "The requested list is unavailable.", 409);
      const current = writeLookupRecord(found, input.reminderId, false)!;
      const record = omitField(normalizeReminder(current, client.remindersZoneOwner, true), "raw");
      if (record.listId !== input.listId) throw new AppError("FORBIDDEN", "The reminder does not belong to the requested list. Use get_reminder for detached deletion recovery.", 403);
      if (!record.recordChangeTag || record.deleted !== false) throw new AppError("CONFLICT", "Inspection requires a current nondeleted reminder. Use get_reminder for deletion recovery.", 409);
      const started = Date.now();
      try {
        const details = await inspectReminder(client, current, list, client.remindersZoneOwner!, input);
        const result = { generation: fence.generation, record, ...details };
        if (jsonBytes(result) > 262_144) throw new AppError("UNSUPPORTED_FEATURE", "The expanded reminder exceeds the inspection response budget.");
        await repository.commitResume(fence, appleSuccess({ ...saved.session, connection: { ...saved.session.connection, remindersZoneOwner: client.remindersZoneOwner }, auth: http.snapshot() }), "READY");
        return result;
      } catch (error) {
        if (!(error instanceof AppError) || !["CONFLICT", "PROTOCOL_CHANGED", "UNSUPPORTED_FEATURE"].includes(error.code)) throw error;
        throw new InspectionReadError(error, { elapsedMs: Date.now() - started,
          requests: client.readTrace.slice(0, 40).map(trace => ({ path: trace.path, elapsedMs: trace.elapsedMs,
            records: trace.response.returnedRecords, recordTypes: trace.response.recordTypes,
            continuation: trace.response.continuationPresent })) });
      }
    }, appleRequestBudget(60_000), 60_000);
  }
  async prepareUpdate(value: unknown) {
    const parsed = PrepareUpdateInput.safeParse(value);
    if (!parsed.success) throw new AppError("VALIDATION_ERROR", "Provide an exact update request with its current generation and supported policy.", 400);
    const input = parsed.data;
    return this.operation(input.expectedGeneration, "read-only", async (http, saved, repository, fence) => {
      const client = new CloudKitRemindersClient(http.http, requireRemindersConnection(saved.session));
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
        datePairShape: absoluteDatePairShape(graph, client.remindersZoneOwner!),
        unsupportedReason: plan.unsupportedReason, preparationToken: token, expiresAt: token ? expiresAt : null, operationCount: plan.operationCount,
        message: "Preparation is not user authorization. No reminder was modified. Supported scheduling recipes are validated against the exact current linked graph; unknown recipes are explicitly unsupported." };
    });
  }
  async validateJobLists(expectedGeneration: number, account: string, ids: string[]) {
    if (!ids.length || ids.length > 50) throw new AppError("UNSUPPORTED_FEATURE", "A job preview supports at most 50 distinct lists.");
    return this.operation(expectedGeneration, "read-only", async (http, saved, repository, fence) => {
      if (await accountScope(this.owner, saved.session.connection.dsid) !== account) throw new AppError("CONFLICT", "The job belongs to a different Apple account.", 409);
      const client = new CloudKitRemindersClient(http.http, requireRemindersConnection(saved.session));
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
      const client = new CloudKitRemindersClient(http.http, requireRemindersConnection(saved.session));
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
      const client = new CloudKitRemindersClient(http.http, requireRemindersConnection(saved.session));
      if (client.remindersZoneOwner === undefined && !(await client.listZones()).available) throw new AppError("PROTOCOL_CHANGED", "Apple did not return a private Reminders zone.");
      const owner = client.remindersZoneOwner!, found = await client.lookup([input.listId, input.reminderId]);
      const list = writeLookupRecord(found, input.listId, false)!;
      if (list.recordType !== "List" || normalizeList(list, false).deleted || normalizeList(list, false).isGroup) throw new AppError("CONFLICT", "The target list is unavailable.", 409);
      let deleted: boolean;
      if (found.records.some(record => record.recordName === input.reminderId && record.deleted)) deleted = true;
      else {
        const current = writeLookupRecord(found, input.reminderId, true);
        if (current) assertOwnedReminder(current, owner);
        const normalized = current ? normalizeReminder(current, owner, true) : null;
        if (normalized && normalized.listId !== input.listId && !(normalized.deleted === true && normalized.listId === null)) throw new AppError("CONFLICT", "The reminder is no longer in the approved list.", 409);
        deleted = current === null || normalized!.deleted === true;
      }
      const children = (await inspectListChildren(client, owner, list)).get(input.reminderId) ?? [];
      await repository.commitResume(fence, appleSuccess({ ...saved.session, auth: http.snapshot() }), "READY");
      return { deleted, remainingChildren: children.length };
    });
  }
  async observeJobChange(expectedGeneration: number, account: string, item: BulkChangeItemData, write: unknown) {
    return this.operation(expectedGeneration, "read-only", async (http, saved, repository, fence) => {
      if (await accountScope(this.owner, saved.session.connection.dsid) !== account) throw new AppError("CONFLICT", "The job belongs to a different Apple account.", 409);
      const client = new CloudKitRemindersClient(http.http, requireRemindersConnection(saved.session));
      if (client.remindersZoneOwner === undefined && !(await client.listZones()).available) throw new AppError("PROTOCOL_CHANGED", "Apple did not return a private Reminders zone.");
      const { listId, reminderId } = item.input;
      const found = await client.lookup([listId, reminderId]);
      const list = ownedListRecord(writeLookupRecord(found, listId, false)!, client.remindersZoneOwner!);
      if (normalizeList(list).deleted !== false || normalizeList(list).isGroup) throw new AppError("CONFLICT", "The target list is unavailable.", 409);
      const current = found.records.some(record => record.recordName === reminderId && record.deleted) ? null : writeLookupRecord(found, reminderId, true);
      if (current) {
        const reminder = normalizeReminder(current, client.remindersZoneOwner, true);
        if (reminder.listId !== listId && !(reminder.deleted === true && reminder.listId === null)) throw new AppError("CONFLICT", "The reminder is no longer in the approved list.", 409);
      }
      const desiredStateObserved = observeBulkChange(item, write, current, client.remindersZoneOwner!);
      await repository.commitResume(fence, appleSuccess({ ...saved.session, auth: http.snapshot() }), "READY");
      return { desiredStateObserved, missing: current === null };
    });
  }
  /** Read-only preview shares the same bounded target planning used at dispatch. */
  async preflightJobDeletes(expectedGeneration: number, account: string, inputs: z.infer<typeof ReminderTargetInput>[]) {
    return this.preflightJobTargets(expectedGeneration, account, inputs,
      (current, owner, index, now) => { buildLifecycleReminder("delete", inputs[index], current, owner, now); });
  }
  async preflightJobChanges(expectedGeneration: number, account: string, items: BulkChangeItemData[]) {
    return this.preflightJobTargets(expectedGeneration, account, items.map(item => item.input),
      (current, owner, index, now) => { planBulkChange(items[index], current, owner, now); });
  }
  private async preflightJobTargets(expectedGeneration: number, account: string, inputs: z.infer<typeof ReminderTargetInput>[],
    plan: (current: CloudKitRecord, owner: string, index: number, now: number) => void) {
    const lists = [...new Set(inputs.map(input => input.listId))];
    if (!inputs.length || inputs.length > 1000 || lists.length > 50) throw new AppError("UNSUPPORTED_FEATURE", "A job preview supports at most 1,000 targets in 50 distinct lists.");
    return this.operation(expectedGeneration, "read-only", async (http, saved, repository, fence) => {
      if (await accountScope(this.owner, saved.session.connection.dsid) !== account) throw new AppError("CONFLICT", "The job belongs to a different Apple account.", 409);
      const client = new CloudKitRemindersClient(http.http, requireRemindersConnection(saved.session));
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
        try { plan(current, owner, index, now); }
        catch (error) {
          if (!(error instanceof AppError)) throw error;
          results[index] = error;
        }
      });
      for (const listId of lists) {
        if (!inputs.some((input, index) => input.listId === listId && results[index] === null)) continue;
        const children = await inspectListChildren(client, owner, writeLookupRecord(foundLists, listId, false)!);
        inputs.forEach((input, index) => {
          if (input.listId === listId && results[index] === null && children.has(input.reminderId)) results[index] = new AppError("UNSUPPORTED_FEATURE", HAS_SUBTASKS_MESSAGE);
        });
      }
      await repository.commitResume(fence, appleSuccess({ ...saved.session, connection: { ...saved.session.connection, remindersZoneOwner: owner }, auth: http.snapshot() }), "READY");
      return results;
    });
  }
  async mutate(value: unknown, hooks?: MutationHooks, expectedRelationshipVersions?: Record<string, string>) {
    // Login availability precedes parsing, storage access and Apple requests.
    requireAppleEnabled(this.env);
    const parsed = ReminderMutation.safeParse(value);
    if (!parsed.success) throw new AppError("VALIDATION_ERROR", "Provide a bounded reminder mutation request with the current session generation.", 400);
    const input = parsed.data;
    if (input.action === "create_subtask" || input.action === "set_parent") {
      if (hooks) throw new AppError("UNSUPPORTED_FEATURE", "Subtask relationship mutations are not supported in bulk jobs.");
      return this.mutateSubtask(input);
    }
    if (input.action === "set_url" || input.action === "set_tags" || input.action === "move" || input.action === "copy") {
      if (hooks) throw new AppError("UNSUPPORTED_FEATURE", "Organization and transfer mutations are not supported in bulk jobs.");
      return this.mutateOrganization(input, expectedRelationshipVersions);
    }
    const targetId = input.action === "create" ? `Reminder/${input.idempotencyKey.toUpperCase()}` : input.reminderId;
    let applied = false;
    try {
      return await this.operation(input.expectedGeneration, "mutation-preparation", async (http, saved, repository, fence, stage) => {
        if (hooks && await accountScope(this.owner, saved.session.connection.dsid) !== hooks.expectedAccount) throw new AppError("CONFLICT", "The job belongs to a different Apple account.", 409);
        const client = new CloudKitRemindersClient(http.http, requireRemindersConnection(saved.session));
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
        if (input.action === "delete") {
          const scope = input.recurringDeletionScope;
          const requestFingerprint = scope === undefined ? undefined : await fingerprint({ account: await accountScope(this.owner, saved.session.connection.dsid), generation: fence.generation,
            listId: input.listId, reminderId: input.reminderId, recordChangeTag: input.recordChangeTag, action: "delete", recurringDeletionScope: scope,
            ...(input.recurrenceCalendarTimeZone === undefined ? {} : { recurrenceCalendarTimeZone: input.recurrenceCalendarTimeZone }) });
          let intent = requestFingerprint === undefined ? undefined : saved.session.recurringIntents?.find(item => item.requestFingerprint === requestFingerprint);
          const recurring = !!normalizeReminder(current!, owner, true).recurrenceRuleIds?.length;
          if (scope !== undefined || recurring || intent || input.recurrenceCalendarTimeZone !== undefined) {
            if (hooks) throw new AppError("UNSUPPORTED_FEATURE", "Recurring deletion is not a bulk job action.");
            if (scope === undefined) throw new AppError("VALIDATION_ERROR", "Recurring deletion requires explicit recurringDeletionScope: occurrence or all_future.", 400);
            if (!recurring && !intent) throw new AppError("VALIDATION_ERROR", "recurringDeletionScope is refused for ordinary deletion.", 400);
            if (intent && (intent.operation !== "delete" || intent.recurringDeletionScope !== scope || intent.recurrenceCalendarTimeZone !== input.recurrenceCalendarTimeZone)) throw new AppError("CONFLICT", "The retained deletion request has a different operation, scope or calendar zone.", 409);
            let records: CloudKitRecord[], replayed = false;
            if (intent && intent.phase !== "prepared") {
              try {
                const ordinary = await client.lookup(intent.expected.filter(item => ["Reminder", "List"].includes(item.type)).map(item => item.id));
                const linked = await client.lookupSchedulingRecords(intent.expected.filter(item => !["Reminder", "List"].includes(item.type)).map(item => item.id));
                if (!ordinary.complete || !linked.complete) throw new WriteOutcomeUnknownError(targetId);
                await verifyRecurringExpected(intent.expected, [...ordinary.records, ...linked.records], owner, true);
                if (intent.retired.length) {
                  const retired = await client.lookupSchedulingRecords(intent.retired);
                  if (retired.records.length || retired.unresolvedRecordNames.length || retired.recordErrors.length !== intent.retired.length ||
                    new Set(retired.recordErrors.map(error => error.recordName)).size !== intent.retired.length ||
                    retired.recordErrors.some(error => !error.recordName || !intent!.retired.includes(error.recordName) || !["UNKNOWN_ITEM", "NOT_FOUND"].includes(error.serverErrorCode))) throw new WriteOutcomeUnknownError(targetId);
                }
                records = [...ordinary.records, ...linked.records] as CloudKitRecord[]; replayed = true;
              } catch {
                if (intent.phase === "confirmed") throw new AppError("CONFLICT", "The previously deleted occurrence has since changed; this request cannot be replayed.", 409);
                throw new WriteOutcomeUnknownError(targetId);
              }
            } else {
              if (current!.recordChangeTag !== input.recordChangeTag) throw new AppError("CONFLICT", "The recurring deletion target changed before dispatch.", 409);
              await requireNoChildren(client, owner, list, targetId);
              const graph = await loadSchedulingGraph({ ...current!, zoneID: current!.zoneID ?? { zoneName: "Reminders", ownerRecordName: owner } }, owner, ids => client.lookupSchedulingRecords(ids));
              const plan = await planRecurringDeletion(graph, list, owner, scope, intent?.ids, intent?.timestamp ?? Date.now(), input.recurrenceCalendarTimeZone);
              if (intent && (intent.recurringDeletionRecipe !== plan.recipe || intent.recurringDeletionTerminal !== plan.terminal || intent.sourceFingerprint !== plan.sourceFingerprint || canonicalJSON(intent.expected) !== canonicalJSON(plan.expected) || canonicalJSON(intent.retired) !== canonicalJSON(plan.retired)))
                throw new AppError("CONFLICT", "The prepared recurring deletion source changed before dispatch.", 409);
              intent = { requestFingerprint: requestFingerprint!, sourceFingerprint: plan.sourceFingerprint, timestamp: plan.timestamp, ids: plan.ids, expected: plan.expected, retired: plan.retired,
                phase: "prepared", ...(plan.recurrenceCalendarTimeZone === undefined ? {} : { recurrenceCalendarTimeZone: plan.recurrenceCalendarTimeZone }),
                intrinsicParentGuards: true, operation: "delete", recurringDeletionScope: scope,
                ...(plan.recipe === undefined ? {} : { recurringDeletionRecipe: plan.recipe }),
                ...(plan.terminal === undefined ? {} : { recurringDeletionTerminal: plan.terminal }) };
              saved.session.recurringIntents = await repository.checkpointRecurringIntent(fence, intent);
              records = await client.modifyRecurringDeletion(plan, async () => {
                await this.assertRemindersWrite(repository, fence);
                if (scope === "occurrence" && !plan.terminal && Number(plan.active.fields.DueDate.value) <= Date.now()) throw new AppError("UNSUPPORTED_FEATURE", "The next recurring deletion occurrence is now overdue.");
                stage.dispatch(); intent = { ...intent!, phase: "dispatched" };
                saved.session.recurringIntents = await repository.checkpointRecurringIntent(fence, intent);
                await this.requirePermission("reminders.write");
              });
              applied = true;
            }
            intent = { ...intent!, phase: "confirmed" }; saved.session.recurringIntents = await repository.checkpointRecurringIntent(fence, intent);
            stage.confirm();
            const active = records.find(record => record.recordName === targetId)!;
            const record = omitField(normalizeReminder(active, owner, true), "raw");
            await repository.commitResume(fence, appleSuccess({ ...omitField(saved.session, "allOpenScan"), connection, auth: http.snapshot() }), "READY");
            return { generation: fence.generation, operation: "delete" as const, replayed, record, affectedRecords: [record], writesEnabled: true as const };
          }
        }
        if (input.action === "complete" || input.action === "reopen") {
          const requestFingerprint = await fingerprint({ account: await accountScope(this.owner, saved.session.connection.dsid), generation: fence.generation,
            listId: input.listId, reminderId: input.reminderId, recordChangeTag: input.recordChangeTag, action: input.action,
            ...(input.recurrenceCalendarTimeZone === undefined ? {} : { recurrenceCalendarTimeZone: input.recurrenceCalendarTimeZone }) });
          let intent = saved.session.recurringIntents?.find(item => item.requestFingerprint === requestFingerprint);
          if (intent && intent.recurrenceCalendarTimeZone !== input.recurrenceCalendarTimeZone) throw new AppError("CONFLICT", "The retained recurrence request has a different calendar zone.", 409);
          if (input.recurrenceCalendarTimeZone !== undefined && !intent && !(normalizeReminder(current!, owner, true).recurrenceRuleIds?.length))
            throw new AppError("UNSUPPORTED_FEATURE", "recurrenceCalendarTimeZone requires the supported ended all-day daily recurrence.");
          if (intent || normalizeReminder(current!, owner, true).recurrenceRuleIds?.length) {
            if (hooks) throw new AppError("UNSUPPORTED_FEATURE", "Recurring completion is not a bulk job action.");
            let records: CloudKitRecord[], replayed = false;
            if (intent && intent.phase !== "prepared") {
              try {
                const ordinaryIds = intent.expected.filter(item => ["Reminder", "List"].includes(item.type)).map(item => item.id);
                const linkedIds = intent.expected.filter(item => !["Reminder", "List"].includes(item.type)).map(item => item.id);
                const ordinary = await client.lookup(ordinaryIds), linked = await client.lookupSchedulingRecords(linkedIds);
                if (!ordinary.complete || !linked.complete) throw new WriteOutcomeUnknownError(targetId);
                await verifyRecurringExpected(intent.expected, [...ordinary.records, ...linked.records], owner, intent.intrinsicParentGuards);
                if (intent.retired.length) {
                  const retired = await client.lookupSchedulingRecords(intent.retired);
                  if (retired.records.length || retired.unresolvedRecordNames.length || retired.recordErrors.length !== intent.retired.length ||
                    new Set(retired.recordErrors.map(error => error.recordName)).size !== intent.retired.length ||
                    retired.recordErrors.some(error => !error.recordName || !intent!.retired.includes(error.recordName) || !["UNKNOWN_ITEM", "NOT_FOUND"].includes(error.serverErrorCode))) throw new WriteOutcomeUnknownError(targetId);
                }
                records = [...ordinary.records, ...linked.records] as CloudKitRecord[]; replayed = true;
              } catch {
                if (intent.phase === "confirmed") throw new AppError("CONFLICT", "The previously completed occurrence has since changed; this request cannot be replayed.", 409);
                throw new WriteOutcomeUnknownError(targetId);
              }
            } else {
              if (current!.recordChangeTag !== input.recordChangeTag) throw new AppError("CONFLICT", "The active occurrence changed before completion.", 409);
              await requireNoChildren(client, owner, list, targetId);
              const graph = await loadSchedulingGraph({ ...current!, zoneID: current!.zoneID ?? { zoneName: "Reminders", ownerRecordName: owner } }, owner, ids => client.lookupSchedulingRecords(ids));
              const plan = await planRecurringCompletion(graph, list, owner, intent?.ids, intent?.timestamp ?? Date.now(), input.action, input.recurrenceCalendarTimeZone);
              if (intent && ((intent.mode ?? "advance") !== plan.mode || intent.sourceFingerprint !== plan.sourceFingerprint || canonicalJSON(intent.expected) !== canonicalJSON(plan.expected))) throw new AppError("CONFLICT", "The prepared recurring occurrence changed before dispatch.", 409);
              intent = { requestFingerprint, sourceFingerprint: plan.sourceFingerprint, timestamp: plan.timestamp, ids: plan.ids, expected: plan.expected, retired: plan.retired, phase: "prepared",
                ...(plan.mode === "advance" ? {} : { mode: plan.mode }),
                ...(plan.recurrenceCalendarTimeZone === undefined ? {} : { recurrenceCalendarTimeZone: plan.recurrenceCalendarTimeZone }),
                ...(plan.intrinsicParentGuards === undefined ? {} : { intrinsicParentGuards: plan.intrinsicParentGuards }) };
              saved.session.recurringIntents = await repository.checkpointRecurringIntent(fence, intent);
              records = await client.modifyRecurringCompletion(plan, async () => {
                await this.assertRemindersWrite(repository, fence);
                if (plan.mode === "advance" && Number(plan.active.fields.DueDate.value) <= Date.now()) throw new AppError("UNSUPPORTED_FEATURE", "The next recurring occurrence is now overdue; the retained request cannot skip it.");
                // Budget and lease gates must precede the durable dispatch marker.
                // Its own checkpoint CAS fences the current lease with >10s left;
                // no local gate may reject after it succeeds and before the POST.
                stage.dispatch();
                intent = { ...intent!, phase: "dispatched" };
                saved.session.recurringIntents = await repository.checkpointRecurringIntent(fence, intent);
                await this.requirePermission("reminders.write");
              });
              applied = true;
            }
            intent = { ...intent!, phase: "confirmed" };
            saved.session.recurringIntents = await repository.checkpointRecurringIntent(fence, intent);
            stage.confirm();
            const active = records.find(record => record.recordName === targetId)!;
            const history = intent.mode === undefined ? records.find(record => record.recordName === `Reminder/${intent!.ids.history}`)! : undefined;
            await repository.commitResume(fence, appleSuccess({ ...omitField(saved.session, "allOpenScan"), connection, auth: http.snapshot() }), "READY");
            return { generation: fence.generation, operation: input.action, replayed, record: omitField(normalizeReminder(active, owner), "raw"),
              ...(history ? { completedOccurrence: omitField(normalizeReminder(history, owner), "raw") } : {}),
              affectedRecords: (history ? [active, history] : [active]).map(record => omitField(normalizeReminder(record, owner), "raw")), writesEnabled: true as const };
          }
        }
        let inspectedFamily: LifecycleFamily | undefined;
        if (["complete", "reopen", "delete"].includes(input.action) && !hooks) {
          const action = input.action as "complete" | "reopen" | "delete";
          const target = { listId: input.listId, reminderId: targetId, recordChangeTag: (input as { recordChangeTag: string }).recordChangeTag };
          inspectedFamily = await inspectLifecycleFamily(client, action, target, current!, list, owner, true);
          if (inspectedFamily.records.some(record => normalizeReminder(record, owner).alarmIds?.length)) {
            const pairs = await loadScheduledFamilyPairs(client, inspectedFamily, owner);
            const plan = planScheduledFamilyLifecycle(action, target, inspectedFamily, pairs, list, owner);
            const confirmations = await client.modifyScheduledFamilyLifecycle(plan, async () => {
              await this.assertRemindersWrite(repository, fence); stage.dispatch();
            });
            applied = true; stage.confirm();
            const confirmed = confirmations.find(record => record.recordName === targetId)!;
            await repository.commitResume(fence, appleSuccess({ ...omitField(saved.session, "allOpenScan"), connection, auth: http.snapshot() }), "READY");
            return { generation: fence.generation, operation: input.action, replayed: false,
              record: omitField(normalizeReminder(confirmed, owner, true), "raw"),
              affectedRecords: plan.writes.map(write => omitField(normalizeReminder(confirmations.find(record => record.recordName === write.recordName)!, owner, true), "raw")),
              writesEnabled: true as const };
          }
        }
        let write: CloudKitWriteRecord;
        let confirmed: CloudKitRecord;
        let affectedRecords: CloudKitRecord[] | undefined;
        let replayed = false;
        const dispatch = async () => {
          await this.assertRemindersWrite(repository, fence);
          if (hooks) await hooks.beforeDispatch(write);
          await hooks?.assertDispatch();
          await this.assertRemindersWrite(repository, fence);
          stage.dispatch();
        };
        if (input.action === "create") {
          const create = omitField(omitField(input, "action"), "expectedGeneration");
          write = buildCreateReminder(create);
          if (current) {
            if (!matchesCreatedReminder(create, current, owner) || !current.recordChangeTag) throw new AppError("CONFLICT", "The create ID already exists with different content or state. Read that reminder; do not reuse this key for another item.", 409);
            confirmed = current; replayed = true;
          } else {
            confirmed = await client.modifyReminderCreation(write, list, dispatch);
            applied = true;
            if (!matchesCreatedReminder(create, confirmed, owner)) throw new WriteOutcomeUnknownError(targetId, input.idempotencyKey);
            verifyWriteFields(write, confirmed, confirmed, owner, input.listId);
            stage.confirm();
          }
        } else {
          const update = { listId: input.listId, reminderId: input.reminderId, recordChangeTag: input.recordChangeTag };
          let dependencies: SchedulingWrite[] = [], dependencyRecords: CloudKitRecord[] = [], guards: CloudKitRecord[] = [];
          let lifecycle: LifecyclePlan | undefined;
          if (input.action === "update" && hooks) {
            write = planBulkChange({ kind: "bulk_update", clientItemKey: "dispatch", input: { ...update, changes: input.changes } }, current!, owner);
            await requireNoChildren(client, owner, list, targetId);
            // Native membership changes must invalidate this exact List version;
            // a bulk edit never silently expands to a newly attached family.
            guards = [{ ...list, zoneID: list.zoneID ?? { zoneName: "Reminders", ownerRecordName: owner } }];
          } else if (input.action === "update") {
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
            if (hooks) {
              if (input.action === "delete") buildLifecycleReminder("delete", update, current!, owner);
              else if (input.action === "complete") planBulkChange({ kind: "bulk_complete", clientItemKey: "dispatch", input: update }, current!, owner);
              else throw new AppError("UNSUPPORTED_FEATURE", "This lifecycle action is not supported in bulk jobs.");
              await requireNoChildren(client, owner, list, targetId);
            }
            lifecycle = await planLifecycle(client, input.action, update, current!, list, owner, Date.now(), inspectedFamily);
            if (hooks && (lifecycle.records.length !== 1 || lifecycle.writes.length !== 1 ||
              lifecycle.records[0].recordName !== targetId || lifecycle.writes[0].recordName !== targetId)) {
              throw new AppError("UNSUPPORTED_FEATURE", "Bulk lifecycle changes authorize only the exact childless root; a discovered family cannot be cascaded.");
            }
            write = lifecycle.writes[0];
          }
          const confirmations = lifecycle ? input.action === "delete"
            ? await client.modifyLifecycleDeletion(lifecycle.writes, lifecycle.records, list, lifecycle.listWrite, dispatch, lifecycle.guards)
            : await client.modifyRecords(lifecycle.writes.map(record => ({ operationType: "update", record })), dispatch, lifecycle.guards) :
            hooks && input.action === "update" ? await client.modifyRecords([{ operationType: "update", record: write }], dispatch, guards) :
            dependencies.length || guards.length || ["AlarmIDs", "RecurrenceRuleIDs", "DueDateDeltaAlertsData"].some(key => Object.hasOwn(write.fields, key)) ? await client.modifyScheduling(write, dependencies, dispatch, guards) :
            [await client.modifyReminder("update", write, dispatch)];
          if (!("recordType" in confirmations[0])) throw new WriteOutcomeUnknownError(targetId);
          confirmed = confirmations[0];
          applied = true;
          if (lifecycle) {
            affectedRecords = lifecycle.writes.map(mutation => {
              const before = lifecycle!.records.find(record => record.recordName === mutation.recordName)!;
              const after = confirmations.find(record => record.recordName === mutation.recordName)!;
              if (!after || !("recordType" in after)) throw new WriteOutcomeUnknownError(mutation.recordName);
              const beforeReminder = normalizeReminder(before, owner), afterReminder = normalizeReminder(after, owner, true);
              const relationshipSet = (ids: string[] | null) => canonicalJSON([...new Set(ids ?? [])].sort());
              const detached = mutation.fields.List?.value === null;
              const expectedParent = mutation.fields.ParentReminder?.value === null ? null : beforeReminder.parentReminderId;
              if (afterReminder.listId !== (detached ? null : beforeReminder.listId) || afterReminder.parentReminderId !== expectedParent ||
                relationshipSet(afterReminder.alarmIds) !== relationshipSet(beforeReminder.alarmIds) ||
                relationshipSet(afterReminder.recurrenceRuleIds) !== relationshipSet(beforeReminder.recurrenceRuleIds) ||
                Object.keys(after.fields).some(field => /parent|child|subtask/i.test(field) && field !== "ParentReminder")) {
                throw new WriteOutcomeUnknownError(mutation.recordName);
              }
              if (input.action === "delete" && (Object.keys(after.fields).some(key => !Object.hasOwn(before.fields, key) && !Object.hasOwn(mutation.fields, key) && key !== "UrgentPresentationAlarmsAsData" && !isKnownEmptyDeletionCollection(key, after.fields[key])) ||
                (detached ? after.raw.parent !== undefined && after.raw.parent !== null : intrinsicParentIdentity(after, owner) !== intrinsicParentIdentity(before, owner)))) {
                throw new WriteOutcomeUnknownError(mutation.recordName);
              }
              const fields = (record: CloudKitRecord) => {
                const stable = input.action === "delete" ? stableDeletionFields(record.fields) : stableNativePresentation(record.fields);
                const token = stable.ResolutionTokenMap as { type?: string; value?: unknown } | undefined;
                return token?.type === "STRING" && typeof token.value === "string" ? { ...stable, ResolutionTokenMap: { ...token, value: canonicalJSON(JSON.parse(token.value)) } } : stable;
              };
              const beforeFields = fields(before), afterFields = fields(after);
              if (input.action === "delete" && [...new Set([...Object.keys(beforeFields), ...Object.keys(afterFields)])].some(key =>
                !Object.hasOwn(mutation.fields, key) && !(key === "UrgentPresentationAlarmsAsData" && !Object.hasOwn(beforeFields, key)) &&
                canonicalJSON(beforeFields[key] ?? null) !== canonicalJSON(afterFields[key] ?? null))) {
                throw new WriteOutcomeUnknownError(mutation.recordName);
              }
              verifyWriteFields(mutation, { ...after, fields: afterFields }, { ...before, fields: beforeFields }, owner, detached ? null : input.listId);
              return after;
            });
            if (lifecycle.listWrite) {
              const after = confirmations.find(record => record.recordName === list.recordName);
              if (!after || !("recordType" in after)) throw new WriteOutcomeUnknownError(targetId);
              const expected = { ...stableNativePresentation(list.fields), ...lifecycle.listWrite.fields };
              const actual = stableNativePresentation(after.fields);
              const canonicalFields = (fields: Record<string, unknown>) => {
                const token = fields.ResolutionTokenMap as { type: string; value: string };
                return canonicalJSON({ ...fields, ResolutionTokenMap: { ...token, value: JSON.parse(token.value) } });
              };
              if (canonicalFields(expected) !== canonicalFields(actual)) throw new WriteOutcomeUnknownError(targetId);
            }
          } else verifyWriteFields(write, confirmed, current!, owner, input.listId);
          for (const dependency of dependencies) {
            verifySchedulingWrite(dependency, dependencyRecords.find(record => record.recordName === dependency.recordName)!,
              confirmations.find(record => record.recordName === dependency.recordName)!, owner);
          }
          stage.confirm();
        }
        const record = omitField(normalizeReminder(confirmed, owner, true), "raw");
        const session = omitField(saved.session, "allOpenScan");
        // A confirmation and cookie save share the existing owner/generation
        // fence. A lost fence after dispatch reports uncertainty, not success.
        await repository.commitResume(fence, appleSuccess({ ...session, connection, auth: http.snapshot() }), "READY");
        return { generation: fence.generation, operation: input.action, replayed, record, writesEnabled: true,
          ...(affectedRecords ? { affectedRecords: affectedRecords.map(record => omitField(normalizeReminder(record, owner, true), "raw")) } : {}),
          ...(input.action === "create" ? { idempotencyKey: input.idempotencyKey } : {}) };
      }, appleRequestBudget(input.action === "complete" && !hooks ? 60_000 : 40_000), input.action === "complete" && !hooks ? 60_000 : 30_000);
    } catch (error) {
      if (applied || error instanceof WriteOutcomeUnknownError) throw new WriteOutcomeUnknownError(targetId, input.action === "create" ? input.idempotencyKey : undefined);
      throw error;
    }
  }
  async readOrganizationForMCP(expectedGeneration: number, listId: string, reminderId: string) {
    ReminderTargetInput.omit({ recordChangeTag: true }).parse({ listId, reminderId });
    return this.operation(expectedGeneration, "read-only", async (http, saved, repository, fence) => {
      const client = new CloudKitRemindersClient(http.http, requireRemindersConnection(saved.session));
      await this.authorizeLists(client, [listId]);
      const root = writeLookupRecord(await client.lookup([reminderId]), reminderId, false)!;
      const owner = client.remindersZoneOwner!;
      assertOwnedReminder(root, owner);
      if (normalizeReminder(root, owner).listId !== listId) throw new AppError("CONFLICT", "The reminder is no longer in the selected list.", 409);
      const related = await organizationRecords(client, root, owner);
      const organization = readReminderOrganization(root, related.attachments, related.hashtags, owner);
      await repository.commitResume(fence, appleSuccess({ ...saved.session, connection: { ...saved.session.connection, remindersZoneOwner: owner }, auth: http.snapshot() }), "READY");
      return { generation: fence.generation, ...organization };
    });
  }

  // Server-only duplication reads. Raw records remain within the encrypted
  // orchestration ledger and are never routed as public MCP data.
  async readDuplicationList(expectedGeneration: number, listId: string, allowMissing = false) {
    ListId.parse(listId);
    return this.operation(expectedGeneration, "read-only", async (http, saved, repository, fence) => {
      const client = new CloudKitRemindersClient(http.http, requireRemindersConnection(saved.session));
      if (client.remindersZoneOwner === undefined && !(await client.listZones()).available) throw new AppError("PROTOCOL_CHANGED", "No owned Reminders zone is available.");
      const current = writeLookupRecord(await client.lookup([listId]), listId, allowMissing);
      const record = current ? ownedListRecord(current, client.remindersZoneOwner!) : null;
      await repository.commitResume(fence, appleSuccess({ ...saved.session, connection: { ...saved.session.connection, remindersZoneOwner: client.remindersZoneOwner }, auth: http.snapshot() }), "READY");
      return { generation: fence.generation, record, zoneOwner: client.remindersZoneOwner! };
    });
  }

  async readDuplicationPage(expectedGeneration: number, listId: string, continuation: string | null, limit: number) {
    const input = ControlledRead.parse({ action: "reminders", expectedGeneration, listId, continuation, limit, includeCompleted: false });
    if (input.action !== "reminders") throw new AppError("VALIDATION_ERROR", "Use an exact duplication source list.", 400);
    return this.operation(expectedGeneration, "read-only", async (http, saved, repository, fence) => {
      const client = new CloudKitRemindersClient(http.http, requireRemindersConnection(saved.session));
      await this.authorizeLists(client, [input.listId]);
      const page = await client.queryRemindersPage(input);
      await repository.commitResume(fence, appleSuccess({ ...saved.session, connection: { ...saved.session.connection, remindersZoneOwner: client.remindersZoneOwner }, auth: http.snapshot() }), "READY");
      return { generation: fence.generation, page };
    });
  }

  async inspectDuplicationSource(expectedGeneration: number, listId: string, reminderId: string) {
    ReminderTargetInput.omit({ recordChangeTag: true }).parse({ listId, reminderId });
    return this.operation(expectedGeneration, "read-only", async (http, saved, repository, fence) => {
      const client = new CloudKitRemindersClient(http.http, requireRemindersConnection(saved.session));
      const [list] = await this.authorizeLists(client, [listId], true);
      const owner = client.remindersZoneOwner!;
      const record = writeLookupRecord(await client.lookup([reminderId]), reminderId, false)!;
      assertOwnedReminder(record, owner);
      if (normalizeReminder(record, owner).listId !== listId) throw new AppError("CONFLICT", "The duplication source moved to another list.", 409);
      await requireNoChildren(client, owner, list, reminderId);
      const related = await organizationRecords(client, record, owner);
      await repository.commitResume(fence, appleSuccess({ ...saved.session, connection: { ...saved.session.connection, remindersZoneOwner: owner }, auth: http.snapshot() }), "READY");
      return { generation: fence.generation, zoneOwner: owner, complete: true, record, children: [] as CloudKitRecord[], ...related };
    });
  }

  async observeDuplicationReminder(expectedGeneration: number, listId: string, reminderId: string) {
    ReminderTargetInput.omit({ recordChangeTag: true }).parse({ listId, reminderId });
    return this.operation(expectedGeneration, "read-only", async (http, saved, repository, fence) => {
      const client = new CloudKitRemindersClient(http.http, requireRemindersConnection(saved.session));
      if (client.remindersZoneOwner === undefined && !(await client.listZones()).available) throw new AppError("PROTOCOL_CHANGED", "No owned Reminders zone is available.");
      const owner = client.remindersZoneOwner!;
      const list = writeLookupRecord(await client.lookup([listId]), listId, true);
      if (list) ownedListRecord(list, owner);
      const record = writeLookupRecord(await client.lookup([reminderId]), reminderId, true);
      if (record) {
        assertOwnedReminder(record, owner);
        const normalized = normalizeReminder(record, owner, true);
        if (normalized.listId !== listId && !(normalized.deleted && normalized.listId === null)) throw new AppError("CONFLICT", "The observed copy no longer belongs to the duplication destination.", 409);
      }
      await repository.commitResume(fence, appleSuccess({ ...saved.session, connection: { ...saved.session.connection, remindersZoneOwner: owner }, auth: http.snapshot() }), "READY");
      return { generation: fence.generation, zoneOwner: owner, record };
    });
  }

  private async mutateOrganization(input: Extract<z.infer<typeof ReminderMutation>, { action: "set_url" | "set_tags" | "move" | "copy" }>, expectedRelationshipVersions?: Record<string, string>) {
    const targetId = input.action === "copy" ? `Reminder/${input.idempotencyKey.toUpperCase()}` : input.reminderId;
    let applied = false;
    try {
      return await this.operation(input.expectedGeneration, "mutation-preparation", async (http, saved, repository, fence, stage) => {
        const client = new CloudKitRemindersClient(http.http, requireRemindersConnection(saved.session));
        if (client.remindersZoneOwner === undefined && !(await client.listZones()).available) throw new AppError("PROTOCOL_CHANGED", "No owned Reminders zone is available.");
        const owner = client.remindersZoneOwner!;
        const transfer = input.action === "move" || input.action === "copy";
        const listIds = transfer ? [input.listId, input.destinationListId] : [input.listId];
        const found = await client.lookup([...listIds, ...new Set([input.reminderId, targetId])]);
        const lists = listIds.map(id => ownedListRecord(writeLookupRecord(found, id, false)!, owner));
        lists.forEach(list => requireMutableList(list, owner));
        let confirmed: CloudKitRecord, replayed = false;
        let listVersions: { listId: string; recordChangeTag: string }[] | undefined;
        const requestFingerprint = input.action === "copy" ? await fingerprint(omitField(input, "expectedGeneration")) : null;
        const intent = input.action === "copy" ? saved.session.copyIntents?.find(item => item.id === input.idempotencyKey.toLowerCase()) : undefined;
        if (intent && intent.requestFingerprint !== requestFingerprint) throw new AppError("CONFLICT", "This copy key belongs to different inputs. Reconcile its exact reminder ID.", 409);
        const candidate = input.action === "copy" ? writeLookupRecord(found, targetId, true) : null;
        if (input.action === "copy" && candidate) {
          if (!intent) throw new AppError("CONFLICT", "This copy identity already exists without a matching retained request.", 409);
          const related = await organizationRecords(client, candidate, owner);
          const organization = readReminderOrganization(candidate, related.attachments, related.hashtags, owner);
          if (normalizeReminder(candidate, owner).listId !== input.destinationListId ||
              await fingerprint(copyContents(candidate, organization, owner, input.destinationListId)) !== intent.contentFingerprint ||
              !normalizeList(lists[1]).reminderIds?.includes(targetId)) throw new AppError("CONFLICT", "The existing copy changed. Read and reconcile it before another request.", 409);
          await requireNoChildren(client, owner, lists[1], targetId);
          confirmed = candidate; replayed = true;
        } else {
          const current = writeLookupRecord(found, input.reminderId, false)!;
          assertOwnedReminder(current, owner);
          const normalized = normalizeReminder(current, owner);
          if (current.recordChangeTag !== input.recordChangeTag || normalized.listId !== input.listId) throw new AppError("CONFLICT", "The selected reminder changed before this request.", 409);
          const selected = input.action === "set_url" ? "url" : input.action === "set_tags" ? "tags" : undefined;
          const related = await organizationRecords(client, current, owner, selected);
          if (expectedRelationshipVersions) {
            const versions = Object.fromEntries([...related.attachments, ...related.hashtags].map(record => [record.recordName, record.recordChangeTag]));
            if (input.action !== "copy" || canonicalJSON(versions) !== canonicalJSON(expectedRelationshipVersions))
              throw new AppError("CONFLICT", "A source URL or tag version changed after duplication preflight.", 409);
          }
          const dispatch = async () => { await this.assertRemindersWrite(repository, fence); stage.dispatch(); };
          let confirmations: CloudKitRecord[];
          let write: CloudKitWriteRecord;
          if (input.action === "set_url" || input.action === "set_tags") {
            const plan = input.action === "set_url" ? planURLChange(current, related.attachments, { url: input.url }, owner, input.recordChangeTag) :
              planTagChange(current, related.hashtags, { tags: input.tags }, owner, input.recordChangeTag);
            write = plan.root;
            confirmations = await client.modifyOrganization(plan.root, plan.dependencies, plan.guards, dispatch);
            for (const dependency of plan.dependencies.filter(item => item.operationType === "update")) {
              const before = [...related.attachments, ...related.hashtags].find(record => record.recordName === dependency.record.recordName)!;
              const after = confirmations.find(record => record.recordName === before.recordName)!;
              verifyOrganizationPreservation(before, after, dependency.record.fields);
            }
          } else {
            const request = omitField(omitField(input, "action"), "expectedGeneration");
            const plan = planReminderTransfer(input.action, request, current, lists[0], lists[1], related.attachments, related.hashtags, owner);
            write = plan.root;
            await requireNoChildren(client, owner, lists[0], input.reminderId);
            if (input.action === "copy") {
              const organization = readReminderOrganization(current, related.attachments, related.hashtags, owner);
              const contentFingerprint = await fingerprint(copyContents(current, organization, owner, input.destinationListId));
              if (intent && intent.contentFingerprint !== contentFingerprint) throw new AppError("CONFLICT", "The original copy source changed before its unresolved attempt could be dispatched.", 409);
              saved.session.copyIntents = await repository.checkpointCopyIntent(fence, { id: input.idempotencyKey.toLowerCase(), requestFingerprint: requestFingerprint!, contentFingerprint });
            }
            confirmations = await client.modifyTransfer(input.action === "copy" ? "create" : "update", plan.root, plan.memberships, plan.listSnapshots,
              plan.dependencies, plan.guards, dispatch, input.listId);
            listVersions = listIds.map(listId => {
              const receipt = confirmations.find(record => record.recordName === listId);
              if (!receipt?.recordChangeTag) throw new WriteOutcomeUnknownError(targetId);
              return { listId, recordChangeTag: receipt.recordChangeTag };
            });
            for (const membership of plan.memberships) {
              verifyOrganizationPreservation(lists.find(list => list.recordName === membership.recordName)!,
                confirmations.find(record => record.recordName === membership.recordName)!, membership.fields);
            }
          }
          confirmed = confirmations.find(record => record.recordName === targetId)!;
          stage.confirm(); applied = true;
          const destination = transfer ? input.destinationListId : input.listId;
          if (input.action !== "copy") {
            const stable = { ...current, fields: stableNativePresentation(current.fields) };
            const fields = { ...stableNativePresentation(confirmed.fields) };
            for (const key of ["AttachmentIDs", "HashtagIDs"]) {
              const field = fields[key] as { type?: unknown; value?: unknown } | undefined;
              if (Object.hasOwn(write.fields, key) && field?.type === "UNKNOWN_LIST" && Array.isArray(field.value) && field.value.length === 0) fields[key] = { ...field, type: "STRING_LIST" };
            }
            verifyWriteFields(write, { ...confirmed, fields }, stable, owner, destination);
          }
        }
        await repository.commitResume(fence, appleSuccess({ ...omitField(omitField(saved.session, "allOpenScan"), "searchScan"),
          connection: { ...saved.session.connection, remindersZoneOwner: owner }, auth: http.snapshot() }), "READY");
        return { generation: fence.generation, operation: input.action, replayed, record: omitField(normalizeReminder(confirmed, owner), "raw"), writesEnabled: true,
          ...(listVersions ? { listVersions } : {}),
          ...(input.action === "copy" ? { idempotencyKey: input.idempotencyKey } : {}) };
      });
    } catch (error) {
      if (applied || error instanceof WriteOutcomeUnknownError) throw new WriteOutcomeUnknownError(targetId, input.action === "copy" ? input.idempotencyKey : undefined);
      throw error;
    }
  }

  private async mutateSubtask(input: Extract<z.infer<typeof ReminderMutation>, { action: "create_subtask" | "set_parent" }>) {
    const targetId = input.action === "create_subtask" ? `Reminder/${input.idempotencyKey.toUpperCase()}` : input.reminderId;
    let applied = false;
    try {
      return await this.operation(input.expectedGeneration, "mutation-preparation", async (http, saved, repository, fence, stage) => {
        const client = new CloudKitRemindersClient(http.http, requireRemindersConnection(saved.session));
        const authorizedLists = await this.authorizeLists(client, [input.listId], true);
        const current = writeLookupRecord(await client.lookup([targetId]), targetId, input.action === "create_subtask");
        const owner = client.remindersZoneOwner!;
        const list = authorizedLists.find(record => record.recordName === input.listId)!;
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
            const parents = await subtaskParents(client, owner, input.listId, null, input.parentReminder, list);
            confirmed = await client.modifyReminderCreation(write, list, async () => {
              await this.assertRemindersWrite(repository, fence); stage.dispatch();
            }, parents);
            stage.confirm(); applied = true;
            if (!matchesCreatedReminder(omitField(create, "parentReminder"), confirmed, owner, create.parentReminder.reminderId)) throw new WriteOutcomeUnknownError(targetId, input.idempotencyKey);
            verifyWriteFields(write, confirmed, confirmed, owner, input.listId);
          }
        } else {
          write = buildSetReminderParent(SetReminderParentInput.parse(omitField(omitField(input, "action"), "expectedGeneration")), current!, owner);
          const parents = await subtaskParents(client, owner, input.listId, current, input.parentReminder, list);
          confirmed = (await client.modifyRecords([{ operationType: "update", record: write }], async () => {
            await this.assertRemindersWrite(repository, fence); stage.dispatch();
          }, [...parents, list]))[0];
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
      const client = new CloudKitRemindersClient(http.http, requireRemindersConnection(saved.session));
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

  async readListAppearanceForMCP(expectedGeneration: number, listId: string) {
    const valid = RenameListInput.shape.listId.safeParse(listId);
    if (!valid.success) throw new AppError("VALIDATION_ERROR", "Supply an exact listId.", 400);
    return this.operation(expectedGeneration, "read-only", async (http, saved, repository, fence) => {
      const client = new CloudKitRemindersClient(http.http, requireRemindersConnection(saved.session));
      if (client.remindersZoneOwner === undefined && !(await client.listZones()).available)
        throw new AppError("PROTOCOL_CHANGED", "No owned Reminders zone is available.");
      const owner = client.remindersZoneOwner!;
      const current = ownedListRecord(writeLookupRecord(await client.lookup([listId]), listId, false)!, owner);
      requireMutableList(current, owner);
      await repository.commitResume(fence, appleSuccess({ ...saved.session,
        connection: { ...saved.session.connection, remindersZoneOwner: owner }, auth: http.snapshot() }), "READY");
      return { generation: fence.generation, listId, recordChangeTag: current.recordChangeTag!, ...readListAppearance(current.fields) };
    });
  }

  async mutateListAppearance(value: unknown) {
    requireAppleEnabled(this.env);
    const parsed = UpdateListAppearanceRequest.safeParse(value);
    if (!parsed.success) throw new AppError("VALIDATION_ERROR", "Provide a listId, current version, and at least one supported appearance change.", 400);
    const input = parsed.data;
    let applied = false;
    try {
      return await this.operation(input.expectedGeneration, "mutation-preparation", async (http, saved, repository, fence, stage) => {
        const client = new CloudKitRemindersClient(http.http, requireRemindersConnection(saved.session));
        if (client.remindersZoneOwner === undefined && !(await client.listZones()).available)
          throw new AppError("PROTOCOL_CHANGED", "No owned Reminders zone is available.");
        const owner = client.remindersZoneOwner!;
        const current = ownedListRecord(writeLookupRecord(await client.lookup([input.listId]), input.listId, false)!, owner);
        const write = buildUpdateListAppearance(omitField(input, "expectedGeneration"), current, owner);
        const confirmed = await client.modifyList("update", write, async () => {
          await this.assertRemindersWrite(repository, fence); stage.dispatch();
        });
        stage.confirm(); applied = true;
        const scoped = ownedListRecord(confirmed, owner);
        verifyListAppearanceUpdate(write, current, scoped, owner);
        await repository.commitResume(fence, appleSuccess({ ...omitField(saved.session, "allOpenScan"),
          connection: { ...saved.session.connection, remindersZoneOwner: owner }, auth: http.snapshot() }), "READY");
        return { generation: fence.generation, operation: "update" as const, listId: input.listId,
          recordChangeTag: scoped.recordChangeTag!, ...readListAppearance(scoped.fields), writesEnabled: true as const };
      });
    } catch (error) {
      if (applied || error instanceof WriteOutcomeUnknownError) throw new WriteOutcomeUnknownError(input.listId);
      throw error;
    }
  }

  async readReminderListSectionsForMCP(value: unknown) {
    const parsed = GetReminderListSectionsRequest.safeParse(value);
    if (!parsed.success || parsed.data.expectedGeneration === undefined) throw new AppError("VALIDATION_ERROR", "Supply an exact Standard list and session generation.", 400);
    const input = parsed.data, generation = input.expectedGeneration!, token = input.continuation ?? null;
    return this.operation(generation, "cursor-progress", async (http, saved, repository, fence) => {
      const permissionRevision = (await this.requirePermission("reminders.read")).revision;
      const previous = token === null ? undefined : saved.session.sectionScan;
      if (previous && (previous.permissionRevision ?? 0) !== permissionRevision)
        throw new AppError("CONFLICT", "Service permissions changed. Start a new section read.", 409);
      const accountHash = await accountScope(this.owner, saved.session.connection.dsid);
      if (token !== null && (!previous || previous.token !== token || previous.listId !== input.listId || previous.limit !== input.limit || previous.accountHash !== accountHash))
        throw new AppError("CONFLICT", "The section continuation was replaced, already used, or its scope changed.", 409);
      if (previous && (previous.expiresAt <= Date.now() || previous.pages >= 1000)) {
        await repository.commitResume(fence, omitField(saved.session, "sectionScan"), "READY");
        throw new AppError("RESTART_REQUIRED", "The section scan expired or reached its pagination budget. Start a new read.", 409);
      }
      const client = new CloudKitRemindersClient(http.http, requireRemindersConnection(saved.session));
      if (client.remindersZoneOwner === undefined && !(await client.listZones()).available) throw new AppError("PROTOCOL_CHANGED", "No owned Reminders zone is available.");
      const result = await readStandardSectionsPage(client, input.listId, {
        limit: input.limit, cursor: previous?.cursor, expectedListRecordChangeTag: previous?.listRecordChangeTag,
      });
      let session: AppleSession = omitField(saved.session, "sectionScan");
      let continuation: string | null = null;
      if (!result.complete) {
        if (!result.nativeContinuation) throw new AppError("PROTOCOL_CHANGED", "Apple omitted section pagination.");
        const marker = await fingerprint(result.nativeContinuation);
        if (previous?.seen.includes(marker)) {
          await repository.commitResume(fence, session, "READY");
          throw new AppError("PROTOCOL_CHANGED", "Apple repeated section pagination. Start a new read.");
        }
        continuation = crypto.randomUUID();
        session = { ...session, sectionScan: { permissionRevision, token: continuation, expiresAt: previous?.expiresAt ?? Math.min(Date.now() + 600000, saved.session.login.expiresAt),
          accountHash, listId: input.listId, listRecordChangeTag: result.listRecordChangeTag, limit: input.limit, cursor: result.nativeContinuation,
          seen: [...previous?.seen ?? [], marker], pages: (previous?.pages ?? 0) + 1 } };
      }
      await repository.commitResume(fence, appleSuccess({ ...session, connection: { ...session.connection, remindersZoneOwner: client.remindersZoneOwner }, auth: http.snapshot() }), "READY");
      const safe = omitField(result, "nativeContinuation");
      return { ...safe, generation: fence.generation, listId: input.listId, paginationComplete: result.complete, continuation,
        pendingReason: result.complete ? null : "continuation" as const, pagesRead: (previous?.pages ?? 0) + 1 };
    });
  }

  async readShoppingCategoriesForMCP(value: unknown) {
    const parsed = GetShoppingCategoriesRequest.safeParse(value);
    if (!parsed.success || parsed.data.expectedGeneration === undefined) throw new AppError("VALIDATION_ERROR", "Supply an exact Shopping list and session generation.", 400);
    const input = parsed.data, generation = input.expectedGeneration!, token = input.continuation ?? null;
    return this.operation(generation, "cursor-progress", async (http, saved, repository, fence) => {
      const permissionRevision = (await this.requirePermission("reminders.read")).revision;
      const previous = token === null ? undefined : saved.session.categoryScan;
      if (previous && (previous.permissionRevision ?? 0) !== permissionRevision) throw new AppError("CONFLICT", "Service permissions changed. Start a new category read.", 409);
      const accountHash = await accountScope(this.owner, saved.session.connection.dsid);
      if (token !== null && (!previous || previous.token !== token || previous.listId !== input.listId || previous.limit !== input.limit || previous.accountHash !== accountHash))
        throw new AppError("CONFLICT", "The category continuation was replaced, already used, or its scope changed.", 409);
      if (previous && (previous.expiresAt <= Date.now() || previous.pages >= 1000)) {
        await repository.commitResume(fence, omitField(saved.session, "categoryScan"), "READY");
        throw new AppError("RESTART_REQUIRED", "The category scan expired or reached its pagination budget. Start a new read.", 409);
      }
      const client = new CloudKitRemindersClient(http.http, requireRemindersConnection(saved.session));
      if (client.remindersZoneOwner === undefined && !(await client.listZones()).available) throw new AppError("PROTOCOL_CHANGED", "No owned Reminders zone is available.");
      const owner = client.remindersZoneOwner!;
      const list = ownedListRecord(writeLookupRecord(await client.lookup([input.listId]), input.listId, false)!, owner);
      const normalized = requireShoppingList(list, owner);
      const state = await loadShoppingAssets(client, list);
      const page = await client.queryListSectionsPage({ continuation: previous?.cursor, limit: input.limit });
      const ids = new Set([...state.memberships.memberships.map(entry => `ListSection/${entry.groupID}`), ...state.ordering.orderedIdentifiers.map(id => `ListSection/${id}`)]);
      for (const candidate of page.records) if ("recordType" in candidate && !candidate.deleted && referenceField(candidate, "List", "List", owner) === input.listId) ids.add(candidate.recordName);
      if (ids.size > 200) throw new AppError("UNSUPPORTED_FEATURE", "The selected Shopping list exceeds its category inspection budget.");
      const categories: ReturnType<typeof categorySummary>[] = [];
      const selected = [...ids];
      for (let index = 0; index < selected.length; index += 32) {
        const names = selected.slice(index, index + 32), found = await client.lookupListSections(names);
        for (const id of names) {
          const current = writeLookupRecord(found, id, true);
          if (!current || current.deleted || (current.fields.Deleted as { value?: unknown })?.value === 1) continue;
          const scoped = { ...current, zoneID: current.zoneID ?? { zoneName: "Reminders", zoneType: "REGULAR_CUSTOM_ZONE", ownerRecordName: owner } };
          // Change feeds can contain old metadata. Current ownership decides what is returned.
          if (referenceField(scoped, "List", "List", owner) !== input.listId) continue;
          categories.push(categorySummary(scoped, owner, input.listId));
        }
      }
      const categoryIds = new Set(categories.map(category => category.categoryId));
      const memberIds = new Set(normalized.reminderIds ?? []);
      const memberships = state.memberships.memberships.filter(entry => memberIds.has(`Reminder/${entry.memberID}`) && categoryIds.has(`ListSection/${entry.groupID}`))
        .map(entry => ({ reminderId: `Reminder/${entry.memberID}`, categoryId: `ListSection/${entry.groupID}` }));
      const latestList = ownedListRecord(writeLookupRecord(await client.lookup([input.listId]), input.listId, false)!, owner);
      requireShoppingList(latestList, owner, list.recordChangeTag);
      let session: AppleSession = omitField(saved.session, "categoryScan");
      let continuation: string | null = null;
      if (!page.complete) {
        const marker = await fingerprint(page.continuation);
        if (previous?.seen.includes(marker)) {
          await repository.commitResume(fence, session, "READY");
          throw new AppError("PROTOCOL_CHANGED", "Apple repeated category pagination. Start a new read.");
        }
        continuation = crypto.randomUUID();
        session = { ...session, categoryScan: { permissionRevision, token: continuation, expiresAt: previous?.expiresAt ?? Math.min(Date.now() + 600000, saved.session.login.expiresAt),
          accountHash, listId: input.listId, limit: input.limit, cursor: page.continuation!, seen: [...previous?.seen ?? [], marker], pages: (previous?.pages ?? 0) + 1 } };
      }
      await repository.commitResume(fence, appleSuccess({ ...session, connection: { ...session.connection, remindersZoneOwner: owner }, auth: http.snapshot() }), "READY");
      const locale = list.fields.GroceryLocaleID as { type?: unknown; value?: unknown } | undefined;
      return { generation: fence.generation, listId: input.listId, listRecordChangeTag: list.recordChangeTag!,
        locale: locale?.type === "STRING" && typeof locale.value === "string" ? locale.value : null,
        categories, memberships, orderedCategoryIds: state.ordering.orderedIdentifiers.map(id => `ListSection/${id}`).filter(id => categoryIds.has(id)),
        complete: page.complete, paginationComplete: page.complete, continuation, pendingReason: page.complete ? null : "continuation" as const,
        pagesRead: (previous?.pages ?? 0) + 1, writesEnabled: true };
    });
  }

  async setShoppingCategory(value: unknown) {
    requireAppleEnabled(this.env);
    const parsed = SetShoppingCategoryRequest.safeParse(value);
    if (!parsed.success) throw new AppError("VALIDATION_ERROR", "Supply the exact reminder, Shopping list and destination category versions.", 400);
    const input = parsed.data;
    let applied = false;
    try {
      return await this.operation(input.expectedGeneration, "mutation-preparation", async (http, saved, repository, fence, stage) => {
        const client = new CloudKitRemindersClient(http.http, requireRemindersConnection(saved.session));
        if (client.remindersZoneOwner === undefined && !(await client.listZones()).available) throw new AppError("PROTOCOL_CHANGED", "No owned Reminders zone is available.");
        const owner = client.remindersZoneOwner!;
        const list = ownedListRecord(writeLookupRecord(await client.lookup([input.listId]), input.listId, false)!, owner);
        requireShoppingList(list, owner, input.listRecordChangeTag);
        const root = writeLookupRecord(await client.lookup([input.reminderId]), input.reminderId, false)!;
        assertOwnedReminder(root, owner);
        if (root.recordChangeTag !== input.recordChangeTag) throw new AppError("CONFLICT", "The reminder version changed.", 409);
        const found = writeLookupRecord(await client.lookupListSections([input.categoryId]), input.categoryId, false)!;
        const category = { ...found, zoneID: found.zoneID ?? { zoneName: "Reminders", zoneType: "REGULAR_CUSTOM_ZONE", ownerRecordName: owner } };
        categorySummary(category, owner, input.listId, input.categoryRecordChangeTag);
        const state = await loadShoppingAssets(client, list, true);
        const plan = await planShoppingCategory(input, root, list, category, state, owner);
        await requireNoChildren(client, owner, list, input.reminderId);
        const uploaded = await client.uploadSectionAssets(list, plan.data);
        const fields: ListWrite["fields"] = { ...plan.fields, MembershipsOfRemindersInSectionsAsData: { type: "ASSETID", value: uploaded.MembershipsOfRemindersInSectionsAsData },
          GroceryLocalCorrectionsAsData: { type: "ASSETID", value: uploaded.GroceryLocalCorrectionsAsData } };
        const result = await client.modifyShoppingCategory(plan.rootWrite, { recordName: list.recordName, recordType: "List", recordChangeTag: list.recordChangeTag, fields }, category,
          async () => { await this.assertRemindersWrite(repository, fence); stage.dispatch(); });
        stage.confirm(); applied = true;
        const confirmedRoot = result.find(record => record.recordName === root.recordName)!, confirmedList = result.find(record => record.recordName === list.recordName)!;
        const categoryReceipt = result.find(record => record.recordName === category.recordName)!;
        const confirmedCategory = { ...categoryReceipt, zoneID: categoryReceipt.zoneID ?? { zoneName: "Reminders", zoneType: "REGULAR_CUSTOM_ZONE", ownerRecordName: owner } };
        verifyShoppingPreservation(root, confirmedRoot, Object.keys(plan.rootWrite.fields), owner);
        verifyShoppingPreservation(list, confirmedList, Object.keys(fields), owner);
        verifyShoppingPreservation(category, confirmedCategory, [], owner);
        for (const key of ["MembershipsOfRemindersInSectionsAsData", "GroceryLocalCorrectionsAsData"]) {
          const observed = confirmedList.fields[key] as { type?: unknown; value?: Record<string, unknown> } | undefined;
          const submitted = fields[key].value as Record<string, unknown>;
          if (observed?.type !== "ASSETID" || !observed.value || ["fileChecksum", "wrappingKey", "referenceChecksum", "size"].some(name => observed.value![name] !== submitted[name]))
            throw new WriteOutcomeUnknownError(input.reminderId);
        }
        for (const [before, after, write] of [[root, confirmedRoot, plan.rootWrite.fields], [list, confirmedList, fields]] as const) {
          for (const [key, expected] of Object.entries(write)) {
            if (key.endsWith("AsData")) continue;
            if (canonicalJSON(canonicalNativeJSONField(key, expected)) !== canonicalJSON(canonicalNativeJSONField(key, after.fields[key])))
              throw new WriteOutcomeUnknownError(before.recordName);
          }
        }
        const after = await loadShoppingAssets(client, confirmedList, true);
        if (canonicalJSON(after.memberships) !== canonicalJSON(plan.memberships) || canonicalJSON(after.corrections) !== canonicalJSON(plan.corrections)) throw new WriteOutcomeUnknownError(input.reminderId);
        await repository.commitResume(fence, appleSuccess({ ...omitField(omitField(saved.session, "allOpenScan"), "categoryScan"),
          connection: { ...saved.session.connection, remindersZoneOwner: owner }, auth: http.snapshot() }), "READY");
        return { generation: fence.generation, operation: "set_category" as const, listId: input.listId, listRecordChangeTag: confirmedList.recordChangeTag!,
          category: categorySummary(confirmedCategory, owner, input.listId), record: omitField(normalizeReminder(confirmedRoot, owner, true), "raw"), writesEnabled: true as const };
      });
    } catch (error) {
      if (applied || error instanceof WriteOutcomeUnknownError) throw new WriteOutcomeUnknownError(input.reminderId);
      throw error;
    }
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
        const client = new CloudKitRemindersClient(http.http, requireRemindersConnection(saved.session));
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
              await this.assertRemindersWrite(repository, fence); stage.dispatch();
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
              if (page.paginationComplete && page.continuation === null) {
                if (!page.complete) throw new AppError("UNSUPPORTED_FEATURE", "List contents could not be checked completely.");
                continuation = null; break;
              }
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
            await this.assertRemindersWrite(repository, fence); stage.dispatch();
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

  private async operation<T>(expectedGeneration: number, mode: OperationMode, run: (http: AppleAuthHTTP, saved: Awaited<ReturnType<AppleSessionRepository["load"]>>, repository: AppleSessionRepository, fence: ResumeFence, stage: OperationStage) => Promise<T>, budget = appleRequestBudget(), readLeaseMs: 30_000 | 60_000 = 30_000) {
    requireAppleEnabled(this.env);
    const permission = mode === "mutation-preparation" ? "reminders.write" : "reminders.read";
    const preferences = mode === "pcs" ? null : await this.requirePermission(permission);
    if (mode === "pcs" && !(await new ServiceSettingsRepository(this.env, this.owner).load()).settings.reminders.enabled) throw new AppError("FORBIDDEN", "Reminders is disabled in Services.", 403);
    const repository = new AppleSessionRepository(this.env, this.owner);
    const renewal = new AppleSessionRenewal(this.env, repository);
    for (let attempt = 0; attempt < 2; attempt++) {
      const saved = mode === "snapshot" ? await repository.load() : await renewal.ensure(expectedGeneration, budget);
      if (saved.fence.generation !== expectedGeneration) throw new AppError("CONFLICT", "The Apple connection changed before this operation.", 409);
      if (budget.deadline <= Date.now()) throw new AppError("UPSTREAM_UNAVAILABLE", "The Apple request deadline was reached.", 503, true);
      if (mode === "pcs" && sessionServices(saved.session, saved.state, saved.action).reminders.state === "DEVICE_APPROVAL_PENDING" && Date.now() < saved.session.pcs.nextAttemptAt) throw new AppError("RATE_LIMITED", "Wait until the displayed retry time before checking approval.", 429, true);
      requireRemindersConnection(saved.session);
      if (mode !== "pcs") requireServiceReady(saved.session, saved.state, "reminders", saved.action);
      const fence = mode === "pcs" ? await repository.claimRenewal(expectedGeneration, saved.fence.version) : await repository.claimRead(expectedGeneration, saved.fence.version, readLeaseMs);
      // Each upstream read is checked again, including multi-page preparation.
      const send: typeof fetch = async (input, init) => {
        if (mode !== "pcs") {
          const current = await this.requirePermission(permission);
          if (current.revision !== preferences!.revision) throw new AppError("CONFLICT", "Service permissions changed before dispatch. Start a new request.", 409);
          const url = new URL(typeof input === "object" && "url" in input ? input.url : String(input));
          // This combined query must remain the last asynchronous gate before
          // fetch, including after graph hooks and durable dispatch checkpoints.
          await repository.assertRemindersTransport(fence, preferences!, url.pathname.endsWith("/records/modify"));
        }
        return fetch(input, init);
      };
      const http = AppleAuthHTTP.restore(saved.session.auth, send, AbortSignal.timeout(budget.deadline - Date.now()));
      const stage: OperationStage = {
        phase: mode,
        dispatch() {
          if (budget.deadline - Date.now() < 9000) throw new AppError("CONFLICT", "The complete request budget is too short for a write. No mutation was dispatched.", 409, true);
          this.phase = "mutation-dispatch";
        },
        confirm() { this.phase = "mutation-confirmation"; },
      };
      let recover = false;
      try {
        const result = await run(http, saved, repository, fence, stage);
        if (mode !== "pcs" && (await this.requirePermission(permission)).revision !== preferences!.revision) {
          throw new AppError("CONFLICT", "Service permissions changed before releasing the result. Start a new request.", 409);
        }
        return result;
      }
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
  async approveReminders(expectedGeneration: number, restartApproval = false) {
    return this.resume(expectedGeneration, restartApproval);
  }
  async resume(expectedGeneration: number, restartApproval = false) {
    requireAppleEnabled(this.env);
    if (!(await new ServiceSettingsRepository(this.env, this.owner).load()).settings.reminders.enabled) throw new AppError("FORBIDDEN", "Enable Reminders in Services before approving Apple access.", 403);
    const repository = new AppleSessionRepository(this.env, this.owner);
    const initial = await repository.load();
    if (initial.fence.generation !== expectedGeneration) throw new AppError("CONFLICT", "The Apple connection changed.", 409);
    if (sessionServices(initial.session, initial.state, initial.action).reminders.state === "READY") return this.status();
    if (!initial.session.connection.cloudKitURL) await new AppleSessionRenewal(this.env, repository).ensure(expectedGeneration, appleRequestBudget(), true);
    await this.operation(expectedGeneration, "pcs", async (http, saved, repository, fence) => {
      const existing = sessionServices(saved.session, saved.state, saved.action).reminders;
      const pending = existing.state === "DEVICE_APPROVAL_PENDING";
      if (pending && saved.session.pcs.expiresAt <= Date.now() && !restartApproval) throw new AppError("RESTART_REQUIRED", "This Reminders approval attempt expired. Use Check Apple approval to start a new bounded attempt; the Apple account connection is preserved.", 409);
      const checkpoint = !pending || restartApproval || saved.session.pcs.expiresAt <= Date.now() ? freshPcsCheckpoint() : saved.session.pcs;
      const result = await advancePcs(http, saved.session.connection.dsid, checkpoint, Date.now(), "reminders", async () => {
        if (!(await new ServiceSettingsRepository(this.env, this.owner).load()).settings.reminders.enabled) throw new AppError("FORBIDDEN", "Reminders was disabled before Apple approval.", 403);
        await repository.assertAccountLease(fence);
      });
      await repository.commitResume(fence, appleSuccess({ ...saved.session, auth: http.snapshot(), pcs: result.checkpoint,
        services: { ...sessionServices(saved.session, saved.state, saved.action), reminders: { state: result.state, pcs: result.checkpoint,
          ...(result.state === "DEVICE_APPROVAL_PENDING" ? { action: result.action } : {}) } },
        renewal: { ...(saved.session.renewal ?? renewalCheckpoint()), requiredAction: result.state === "READY" ? null : "approve-reminders", lastErrorCode: null } }), result.state, result.state === "DEVICE_APPROVAL_PENDING" ? result.action : undefined);
    });
    return this.status();
  }
  private async fetchDirectLists(http: AppleAuthHTTP, session: AppleSession) {
    const client = new CloudKitRemindersClient(http.http, requireRemindersConnection(session));
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
      const permissionRevision = (await this.requirePermission("reminders.read")).revision;
      let scan: AllOpenScan;
      if (continuation) {
        if ((session.allOpenScan?.permissionRevision ?? 0) !== permissionRevision) throw new AppError("CONFLICT", "Service permissions changed. Start a new all-open read.", 409);
        if (!session.allOpenScan || session.allOpenScan.token !== continuation) throw new AppError("CONFLICT", "The all-open continuation was replaced or already used. Restart the all-open read.", 409);
        if (session.allOpenScan.expiresAt <= Date.now()) {
          await repository.commitResume(fence, { ...session, allOpenScan: undefined }, "READY");
          throw new AppError("RESTART_REQUIRED", "The ten-minute all-open read expired. Start a new all-open read.", 409);
        }
        scan = { ...session.allOpenScan, token: crypto.randomUUID() };
      } else {
        const lists = session.savedLists ?? [];
        scan = { permissionRevision, source: "direct-cloudkit-query", lists: lists.filter(list => !list.deleted && !list.isGroup), token: crypto.randomUUID(), expiresAt: Math.min(Date.now() + 600_000, session.login.expiresAt), listIds: lists.filter(list => !list.deleted && !list.isGroup).map(list => list.id), index: 0, cursor: null, seen: [], listPages: 0, totalPages: 0, caughtUpAt: session.directListSnapshot!.updatedAt };
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
      if (scan && (scan.permissionRevision ?? 0) !== (await this.requirePermission("reminders.read")).revision) throw new AppError("CONFLICT", "Service permissions changed. Start a new all-open read.", 409);
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
        const client = new CloudKitRemindersClient(http.http, requireRemindersConnection(session));
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
    if ((await this.requirePermission("reminders.read")).revision !== (scan.permissionRevision ?? 0)) throw new AppError("CONFLICT", "Service permissions changed during the read. Start a new read.", 409);
    return { result: resultFor(), generation: expectedGeneration, liveReadValidated: false, writesEnabled: appleGates(this.env).enabled };
  }
  async collectRemindersForMCP(value: z.input<typeof ReminderCollectionInput>, expectedGeneration: number, format?: "json" | "csv") {
    const input = ReminderCollectionInput.parse(value);
    const preferences = await this.requirePermission("reminders.read");
    try {
      const collection = await collectReminders({ input, maxPages: 25, maxReminders: 1000, maxBytes: 524288, maxDurationMs: 30000,
        searchPage: async ({ filters, continuation, remainingReminders }) => {
          // Keep the cursor's page size unchanged. Refuse another page when its
          // full budget would not fit, rather than silently over-reading.
          if (remainingReminders < 100) throw new ReminderCollectionError("The remaining scan budget cannot fit another page. Narrow the search; no partial result is available.");
          const response = await this.searchRemindersForMCP({ ...filters, expectedGeneration, continuation, limit: 100 }, remainingReminders);
          // Search's complete flag covers the entire scan. The collector's
          // complete flag means this page has no unresolved errors.
          return { generation: response.generation, result: { ...response.result, records: response.result.records as unknown as CollectedReminder[], complete: response.result.recordErrors.length === 0 } };
        } });
      if ((await this.requirePermission("reminders.read")).revision !== preferences.revision)
        throw new AppError("CONFLICT", "Service permissions changed during collection. Start a new request.", 409);
      const metadata = { generation: collection.generation, pagesRead: collection.pagesRead, complete: true as const,
        consistency: "live-pages-not-snapshot" as const, view: input.view, timeZone: input.timeZone,
        referenceInstant: input.referenceInstant, upcomingDays: input.upcomingDays, sortBy: input.sortBy };
      if (format) return { ...metadata, format, count: collection.records.length,
        content: exportReminderCollection(collection, { format, maxBytes: 524288 }) };
      return { ...metadata, records: collection.records };
    } catch (error) {
      if (error instanceof ReminderCollectionError) throw new AppError("UNSUPPORTED_FEATURE", error.message);
      throw error;
    }
  }

  async searchRemindersForMCP(input: z.input<typeof SearchReminderInput>, maxScannedRecords?: number) {
    const request = SearchReminderInput.parse(input);
    const expectedGeneration = request.expectedGeneration;
    if (expectedGeneration === undefined) throw new AppError("VALIDATION_ERROR", "The expected Apple session generation is required.", 400);
    const filters = SearchFilters.parse({ text: request.text, status: request.status, flagged: request.flagged,
      priority: request.priority, dueFrom: request.dueFrom, dueTo: request.dueTo, listId: request.listId,
      tags: request.tags, tagMatch: request.tagMatch, hasTags: request.hasTags, hasUrl: request.hasUrl, urlText: request.urlText }) as ReminderSearchFilters;
    const filterHash = await fingerprint({ filters, limit: request.limit });
    const token = request.continuation ?? null;
    if (token !== null && !z.string().uuid().safeParse(token).success) throw new AppError("VALIDATION_ERROR", "The search continuation is invalid.", 400);
    if (token !== null) {
      const repository = new AppleSessionRepository(this.env, this.owner);
      const saved = await repository.load();
      const scan = saved.session.searchScan;
      if (!scan || saved.fence.generation !== expectedGeneration || scan.token !== token || scan.filtersHash !== filterHash || scan.inventoryHash !== await fingerprint(scan.listIds))
        throw new AppError("CONFLICT", "The search continuation was replaced, already used, or its options changed. Start a new search or use the latest continuation with the same options.", 409);
      if (scan.accountHash !== await accountScope(this.owner, saved.session.connection.dsid))
        throw new AppError("CONFLICT", "The Apple account changed during this search. Start a new search.", 409);
      if (scan.expiresAt <= Date.now()) {
        const fence = await repository.claimRead(expectedGeneration, saved.fence.version);
        try { await repository.commitResume(fence, omitField(saved.session, "searchScan"), "READY"); }
        finally { await repository.releaseResume(fence); }
        throw new AppError("RESTART_REQUIRED", "The ten-minute search expired. Start a new search; the Apple account is preserved.", 409);
      }
    }
    return this.operation(expectedGeneration, "cursor-progress", async (http, saved, repository, fence) => {
      let session = saved.session;
      const permissionRevision = (await this.requirePermission("reminders.read")).revision;
      let scan: SearchScan;
      if (token !== null) {
        if ((session.searchScan?.permissionRevision ?? 0) !== permissionRevision) throw new AppError("CONFLICT", "Service permissions changed. Start a new search.", 409);
        const current = session.searchScan;
        if (!current || current.token !== token || current.filtersHash !== filterHash || current.inventoryHash !== await fingerprint(current.listIds) || current.accountHash !== await accountScope(this.owner, session.connection.dsid))
          throw new AppError("CONFLICT", "The search continuation changed during this request. Start a new search.", 409);
        if (current.expiresAt <= Date.now()) {
          await repository.commitResume(fence, omitField(session, "searchScan"), "READY");
          throw new AppError("RESTART_REQUIRED", "The ten-minute search expired. Start a new search.", 409);
        }
        scan = current;
      } else {
        let listIds: string[];
        if (filters.listId !== undefined) {
          const client = new CloudKitRemindersClient(http.http, requireRemindersConnection(session));
          await this.authorizeLists(client, [filters.listId]);
          session = { ...session, connection: { ...session.connection, remindersZoneOwner: client.remindersZoneOwner } };
          listIds = [filters.listId];
        } else {
          session = (await this.fetchDirectLists(http, session)).session;
          listIds = (session.savedLists ?? []).filter(list => !list.deleted && !list.isGroup).map(list => list.id);
        }
        scan = {
          permissionRevision, token: crypto.randomUUID(), expiresAt: Math.min(Date.now() + 600_000, session.login.expiresAt),
          accountHash: await accountScope(this.owner, session.connection.dsid), filtersHash: filterHash,
          inventoryHash: await fingerprint(listIds), listIds, index: 0, cursor: null, seen: [], listPages: 0, totalPages: 0,
        };
      }
      if (scan.totalPages >= 10_000 || scan.listPages >= 1_000) {
        if (token !== null) await repository.commitResume(fence, omitField(session, "searchScan"), "READY");
        throw new AppError("UNSUPPORTED_FEATURE", "The search reached its safe pagination limit. Start a narrower search.", 409);
      }

      const records: Record<string, unknown>[] = [];
      let pagesRead = 0;
      let scannedRecords = 0;
      let next = scan;
      if (scan.index < scan.listIds.length) {
        const listId = scan.listIds[scan.index];
        const client = new CloudKitRemindersClient(http.http, requireRemindersConnection(session));
        let page: CloudKitPage;
        try {
          page = await client.queryRemindersPage({ listId, includeCompleted: filters.status !== "open", limit: request.limit, continuation: scan.cursor, projection: "search" });
        } catch (error) {
          // Malformed native pagination cannot be repaired by replaying the
          // same token. Retire this search, while transient failures keep the
          // current token available for a safe retry.
          if (token !== null && error instanceof AppError && error.code === "PROTOCOL_CHANGED")
            await repository.commitResume(fence, omitField(session, "searchScan"), "READY");
          throw error;
        }
        pagesRead = 1;
        scannedRecords = page.records.filter(record => record.recordName.startsWith("Reminder/")).length;
        if (maxScannedRecords !== undefined && scannedRecords > maxScannedRecords)
          throw new AppError("UNSUPPORTED_FEATURE", "The search page exceeded the remaining scanned-reminder budget. Narrow the search.");
        if (page.recordErrors.length) {
          if (page.recordErrors.some(error => ["AUTHENTICATION_REQUIRED", "NOT_AUTHENTICATED", "INVALID_AUTH_TOKEN", "AUTHENTICATION_FAILED"].includes(error.serverErrorCode.toUpperCase())))
            throw new AppError("REAUTH_REQUIRED", "Apple rejected the reminder search. Reconnect your Apple account.", 409);
          if (page.recordErrors.some(error => ["ACCESS_DENIED", "PERMISSION_FAILURE", "PERMISSION_DENIED"].includes(error.serverErrorCode.toUpperCase())))
            throw new AppError("FORBIDDEN", "Apple denied access to a list in this search.", 403);
          if (page.recordErrors.some(error => ["THROTTLED", "REQUEST_RATE_LIMITED", "ZONE_BUSY"].includes(error.serverErrorCode.toUpperCase()))) throw new CloudKitRateLimitedError(null);
          throw new AppError("UPSTREAM_UNAVAILABLE", "Apple returned reminder record errors. This page was not acknowledged; retry with the same continuation or restart the search.", 503, true);
        }
        const candidates: { record: CloudKitRecord; reminder: ReturnType<typeof normalizeReminder> }[] = [];
        for (const record of page.records) {
          if (!("recordType" in record) || record.recordType !== "Reminder" || record.deleted) continue;
          const reminder = normalizeReminder(record, client.remindersZoneOwner);
          if (!matchesReminderSearch(reminder, filters)) continue;
          if (reminder.listId !== listId) throw new AppError("PROTOCOL_CHANGED", "Apple returned a search reminder outside the authorized selected list.");
          candidates.push({ record, reminder });
        }

        const needsTags = filters.tags !== undefined || filters.hasTags !== undefined;
        const needsURL = filters.hasUrl !== undefined || filters.urlText !== undefined;
        const selected: OrganizationFilterSelection[] = [...(needsTags ? ["tags" as const] : []), ...(needsURL ? ["url" as const] : [])];
        const selectedIds = new Map<OrganizationFilterSelection, string[]>();
        const selectedSets = new Map<OrganizationFilterSelection, Set<string>>();
        for (const kind of selected) { selectedIds.set(kind, []); selectedSets.set(kind, new Set()); }
        for (const candidate of candidates) for (const kind of selected) {
          const ids = reminderOrganizationIds(candidate.record, client.remindersZoneOwner!, kind);
          const requested = selectedIds.get(kind)!;
          const seen = selectedSets.get(kind)!;
          for (const id of ids) if (!seen.has(id)) { seen.add(id); requested.push(id); }
        }
        const uniqueRelatedIds = [...selectedIds.values()].reduce((count, ids) => count + ids.length, 0);
        const batches = selected.flatMap(kind => {
          const ids = selectedIds.get(kind)!;
          return Array.from({ length: Math.ceil(ids.length / 32) }, (_, index) => ({ kind, ids: ids.slice(index * 32, (index + 1) * 32) }));
        });
        if (uniqueRelatedIds > 256 || batches.length > 8) {
          throw new AppError("UNSUPPORTED_FEATURE", "Selected tag or URL relationships exceed the search hydration budget. Use a smaller result limit or narrower filters.");
        }
        const relatedByName = new Map<string, CloudKitRecord>();
        let relationshipBytes = 0;
        for (const batch of batches) {
          const type = batch.kind === "url" ? "Attachment" : "Hashtag";
          const names = batch.ids.map(id => `${type}/${id}`);
          const found = batch.kind === "url" ? await client.lookupAttachments(names) : await client.lookupHashtags(names);
          const metadata = new TextEncoder().encode(JSON.stringify({
            records: found.records.map(record => record.raw),
            recordErrors: found.recordErrors.map(error => error.raw),
          })).length;
          relationshipBytes += metadata;
          if (relationshipBytes > 256 * 1024) {
            throw new AppError("UNSUPPORTED_FEATURE", "Selected relationship metadata exceeds the 256 KiB search budget. Use a smaller result limit or narrower filters.");
          }
          for (const name of names) {
            const record = writeLookupRecord(found, name, false)!;
            relatedByName.set(record.recordName, record);
          }
        }

        for (const candidate of candidates) {
          const organization: { tags?: string[]; url?: string | null } = {};
          for (const kind of selected) {
            const ids = reminderOrganizationIds(candidate.record, client.remindersZoneOwner!, kind);
            const type = kind === "url" ? "Attachment" : "Hashtag";
            const related = ids.map(id => relatedByName.get(`${type}/${id}`)).filter((record): record is CloudKitRecord => record !== undefined);
            if (related.length !== ids.length) throw new AppError("PROTOCOL_CHANGED", "Apple omitted a selected relationship from the complete search graph.");
            Object.assign(organization, readReminderOrganizationSelection(candidate.record, related, client.remindersZoneOwner!, kind));
          }
          if (!matchesReminderOrganizationSearch(organization, filters)) continue;
          records.push(omitField(candidate.reminder, "raw"));
        }
        if (records.length > request.limit) throw new AppError("PROTOCOL_CHANGED", "Apple returned more search matches than the requested page size.");
        const bytes = jsonBytes({ records });
        if (bytes > 1_048_576 - 4096) throw new AppError("UNSUPPORTED_FEATURE", "The matching search page exceeds the response budget. Start again with a smaller limit or narrower filters.", 409);
        next = { ...scan, token: crypto.randomUUID(), totalPages: scan.totalPages + 1, listPages: scan.listPages + 1 };
        if (page.continuation !== null) {
          const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(page.continuation));
          const marker = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
          if (scan.seen.includes(marker)) {
            await repository.commitResume(fence, omitField(session, "searchScan"), "READY");
            throw new AppError("PROTOCOL_CHANGED", "Apple repeated a search pagination continuation. Start a new search.");
          }
          next = { ...next, cursor: page.continuation, seen: [...scan.seen, marker] };
        } else {
          next = { ...next, index: scan.index + 1, cursor: null, seen: [], listPages: 0 };
        }
      } else {
        next = { ...scan, token: crypto.randomUUID() };
      }
      const complete = next.index >= next.listIds.length;
      if (jsonBytes({ records, continuation: complete ? null : next.token, complete }) > 1_048_576 - 4096)
        throw new AppError("UNSUPPORTED_FEATURE", "The matching search page exceeds the response budget. Start again with a smaller limit or narrower filters.", 409);
      await repository.commitResume(fence, appleSuccess({ ...session, searchScan: complete ? undefined : next, auth: http.snapshot() }), "READY");
      return {
        result: {
          records, scannedRecords, recordErrors: [], complete, paginationComplete: complete,
          continuation: complete ? null : next.token, pendingReason: complete ? null : "continuation",
          progress: { listsTotal: next.listIds.length, listsCompleted: next.index, pagesRead, totalPages: next.totalPages,
            currentListId: complete ? null : next.listIds[next.index] ?? null },
          source: "direct-cloudkit-query", freshness: { mode: "live", retrievedAt: Date.now() },
          scope: "search-reminders", consistency: "live-pages-not-snapshot",
        },
        generation: fence.generation, liveReadValidated: false, writesEnabled: appleGates(this.env).enabled,
      };
    });
  }
  private async authorizeLists(client: CloudKitRemindersClient, ids: string[], fullSnapshot = false): Promise<CloudKitRecord[]> {
    if (client.remindersZoneOwner === undefined && !(await client.listZones()).available) throw new AppError("PROTOCOL_CHANGED", "Apple did not return an available private Reminders zone.");
    const found = await client.lookup(ids, !fullSnapshot);
    for (const error of found.recordErrors) {
      if (["AUTHENTICATION_REQUIRED", "NOT_AUTHENTICATED", "INVALID_AUTH_TOKEN", "AUTHENTICATION_FAILED"].includes(error.serverErrorCode.toUpperCase())) throw new AppError("REAUTH_REQUIRED", "Apple rejected the list lookup. Reconnect your Apple account.", 409);
      if (["ACCESS_DENIED", "PERMISSION_FAILURE", "PERMISSION_DENIED"].includes(error.serverErrorCode.toUpperCase())) throw new AppError("FORBIDDEN", "Apple denied access to the requested list.", 403);
      if (["THROTTLED", "REQUEST_RATE_LIMITED", "ZONE_BUSY"].includes(error.serverErrorCode.toUpperCase())) throw new CloudKitRateLimitedError(null);
      if (["UNKNOWN_ITEM", "NOT_FOUND"].includes(error.serverErrorCode.toUpperCase())) throw new AppError("FORBIDDEN", "The requested list is not accessible.", 403);
      throw new AppError("PROTOCOL_CHANGED", "Apple could not verify the requested list.");
    }
    if (!found.complete || found.records.length !== ids.length) throw new AppError("PROTOCOL_CHANGED", "Apple omitted a requested list authorization result.");
    const authorized: CloudKitRecord[] = [];
    for (const record of found.records) {
      if (!("recordType" in record) || record.recordType !== "List" || record.deleted) throw new AppError("FORBIDDEN", "The requested list is unavailable.", 403);
      const list = normalizeList(record, false);
      if (list.deleted || list.isGroup) throw new AppError("FORBIDDEN", "The requested list is unavailable or is a group.", 403);
      authorized.push({ ...record, zoneID: record.zoneID ?? { zoneName: "Reminders", ownerRecordName: client.remindersZoneOwner! } });
    }
    return authorized;
  }
  async read(input: z.infer<typeof ControlledRead>) {
    if (input.action === "current-lists") return this.getCurrentLists(input.expectedGeneration);
    return this.controlledRead(input);
  }
  private async controlledRead(input: z.infer<typeof ControlledRead>) {
    return this.operation(input.expectedGeneration, input.action === "saved-lists" ? "snapshot" : input.action === "reminders" && input.continuation ? "cursor-progress" : "read-only", async (http, saved, repository, fence) => {
      const client = new CloudKitRemindersClient(http.http, requireRemindersConnection(saved.session));
      const permissionRevision = (await this.requirePermission("reminders.read")).revision;
      if (input.action === "reminders" && input.continuation && !(saved.session.readContinuations ?? []).some(cursor =>
        cursor.cursor === input.continuation && cursor.listId === input.listId && cursor.includeCompleted === input.includeCompleted &&
        cursor.limit === input.limit && cursor.permissionRevision === permissionRevision && cursor.expiresAt > Date.now())) {
        throw new AppError("CONFLICT", "The reminder continuation expired or its scope or service permissions changed. Start a new read.", 409);
      }
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
      const readContinuations = (saved.session.readContinuations ?? []).filter(cursor => cursor.expiresAt > Date.now() && cursor.permissionRevision === permissionRevision &&
        !(input.action === "reminders" && cursor.listId === input.listId));
      const retain = (page: Record<string, unknown>, listId: string, includeCompleted: boolean, limit: number) => {
        if (typeof page.continuation === "string") readContinuations.push({ cursor: page.continuation, listId, includeCompleted, limit,
          permissionRevision, expiresAt: Math.min(Date.now() + 600_000, saved.session.login.expiresAt) });
      };
      if (input.action === "reminders") retain(result as Record<string, unknown>, input.listId, input.includeCompleted, input.limit);
      if (input.action === "reminders-batch") (result as { pages: Record<string, unknown>[] }).pages.forEach((page, index) => retain(page, input.listIds[index], input.includeCompleted, input.limit));
      const session = { ...saved.session, connection, savedLists, auth: http.snapshot(), readContinuations: readContinuations.slice(-32) };
      await repository.commitResume(fence, input.action === "saved-lists" ? session : appleSuccess(session), "READY");
      result = { ...(result as Record<string, unknown>), requestTrace: client.readTrace };
      return { result, generation: fence.generation, liveReadValidated: false, writesEnabled: appleGates(this.env).enabled };
    });
  }
}
