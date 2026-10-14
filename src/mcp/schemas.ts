import { ServiceSettingsSchema } from "../services/settings.ts";
import { EARLY_UNITS } from "../reminders/early-reminder.ts";
import { LocationAlarmSummary } from "../reminders/location-alarm.ts";
import { z } from "zod";
import { RecurrenceSummary } from "../reminders/recurrence.ts";
import { SavedListSchema } from "../persistence/apple-sessions.ts";
import { ListBadgeAppearance, ListColorAppearance } from "../reminders/list-appearance.ts";

const counter = z.number().int().nonnegative().safe();
const nullableTime = counter.nullable();
const text = z.string().nullable();
const flag = z.boolean().nullable();
const ids = z.array(z.string()).nullable();

export const ExpectedGenerationInput = counter.optional().describe("Apple session generation from connection_status. Supply it to bind reads and writes to that session; retain it for reconciliation. A changed session returns CONFLICT.");

// Public normalized data only. Strict objects keep raw Apple records, proof
// material and transport metadata outside the advertised success contracts.
export const ReminderOutput = z.object({
  id: z.string().describe("Exact reminder ID to retain for subsequent reads and changes."),
  listId: z.string().nullable().describe("Stored List relationship; null for an owned soft-deleted reminder detached by native deletion."),
  title: text,
  notes: text,
  completed: flag,
  completedDate: text.describe("ISO completion timestamp, or null when absent."),
  dueDate: text,
  startDate: text,
  priority: z.number().int().nullable(),
  flagged: flag,
  allDay: flag,
  deleted: flag,
  timeZone: text,
  parentReminderId: text,
  alarmIds: ids,
  attachmentIds: ids,
  hashtagIds: ids,
  recurrenceRuleIds: ids,
  created: text,
  modified: text,
  recordChangeTag: text.describe("Current Apple version token. Read again after a change; never invent or automatically replace it to retry a conflicting write."),
}).strict();

const recordError = z.object({ id: text, code: z.string() }).strict();
const freshness = z.object({ mode: z.literal("live"), retrievedAt: counter.optional().describe("Time the current list set was retrieved; reminder contents are queried live per page.") }).strict();
const page = {
  generation: counter,
  complete: z.boolean().describe("Whether this page has no unresolved record errors; use paginationComplete to determine whether the list has finished."),
  paginationComplete: z.boolean(),
  continuation: z.string().nullable().describe("Opaque next-page value. Keep the same list and read options when continuing; null means no further page."),
  pendingReason: text,
  recordErrors: z.array(recordError),
  freshness,
  source: z.enum(["direct-cloudkit-query", "direct-known-list-query"]),
  writesEnabled: z.boolean(),
};

export const ListsOutput = z.object({ ...page, records: z.array(SavedListSchema.pick({ id: true }).extend({ title: text, color: text, count: counter.nullable(), isGroup: flag, deleted: flag, reminderIds: ids }).strict()) }).strict();
export const RemindersPageOutput = z.object({
  ...page,
  listId: z.string(),
  records: z.array(z.union([ReminderOutput, z.object({ id: z.string(), deleted: z.literal(true) }).strict()])),
}).strict();
export const ReminderLookupOutput = z.object({
  generation: counter,
  record: ReminderOutput.nullable(),
  missing: z.boolean().describe("True only when Apple reports the exact item absent. A soft-deleted item may instead be returned with record.deleted=true."),
}).strict();

const collectionMetadata = {
  generation: counter, pagesRead: counter, complete: z.literal(true), consistency: z.literal("live-pages-not-snapshot"),
  view: z.enum(["all", "overdue", "today", "upcoming", "untagged"]), timeZone: z.string(), referenceInstant: z.string(),
  upcomingDays: counter, sortBy: z.enum(["due", "priority", "title", "created"]),
};
export const ReminderCollectionOutput = z.object({ ...collectionMetadata, records: z.array(ReminderOutput).max(1000) }).strict();
export const ReminderExportOutput = z.object({ ...collectionMetadata, format: z.enum(["json", "csv"]), count: counter, content: z.string() }).strict();

export const ReminderOrganizationOutput = z.object({
  generation: counter, reminderId: z.string(), recordChangeTag: z.string(),
  url: z.object({ id: z.string(), url: z.string() }).strict().nullable(),
  tags: z.array(z.object({ id: z.string(), name: z.string() }).strict()),
  otherAttachmentIds: z.array(z.string()).describe("Opaque IDs of attachments that are preserved; their contents are not exposed."),
}).strict();

const inspectionStatus = z.enum(["known", "unknown"]);
const actionCheck = z.object({
  status: z.enum(["supported", "unsupported", "requires_input"]), reason: z.string(),
  affectedReminderIds: z.array(z.string()).max(31), requiredInputs: z.array(z.string()).max(8),
}).strict();
export const ReminderInspectionOutput = z.object({
  syntheticEarlyAlert: z.object({
    alertIdentity: z.string().regex(/^[a-f0-9]{64}$/), accountIdentity: z.string().regex(/^[a-f0-9]{64}$/),
    creationDate: z.number().finite(), acknowledgedDate: z.number().finite().nullable(),
    reminderIdentityMatches: z.literal(true), minimumSupportedVersion: z.literal(20230430),
  }).strict().optional(),
  generation: counter, record: ReminderOutput, inspectionOnly: z.literal(true),
  schedule: z.object({ status: inspectionStatus, dueDate: text, timeZone: text, allDay: flag,
    recurrence: RecurrenceSummary.nullable(), earlyReminder: z.object({ unit: z.enum(EARLY_UNITS), count: counter }).strict().nullable(),
    locationAlarm: LocationAlarmSummary.nullable(), reason: text,
  }).strict(),
  organization: z.object({ status: inspectionStatus, url: z.object({ id: z.string(), url: z.string() }).strict().nullable(),
    tags: z.array(z.object({ id: z.string(), name: z.string() }).strict()).max(31), otherAttachmentIds: z.array(z.string()).max(31), reason: text,
  }).strict(),
  category: z.object({ status: z.enum(["known", "unknown", "not_applicable"]), assignment: z.object({
    categoryId: z.string(), name: z.string(), canonicalName: text, recordChangeTag: z.string(),
  }).strict().nullable(), reason: text }).strict(),
  subtasks: z.object({ status: inspectionStatus, parentReminderId: text, childIds: z.array(z.string()).max(30).nullable(),
    familyIds: z.array(z.string()).max(31).nullable(), reason: text }).strict(),
  actions: z.object({ complete: actionCheck, reopen: actionCheck, delete: actionCheck, move: actionCheck, copy: actionCheck, update: actionCheck }).strict(),
}).strict();

export const ShoppingCategoriesOutput = z.object({
  generation: counter,
  listId: z.string(),
  listRecordChangeTag: z.string(),
  locale: text,
  categories: z.array(z.object({
    categoryId: z.string(),
    name: z.string(),
    canonicalName: text,
    recordChangeTag: z.string(),
  }).strict()),
  memberships: z.array(z.object({ reminderId: z.string(), categoryId: z.string() }).strict()),
  orderedCategoryIds: z.array(z.string()),
  complete: z.boolean(),
  paginationComplete: z.boolean(),
  continuation: z.string().uuid().nullable(),
  pendingReason: z.enum(["continuation"]).nullable(),
  pagesRead: counter,
  writesEnabled: z.boolean(),
}).strict();

export const ReminderListSectionsOutput = z.object({
  generation: counter, listId: z.string(), listRecordChangeTag: z.string(),
  sections: z.array(z.object({ sectionId: z.string(), name: z.string(), canonicalName: text, recordChangeTag: z.string() }).strict()).max(200),
  memberships: z.array(z.object({ reminderId: z.string(), sectionId: z.string() }).strict()).max(200),
  orderedSectionIds: z.array(z.string()).max(200),
  orderingStatus: z.enum(["explicit", "not_materialized"]),
  complete: z.boolean(), paginationComplete: z.boolean(), continuation: z.string().uuid().nullable(),
  pendingReason: z.enum(["continuation"]).nullable(), pagesRead: counter,
}).strict();

export const ShoppingCategoryMutationOutput = z.object({
  generation: counter,
  operation: z.literal("set_category"),
  listId: z.string(),
  listRecordChangeTag: z.string(),
  category: z.object({
    categoryId: z.string(),
    name: z.string(),
    canonicalName: text,
    recordChangeTag: z.string(),
  }).strict(),
  record: ReminderOutput,
  writesEnabled: z.literal(true),
}).strict();

export const AllOpenOutput = z.object({
  generation: counter,
  records: z.array(ReminderOutput),
  lists: z.array(SavedListSchema),
  recordErrors: z.array(recordError),
  errors: z.array(z.object({ code: z.string(), retryable: z.boolean(), retryAfterSeconds: z.number().nonnegative().optional() }).strict()),
  complete: z.boolean().describe("True only when every discovered list finished without record or read errors. Otherwise combine pages using continuation and inspect errors."),
  paginationComplete: z.boolean(),
  continuation: z.string().uuid().nullable().describe("Short-lived single-use continuation bound to this owner and Apple session. Use the newly returned token for the next call."),
  pendingReason: text,
  progress: z.object({ listsTotal: counter, listsCompleted: counter, pagesRead: counter, totalPages: counter }).strict(),
  freshness,
  source: z.literal("direct-cloudkit-query"),
  scope: z.literal("all-open-reminders"),
  writesEnabled: z.boolean(),
}).strict();

export const ReminderSearchOutput = z.object({
  generation: counter,
  records: z.array(ReminderOutput),
  scannedRecords: counter.describe("Reminder records read before scalar and organization filtering on this page."),
  recordErrors: z.array(recordError),
  complete: z.boolean().describe("True only after every page in the selected owned private lists finished without errors."),
  paginationComplete: z.boolean(),
  continuation: z.string().uuid().nullable().describe("Single-use, ten-minute owner/account/session-bound continuation. Repeat the same filters and use the newly returned token."),
  pendingReason: text,
  progress: z.object({ listsTotal: counter, listsCompleted: counter, pagesRead: counter, totalPages: counter, currentListId: text }).strict(),
  freshness,
  source: z.literal("direct-cloudkit-query"),
  scope: z.literal("search-reminders"),
  consistency: z.literal("live-pages-not-snapshot").describe("Each page is current when fetched; reminders can change between pages."),
  writesEnabled: z.boolean(),
}).strict();

export function MutationOutput(action: "create" | "update" | "complete" | "reopen" | "delete" | "create_subtask" | "set_parent" | "set_url" | "set_tags" | "move" | "copy") {
  const result = z.object({
    generation: counter,
    operation: z.literal(action),
    replayed: z.boolean().describe("True for an identical create reconciled from the existing item without another Apple write."),
    record: ReminderOutput,
    writesEnabled: z.literal(true),
  }).strict();
  if (action === "complete" || action === "reopen" || action === "delete") return result.extend({
    ...(action === "complete" ? { completedOccurrence: ReminderOutput.optional().describe("Fresh completed history when recurrence advances. Absent for ordinary completion or when a supported ended daily/weekly recurrence completes its final active occurrence in place.") } : {}),
    affectedRecords: z.array(ReminderOutput).max(31).describe("Reminder records mutated atomically, including a root touched by direct child deletion. Unchanged family members are version guarded.").optional(),
  }).strict();
  if (action === "move" || action === "copy") return result.extend({
    ...(action === "copy" ? { idempotencyKey: z.string().uuid() } : {}),
    listVersions: z.array(z.object({ listId: z.string(), recordChangeTag: z.string() }).strict()).length(2).optional()
      .describe("Exact List versions from this confirmed transfer. Absent for read-only copy reconciliation; do not adopt unrelated later reads as operation receipts."),
  }).strict();
  return action === "create" || action === "create_subtask" ? result.extend({ idempotencyKey: z.string().uuid() }).strict() : result;
}

export const ExactListOutput = z.object({
  generation: counter,
  list: z.object({ id: z.string(), title: text, color: text, count: counter.nullable(),
    isGroup: flag, deleted: flag, recordChangeTag: z.string() }).strict(),
}).strict();

export const ListMutationOutput = z.object({
  generation: counter,
  operation: z.enum(["create", "rename", "delete"]),
  replayed: z.boolean(),
  list: z.object({
    id: z.string(), title: text, color: text, count: counter.nullable(),
    isGroup: flag, deleted: flag, recordChangeTag: text,
  }).strict(),
  writesEnabled: z.literal(true),
  idempotencyKey: z.string().uuid().optional(),
}).strict();

const listAppearance = { color: ListColorAppearance, badge: ListBadgeAppearance };
export const ListAppearanceOutput = z.object({
  generation: counter, listId: z.string(), recordChangeTag: z.string(), ...listAppearance,
}).strict();
export const ListAppearanceMutationOutput = z.object({
  generation: counter, operation: z.literal("update"), listId: z.string(), recordChangeTag: z.string(),
  ...listAppearance, writesEnabled: z.literal(true),
}).strict();

const ServiceReadinessOutput = z.object({
  enabled: z.boolean(), state: z.string(), ready: z.boolean(), action: z.string().nullable(),
  nextAttemptAt: counter, lastErrorCode: z.string().nullable(),
});
export const ConnectionStatusOutput = z.object({
  accountAuthenticated: z.boolean(), accountConnected: z.boolean(),
  serviceSettings: z.object({ revision: counter, available: z.boolean(), settings: ServiceSettingsSchema }).strict(),
  services: z.object({
    reminders: ServiceReadinessOutput.extend({ read: z.boolean(), write: z.boolean() }).strict(),
    drive: ServiceReadinessOutput.extend({ browse: z.boolean(), contents: z.boolean(), upload: z.boolean(), organize: z.boolean() }).strict(),
  }).strict(),
  generation: counter,
  version: counter,
  state: z.enum(["DISCONNECTED", "CONNECTING", "DEVICE_APPROVAL_PENDING", "READY"]),
  action: z.enum(["approve-device-consent", "wait-for-reminders-keys"]).nullable(),
  nextAttemptAt: counter,
  transportReady: z.boolean(),
  expiresAt: nullableTime.describe("Fixed local retention deadline in Unix milliseconds, separate from Apple credential expiry; operations and renewal never extend it."),
  retentionDays: counter.nullable(),
  retentionSource: z.enum(["interactive-consent", "owner-authorised-migration", "legacy-consent"]).nullable(),
  lastValidatedAt: nullableTime,
  lastAppleSuccessAt: nullableTime,
  lastRenewedAt: nullableTime,
  nextRetryAt: nullableTime,
  requiredAction: z.enum(["verify-device", "review-terms", "approve-reminders", "retry", "local-retention-expired", "apple-sign-in"]).nullable(),
  listDiscovery: z.object({ strategy: z.literal("direct"), liveValidated: z.literal(false), experimental: z.literal(true) }).strict(),
  gates: z.object({
    enabled: z.boolean(), liveConnectionApproved: z.boolean(), cryptographyReviewed: z.boolean(),
    loginPolicy: z.literal("device-only-v2"), verificationMethod: z.literal("trusted-device-spake2"),
    passwordLocation: z.literal("browser-only"), sessionStorage: z.literal("owner-scoped-encrypted"),
    sessionLifetimeMs: counter, socketLifetimeMs: counter, retentionDays: counter,
    retentionWritesEnabled: z.boolean(), renewalEnabled: z.boolean(),
  }).strict(),
  connected: z.boolean(),
  writeEnabled: z.boolean(),
  phase: z.enum(["read-only", "read-write"]),
  capabilities: z.object({
    liveRead: z.boolean(), controlledRead: z.boolean(), listReminders: z.boolean(),
    allOpenReminders: z.boolean(), search: z.boolean(), connectorCollections: z.boolean(), boundedExport: z.boolean(), savedFilters: z.boolean(), compoundCreate: z.boolean(), listDuplication: z.boolean(), create: z.boolean(),
    update: z.boolean(), complete: z.boolean(), reopen: z.boolean(), delete: z.boolean(),
    prepareUpdate: z.boolean(), linkedScheduling: z.boolean(), reminderJobs: z.boolean(),
    reminderInspection: z.boolean(), bulkCreate: z.boolean(), bulkDelete: z.boolean(), bulkUpdate: z.boolean(), bulkComplete: z.boolean(), autonomousJobs: z.literal(false),
    jobExecutionMode: z.literal("request-driven"),
    subtasks: z.boolean(), urls: z.boolean(), tags: z.boolean(), moveCopy: z.boolean(),
    createList: z.boolean(), renameList: z.boolean(), deleteList: z.boolean(),
    listAppearanceRead: z.boolean(), listAppearanceUpdate: z.boolean(),
    shoppingCategoriesRead: z.boolean().optional(), shoppingCategoriesUpdate: z.boolean().optional(),
    standardSectionsRead: z.boolean().optional(),
  }).strict(),
  mcpTools: z.array(z.string()),
  message: z.string(),
}).strict();

const schedule = z.object({ locationAlarm: LocationAlarmSummary.nullable(), dueDate: text, timeZone: text, allDay: flag, recurrence: RecurrenceSummary.nullable(), earlyReminder: z.object({ unit: z.enum(EARLY_UNITS), count: counter }).strict().nullable() }).strict();
export const PrepareUpdateOutput = z.object({
  datePairShape: z.object({
    alarmFields: z.array(z.string().max(64)).max(32), triggerFields: z.array(z.string().max(64)).max(32),
    alarmUIDMatchesRecord: z.boolean(), alarmUIDMatchesIgnoringCase: z.boolean(), triggerIDMatchesRecord: z.boolean(),
    alarmUIDIsUuid: z.boolean(), acknowledgementFieldType: z.string().max(32).nullable(),
    reminderBacklinkMatches: z.boolean(), alarmBacklinkMatches: z.boolean(), absoluteTrigger: z.boolean(),
  }).strict().optional(),
  generation: counter, supported: z.boolean(), classification: z.enum(["single-record", "linked-date", "unverified-linked-schedule"]),
  before: schedule, after: schedule.nullable(), linkedFeatures: z.object({ alarms: counter, recurrenceRules: counter, graphComplete: z.boolean() }).strict(),
  unsupportedReason: text, preparationToken: z.string().nullable(), expiresAt: nullableTime, operationCount: counter, message: z.string(),
}).strict();
