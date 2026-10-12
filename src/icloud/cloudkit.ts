import { AppError, WriteOutcomeUnknownError, requireValue as requireInput } from "../errors.ts";
import type { CloudKitWriteRecord } from "../reminders/writes.ts";
import type { ListWrite } from "../reminders/list-writes.ts";
import { creationMembership } from "../reminders/creation.ts";
import { isNativeColorValue, isNativeEmojiValue } from "../reminders/list-appearance.ts";
import { decodeDateComponents, type LinkedDateWrite } from "../reminders/linked-date.ts";
import { LOCATION_ENCRYPTED_FIELDS, validLocationMutation } from "../reminders/location-alarm.ts";
import { validRecurrenceMutation, validRecurrenceCreation } from "../reminders/recurrence.ts";
import { earlyReminderPayload } from "../reminders/early-reminder.ts";
import { schedulingOperation, type SchedulingWrite } from "../reminders/scheduling-plan.ts";
import { canonicalJSON } from "../lib/canonical.ts";
import { stableNativePresentation } from "../lib/native-presentation.ts";
import { decodeDocument } from "../reminders/crdt.ts";
import { planRecurringCompletion, verifyRecurringExpected, type RecurringCompletionPlan } from "../reminders/recurring-lifecycle.ts";
import { planRecurringDeletion, type RecurringDeletionPlan } from "../reminders/recurring-deletion.ts";
import { planDateAlarmLifecycle, verifyDateAlarmLifecycle, verifyLifecycleParticipants, type DateAlarmLifecyclePlan } from "../reminders/date-alarm-lifecycle.ts";
import { planScheduledFamilyLifecycle, type ScheduledFamilyLifecyclePlan } from "../reminders/scheduled-family-lifecycle.ts";
import { AppleHTTP, validatedAppleURL, appleWebHeaders } from "../transport/apple-http.ts";
import { downloadShoppingAsset, uploadShoppingAsset, type ShoppingAssetFieldName, type ShoppingAssetToken } from "./shopping-assets.ts";

const REMINDERS_ZONE = { zoneName: "Reminders", zoneType: "REGULAR_CUSTOM_ZONE" } as const;
const DEFAULT_OWNER = "__defaultOwner__";
const MAX_PAGE_SIZE = 200;
// Compound pages include alarms, recurrences and attachments as well as reminders.
// The transport still enforces its independent 1 MiB response budget.
const MAX_COMPOUND_RECORDS = 1000;
const MAX_RECORD_NAME_LENGTH = 512;
const MAX_TOKEN_LENGTH = 8192;
const MAX_REQUEST_BYTES = 65_536;
const MAX_RESPONSE_BYTES = 1_048_576;
const MAX_ALL_LIST_PAGES = 25;
const MAX_ALL_LIST_DURATION_MS = 20_000;
const MAX_ALL_LIST_SUMMARY_BYTES = MAX_RESPONSE_BYTES - 4_096;
const MAX_ALL_LIST_IDS = 1_000;
const RECORD_TYPES = new Set(["List", "Reminder", "Alarm", "AlarmTrigger", "Attachment", "Hashtag", "RecurrenceRule"]);
const LIST_SUMMARY_KEYS = ["Name", "Color", "Count", "IsGroup", "Deleted"];
const SEARCH_REMINDER_KEYS = ["List", "ParentReminder", "TitleDocument", "NotesDocument", "Completed", "CompletionDate", "DueDate", "StartDate", "Priority", "Flagged", "AllDay", "Deleted", "TimeZone", "AlarmIDs", "AttachmentIDs", "HashtagIDs", "RecurrenceRuleIDs"] as const;
export interface CloudKitReadTrace { path: string; url: string; request: Record<string, unknown>; response: { status: number; returnedRecords: number; recordTypes: Record<string, number>; zones: number; continuationPresent: boolean; recordErrors: number }; }

function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new AppError("PROTOCOL_CHANGED", message);
}

export interface CloudKitConnection {
  dsid: string;
  clientId: string;
  clientBuildNumber: string;
  clientMasteringNumber: string;
  cloudKitURL: string;
  remindersZoneOwner?: string;
}

export interface CloudKitZoneID {
  zoneName: string;
  zoneType?: string;
  ownerRecordName?: string;
}

export interface CloudKitRecord {
  recordName: string;
  recordType: string;
  fields: Record<string, unknown>;
  zoneID?: CloudKitZoneID;
  deleted?: boolean;
  recordChangeTag?: string;
  raw: Record<string, unknown>;
}

export interface CloudKitTombstone {
  recordName: string;
  deleted: true;
  zoneID?: CloudKitZoneID;
  raw: Record<string, unknown>;
}

export interface CloudKitRecordError {
  recordName: string | null;
  serverErrorCode: string;
  reason: string | null;
  raw: Record<string, unknown>;
}

export type CloudKitRecordItem = CloudKitRecord | CloudKitTombstone;

export interface CloudKitPage<T extends CloudKitRecordItem = CloudKitRecordItem> {
  records: T[];
  recordErrors: CloudKitRecordError[];
  paginationComplete: boolean;
  complete: boolean;
  continuation: string | null;
  pendingReason: "continuation" | "record_errors" | null;
}

export interface CloudKitZone {
  zoneID: CloudKitZoneID;
  deleted: boolean;
}

export interface CloudKitZoneDiscovery {
  zones: CloudKitZone[];
  remindersZone: CloudKitZone | null;
  available: boolean;
  complete: true;
}

export interface CloudKitLookupResult {
  requestedRecordNames: string[];
  records: CloudKitRecordItem[];
  recordErrors: CloudKitRecordError[];
  unresolvedRecordNames: string[];
  complete: boolean;
}

export interface RemindersList {
  id: string;
  title: string | null;
  color: string | null;
  count: number | null;
  isGroup: boolean | null;
  deleted: boolean | null;
  reminderIds: string[] | null;
  raw: Record<string, unknown>;
}

export type RemindersListSummary = Omit<RemindersList, "raw" | "reminderIds"> & { reminderIds: null };

export interface CloudKitAllListsResult {
  lists: RemindersList[];
  complete: boolean;
  pagesRead: number;
  pendingReason: "continuation_cycle" | "record_errors" | "page_limit" | "time_limit" | "summary_byte_limit" | "list_limit" | null;
}

export interface Reminder {
  id: string;
  listId: string;
  title: string | null;
  notes: string | null;
  completed: boolean | null;
  completedDate: string | null;
  dueDate: string | null;
  startDate: string | null;
  priority: number | null;
  flagged: boolean | null;
  allDay: boolean | null;
  deleted: boolean | null;
  timeZone: string | null;
  parentReminderId: string | null;
  alarmIds: string[] | null;
  attachmentIds: string[] | null;
  hashtagIds: string[] | null;
  recurrenceRuleIds: string[] | null;
  created: string | null;
  modified: string | null;
  recordChangeTag: string | null;
  raw: Record<string, unknown>;
}

export class CloudKitRateLimitedError extends AppError {
  readonly retryAfterSeconds: number | null;

  constructor(retryAfterSeconds: number | null) {
    super("RATE_LIMITED", "Apple rate limited the Reminders read request.", 429, true);
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function object(value: unknown, message: string): Record<string, unknown> {
  requireValue(value !== null && typeof value === "object" && !Array.isArray(value), message);
  return value as Record<string, unknown>;
}

function string(value: unknown, message: string, max = MAX_TOKEN_LENGTH): string {
  requireValue(typeof value === "string" && value.length > 0 && value.length <= max, message);
  return value as string;
}

function optionalString(value: unknown, message: string, max = MAX_TOKEN_LENGTH): string | null {
  if (value === undefined || value === null) return null;
  return string(value, message, max);
}

function recordName(value: unknown, allowedTypes: readonly string[]): string {
  const name = string(value, "Apple returned a malformed record name.", MAX_RECORD_NAME_LENGTH);
  const separator = name.indexOf("/");
  requireValue(separator > 0 && separator < name.length - 1 && name.indexOf("/", separator + 1) === -1, "Apple returned a malformed record name.");
  requireValue(allowedTypes.includes(name.slice(0, separator)), "The record name is outside the Reminders record types.");
  requireValue(!/[\u0000-\u001f\u007f]/.test(name), "Apple returned a malformed record name.");
  return name;
}

function canonicalRecordName(value: unknown, type: string): string {
  const name = string(value, "Apple returned a malformed record relationship.", MAX_RECORD_NAME_LENGTH);
  const full = name.includes("/") ? name : `${type}/${name}`;
  return recordName(full, [type]);
}

function requestedRecordName(value: unknown, allowedTypes: readonly string[]): string {
  requireInput(typeof value === "string" && value.length <= MAX_RECORD_NAME_LENGTH, "The requested CloudKit record name is invalid.");
  const name = value as string;
  requireInput(/^[A-Za-z][A-Za-z0-9]*\/[^/]+$/.test(name) && allowedTypes.includes(name.slice(0, name.indexOf("/"))), "The requested CloudKit record name is invalid.");
  return recordName(name, allowedTypes);
}

function zoneID(value: unknown, allowMissing = false, remindersOnly = true, expectedOwner: string | null = DEFAULT_OWNER, allowDefaultOwner = true): CloudKitZoneID | undefined {
  if (value === undefined || value === null) {
    requireValue(allowMissing, "Apple omitted the Reminders zone identifier.");
    return undefined;
  }
  const raw = object(value, "Apple returned a malformed zone identifier.");
  const name = string(raw.zoneName, "Apple returned a malformed zone name.", 128);
  if (remindersOnly) requireValue(name === REMINDERS_ZONE.zoneName, "Apple returned data from a different CloudKit zone.");
  const type = optionalString(raw.zoneType, "Apple returned a malformed zone type.", 128) ?? undefined;
  if (remindersOnly) requireValue(type === undefined || type === REMINDERS_ZONE.zoneType, "Apple returned data from a different CloudKit zone type.");
  const owner = optionalString(raw.ownerRecordName, "Apple returned a malformed zone owner.", 256) ?? undefined;
  if (owner !== undefined) requireValue(!/[\u0000-\u0020\u007f]/.test(owner), "Apple returned a malformed zone owner.");
  if (remindersOnly && expectedOwner !== null) requireValue(owner === undefined || (allowDefaultOwner && owner === DEFAULT_OWNER) || owner === expectedOwner, "Apple returned data from a different CloudKit owner.");
  return { zoneName: name, ...(type ? { zoneType: type } : {}), ...(owner ? { ownerRecordName: owner } : {}) };
}

function validateToken(value: unknown, message: string): string {
  const token = string(value, message, MAX_TOKEN_LENGTH);
  requireValue(!/[\u0000-\u001f\u007f]/.test(token), message);
  return token;
}

function boundedLimit(value: number | undefined): number {
  const limit = value ?? MAX_PAGE_SIZE;
  requireInput(Number.isSafeInteger(limit) && limit >= 1 && limit <= MAX_PAGE_SIZE, "The CloudKit page size is outside the supported limit.");
  return limit;
}

function requestedToken(value: string | null | undefined, message: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  requireInput(typeof value === "string" && value.length <= MAX_TOKEN_LENGTH && !/[\u0000-\u001f\u007f]/.test(value), message);
  return value;
}

function readField(record: CloudKitRecord, key: string, tags: readonly string[]): unknown {
  const rawFields = record.fields;
  if (!Object.hasOwn(rawFields, key)) return undefined;
  const wrapper = object(rawFields[key], `Apple returned a malformed ${key} field.`);
  requireValue(typeof wrapper.type === "string" && tags.includes(wrapper.type), `Apple changed the ${key} field type.`);
  requireValue(Object.hasOwn(wrapper, "value"), `Apple omitted the ${key} field value.`);
  return wrapper.value;
}

function textField(record: CloudKitRecord, key: string): string | null {
  const value = readField(record, key, ["STRING"]);
  if (value === undefined || value === null) return null;
  return string(value, `Apple returned malformed text in ${key}.`, 65_536);
}

function boolField(record: CloudKitRecord, key: string): boolean | null {
  const value = readField(record, key, ["INT64"]);
  if (value === undefined || value === null) return null;
  requireValue(value === 0 || value === 1, `Apple returned an invalid boolean in ${key}.`);
  return value === 1;
}

function integerField(record: CloudKitRecord, key: string): number | null {
  const value = readField(record, key, ["INT64"]);
  if (value === undefined || value === null) return null;
  requireValue(Number.isSafeInteger(value), `Apple returned an invalid integer in ${key}.`);
  return value as number;
}

function dateField(record: CloudKitRecord, key: string): string | null {
  const value = readField(record, key, ["TIMESTAMP"]);
  if (value === undefined || value === null) return null;
  if (typeof value === "string" && value.startsWith("0001-01-01")) return null;
  let millis: number;
  if (typeof value === "number") millis = value;
  else if (typeof value === "string" && /^-?\d+$/.test(value)) millis = Number(value);
  else throw new AppError("PROTOCOL_CHANGED", `Apple returned an invalid timestamp in ${key}.`);
  requireValue(Number.isSafeInteger(millis), `Apple returned an invalid timestamp in ${key}.`);
  // These ancient values are CloudKit's observed unset-date sentinels.
  if (millis <= -62_135_596_800_000) return null;
  const date = new Date(millis);
  requireValue(Number.isFinite(date.getTime()), `Apple returned an out-of-range timestamp in ${key}.`);
  return date.toISOString();
}

export function referenceField(record: CloudKitRecord, key: string, type: string, expectedOwner: string): string | null {
  const value = readField(record, key, ["REFERENCE"]);
  if (value === undefined || value === null) return null;
  const reference = object(value, `Apple returned a malformed ${key} relationship.`);
  if (reference.zoneID !== undefined) zoneID(reference.zoneID, false, true, expectedOwner);
  if (reference.action !== undefined) requireValue(reference.action === "VALIDATE", `Apple returned an unsupported ${key} relationship action.`);
  return canonicalRecordName(reference.recordName, type);
}

export function intrinsicParentIdentity(record: CloudKitRecord, expectedOwner: string): string | null {
  if (record.raw.parent === undefined || record.raw.parent === null) return null;
  const parent = object(record.raw.parent, "Apple returned a malformed intrinsic Reminder parent.");
  const { zoneID: parentZone, ...metadata } = parent;
  if (parentZone !== undefined) {
    const zone = object(parentZone, "Apple returned a malformed intrinsic-parent zone.");
    requireValue(Object.keys(zone).every(key => ["zoneName", "zoneType", "ownerRecordName"].includes(key)), "Apple returned unknown intrinsic-parent zone metadata.");
    zoneID(zone, false, true, expectedOwner);
  }
  const name = canonicalRecordName(metadata.recordName, "List");
  requireValue(name === referenceField(record, "List", "List", expectedOwner), "The intrinsic parent does not match the Reminder's stored List relationship.");
  return canonicalJSON({ ...metadata, recordName: name });
}

export function isKnownEmptyDeletionCollection(name: string, field: unknown): boolean {
  if (!["AlarmIDs", "HashtagIDs", "RecurrenceRuleIDs", "AssignmentIDs", "AttachmentIDs"].includes(name) ||
    !field || typeof field !== "object" || Array.isArray(field)) return false;
  const wrapper = field as Record<string, unknown>;
  return typeof wrapper.type === "string" && ["STRING_LIST", "UNKNOWN_LIST"].includes(wrapper.type) && Array.isArray(wrapper.value) && wrapper.value.length === 0 &&
    Object.keys(wrapper).every(key => key === "type" || key === "value");
}

export function stableDeletionFields(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(stableNativePresentation(fields)).filter(([name, field]) => !isKnownEmptyDeletionCollection(name, field)));
}

function confirmsField(record: CloudKitRecord, key: string, sent: { type: string; value: unknown; isEncrypted?: unknown }, owner: string): boolean {
  const received = record.fields[key];
  if (["REFERENCE", "TIMESTAMP"].includes(sent.type) && sent.value === null && received === undefined) return true;
  if (!received || typeof received !== "object" || Array.isArray(received) || !("type" in received) || !("value" in received)) return false;
  const emptyRelationship = sent.type === "STRING_LIST" && received.type === "UNKNOWN_LIST" &&
    Array.isArray(sent.value) && sent.value.length === 0 && Array.isArray(received.value) && received.value.length === 0;
  const encryptedDocument = ["TitleDocument", "NotesDocument"].includes(key) && sent.type === "STRING" && received.type === "ENCRYPTED_BYTES";
  if (received.type !== sent.type && !emptyRelationship && !encryptedDocument) return false;
  if (sent.isEncrypted !== undefined && (!("isEncrypted" in received) || received.isEncrypted !== sent.isEncrypted)) return false;
  if (sent.type === "REFERENCE" && sent.value && typeof sent.value === "object" && "recordName" in sent.value) {
    const reference = received.value;
    if (!reference || typeof reference !== "object" || Array.isArray(reference) || !("action" in reference) || reference.action !== "VALIDATE" ||
        Object.keys(reference).some(name => !["recordName", "action", "zoneID"].includes(name))) return false;
    try {
      return typeof sent.value.recordName === "string" &&
        referenceField(record, key, sent.value.recordName.split("/")[0], owner) === sent.value.recordName;
    } catch { return false; }
  }
  return canonicalJSON(received.value) === canonicalJSON(sent.value);
}

function idListField(record: CloudKitRecord, key: string, type: string): string[] | null {
  const value = readField(record, key, ["STRING_LIST", "UNKNOWN_LIST"]);
  // CloudKit emits UNKNOWN_LIST for empty relationships because there is no
  // element from which to infer a type. Never accept populated unknown lists.
  if ((record.fields[key] as { type?: string } | undefined)?.type === "UNKNOWN_LIST") {
    requireValue(Array.isArray(value) && value.length === 0, `Apple returned an invalid ${key} untyped relationship list.`);
    return [];
  }
  if (value === undefined || value === null) return null;
  requireValue(Array.isArray(value) && value.length <= 2_000, `Apple returned an invalid ${key} relationship list.`);
  return value.map((entry) => canonicalRecordName(entry, type));
}

function documentField(record: CloudKitRecord, key: string): string | null {
  const value = readField(record, key, ["ENCRYPTED_BYTES", "STRING"]);
  if (value === undefined || value === null) return null;
  requireValue(typeof value === "string" && value.length <= 350_000, `Apple returned an invalid ${key} document.`);
  try {
    return decodeDocument(value).text;
  } catch {
    throw new AppError("PROTOCOL_CHANGED", `Apple returned a ${key} document that could not be decoded safely.`);
  }
}

export function normalizeList(record: CloudKitRecord, includeMembership = true): RemindersList {
  requireValue(record.recordType === "List", "Only Reminders List records can be normalized as lists.");
  const rawName = recordName(record.recordName, ["List"]);
  const count = integerField(record, "Count");
  if (count !== null) requireValue(count >= 0, "Apple returned a negative reminder list count.");
  let reminderIds: string[] | null = null;
  const membership = includeMembership ? readField(record, "ReminderIDs", ["STRING"]) : undefined;
  if (membership !== undefined && membership !== null) {
    requireValue(typeof membership === "string" && membership.length <= 65_536, "Apple returned invalid list membership data.");
    let parsed: unknown;
    try { parsed = JSON.parse(membership as string); }
    catch { throw new AppError("PROTOCOL_CHANGED", "Apple returned invalid list membership data."); }
    requireValue(Array.isArray(parsed) && parsed.length <= 2_000, "Apple returned invalid list membership data.");
    reminderIds = parsed.map((id) => canonicalRecordName(id, "Reminder"));
  }
  return {
    id: rawName,
    title: textField(record, "Name"),
    color: textField(record, "Color"),
    count,
    isGroup: boolField(record, "IsGroup"),
    deleted: boolField(record, "Deleted"),
    reminderIds,
    raw: record.raw,
  };
}

function summarizeListRecord(record: CloudKitRecordItem): { list: RemindersList; summary: RemindersListSummary } {
  if (!("recordType" in record)) {
    const list: RemindersList = { id: record.recordName, title: null, color: null, count: null, isGroup: null, deleted: true, reminderIds: null, raw: {} };
    return { list, summary: { id: list.id, title: null, color: null, count: null, isGroup: null, deleted: true, reminderIds: null } };
  }
  const normalized = normalizeList(record, false);
  const list = { ...normalized, deleted: record.deleted === true || normalized.deleted === true ? true : normalized.deleted, raw: {} };
  const summary: RemindersListSummary = { id: list.id, title: list.title, color: list.color, count: list.count, isGroup: list.isGroup, deleted: list.deleted, reminderIds: null };
  return { list, summary };
}

export type DetachedDeletedReminder = Omit<Reminder, "listId"> & { listId: null };
export function normalizeReminder(record: CloudKitRecord, expectedOwner?: string): Reminder;
export function normalizeReminder(record: CloudKitRecord, expectedOwner: string | undefined, allowDetachedDeleted: true): Reminder | DetachedDeletedReminder;
export function normalizeReminder(record: CloudKitRecord, expectedOwner = DEFAULT_OWNER, allowDetachedDeleted = false): Reminder | DetachedDeletedReminder {
  requireValue(record.recordType === "Reminder", "Only Reminders Reminder records can be normalized as reminders.");
  const id = recordName(record.recordName, ["Reminder"]);
  const listId = referenceField(record, "List", "List", expectedOwner);
  requireValue(listId !== null || allowDetachedDeleted && boolField(record, "Deleted") === true, "Apple returned a reminder without its source-proven List relationship.");
  const parent = referenceField(record, "ParentReminder", "Reminder", expectedOwner);
  return {
    id,
    listId,
    title: documentField(record, "TitleDocument"),
    notes: documentField(record, "NotesDocument"),
    completed: boolField(record, "Completed"),
    completedDate: dateField(record, "CompletionDate"),
    dueDate: dateField(record, "DueDate"),
    startDate: dateField(record, "StartDate"),
    priority: integerField(record, "Priority"),
    flagged: boolField(record, "Flagged"),
    allDay: boolField(record, "AllDay"),
    deleted: boolField(record, "Deleted"),
    timeZone: textField(record, "TimeZone"),
    parentReminderId: parent,
    alarmIds: idListField(record, "AlarmIDs", "Alarm"),
    attachmentIds: idListField(record, "AttachmentIDs", "Attachment"),
    hashtagIds: idListField(record, "HashtagIDs", "Hashtag"),
    recurrenceRuleIds: idListField(record, "RecurrenceRuleIDs", "RecurrenceRule"),
    created: recordAuditDate(record.raw, "created"),
    modified: recordAuditDate(record.raw, "modified"),
    recordChangeTag: typeof record.recordChangeTag === "string" ? record.recordChangeTag : null,
    raw: record.raw,
  };
}

function recordAuditDate(rawRecord: Record<string, unknown>, key: string): string | null {
  if (rawRecord[key] === undefined || rawRecord[key] === null) return null;
  const info = object(rawRecord[key], `Apple returned malformed record ${key} metadata.`);
  const value = info.timestamp;
  const millis = typeof value === "number" ? value : typeof value === "string" && /^-?\d+$/.test(value) ? Number(value) : Number.NaN;
  requireValue(Number.isSafeInteger(millis), `Apple returned malformed record ${key} metadata.`);
  const date = new Date(millis);
  requireValue(Number.isFinite(date.getTime()), `Apple returned out-of-range record ${key} metadata.`);
  return date.toISOString();
}

function parseRecord(value: unknown, expectedOwner: string, allowDefaultOwner = true, allowedTypes = [...RECORD_TYPES]): CloudKitRecordItem | CloudKitRecordError {
  const raw = object(value, "Apple returned a malformed CloudKit record.");
  const recordZone = zoneID(raw.zoneID, true, true, expectedOwner, allowDefaultOwner);
  if (typeof raw.serverErrorCode === "string") {
    return {
      recordName: typeof raw.recordName === "string" ? raw.recordName : null,
      serverErrorCode: string(raw.serverErrorCode, "Apple returned a malformed per-record error code.", 256),
      reason: optionalString(raw.reason, "Apple returned a malformed per-record error reason.", 2_000),
      raw,
    };
  }
  const name = recordName(raw.recordName, allowedTypes);
  if (raw.deleted === true && raw.recordType === undefined) {
    return { recordName: name, deleted: true, ...(recordZone ? { zoneID: recordZone } : {}), raw };
  }
  const type = string(raw.recordType, "Apple returned a malformed record type.", 128);
  requireValue(allowedTypes.includes(type) && name.startsWith(`${type}/`), "Apple returned a record outside the requested Reminders record types.");
  const fields = object(raw.fields ?? {}, "Apple returned malformed record fields.");
  for (const field of Object.values(fields)) {
    if (field !== null && typeof field === "object" && !Array.isArray(field) && (field as Record<string, unknown>).type === "REFERENCE") {
      const value = (field as Record<string, unknown>).value;
      if (value === undefined || value === null) continue;
      const reference = object(value, "Apple returned a malformed record relationship.");
      if (reference.zoneID !== undefined) zoneID(reference.zoneID, false, true, expectedOwner, allowDefaultOwner);
    }
  }
  if (raw.recordChangeTag !== undefined) string(raw.recordChangeTag, "Apple returned a malformed record change tag.", 512);
  if (raw.deleted !== undefined) requireValue(typeof raw.deleted === "boolean", "Apple returned a malformed deleted marker.");
  return {
    recordName: name,
    recordType: type,
    fields,
    ...(recordZone ? { zoneID: recordZone } : {}),
    ...(typeof raw.deleted === "boolean" ? { deleted: raw.deleted } : {}),
    ...(typeof raw.recordChangeTag === "string" ? { recordChangeTag: raw.recordChangeTag } : {}),
    raw,
  };
}

function pageRecords(value: unknown, limit: number, absoluteLimit = MAX_PAGE_SIZE, expectedOwner = DEFAULT_OWNER, allowDefaultOwner = true, allowDuplicates = false, allowedTypes = [...RECORD_TYPES]): { records: CloudKitRecordItem[]; recordErrors: CloudKitRecordError[] } {
  requireValue(Array.isArray(value), "Apple returned a malformed CloudKit records page.");
  requireValue(value.length <= limit && value.length <= absoluteLimit, "Apple returned more records than the supported page budget.");
  const records: CloudKitRecordItem[] = [];
  const recordErrors: CloudKitRecordError[] = [];
  const names = new Set<string>();
  for (const item of value) {
    const parsed = parseRecord(item, expectedOwner, allowDefaultOwner, allowedTypes);
    if ("serverErrorCode" in parsed) {
      recordErrors.push(parsed);
      continue;
    }
    requireValue(allowDuplicates || !names.has(parsed.recordName), "Apple returned a duplicate record in one page.");
    names.add(parsed.recordName);
    records.push(parsed);
  }
  return { records, recordErrors };
}

function parseTopLevelError(body: Record<string, unknown>, context: { path: CloudKitPath; upstreamStatus: number; hasSessionCookie: boolean }): never | void {
  const code = typeof body.serverErrorCode === "string" ? body.serverErrorCode : null;
  if (!code) return;
  const normalized = code.toUpperCase();
  if (["PCS_REQUIRED", "DEVICE_CONSENT_REQUIRED", "WEB_ACCESS_DISABLED"].includes(normalized)) {
    throw new AppError("DEVICE_APPROVAL_PENDING", "Apple requires Reminders web-access approval. The account session can be preserved.", 409);
  }
  if (["AUTHENTICATION_REQUIRED", "NOT_AUTHENTICATED", "INVALID_AUTH_TOKEN", "AUTHENTICATION_FAILED"].includes(normalized)) {
    console.warn({ event: "apple-reminders-auth-rejected", ...context, reason: normalized });
    throw new AppError("REAUTH_REQUIRED", "Apple rejected Reminders authentication. A saved-token check or Apple sign-in may be needed.", 409);
  }
  if (["ACCESS_DENIED", "PERMISSION_FAILURE"].includes(normalized)) {
    throw new AppError("FORBIDDEN", "Apple denied access to the private Reminders zone.", 403);
  }
  if (["THROTTLED", "REQUEST_RATE_LIMITED", "ZONE_BUSY"].includes(normalized)) {
    throw new CloudKitRateLimitedError(null);
  }
  if (context.path === "/records/modify") {
    if (["CONFLICT", "SERVER_RECORD_CHANGED", "ALREADY_EXISTS"].includes(normalized)) throw new AppError("CONFLICT", "The reminder changed or its create ID already exists. Read its current state before retrying.", 409);
    if (["UNKNOWN_ITEM", "NOT_FOUND"].includes(normalized)) throw new AppError("CONFLICT", "The reminder or its list is no longer available.", 409);
    if (["BAD_REQUEST", "INVALID_ARGUMENTS", "VALIDATION_ERROR"].includes(normalized)) throw new AppError("PROTOCOL_CHANGED", "Apple rejected the reminder write fields. No automatic retry was attempted.");
    // An unfamiliar error after submission is not proof that nothing was saved.
    throw new WriteOutcomeUnknownError(String(body.recordName ?? ""));
  }
  throw new AppError("PROTOCOL_CHANGED", "Apple rejected the Reminders read request.");
}

type ReadPath = "/zones/list" | "/records/lookup" | "/records/query" | "/changes/zone";
type CloudKitPath = ReadPath | "/records/modify" | "/assets/upload";

export class CloudKitRemindersClient {
  private readonly endpoint: URL;
  private readonly params: URLSearchParams;
  private readonly http: AppleHTTP;
  private owner: string | undefined;
  readonly readTrace: CloudKitReadTrace[] = [];
  get remindersZoneOwner() { return this.owner; }
  private get expectedOwner() { return this.owner ?? DEFAULT_OWNER; }
  private get requestZone() { return { ...REMINDERS_ZONE, ...(this.owner && this.owner !== DEFAULT_OWNER ? { ownerRecordName: this.owner } : {}) }; }

  constructor(http: AppleHTTP, connection: CloudKitConnection) {
    this.http = http;
    if (connection.remindersZoneOwner !== undefined) requireInput(typeof connection.remindersZoneOwner === "string" && connection.remindersZoneOwner.length > 0 && connection.remindersZoneOwner.length <= 256 && !/[\u0000-\u0020\u007f]/.test(connection.remindersZoneOwner), "The saved Reminders zone owner is invalid.");
    this.owner = connection.remindersZoneOwner;
    requireInput(/^\d{1,32}$/.test(connection.dsid), "The Apple account identifier is invalid.");
    for (const [key, value] of [["client ID", connection.clientId], ["client build number", connection.clientBuildNumber], ["client mastering number", connection.clientMasteringNumber]] as const) {
      requireInput(typeof value === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(value), `The Apple ${key} is invalid.`);
    }
    const endpoint = validatedAppleURL(connection.cloudKitURL, true);
    requireInput(endpoint.pathname.replace(/\/$/, "") === "/database/1/com.apple.reminders/production/private", "The discovered URL is not the private Reminders CloudKit database.");
    requireInput(!endpoint.search && !endpoint.hash, "The discovered Reminders URL must not contain query parameters or fragments.");
    this.endpoint = endpoint;
    this.params = new URLSearchParams();
    this.params.set("remapEnums", "true");
    this.params.set("clientBuildNumber", connection.clientBuildNumber);
    this.params.set("clientMasteringNumber", connection.clientMasteringNumber);
    this.params.set("clientId", connection.clientId);
    this.params.set("dsid", connection.dsid);
  }

  private async post(path: CloudKitPath, payload: Record<string, unknown>, database: "private" | "shared" = "private"): Promise<Record<string, unknown>> {
    requireInput(database === "private" || path === "/zones/list" || path === "/records/lookup", "The shared diagnostic only supports zone discovery and exact record lookups.");
    const body = JSON.stringify(payload);
    requireInput(new TextEncoder().encode(body).length <= MAX_REQUEST_BYTES, "The CloudKit request exceeded the byte budget.");
    const url = new URL(this.endpoint.href);
    if (database === "shared") url.pathname = url.pathname.replace(/\/private\/?$/, "/shared");
    url.pathname = `${url.pathname.replace(/\/$/, "")}${path}`;
    url.search = this.params.toString();
    const hasSessionCookie = this.http.jar.header(url).length > 0;
    const response = await this.http.request(url.href, {
      method: "POST",
      headers: appleWebHeaders(),
      body,
      discovered: true,
      followRedirects: path !== "/records/modify",
    });
    if ([401, 421, 450].includes(response.status)) {
      console.warn({ event: "apple-reminders-auth-rejected", path, upstreamStatus: response.status, hasSessionCookie, reason: "http-auth-rejection" });
      throw new AppError("REAUTH_REQUIRED", "Apple did not accept Reminders authentication. A saved-token check or Apple sign-in may be required.", 409);
    }
    if (response.status === 403) {
      let denial: unknown;
      try { denial = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(response.bytes)); }
      catch { throw new AppError("FORBIDDEN", "Apple denied access to the private Reminders zone.", 403); }
      if (denial && typeof denial === "object" && "serverErrorCode" in denial && typeof denial.serverErrorCode === "string" &&
        ["PCS_REQUIRED", "DEVICE_CONSENT_REQUIRED", "WEB_ACCESS_DISABLED"].includes(denial.serverErrorCode.toUpperCase())) throw new AppError("DEVICE_APPROVAL_PENDING", "Apple requires Reminders web-access approval. The saved Apple account is preserved.", 409);
      throw new AppError("FORBIDDEN", "Apple denied access to the private Reminders zone.", 403);
    }
    if (response.status === 429) {
      const retryText = response.headers.get("retry-after");
      const retry = retryText && /^\d+(?:\.\d+)?$/.test(retryText) ? Number(retryText) :
        retryText && Number.isFinite(Date.parse(retryText)) ? Math.max(0, (Date.parse(retryText) - Date.now()) / 1000) : null;
      throw new CloudKitRateLimitedError(retry !== null && Number.isFinite(retry) ? retry : null);
    }
    if (response.status !== 200) {
      if (path === "/records/modify") {
        // Only a recognized rejection is a confirmed failure. Timeouts, redirects
        // and server errors can occur after Apple commits the record.
        if (response.status >= 400 && response.status < 500) {
          let failure: Record<string, unknown> | null = null;
          try { failure = object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(response.bytes)), "Invalid write rejection."); } catch { /* Treat unconfirmed responses as uncertain. */ }
          if (failure) parseTopLevelError(failure, { path, upstreamStatus: response.status, hasSessionCookie });
        }
        throw new WriteOutcomeUnknownError("");
      }
      console.warn({ event: "apple-reminders-http-rejected", path, upstreamStatus: response.status });
      if (response.status >= 500) throw new AppError("UPSTREAM_UNAVAILABLE", "Apple could not complete the Reminders read request.", 503, true);
      throw new AppError("PROTOCOL_CHANGED", "Apple returned an unexpected status for the Reminders read request.");
    }
    requireValue(response.bytes.length <= MAX_RESPONSE_BYTES, "Apple returned more data than the CloudKit response budget.");
    let decoded: unknown;
    try { decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(response.bytes)); }
    catch { throw new AppError("PROTOCOL_CHANGED", "Apple returned an invalid Reminders response."); }
    const result = object(decoded, "Apple returned a malformed Reminders response.");
    const zones = Array.isArray(result.zones) ? result.zones : [];
    const records = Array.isArray(result.records) ? result.records : zones.flatMap(zone => Array.isArray(zone?.records) ? zone.records : []);
    const recordTypes: Record<string, number> = {};
    for (const record of records) {
      const type = record && typeof record === "object" && RECORD_TYPES.has(record.recordType) ? record.recordType as string : "other";
      recordTypes[type] = (recordTypes[type] ?? 0) + 1;
    }
    if (path !== "/records/modify") {
      const redactedRequest = JSON.parse(JSON.stringify(payload, (key, value) => ["recordName", "ownerRecordName", "continuationMarker", "syncToken"].includes(key) ? "[redacted]" : key === "zoneName" && value !== "Reminders" ? "[other authorized zone]" : value)) as Record<string, unknown>;
      const redactedURL = new URL(url); redactedURL.searchParams.set("dsid", "[redacted]"); redactedURL.searchParams.set("clientId", "[redacted]");
      this.readTrace.push({ path, url: redactedURL.href, request: redactedRequest, response: { status: response.status, returnedRecords: records.length, recordTypes, zones: zones.length, continuationPresent: typeof result.continuationMarker === "string", recordErrors: records.filter(record => record && typeof record.serverErrorCode === "string").length } });
    }
    parseTopLevelError(result, { path, upstreamStatus: response.status, hasSessionCookie });
    return result;
  }

  async modifyList(operationType: "create" | "update", record: ListWrite, beforeDispatch: () => Promise<void>): Promise<CloudKitRecord> {
    requireInput((operationType === "create" || operationType === "update") && this.owner !== undefined &&
      record.recordType === "List" && record.recordName.length <= 255,
      "Only authenticated private list writes are supported.");
    requestedRecordName(record.recordName, ["List"]);
    const createFields = ["Name", "SortingStyle", "IsLinkedToAccount", "Imported", "IsGroup", "Deleted", "ReminderIDs",
      "ShouldAutoCategorizeItems", "ShouldCategorizeGroceryItems", "ResolutionTokenMap"];
    const renameFields = ["Name", "ResolutionTokenMap"];
    const deleteFields = ["Deleted", "IsLinkedToAccount", "ResolutionTokenMap"];
    const colorFields = ["Color", "ResolutionTokenMap"];
    const badgeFields = ["BadgeEmblem", "ResolutionTokenMap"];
    const appearanceFields = ["BadgeEmblem", "Color", "ResolutionTokenMap"];
    const keys = Object.keys(record.fields);
    const sameKeys = (expected: string[]) => keys.length === expected.length && expected.every(key => Object.hasOwn(record.fields, key));
    const isAppearanceWrite = sameKeys(colorFields) || sameKeys(badgeFields) || sameKeys(appearanceFields);
    requireInput(operationType === "create" ? sameKeys(createFields) : sameKeys(renameFields) || sameKeys(deleteFields) || isAppearanceWrite,
      "Unexpected list write field set.");
    requireInput(operationType === "create" ? record.recordChangeTag === undefined :
      typeof record.recordChangeTag === "string" && record.recordChangeTag.length > 0 && record.recordChangeTag.length <= 512,
      "A list update requires an exact version tag.");
    for (const [key, field] of Object.entries(record.fields)) {
      const type = ["Name", "SortingStyle", "ReminderIDs", "ResolutionTokenMap", "Color", "BadgeEmblem"].includes(key) ? "STRING" : "INT64";
      const encrypted = key === "Name" || key === "ShouldAutoCategorizeItems" || key === "ShouldCategorizeGroceryItems";
      requireInput(field !== null && typeof field === "object" && !Array.isArray(field) &&
        Object.keys(field).every(name => name === "type" || name === "value" || name === "isEncrypted") &&
        field.type === type && (encrypted ? field.isEncrypted === true && Object.hasOwn(field, "isEncrypted") : !Object.hasOwn(field, "isEncrypted")) &&
        (type === "STRING" ? typeof field.value === "string" : Number.isSafeInteger(field.value)),
      "Invalid list write field.");
    }
    if (operationType === "create") {
      requireInput(record.fields.SortingStyle.value === "manual" && record.fields.IsLinkedToAccount.value === 1 &&
        record.fields.Imported.value === 0 && record.fields.IsGroup.value === 0 && record.fields.Deleted.value === 0 &&
        record.fields.ReminderIDs.value === "[]" && record.fields.ShouldAutoCategorizeItems.value === 0 &&
        record.fields.ShouldCategorizeGroceryItems.value === 0,
      "The list creation fields do not match the observed native shape.");
    } else if (sameKeys(renameFields)) {
      requireInput(record.fields.Name.type === "STRING", "A list rename requires a name.");
    } else if (sameKeys(deleteFields)) {
      requireInput(record.fields.Deleted.value === 1 && record.fields.IsLinkedToAccount.value === 0,
        "The list deletion fields do not match the observed native shape.");
    } else {
      requireInput(record.fields.ResolutionTokenMap.type === "STRING" &&
        (!Object.hasOwn(record.fields, "Color") || isNativeColorValue(record.fields.Color.value)) &&
        (!Object.hasOwn(record.fields, "BadgeEmblem") || isNativeEmojiValue(record.fields.BadgeEmblem.value)),
      "The list appearance fields do not match an observed native preset or emoji shape.");
    }
    const payload = { zoneID: this.requestZone, atomic: true, operations: [{ operationType, record }] };
    requireInput(new TextEncoder().encode(JSON.stringify(payload)).length <= MAX_REQUEST_BYTES, "List write exceeded the request budget.");
    await beforeDispatch();
    try {
      const result = await this.post("/records/modify", payload);
      const parsed = pageRecords(result.records, 1, 1, this.expectedOwner);
      if (parsed.recordErrors.length) {
        requireValue(parsed.recordErrors.length === 1 && parsed.recordErrors[0].recordName === record.recordName && !parsed.records.length, "Unexpected list write error.");
        parseTopLevelError({ serverErrorCode: parsed.recordErrors[0].serverErrorCode, recordName: record.recordName },
          { path: "/records/modify", upstreamStatus: 200, hasSessionCookie: this.http.jar.header(this.endpoint).length > 0 });
      }
      const confirmed = parsed.records[0];
      requireValue(parsed.records.length === 1 && confirmed && "recordType" in confirmed &&
        confirmed.recordType === "List" && confirmed.recordName === record.recordName &&
        typeof confirmed.recordChangeTag === "string" && confirmed.recordChangeTag.length > 0,
        "Apple did not confirm the exact list mutation.");
      if (operationType === "update") requireValue(confirmed.recordChangeTag !== record.recordChangeTag, "Apple did not advance the list version.");
      for (const [key, submitted] of Object.entries(record.fields)) {
        const observed = confirmed.fields[key];
        requireValue(observed !== null && typeof observed === "object" && !Array.isArray(observed) &&
          "type" in observed && "value" in observed && observed.type === submitted.type &&
          canonicalListFieldValue(key, observed.value) === canonicalListFieldValue(key, submitted.value) &&
          (submitted.isEncrypted === true ? "isEncrypted" in observed && observed.isEncrypted === true : !Object.hasOwn(observed, "isEncrypted")),
        "Apple did not confirm the submitted list fields.");
      }
      return confirmed as CloudKitRecord;
    } catch (error) {
      if (error instanceof AppError && ["REAUTH_REQUIRED", "FORBIDDEN", "RATE_LIMITED", "CONFLICT"].includes(error.code)) throw error;
      throw new WriteOutcomeUnknownError(record.recordName);
    }
  }

  async modifyReminder(operationType: "create" | "update", record: CloudKitWriteRecord, beforeDispatch?: () => Promise<void>): Promise<CloudKitRecord> {
    return (await this.modifyRecords([{ operationType, record }], beforeDispatch))[0];
  }

  async modifyOrganization(root: CloudKitWriteRecord, dependencies: { operationType: "create" | "update"; record: {
    recordName: string; recordType: "Attachment" | "Hashtag"; recordChangeTag?: string;
    fields: Record<string, { type: string; value: unknown; isEncrypted?: boolean }>;
  } }[] = [], versionGuards: CloudKitRecord[] = [], beforeDispatch?: () => Promise<void>): Promise<CloudKitRecord[]> {
    const relationshipKeys = ["AttachmentIDs", "HashtagIDs"] as const;
    const relationshipFields = relationshipKeys.filter(key => Object.hasOwn(root.fields, key));
    requireInput(relationshipFields.length === 1 && Object.keys(root.fields).length === 3 &&
      ["LastModifiedDate", "ResolutionTokenMap", ...relationshipFields].every(key => Object.hasOwn(root.fields, key)),
    "Organization updates require exactly one observed relationship list and its native timestamp tokens.");
    const relationshipKey = relationshipFields[0];
    const childType = relationshipKey === "AttachmentIDs" ? "Attachment" : "Hashtag";
    const childPrefix = `${childType}/`;
    const idsField = root.fields[relationshipKey];
    requireInput(idsField.type === "STRING_LIST" && Array.isArray(idsField.value) && idsField.value.length <= 31 &&
      idsField.value.every(id => typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) &&
      new Set((idsField.value as string[]).map(id => id.toLowerCase())).size === idsField.value.length,
    "The organization relationship list must contain bounded unique native UUIDs.");
    const exactEnvelope = (field: unknown, encrypted = false): boolean => field !== null && typeof field === "object" && !Array.isArray(field) &&
      "type" in field && "value" in field && Object.keys(field).length === (encrypted ? 3 : 2) &&
      Object.keys(field).every(key => key === "type" || key === "value" || encrypted && key === "isEncrypted") &&
      (!encrypted || "isEncrypted" in field && field.isEncrypted === true);
    requireInput(Object.values(root.fields).every(field => exactEnvelope(field)), "Organization root fields require exact native field wrappers.");
    this.validateWrite("update", { ...root, fields: Object.fromEntries(Object.entries(root.fields).filter(([key]) => !relationshipKeys.includes(key as typeof relationshipKeys[number]))) });
    requireInput(dependencies.length <= 30, "Organization changes exceed the atomic operation budget.");
    const activeURL = (record: { fields: Record<string, unknown> }) => {
      const type = record.fields.Type as { type?: unknown; value?: unknown } | undefined;
      const uti = record.fields.UTI as { type?: unknown; value?: unknown } | undefined;
      const url = record.fields.URL as { type?: unknown; value?: unknown; isEncrypted?: unknown } | undefined;
      return type?.type === "STRING" && type.value === "URL" || uti?.type === "STRING" && uti.value === "public.url" ?
        type?.type === "STRING" && type.value === "URL" && uti?.type === "STRING" && uti.value === "public.url" &&
          (record.fields.Imported as { type?: unknown; value?: unknown } | undefined)?.type === "INT64" &&
          (record.fields.Imported as { type?: unknown; value?: unknown }).value === 0 && url?.type === "STRING" &&
          url.isEncrypted === true && typeof url.value === "string" && url.value.length <= 2_048 &&
          !/[\s\u0000-\u001f\u007f-\u009f]/u.test(url.value) && (() => { try { const parsed = new URL(url.value as string); return ["http:", "https:"].includes(parsed.protocol) && !parsed.username && !parsed.password; } catch { return false; } })() : false;
    };
    const checkRelated = (record: { recordName: string; recordType: string; fields: Record<string, unknown> }, operationType: "create" | "update" | "guard") => {
      requireInput(record.recordType === childType && record.recordName.startsWith(childPrefix) &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(record.recordName.slice(childPrefix.length)),
      "Organization records require canonical attachment or hashtag UUID identities.");
      const backref = record.fields.Reminder as { type?: unknown; value?: unknown } | undefined;
      requireInput(backref?.type === "REFERENCE" && (backref.value === null && operationType === "update" || backref.value !== null && typeof backref.value === "object" &&
        !Array.isArray(backref.value) && "recordName" in backref.value && backref.value.recordName === root.recordName &&
        "action" in backref.value && backref.value.action === "VALIDATE" && (operationType === "guard" ?
          Object.keys(backref.value).every(key => ["recordName", "action", "zoneID"].includes(key)) : Object.keys(backref.value).length === 2)),
      "An organization record must use the exact observed reminder backlink.");
      if (operationType === "guard" && backref?.value && typeof backref.value === "object" && "zoneID" in backref.value) {
        zoneID(backref.value.zoneID, false, true, this.expectedOwner);
      }
      const deleted = record.fields.Deleted as { type?: unknown; value?: unknown } | undefined;
      if (operationType === "guard") {
        requireInput(deleted?.type === "INT64" && deleted.value === 0, "Organization guards must preserve an active relationship record.");
        if (childType === "Hashtag") {
          const name = record.fields.Name as { type?: unknown; value?: unknown; isEncrypted?: unknown } | undefined;
          const type = record.fields.Type as { type?: unknown; value?: unknown } | undefined;
          const imported = record.fields.Imported as { type?: unknown; value?: unknown } | undefined;
          requireInput(name?.type === "STRING" && name.isEncrypted === true && typeof name.value === "string" && name.value.length <= 128 &&
            type?.type === "INT64" && type.value === 0 && imported?.type === "INT64" && imported.value === 0,
          "Hashtag guards must match the observed private tag recipe.");
        } else {
          const type = record.fields.Type as { value?: unknown } | undefined;
          const uti = record.fields.UTI as { value?: unknown } | undefined;
          if ((type?.value === "URL" || uti?.value === "public.url") && !activeURL(record)) {
            requireInput(false, "URL attachment guards must match the observed native URL recipe.");
          }
        }
      } else if (operationType === "update") {
        requireInput(Object.keys(record.fields).length === 2 && deleted?.type === "INT64" && deleted.value === 1 && backref.type === "REFERENCE" && backref.value === null,
          "Relationship retirement may only soft-delete and detach the exact record.");
        requireInput(Object.values(record.fields).every(field => exactEnvelope(field)), "Relationship retirement fields require exact native wrappers.");
      } else if (operationType === "create") {
        requireInput(Object.entries(record.fields).every(([key, field]) => exactEnvelope(field, key === (childType === "Attachment" ? "URL" : "Name"))),
          "Organization creation fields require exact native field wrappers.");
        if (childType === "Attachment") {
          const type = record.fields.Type as { type?: unknown; value?: unknown } | undefined;
          const uti = record.fields.UTI as { type?: unknown; value?: unknown } | undefined;
          const imported = record.fields.Imported as { type?: unknown; value?: unknown } | undefined;
          const url = record.fields.URL as { type?: unknown; value?: unknown; isEncrypted?: unknown } | undefined;
          requireInput(Object.keys(record.fields).length === 6 && type?.type === "STRING" && type.value === "URL" &&
            uti?.type === "STRING" && uti.value === "public.url" && imported?.type === "INT64" &&
            imported.value === 0 && deleted?.type === "INT64" && deleted.value === 0 && url?.type === "STRING" &&
            url.isEncrypted === true && typeof url.value === "string" && activeURL(record),
          "Only the observed URL attachment creation recipe is supported.");
        } else {
          const creation = record.fields.CreationDate as { type?: unknown; value?: unknown } | undefined;
          const type = record.fields.Type as { type?: unknown; value?: unknown } | undefined;
          const imported = record.fields.Imported as { type?: unknown; value?: unknown } | undefined;
          const name = record.fields.Name as { type?: unknown; value?: unknown; isEncrypted?: unknown } | undefined;
          requireInput(Object.keys(record.fields).length === 6 && creation?.type === "TIMESTAMP" && Number.isSafeInteger(creation.value) &&
            type?.type === "INT64" && type.value === 0 && imported?.type === "INT64" && imported.value === 0 &&
            deleted?.type === "INT64" && deleted.value === 0 && name?.type === "STRING" && name.isEncrypted === true &&
            typeof name.value === "string" && name.value.length >= 1 && name.value.length <= 128 && !/[\s\u0000-\u001f\u007f-\u009f]/u.test(name.value),
          "Only the observed hashtag creation recipe is supported.");
        }
      } else {
        requireInput(false, "Unsupported organization operation.");
      }
    };
    for (const operation of dependencies) {
      requestedRecordName(operation.record.recordName, [childType]);
      const create = operation.operationType === "create";
      requireInput(create ? operation.record.recordChangeTag === undefined : typeof operation.record.recordChangeTag === "string" &&
        operation.record.recordChangeTag.length > 0 && operation.record.recordChangeTag.length <= 512,
      "Organization updates require exact versions and creates cannot carry a version tag.");
      checkRelated(operation.record, operation.operationType);
      const id = operation.record.recordName.slice(childPrefix.length);
      requireInput(create ? (idsField.value as string[]).some(value => value.toLowerCase() === id.toLowerCase()) :
        !(idsField.value as string[]).some(value => value.toLowerCase() === id.toLowerCase()),
      "Organization records and root relationship IDs disagree.");
    }
    const guardNames = new Set<string>();
    for (const guard of versionGuards) {
      requireInput(guard.recordType === childType && !guardNames.has(guard.recordName) && !dependencies.some(item => item.record.recordName === guard.recordName),
        "Organization guards must be unique unchanged records of the selected relationship type.");
      guardNames.add(guard.recordName);
      requestedRecordName(guard.recordName, [childType]);
      requireInput(guard.zoneID?.zoneName === "Reminders" && [this.expectedOwner, DEFAULT_OWNER].includes(guard.zoneID.ownerRecordName ?? this.expectedOwner) &&
        (guard.zoneID.zoneType === undefined || guard.zoneID.zoneType === REMINDERS_ZONE.zoneType) && !guard.deleted &&
        typeof guard.recordChangeTag === "string" && guard.recordChangeTag.length > 0 && guard.recordChangeTag.length <= 512 &&
        (idsField.value as string[]).some(value => `${childPrefix}${value}` === guard.recordName),
      "An organization guard must be a versioned record in the authenticated private reminder relationship.");
      checkRelated(guard, "guard");
    }
    requireInput(new Set([...dependencies.map(item => item.record.recordName), ...versionGuards.map(record => record.recordName), root.recordName]).size ===
      dependencies.length + versionGuards.length + 1, "An organization transaction contains duplicate records.");
    const operations = [{ operationType: "update" as const, record: root }, ...dependencies];
    const result = await this.executeRecords(operations, beforeDispatch, versionGuards, [childType]);
    const submitted = new Map(operations.map(operation => [operation.record.recordName, operation.record]));
    for (const confirmed of result) {
      if (!("recordType" in confirmed)) continue;
      const write = submitted.get(confirmed.recordName);
      if (!write) continue;
      for (const [key, rawSent] of Object.entries(write.fields)) {
        const sent = rawSent as { type: string; value: unknown; isEncrypted?: unknown };
        if (!confirmsField(confirmed, key, sent, this.expectedOwner)) {
          throw new WriteOutcomeUnknownError(root.recordName);
        }
      }
    }
    return result as CloudKitRecord[];
  }

  async modifyTransfer(operationType: "create" | "update", root: CloudKitWriteRecord,
    memberships: ListWrite[], listSnapshots: CloudKitRecord[], dependencies: { operationType: "create"; record: {
      recordName: string; recordType: "Attachment" | "Hashtag"; recordChangeTag?: string; fields: Record<string, { type: string; value: unknown; isEncrypted?: boolean }>;
    } }[] = [], versionGuards: CloudKitRecord[] = [], beforeDispatch?: () => Promise<void>, sourceListId?: string): Promise<CloudKitRecord[]> {
    requireInput(operationType === "create" || operationType === "update", "Only a copied or moved Reminder can use the transfer recipe.");
    const rootLinkKeys = ["AttachmentIDs", "HashtagIDs"] as const;
    const listValue = root.fields.List;
    requireInput(listValue?.type === "REFERENCE" && listValue.value !== null && typeof listValue.value === "object" && !Array.isArray(listValue.value) &&
      "recordName" in listValue.value && typeof listValue.value.recordName === "string" && "action" in listValue.value && listValue.value.action === "VALIDATE" &&
      Object.keys(listValue.value).length === 2,
    "A transfer requires an exact validated destination List reference.");
    const destinationId = listValue.value.recordName;
    requestedRecordName(destinationId, ["List"]);
    if (operationType === "update") {
      requireInput(root.recordChangeTag !== undefined && root.parent?.recordName === destinationId && Object.keys(root.fields).length === 3 &&
        ["List", "LastModifiedDate", "ResolutionTokenMap"].every(key => Object.hasOwn(root.fields, key)) && sourceListId !== undefined && sourceListId !== destinationId,
      "A move requires one exact root version, distinct source and destination lists, and only the observed root fields.");
      this.validateWrite("update", { ...root, parent: undefined, fields: Object.fromEntries(Object.entries(root.fields).filter(([key]) => key !== "List")) });
    } else {
      const baseKeys = ["AllDay", "Completed", "CompletionDate", "CreationDate", "Deleted", "Flagged", "Imported", "LastModifiedDate", "List", "NotesDocument", "Priority", "ResolutionTokenMap", "TitleDocument"];
      requireInput(root.recordChangeTag === undefined && root.parent?.recordName === destinationId &&
        Object.keys(root.fields).every(key => [...baseKeys, ...rootLinkKeys].includes(key)) &&
        baseKeys.every(key => Object.hasOwn(root.fields, key)),
      "A copy requires the observed plain Reminder creation fields and destination parent.");
      this.validateWrite("create", { ...root, fields: Object.fromEntries(Object.entries(root.fields).filter(([key]) => !rootLinkKeys.includes(key as typeof rootLinkKeys[number]))) });
      requireInput(root.fields.AllDay?.value === 0 && root.fields.Completed?.value === 0 && root.fields.Deleted?.value === 0 && root.fields.Imported?.value === 0 &&
        !Object.hasOwn(root.fields, "ParentReminder") && !Object.hasOwn(root.fields, "DueDate") && !Object.hasOwn(root.fields, "TimeZone"),
      "Only undated, open, top-level Reminder copies are supported.");
    }
    const parseLinkIds = (value: unknown, key: string, type: "Attachment" | "Hashtag"): string[] => {
      if (value === undefined) return [];
      const field = value as { type?: unknown; value?: unknown };
      requireInput((field.type === "STRING_LIST" || field.type === "UNKNOWN_LIST" && Array.isArray(field.value) && field.value.length === 0) &&
        Array.isArray(field.value) && field.value.length <= 31 &&
        field.value.every(id => typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) &&
        new Set((field.value as string[]).map(id => id.toLowerCase())).size === field.value.length,
      `The ${key} copy list must contain bounded native UUIDs.`);
      return field.value as string[];
    };
    const createdAttachmentIds = parseLinkIds(root.fields.AttachmentIDs, "AttachmentIDs", "Attachment");
    const createdHashtagIds = parseLinkIds(root.fields.HashtagIDs, "HashtagIDs", "Hashtag");
    requireInput(operationType === "update" ? root.fields.AttachmentIDs === undefined && root.fields.HashtagIDs === undefined : true,
      "A move preserves existing organization relationships without rewriting their root lists.");

    const snapshotsByName = new Map(listSnapshots.map(record => [record.recordName, record]));
    requireInput((operationType === "update" ? listSnapshots.length === 2 : listSnapshots.length === 1) &&
      snapshotsByName.size === listSnapshots.length && snapshotsByName.has(destinationId) && sourceListId !== undefined && sourceListId !== destinationId,
    "A transfer requires an exact destination List snapshot and (for moves) the source snapshot.");
    const sourceListSnapshot = snapshotsByName.get(sourceListId) ?? versionGuards.find(record => record.recordType === "List" && record.recordName === sourceListId);
    requireInput(sourceListSnapshot !== undefined, "A transfer requires the exact current source List membership.");
    const listMembership = (record: CloudKitRecord): string[] => {
      if (record.recordType !== "List" || record.deleted || record.zoneID && record.zoneID.zoneName !== "Reminders" ||
        record.zoneID?.zoneType !== undefined && record.zoneID.zoneType !== REMINDERS_ZONE.zoneType ||
        record.zoneID?.ownerRecordName !== undefined && ![this.expectedOwner, DEFAULT_OWNER].includes(record.zoneID.ownerRecordName) ||
        (record.fields.Deleted as { type?: unknown; value?: unknown } | undefined)?.type !== "INT64" ||
        (record.fields.Deleted as { type?: unknown; value?: unknown } | undefined)?.value !== 0) {
        throw new AppError("FORBIDDEN", "A transfer List must be active in the authenticated private Reminders zone.", 403);
      }
      const field = record.fields.ReminderIDs as { type?: unknown; value?: unknown } | undefined;
      requireInput(field?.type === "STRING" && typeof field.value === "string" && field.value.length <= 65_536,
        "A transfer requires an observed List ReminderIDs JSON field.");
      let parsed: unknown;
      try { parsed = JSON.parse(field.value); } catch { throw new AppError("PROTOCOL_CHANGED", "The current List membership is malformed."); }
      requireInput(Array.isArray(parsed) && parsed.length <= 2_000 && parsed.every(id => typeof id === "string"), "The List membership is outside the transfer budget.");
      const values = parsed as string[];
      const canonical = values.map(id => id.includes("/") ? requestedRecordName(id, ["Reminder"]) : `Reminder/${id}`);
      requireInput(new Set(canonical).size === canonical.length, "The List membership contains duplicate Reminder IDs.");
      return canonical;
    };
    const beforeLists = new Map([...new Map([...snapshotsByName, [sourceListId, sourceListSnapshot]]).values()].map(record => [record.recordName, listMembership(record)]));
    const writesByName = new Map(memberships.map(write => [write.recordName, write]));
    requireInput((operationType === "update" ? memberships.length === 2 : memberships.length === 1) && writesByName.size === memberships.length &&
      memberships.every(write => write.recordType === "List" && write.recordName !== sourceListId || operationType === "update" && write.recordName === sourceListId),
    "A move must update both Lists; a copy may update only the destination List.");
    const transferId = root.recordName;
    const sourceBefore = beforeLists.get(sourceListId)!;
    const destinationBefore = beforeLists.get(destinationId)!;
    if (operationType === "update") {
      requireInput(sourceBefore.includes(transferId) && !destinationBefore.includes(transferId), "The move source/destination membership does not match the current Reminder links.");
    } else {
      requireInput(!sourceBefore.includes(transferId) && !destinationBefore.includes(transferId), "A copy must use a fresh Reminder identity.");
    }
    const expectedMembership = new Map<string, string[]>();
    if (operationType === "update") {
      expectedMembership.set(sourceListId, sourceBefore.filter(id => id !== transferId));
      expectedMembership.set(destinationId, [...destinationBefore, transferId]);
    } else expectedMembership.set(destinationId, [...destinationBefore, transferId]);
    for (const [name, expected] of expectedMembership) {
      const write = writesByName.get(name), before = snapshotsByName.get(name)!;
      requireInput(write && write.recordChangeTag === before.recordChangeTag && typeof write.recordChangeTag === "string" && write.recordChangeTag.length > 0 &&
        write.recordChangeTag.length <= 512 && Object.keys(write.fields).length === 2 && Object.hasOwn(write.fields, "ReminderIDs") && Object.hasOwn(write.fields, "ResolutionTokenMap"),
      "Transfer List writes require their exact snapshot versions and only the observed membership fields.");
      const submitted = write.fields.ReminderIDs;
      requireInput(submitted?.type === "STRING" && typeof submitted.value === "string" && submitted.value.length <= 65_536,
        "Transfer List membership updates must use native JSON string fields.");
      let submittedIds: unknown;
      try { submittedIds = JSON.parse(submitted.value); } catch { throw new AppError("VALIDATION_ERROR", "A transfer List membership update is malformed."); }
      requireInput(Array.isArray(submittedIds) && submittedIds.length === expected.length && submittedIds.every(id => typeof id === "string"),
        "A transfer List membership update has an invalid entry count.");
      const canonical = (submittedIds as string[]).map(id => id.includes("/") ? requestedRecordName(id, ["Reminder"]) : `Reminder/${id}`);
      requireInput(canonical.length === expected.length && canonical.every((id, index) => id === expected[index]),
        "A transfer List write may only remove or append the selected Reminder while preserving every other membership.");
      const oldRaw = (JSON.parse(String((before.fields.ReminderIDs as { value: string }).value)) as string[]);
      const submittedRaw = submittedIds as string[];
      for (const id of expected) if (id !== transferId) {
        const indexBefore = beforeLists.get(name)!.indexOf(id);
        const indexAfter = canonical.indexOf(id);
        requireInput(indexBefore >= 0 && oldRaw[indexBefore] === submittedRaw[indexAfter], "A transfer must preserve each existing List membership representation.");
      }
      const beforeTokens = (before.fields.ResolutionTokenMap as { type?: unknown; value?: unknown } | undefined);
      const afterTokens = write.fields.ResolutionTokenMap;
      requireInput(beforeTokens?.type === "STRING" && typeof beforeTokens.value === "string" && afterTokens?.type === "STRING" && typeof afterTokens.value === "string",
        "Transfer List writes require the observed resolution-token map.");
      let priorMap: unknown, nextMap: unknown;
      try { priorMap = JSON.parse(beforeTokens.value); nextMap = JSON.parse(afterTokens.value); }
      catch { throw new AppError("PROTOCOL_CHANGED", "A transfer List resolution-token map is malformed."); }
      requireInput(priorMap !== null && typeof priorMap === "object" && !Array.isArray(priorMap) && nextMap !== null && typeof nextMap === "object" && !Array.isArray(nextMap) &&
        Object.keys(priorMap).length === 1 && Object.hasOwn(priorMap, "map") && Object.keys(nextMap).length === 1 && Object.hasOwn(nextMap, "map"),
      "A transfer List resolution-token map has an unsupported envelope.");
      const oldMap = (priorMap as { map: Record<string, unknown> }).map, newMap = (nextMap as { map: Record<string, unknown> }).map;
      requireInput(oldMap !== null && typeof oldMap === "object" && newMap !== null && typeof newMap === "object" &&
        Object.keys(newMap).every(key => key === "reminderIDsMergeableOrdering" || Object.hasOwn(oldMap, key)) &&
        Object.keys(oldMap).every(key => key === "reminderIDsMergeableOrdering" || Object.hasOwn(newMap, key)),
      "A transfer may only change the List ordering token.");
      for (const key of Object.keys(oldMap)) if (key !== "reminderIDsMergeableOrdering") {
        requireInput(canonicalJSON(oldMap[key]) === canonicalJSON(newMap[key]), "A transfer changed an unrelated List resolution token.");
      }
      const oldToken = oldMap.reminderIDsMergeableOrdering as { counter?: unknown; modificationTime?: unknown; replicaID?: unknown } | undefined;
      const newToken = newMap.reminderIDsMergeableOrdering as { counter?: unknown; modificationTime?: unknown; replicaID?: unknown } | undefined;
      requireInput(newToken !== undefined && Number.isSafeInteger(newToken.counter) && typeof newToken.modificationTime === "number" && Number.isFinite(newToken.modificationTime) &&
        typeof newToken.replicaID === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(newToken.replicaID) &&
        (oldToken === undefined ? newToken.counter === 1 : Number.isSafeInteger(oldToken.counter) && newToken.counter === (oldToken.counter as number) + 1 &&
          newToken.replicaID === oldToken.replicaID && typeof oldToken.modificationTime === "number" && newToken.modificationTime >= oldToken.modificationTime),
      "A transfer must advance only the native List membership ordering token.");
    }

    const privateZoneRecord = (record: CloudKitRecord): CloudKitRecord => {
      if (record.zoneID && (record.zoneID.zoneName !== "Reminders" ||
        record.zoneID.zoneType !== undefined && record.zoneID.zoneType !== REMINDERS_ZONE.zoneType ||
        record.zoneID.ownerRecordName !== undefined && ![this.expectedOwner, DEFAULT_OWNER].includes(record.zoneID.ownerRecordName))) {
        throw new AppError("FORBIDDEN", "A transfer guard belongs to a different CloudKit zone owner.", 403);
      }
      return { ...record, zoneID: record.zoneID ?? this.requestZone };
    };
    const checkedGuards = versionGuards.map(privateZoneRecord);
    let sourceReminder: CloudKitRecord | undefined;
    if (operationType === "create") {
      sourceReminder = checkedGuards.find(record => record.recordType === "Reminder");
      requireInput(sourceReminder && sourceReminder.recordName !== root.recordName &&
        sourceReminder.recordChangeTag && sourceReminder.zoneID?.zoneName === "Reminders" &&
        (sourceReminder.fields.Deleted as { type?: unknown; value?: unknown } | undefined)?.type === "INT64" &&
        (sourceReminder.fields.Deleted as { type?: unknown; value?: unknown } | undefined)?.value === 0 &&
        (sourceReminder.fields.Completed as { type?: unknown; value?: unknown } | undefined)?.type === "INT64" &&
        (sourceReminder.fields.Completed as { type?: unknown; value?: unknown } | undefined)?.value === 0 &&
        referenceField(sourceReminder, "List", "List", this.expectedOwner) === sourceListId && sourceBefore.includes(sourceReminder.recordName),
      "A copy requires the exact active source Reminder and its current source List membership.");
      const sourceNormalized = normalizeReminder(sourceReminder, this.expectedOwner);
      requireInput(sourceNormalized.listId === sourceListId && sourceNormalized.completed === false && sourceNormalized.deleted === false &&
        sourceNormalized.parentReminderId === null && sourceNormalized.dueDate === null && sourceNormalized.startDate === null &&
        sourceNormalized.timeZone === null && sourceNormalized.allDay === false && (sourceNormalized.alarmIds?.length ?? 0) === 0 &&
        (sourceNormalized.recurrenceRuleIds?.length ?? 0) === 0,
      "Only active, open, undated, top-level reminders without alarms or recurrence can be copied.");
      requireInput(checkedGuards.some(record => record.recordType === "List" && record.recordName === sourceListId &&
        record.recordChangeTag === sourceListSnapshot.recordChangeTag), "A copy must version-guard its unchanged source List.");
      const sourceHashtags = parseLinkIds(sourceReminder.fields.HashtagIDs, "HashtagIDs", "Hashtag");
      const sourceAttachments = parseLinkIds(sourceReminder.fields.AttachmentIDs, "AttachmentIDs", "Attachment");
      const relatedGuards = checkedGuards.filter(record => record.recordType === "Hashtag" || record.recordType === "Attachment");
      requireInput(relatedGuards.length === sourceHashtags.length + sourceAttachments.length &&
        new Set(relatedGuards.map(record => record.recordName)).size === relatedGuards.length,
      "A copy requires an exact version guard for every known source tag and URL attachment.");
      const sourceTags = new Map<string, string>();
      for (const record of relatedGuards.filter(record => record.recordType === "Hashtag")) {
        requireInput(sourceHashtags.some(id => `${record.recordName.slice("Hashtag/".length)}`.toLowerCase() === id.toLowerCase()) &&
          referenceField(record, "Reminder", "Reminder", this.expectedOwner) === sourceReminder.recordName &&
          (record.fields.Deleted as { type?: unknown; value?: unknown } | undefined)?.type === "INT64" &&
          (record.fields.Deleted as { type?: unknown; value?: unknown } | undefined)?.value === 0 &&
          (record.fields.Type as { type?: unknown; value?: unknown } | undefined)?.type === "INT64" &&
          (record.fields.Type as { type?: unknown; value?: unknown } | undefined)?.value === 0 &&
          (record.fields.Imported as { type?: unknown; value?: unknown } | undefined)?.type === "INT64" &&
          (record.fields.Imported as { type?: unknown; value?: unknown } | undefined)?.value === 0,
        "A copied hashtag must be a known source-owned native tag.");
        const name = record.fields.Name as { type?: unknown; value?: unknown; isEncrypted?: unknown } | undefined;
        requireInput(name?.type === "STRING" && name.isEncrypted === true && typeof name.value === "string" && name.value.length >= 1 && name.value.length <= 128 && !/[\s\u0000-\u001f\u007f-\u009f]/u.test(name.value),
          "A copied hashtag name is outside the supported literal format.");
        sourceTags.set(name.value, record.recordName);
      }
      const sourceURLs: string[] = [];
      for (const record of relatedGuards.filter(record => record.recordType === "Attachment")) {
        requireInput(sourceAttachments.some(id => `${record.recordName.slice("Attachment/".length)}`.toLowerCase() === id.toLowerCase()) &&
          referenceField(record, "Reminder", "Reminder", this.expectedOwner) === sourceReminder.recordName &&
          (record.fields.Deleted as { type?: unknown; value?: unknown } | undefined)?.type === "INT64" &&
          (record.fields.Deleted as { type?: unknown; value?: unknown } | undefined)?.value === 0,
        "A copied attachment must be linked to the exact source reminder.");
        const type = record.fields.Type as { type?: unknown; value?: unknown } | undefined;
        const uti = record.fields.UTI as { type?: unknown; value?: unknown } | undefined;
        const imported = record.fields.Imported as { type?: unknown; value?: unknown } | undefined;
        const url = record.fields.URL as { type?: unknown; value?: unknown; isEncrypted?: unknown } | undefined;
        requireInput(type?.type === "STRING" && type.value === "URL" && uti?.type === "STRING" && uti.value === "public.url" &&
          imported?.type === "INT64" && imported.value === 0 && url?.type === "STRING" && url.isEncrypted === true && typeof url.value === "string",
        "Only known native URL attachments can be copied.");
        sourceURLs.push(url.value);
      }
      requireInput(sourceURLs.length <= 1 && createdAttachmentIds.length === sourceURLs.length && createdHashtagIds.length === sourceTags.size &&
        dependencies.length === sourceURLs.length + sourceTags.size,
      "The copied Reminder links must match exactly its known source URLs and tags.");
      requireInput(dependencies.every(item => item.operationType === "create" && item.record.recordChangeTag === undefined &&
        item.record.recordName.startsWith(`${item.record.recordType}/`) &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(item.record.recordName.slice(item.record.recordType.length + 1)) &&
        item.record.fields.Reminder?.type === "REFERENCE" && item.record.fields.Reminder.value !== null && typeof item.record.fields.Reminder.value === "object" &&
        "recordName" in item.record.fields.Reminder.value && item.record.fields.Reminder.value.recordName === root.recordName &&
        "action" in item.record.fields.Reminder.value && item.record.fields.Reminder.value.action === "VALIDATE" && Object.keys(item.record.fields.Reminder.value).length === 2),
      "A copied linked record must use a fresh UUID and the exact validated new Reminder backlink.");
      for (const item of dependencies) {
        const fields = item.record.fields;
        if (item.record.recordType === "Attachment") {
          const rawURL = fields.URL;
          requireInput(Object.keys(fields).length === 6 && fields.Type?.type === "STRING" && fields.Type.value === "URL" &&
            fields.UTI?.type === "STRING" && fields.UTI.value === "public.url" && fields.Imported?.type === "INT64" && fields.Imported.value === 0 &&
            fields.Deleted?.type === "INT64" && fields.Deleted.value === 0 && rawURL?.type === "STRING" && rawURL.isEncrypted === true &&
            typeof rawURL.value === "string" && rawURL.value.length <= 2_048 && !/[\s\u0000-\u001f\u007f-\u009f]/u.test(rawURL.value) &&
            (() => { try { const parsed = new URL(rawURL.value as string); return ["http:", "https:"].includes(parsed.protocol) && !parsed.username && !parsed.password; } catch { return false; } })(),
          "A copied attachment must use the exact native encrypted HTTP(S) URL template.");
        } else {
          const name = fields.Name;
          requireInput(Object.keys(fields).length === 6 && fields.CreationDate?.type === "TIMESTAMP" && Number.isSafeInteger(fields.CreationDate.value) &&
            fields.Type?.type === "INT64" && fields.Type.value === 0 && fields.Imported?.type === "INT64" && fields.Imported.value === 0 &&
            fields.Deleted?.type === "INT64" && fields.Deleted.value === 0 && name?.type === "STRING" && name.isEncrypted === true &&
            typeof name.value === "string" && name.value.length >= 1 && name.value.length <= 128 && !/[\s\u0000-\u001f\u007f-\u009f]/u.test(name.value),
          "A copied hashtag must use the exact native encrypted literal tag template.");
        }
      }
      requireInput(dependencies.filter(item => item.record.recordType === "Attachment").length === sourceURLs.length &&
        dependencies.filter(item => item.record.recordType === "Hashtag").length === sourceTags.size,
      "The copied linked-record types do not match the source organization records.");
      const outputURL = dependencies.filter(item => item.record.recordType === "Attachment").map(item => item.record.fields.URL.value as string);
      const outputTags = dependencies.filter(item => item.record.recordType === "Hashtag").map(item => item.record.fields.Name.value as string);
      requireInput(canonicalJSON(outputURL) === canonicalJSON(sourceURLs) &&
        outputTags.length === sourceTags.size && outputTags.every(name => sourceTags.has(name)),
      "A copy must create fresh linked identities with the exact observed source URL and tag values.");
      const sourceIds = new Set([sourceReminder.recordName, ...relatedGuards.map(record => record.recordName)]);
      requireInput(!sourceIds.has(root.recordName) && dependencies.every(item => !sourceIds.has(item.record.recordName)), "A copy must use fresh Reminder and related-record identities.");
    } else {
      requireInput(checkedGuards.every(record => record.recordType === "Attachment" || record.recordType === "Hashtag") &&
        checkedGuards.every(record => referenceField(record, "Reminder", "Reminder", this.expectedOwner) === root.recordName),
      "A move may only guard relationships attached to the moved Reminder.");
    }
    for (const guard of checkedGuards) {
      requireInput(["Reminder", "List", "Attachment", "Hashtag"].includes(guard.recordType) && !guard.deleted &&
        typeof guard.recordChangeTag === "string" && guard.recordChangeTag.length > 0 && guard.recordChangeTag.length <= 512,
      "A transfer guard requires an exact active private record version.");
    }
    const rootTargetListIds = new Map<string, string[]>([
      ["Attachment", createdAttachmentIds], ["Hashtag", createdHashtagIds],
    ]);
    if (operationType === "create") for (const dependency of dependencies) {
      const type = dependency.record.recordType;
      const ids = rootTargetListIds.get(type)!;
      requireInput(ids.some(id => id.toLowerCase() === dependency.record.recordName.slice(type.length + 1).toLowerCase()),
        "A copied related record must be linked by the new Reminder in the same atomic group.");
    }
    const dependencyWrites = dependencies.map(dependency => ({ operationType: "create" as const, record: dependency.record }));
    const ops: { operationType: "create" | "update"; record: CloudKitWriteRecord | ListWrite | { recordName: string; recordType: "Attachment" | "Hashtag"; fields: Record<string, { type: string; value: unknown; isEncrypted?: boolean }> } }[] = [
      { operationType, record: root }, ...memberships.map(record => ({ operationType: "update" as const, record })), ...dependencyWrites,
    ];
    const allGuards = [...checkedGuards];
    requireInput(ops.length + allGuards.length <= 32 && new Set([...ops.map(item => item.record.recordName), ...allGuards.map(record => record.recordName)]).size === ops.length + allGuards.length,
      "The transfer exceeds the atomic record budget or contains duplicate identities.");
    const executorOps = ops.map(item => ({ operationType: item.operationType, record: item.record as { recordName: string; recordType: string; recordChangeTag?: string; fields?: Record<string, unknown> } }));
    const presentationGuards = operationType === "create" && sourceReminder ? [sourceReminder.recordName] : [];
    const result = await this.executeRecords(executorOps, beforeDispatch, allGuards, ["List", "Attachment", "Hashtag"], presentationGuards);
    const confirmedRoot = result.find(item => item.recordName === root.recordName);
    const parent = confirmedRoot && "recordType" in confirmedRoot ? confirmedRoot.raw.parent : undefined;
    if (!confirmedRoot || !("recordType" in confirmedRoot) || parent === null || typeof parent !== "object" || Array.isArray(parent) ||
      !Object.hasOwn(parent, "recordName") || (parent as { recordName?: unknown }).recordName !== destinationId) {
      throw new WriteOutcomeUnknownError(root.recordName);
    }
    const submitted = new Map(ops.map(item => [item.record.recordName, item.record]));
    for (const confirmed of result) {
      if (!("recordType" in confirmed)) continue;
      const write = submitted.get(confirmed.recordName);
      if (!write) continue;
      for (const [key, rawSent] of Object.entries(write.fields)) {
        const sent = rawSent as { type: string; value: unknown; isEncrypted?: unknown };
        if (!confirmsField(confirmed, key, sent, this.expectedOwner)) {
          throw new WriteOutcomeUnknownError(root.recordName);
        }
      }
    }
    return result as CloudKitRecord[];
  }

  async modifyRecords(operations: { operationType: "create" | "update"; record: CloudKitWriteRecord }[], beforeDispatch?: () => Promise<void>, versionGuards: CloudKitRecord[] = []): Promise<CloudKitRecord[]> {
    for (const { operationType, record } of operations) this.validateWrite(operationType, record);
    for (const record of versionGuards.filter(record => record.recordType === "List")) {
      const list = normalizeList(record, false);
      requireInput(list.deleted === false && list.isGroup !== true, "A reminder write can only guard a live standard List.");
    }
    const guardedCreateLists = operations.filter(operation => operation.operationType === "create")
      .map(operation => operation.record.parent?.recordName)
      .filter((recordName): recordName is string => typeof recordName === "string" &&
        versionGuards.some(guard => guard.recordType === "List" && guard.recordName === recordName));
    return await this.executeRecords(operations, beforeDispatch, versionGuards, ["List"],
      versionGuards.filter(record => ["Reminder", "List"].includes(record.recordType)).map(record => record.recordName), false, guardedCreateLists.length > 0) as CloudKitRecord[];
  }

  async modifyReminderCreation(reminder: CloudKitWriteRecord, list: CloudKitRecord, beforeDispatch?: () => Promise<void>, parents: CloudKitRecord[] = []): Promise<CloudKitRecord> {
    this.validateWrite("create", reminder);
    const scoped = { ...list, zoneID: list.zoneID ?? this.requestZone };
    const membership = creationMembership(reminder, scoped, this.expectedOwner);
    const parentId = (reminder.fields.ParentReminder?.value as { recordName?: unknown } | undefined)?.recordName;
    requireInput(parents.length === (parentId ? 1 : 0) && parents.every(parent => parent.recordType === "Reminder" &&
      parent.recordName === parentId && normalizeReminder(parent, this.expectedOwner).listId === list.recordName &&
      normalizeReminder(parent, this.expectedOwner).completed === false && !normalizeReminder(parent, this.expectedOwner).parentReminderId),
    "Subtask creation requires the exact open same-List root guard.");
    // A pristine native List must be updated before its first intrinsic child is created.
    const result = await this.executeRecords([{ operationType: "update", record: membership }, { operationType: "create", record: reminder }],
      beforeDispatch, parents, ["List"]);
    const confirmedList = result.find(record => record.recordName === list.recordName);
    const confirmed = result.find(record => record.recordName === reminder.recordName);
    try {
      requireValue(confirmedList && "recordType" in confirmedList && confirmed && "recordType" in confirmed, "Apple omitted the exact creation participants.");
      const expected = { ...stableNativePresentation(list.fields), ...membership.fields };
      const actual = stableNativePresentation(confirmedList.fields);
      requireValue(Object.keys(actual).length === Object.keys(expected).length && Object.entries(expected).every(([key, value]) =>
        canonicalJSON(canonicalListFieldValue(key, (value as { value: unknown }).value)) === canonicalJSON(canonicalListFieldValue(key, (actual[key] as { value?: unknown })?.value)) &&
        canonicalJSON({ ...(value as object), value: null }) === canonicalJSON({ ...(actual[key] as object), value: null })), "Apple changed unrelated List fields during creation.");
      requireValue(canonicalJSON(confirmedList.raw.parent ?? null) === canonicalJSON(list.raw.parent ?? null), "Apple changed the List's intrinsic parent during creation.");
      return confirmed;
    } catch { throw new WriteOutcomeUnknownError(reminder.recordName); }
  }

  async modifyRecurringCompletion(plan: RecurringCompletionPlan, beforeDispatch: () => Promise<void>): Promise<CloudKitRecord[]> {
    const rebuilt = await planRecurringCompletion(plan.graph, plan.list, this.expectedOwner, plan.ids, plan.timestamp, plan.mode === "reopen" ? "reopen" : "complete", plan.recurrenceCalendarTimeZone);
    requireInput(canonicalJSON(plan.operations) === canonicalJSON(rebuilt.operations) && canonicalJSON(plan.guards) === canonicalJSON(rebuilt.guards) && canonicalJSON(plan.expected) === canonicalJSON(rebuilt.expected) &&
      plan.mode === rebuilt.mode && plan.intrinsicParentGuards === rebuilt.intrinsicParentGuards && plan.sourceFingerprint === rebuilt.sourceFingerprint, "Recurring completion must match the validated native occurrence recipe.");
    this.validateWrite("update", { ...plan.active, fields: Object.fromEntries(Object.entries(plan.active.fields).filter(([key]) => key !== "AlarmIDs")) });
    if (plan.history) this.validateWrite("create", { ...plan.history, fields: Object.fromEntries(Object.entries(plan.history.fields).filter(([key]) => !["AlarmIDs", "RecurrenceRuleIDs", "AttachmentIDs", "HashtagIDs", "AssignmentIDs"].includes(key))) });
    const result = plan.intrinsicParentGuards ? await this.executeRecords([...plan.operations, ...plan.guards.map(record => ({ operationType: "update" as const,
      record: { recordName: record.recordName, recordType: record.recordType, recordChangeTag: record.recordChangeTag, fields: { Deleted: { type: "INT64", value: 0 } } } }))], beforeDispatch) :
      await this.executeRecords(plan.operations, beforeDispatch, plan.guards, ["List"], plan.mode === "advance" ? [] : [plan.list.recordName]);
    try {
      await verifyRecurringExpected(plan.expected, result, this.expectedOwner, plan.intrinsicParentGuards);
      for (const id of plan.retired) requireValue(result.some(record => record.recordName === id && record.deleted === true && !("recordType" in record)), "Apple did not confirm exact alarm retirement.");
      return result.filter((record): record is CloudKitRecord => "recordType" in record);
    } catch { throw new WriteOutcomeUnknownError(plan.active.recordName); }
  }

  async modifyRecurringDeletion(plan: RecurringDeletionPlan, beforeDispatch: () => Promise<void>): Promise<CloudKitRecord[]> {
    const rebuilt = await planRecurringDeletion(plan.graph, plan.list, this.expectedOwner, plan.scope, plan.ids, plan.timestamp, plan.recurrenceCalendarTimeZone);
    requireInput(plan.scope === rebuilt.scope && plan.recipe === rebuilt.recipe && plan.terminal === rebuilt.terminal && plan.recurrenceCalendarTimeZone === rebuilt.recurrenceCalendarTimeZone && canonicalJSON(plan.operations) === canonicalJSON(rebuilt.operations) && canonicalJSON(plan.expected) === canonicalJSON(rebuilt.expected) &&
      canonicalJSON(plan.retired) === canonicalJSON(rebuilt.retired) && plan.sourceFingerprint === rebuilt.sourceFingerprint && canonicalJSON(plan.active) === canonicalJSON(rebuilt.active),
      "Recurring deletion must match its explicit validated native scope recipe.");
    this.validateWrite("update", { ...plan.active, parent: undefined, fields: Object.fromEntries(Object.entries(plan.active.fields).filter(([key]) => !["List", "AlarmIDs"].includes(key))) });
    const operations = plan.operations.map(operation => operation.record.parent === null ? { ...operation, record: { ...operation.record, parent: { recordName: null } } } : operation);
    const result = await this.executeRecords(operations, beforeDispatch);
    try {
      if (plan.scope === "all_future" || plan.terminal) {
        const receipt = result.find(record => record.recordName === plan.active.recordName)!;
        requireValue("recordType" in receipt && receipt.recordType === "Reminder", "Recurring deletion omitted its active receipt.");
        if (receipt.raw.parent !== undefined && receipt.raw.parent !== null) requireValue(
          intrinsicParentIdentity({ ...plan.graph.reminder, raw: { ...plan.graph.reminder.raw, parent: receipt.raw.parent } }, this.expectedOwner) === intrinsicParentIdentity(plan.graph.reminder, this.expectedOwner),
          "Recurring deletion returned an unexpected intrinsic parent.");
        const found = await this.lookup([receipt.recordName]);
        requireValue(found.complete && found.recordErrors.length === 0 && found.unresolvedRecordNames.length === 0 && found.records.length === 1,
          "The detached recurring deletion could not be exactly reread.");
        const exact = found.records[0];
        requireValue("recordType" in exact && exact.recordType === "Reminder" && exact.recordName === receipt.recordName && exact.recordChangeTag === receipt.recordChangeTag && !exact.deleted &&
          canonicalJSON(stableNativePresentation(exact.fields)) === canonicalJSON(stableNativePresentation(receipt.fields)), "The recurring deletion record drifted after its receipt.");
        const reminder = normalizeReminder(exact, this.expectedOwner, true);
        requireValue(reminder.deleted === true && reminder.listId === null && reminder.parentReminderId === null && (exact.raw.parent === undefined || exact.raw.parent === null),
          "Recurring deletion did not confirm intrinsic-parent detachment.");
        result[result.findIndex(record => record.recordName === exact.recordName)] = exact;
      }
      requireValue(result.filter(record => "recordType" in record).length === plan.expected.length, "Recurring deletion returned an unexpected live outcome.");
      await verifyRecurringExpected(plan.expected, result, this.expectedOwner, true);
      for (const id of plan.retired) requireValue(result.some(record => record.recordName === id && record.deleted === true && !("recordType" in record)), "Apple did not confirm exact occurrence pair retirement.");
      return result.filter((record): record is CloudKitRecord => "recordType" in record);
    } catch { throw new WriteOutcomeUnknownError(plan.active.recordName); }
  }

  async modifyDateAlarmLifecycle(plan: DateAlarmLifecyclePlan, beforeDispatch: () => Promise<void>): Promise<CloudKitRecord[]> {
    const rebuilt = planDateAlarmLifecycle(plan.action, plan.input, plan.graph, plan.list, this.expectedOwner, plan.timestamp, plan.replicas);
    requireInput(canonicalJSON(plan.operations) === canonicalJSON(rebuilt.operations) && canonicalJSON(plan.expected) === canonicalJSON(rebuilt.expected) &&
      canonicalJSON(plan.write) === canonicalJSON(rebuilt.write), "Date-alarm lifecycle must match the complete validated native recipe.");
    this.validateWrite("update", { ...plan.write, parent: undefined, fields: Object.fromEntries(Object.entries(plan.write.fields).filter(([key]) => key !== "List")) });
    const result = await this.executeRecords(plan.operations, beforeDispatch) as CloudKitRecord[];
    try {
      if (plan.action === "delete") {
        const receipt = result.find(record => record.recordName === plan.write.recordName)!;
        if (receipt.raw.parent !== undefined && receipt.raw.parent !== null) requireValue(
          intrinsicParentIdentity({ ...plan.graph.reminder, raw: { ...plan.graph.reminder.raw, parent: receipt.raw.parent } }, this.expectedOwner) === intrinsicParentIdentity(plan.graph.reminder, this.expectedOwner),
          "The date-alarm deletion returned an unexpected intrinsic parent.");
        const found = await this.lookup([receipt.recordName]);
        requireValue(found.complete && found.recordErrors.length === 0 && found.unresolvedRecordNames.length === 0 && found.records.length === 1,
          "The detached date-alarm reminder could not be exactly reread.");
        const exact = found.records[0];
        requireValue("recordType" in exact && exact.recordType === "Reminder" && exact.recordName === receipt.recordName && exact.recordChangeTag === receipt.recordChangeTag && !exact.deleted &&
          canonicalJSON(stableNativePresentation(exact.fields)) === canonicalJSON(stableNativePresentation(receipt.fields)), "The date-alarm deletion record drifted after its receipt.");
        const reminder = normalizeReminder(exact, this.expectedOwner, true);
        requireValue(reminder.deleted === true && reminder.listId === null && reminder.parentReminderId === null && (exact.raw.parent === undefined || exact.raw.parent === null),
          "The date-alarm deletion did not confirm exact intrinsic-parent detachment.");
        result[result.findIndex(record => record.recordName === exact.recordName)] = exact;
      }
      verifyDateAlarmLifecycle(plan, result, this.expectedOwner);
    } catch { throw new WriteOutcomeUnknownError(plan.write.recordName); }
    return result;
  }

  async modifyScheduledFamilyLifecycle(plan: ScheduledFamilyLifecyclePlan, beforeDispatch: () => Promise<void>): Promise<CloudKitRecord[]> {
    const rebuilt = planScheduledFamilyLifecycle(plan.action, plan.input, plan.family, plan.pairs, plan.list, this.expectedOwner, plan.timestamp, plan.replicas);
    requireInput(canonicalJSON(plan.operations) === canonicalJSON(rebuilt.operations) && canonicalJSON(plan.expected) === canonicalJSON(rebuilt.expected) &&
      canonicalJSON(plan.writes) === canonicalJSON(rebuilt.writes), "Scheduled-family lifecycle must match the entire validated native recipe.");
    for (const write of plan.writes) this.validateWrite("update", { ...write, parent: undefined,
      fields: Object.fromEntries(Object.entries(write.fields).filter(([key]) => key !== "List")) });
    const result = await this.executeRecords(plan.operations, beforeDispatch) as CloudKitRecord[];
    try {
      if (plan.action === "delete") {
        const before = plan.family.records.find(record => record.recordName === plan.input.reminderId)!;
        const receipt = result.find(record => record.recordName === before.recordName)!;
        if (receipt.raw.parent !== undefined && receipt.raw.parent !== null) requireValue(
          intrinsicParentIdentity({ ...before, raw: { ...before.raw, parent: receipt.raw.parent } }, this.expectedOwner) === intrinsicParentIdentity(before, this.expectedOwner),
          "The family deletion returned an unexpected intrinsic parent.");
        const found = await this.lookup([receipt.recordName]);
        requireValue(found.complete && found.recordErrors.length === 0 && found.unresolvedRecordNames.length === 0 && found.records.length === 1,
          "The detached scheduled target could not be exactly reread.");
        const exact = found.records[0];
        requireValue("recordType" in exact && exact.recordType === "Reminder" && exact.recordName === receipt.recordName && exact.recordChangeTag === receipt.recordChangeTag && !exact.deleted &&
          canonicalJSON(stableNativePresentation(exact.fields)) === canonicalJSON(stableNativePresentation(receipt.fields)), "The scheduled deletion record drifted after its receipt.");
        const reminder = normalizeReminder(exact, this.expectedOwner, true);
        requireValue(reminder.deleted === true && reminder.listId === null && reminder.parentReminderId === null && (exact.raw.parent === undefined || exact.raw.parent === null),
          "The scheduled deletion did not confirm exact intrinsic-parent detachment.");
        result[result.findIndex(record => record.recordName === exact.recordName)] = exact;
      }
      verifyLifecycleParticipants(plan.expected, result, this.expectedOwner, plan.input.reminderId);
    } catch { throw new WriteOutcomeUnknownError(plan.input.reminderId); }
    return result;
  }

  async modifyLifecycleDeletion(writes: CloudKitWriteRecord[], records: CloudKitRecord[], list: CloudKitRecord,
    listWrite: ListWrite | undefined, beforeDispatch?: () => Promise<void>, versionGuards: CloudKitRecord[] = []): Promise<CloudKitRecord[]> {
    const normalizedList = normalizeList(list);
    requireInput(list.recordType === "List" && normalizedList.deleted === false && normalizedList.isGroup !== true && normalizedList.reminderIds !== null,
      "Native deletion requires the exact live List membership.");
    const detached = writes.filter(write => Object.hasOwn(write.fields, "List"));
    requireInput(detached.length === 1, "Native deletion must detach exactly the selected Reminder.");
    const target = detached[0], beforeTarget = records.find(record => record.recordName === target.recordName);
    requireInput(beforeTarget, "Native deletion requires its exact target snapshot.");
    const before = normalizeReminder(beforeTarget, this.expectedOwner);
    for (const record of records) intrinsicParentIdentity(record, this.expectedOwner);
    requireInput(before.listId === list.recordName && target.parent === null && target.fields.List.type === "REFERENCE" && target.fields.List.value === null &&
      target.fields.Deleted?.type === "INT64" && target.fields.Deleted.value === 1 &&
      Object.keys(target.fields).length === (before.parentReminderId ? 5 : 4) &&
      ["List", "Deleted", "LastModifiedDate", "ResolutionTokenMap", ...(before.parentReminderId ? ["ParentReminder"] : [])].every(key => Object.hasOwn(target.fields, key)) &&
      (!before.parentReminderId || target.fields.ParentReminder.type === "REFERENCE" && target.fields.ParentReminder.value === null),
      "The direct delete must use only the observed detach fields and intrinsic-parent removal.");
    for (const write of writes) {
      const snapshot = records.find(record => record.recordName === write.recordName);
      requireInput(snapshot && write.recordChangeTag === snapshot.recordChangeTag, "Every deletion participant requires its exact snapshot version.");
      const reminder = normalizeReminder(snapshot, this.expectedOwner);
      requireInput(reminder.listId === list.recordName && reminder.deleted === false && !(reminder.alarmIds?.length) && !(reminder.recurrenceRuleIds?.length),
        "Native family deletion supports only live ordinary reminders in the selected List.");
      if (write !== target) {
        requireInput(write.parent === undefined && (before.parentReminderId
          ? write.recordName === before.parentReminderId && Object.keys(write.fields).length === 2 && Object.hasOwn(write.fields, "LastModifiedDate") && Object.hasOwn(write.fields, "ResolutionTokenMap")
          : reminder.parentReminderId === target.recordName && Object.keys(write.fields).length === 1 && write.fields.Deleted?.type === "INT64" && write.fields.Deleted.value === 1),
        "Only the direct child's root timestamp or cascaded child deletion markers may also change.");
      }
      this.validateWrite("update", { ...write, parent: undefined, fields: Object.fromEntries(Object.entries(write.fields).filter(([key]) => key !== "List")) });
    }
    requireInput(before.parentReminderId ? writes.some(write => write.recordName === before.parentReminderId) : true,
      "Direct child deletion must touch its exact root in the same atomic group.");
    const memberField = list.fields.ReminderIDs as { type?: unknown; value?: unknown };
    requireInput(memberField?.type === "STRING" && typeof memberField.value === "string", "The deletion List membership must use its observed JSON string.");
    const membership = normalizedList.reminderIds!;
    const included = membership.includes(target.recordName);
    requireInput(included === !!listWrite, "Deletion must remove existing target membership or guard its established absence.");
    if (listWrite) {
      const raw = JSON.parse(memberField.value as string) as string[];
      requireInput(listWrite.recordName === list.recordName && listWrite.recordType === "List" && listWrite.recordChangeTag === list.recordChangeTag &&
        Object.keys(listWrite.fields).length === 2 && listWrite.fields.ReminderIDs?.type === "STRING" &&
        listWrite.fields.ReminderIDs.value === JSON.stringify(raw.filter((_, index) => membership[index] !== target.recordName)) &&
        listWrite.fields.ResolutionTokenMap?.type === "STRING" && typeof listWrite.fields.ResolutionTokenMap.value === "string",
        "Native deletion may only remove the selected membership with the exact List version and ordering token.");
    } else requireInput(versionGuards.some(guard => guard.recordName === list.recordName && guard.recordChangeTag === list.recordChangeTag),
      "Native deletion must atomically guard the List when membership is already absent.");
    const guardedParents = new Map(versionGuards.filter(record => record.recordType === "Reminder")
      .map(record => [record.recordName, intrinsicParentIdentity(record, this.expectedOwner)]));
    // CloudKit ignores a null parent object; this observed deletion recipe
    // clears the intrinsic edge through an object with a null record name.
    const result = await this.executeRecords([...writes.map(record => ({ operationType: "update" as const,
      record: record === target ? { ...record, parent: { recordName: null } } : record })),
      ...(listWrite ? [{ operationType: "update" as const, record: listWrite }] : [])], beforeDispatch, versionGuards, ["List"],
      versionGuards.filter(record => ["Reminder", "List"].includes(record.recordType)).map(record => record.recordName), true) as CloudKitRecord[];
    try {
      for (const [name, identity] of guardedParents) {
        const after = result.find(record => record.recordName === name);
        requireValue(after && intrinsicParentIdentity(after, this.expectedOwner) === identity, "Apple changed a guarded Reminder's intrinsic parent.");
      }
      const receipt = result.find(record => record.recordName === target.recordName)!;
      if (receipt.raw.parent !== undefined && receipt.raw.parent !== null) {
        requireValue(intrinsicParentIdentity({ ...beforeTarget, raw: { ...beforeTarget.raw, parent: receipt.raw.parent } }, this.expectedOwner) ===
          intrinsicParentIdentity(beforeTarget, this.expectedOwner), "Apple returned an unexpected intrinsic parent in the deletion receipt.");
      }
      const found = await this.lookup([target.recordName]);
      requireValue(found.complete && found.recordErrors.length === 0 && found.unresolvedRecordNames.length === 0 && found.records.length === 1,
        "The detached deletion receipt could not be exactly reread.");
      const exact = found.records[0];
      requireValue("recordType" in exact && exact.recordType === "Reminder" && exact.recordName === receipt.recordName &&
        exact.recordChangeTag === receipt.recordChangeTag && !exact.deleted &&
        canonicalJSON(stableNativePresentation(exact.fields)) === canonicalJSON(stableNativePresentation(receipt.fields)),
        "The detached deletion record drifted after its receipt.");
      const normalized = normalizeReminder(exact, this.expectedOwner, true);
      requireValue(normalized.deleted === true && normalized.listId === null && normalized.parentReminderId === null &&
        (exact.raw.parent === undefined || exact.raw.parent === null), "The exact deletion record did not confirm intrinsic-parent detachment.");
      result[result.findIndex(record => record.recordName === target.recordName)] = exact;
    } catch { throw new WriteOutcomeUnknownError(target.recordName); }
    return result;
  }

  async modifyLinkedDate(root: CloudKitWriteRecord, dependencies: LinkedDateWrite[], beforeDispatch?: () => Promise<void>, versionGuards: CloudKitRecord[] = []) {
    this.validateWrite("update", root);
    requireInput(dependencies.length === 2 && dependencies.filter(record => record.recordType === "Alarm").length === 1 &&
      dependencies.filter(record => record.recordType === "AlarmTrigger").length === 1, "A linked date update requires exactly one alarm and one trigger.");
    for (const record of dependencies) {
      requestedRecordName(record.recordName, [record.recordType]);
      requireInput(record.recordName.length <= 255 && typeof record.recordChangeTag === "string" && record.recordChangeTag.length > 0 &&
        record.recordChangeTag.length <= 512 && Object.keys(record.fields).length === 1, "Linked date updates require exact bounded versions and only the date field.");
      if (record.recordType === "Alarm") {
        const field = record.fields.DueDateResolutionTokenAsNonce;
        requireInput(field?.type === "DOUBLE" && typeof field.value === "number" && Number.isFinite(field.value) &&
          Math.abs(field.value) <= Number.MAX_SAFE_INTEGER, "The date alarm nonce must be a finite bounded double.");
      } else {
        const field = record.fields.DateComponentsData;
        requireInput(field?.type === "BYTES", "The date trigger must use encoded date components.");
        try { decodeDateComponents(field.value); }
        catch { throw new AppError("VALIDATION_ERROR", "The date trigger components are invalid.", 400); }
      }
    }
    requireInput(versionGuards.length <= 1 && versionGuards.every(record => record.recordType === "RecurrenceRule"), "Date updates may only guard one unchanged recurrence rule.");
    return await this.executeRecords([{ operationType: "update", record: root },
      ...dependencies.map(record => ({ operationType: "update" as const, record }))], beforeDispatch, versionGuards) as CloudKitRecord[];
  }

  async modifyScheduling(root: CloudKitWriteRecord, dependencies: SchedulingWrite[], beforeDispatch?: () => Promise<void>, versionGuards: CloudKitRecord[] = []) {
    const links = new Set(["AlarmIDs", "RecurrenceRuleIDs", "DueDateDeltaAlertsData"]);
    this.validateWrite("update", { ...root, fields: Object.fromEntries(Object.entries(root.fields).filter(([key]) => !links.has(key))) });
    if (root.fields.DueDateDeltaAlertsData) {
      requireInput(root.fields.DueDateDeltaAlertsData.type === "ENCRYPTED_BYTES", "Early reminder writes require the observed encrypted-bytes field.");
      if (root.fields.DueDateDeltaAlertsData.value !== null) earlyReminderPayload({ ...root, raw: {} });
    }
    for (const key of ["AlarmIDs", "RecurrenceRuleIDs"]) if (root.fields[key]) {
      const field = root.fields[key];
      requireInput(Array.isArray(field.value) && (field.type === "UNKNOWN_LIST" && field.value.length === 0 ||
        field.type === "STRING_LIST" && field.value.length <= (key === "AlarmIDs" ? 2 : 1) && new Set(field.value).size === field.value.length && field.value.every(id => typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))), "Scheduling links require a bounded observed relationship shape.");
    }
    const allCreates = dependencies.filter(record => record.operationType === "create");
    const ruleCreates = allCreates.filter(record => record.recordType === "RecurrenceRule");
    if (ruleCreates.length) requireInput(ruleCreates.length === 1 && canonicalJSON(root.fields.RecurrenceRuleIDs?.value) === canonicalJSON([ruleCreates[0].recordName.slice(15)]) && !versionGuards.some(record => record.recordType === "RecurrenceRule"), "Creating recurrence requires one new rule and its exact root link.");
    const creates = allCreates.filter(record => record.recordType !== "RecurrenceRule");
    if (creates.length) {
      const alarms = creates.filter(record => record.recordType === "Alarm"), triggers = creates.filter(record => record.recordType === "AlarmTrigger");
      const rootIds = root.fields.AlarmIDs?.value;
      requireInput(alarms.length >= 1 && alarms.length <= 2 && triggers.length === alarms.length && creates.length === alarms.length * 2 &&
        Array.isArray(rootIds) && alarms.every(alarm => rootIds.includes(alarm.recordName.slice(6))) &&
        rootIds.every(id => [...dependencies, ...versionGuards].some(record => record.recordType === "Alarm" && record.recordName.slice(6) === id)), "New alarm pairs require complete root links and version protection for existing alarms.");
      requireInput(new Set(triggers.map(trigger => trigger.fields.Type?.value)).size === triggers.length, "At most one date and one location pair may be created.");
    }
    const locationRetired = dependencies.filter(record => record.locationRetirement);
    if (locationRetired.length) {
      const pair = locationRetired[0].locationRetirement!;
      requireInput(locationRetired.length === 2 && locationRetired.every(record => canonicalJSON(record.locationRetirement) === canonicalJSON(pair)) &&
        locationRetired.some(record => record.recordType === "Alarm" && record.recordName === pair.alarmId) &&
        locationRetired.some(record => record.recordType === "AlarmTrigger" && record.recordName === pair.triggerId) &&
        Array.isArray(root.fields.AlarmIDs?.value) && !root.fields.AlarmIDs.value.includes(pair.alarmId.slice(6)), "Location retirement requires the complete exact-tag pair and root unlink.");
    }
    const retired = dependencies.filter(record => record.fields.Deleted?.value === 1);
    const retiredDate = dependencies.filter(record => record.operationType === "delete");
    if (retiredDate.length) {
      const retained = root.fields.AlarmIDs?.value;
      requireInput(retiredDate.length === 2 && retiredDate[0].recordType === "AlarmTrigger" && retiredDate[1].recordType === "Alarm" &&
        Array.isArray(retained) && !retained.includes(retiredDate[1].recordName.slice(6)), "Retiring a date alarm requires the complete pair and root unlink in the same atomic group.");
      for (const id of retained) {
        const alarm = versionGuards.find(record => record.recordType === "Alarm" && record.recordName.slice(6) === id);
        const triggerUid = (alarm?.fields.TriggerID as { value?: unknown })?.value;
        const trigger = versionGuards.find(record => record.recordType === "AlarmTrigger" && (record.recordName.slice(13) === triggerUid || record.recordName === triggerUid));
        requireInput(alarm && trigger && referenceField(alarm, "Reminder", "Reminder", this.expectedOwner) === root.recordName && referenceField(trigger, "Alarm", "Alarm", this.expectedOwner) === alarm.recordName &&
          (alarm.fields.DueDateResolutionTokenAsNonce as { value?: unknown })?.value === 0 && (trigger.fields.Type as { value?: unknown })?.value === "Location", "Every retained alarm must be an unchanged version-guarded location pair.");
      }
    }
    if (retired.some(record => record.recordType === "RecurrenceRule")) requireInput(canonicalJSON(root.fields.RecurrenceRuleIDs?.value) === "[]", "Retiring recurrence requires its root unlink in the same atomic group.");
    for (const record of dependencies) {
      requestedRecordName(record.recordName, [record.recordType]);
      requireInput(["Alarm", "AlarmTrigger", "RecurrenceRule"].includes(record.recordType) && record.recordName.length <= 255, "Unsupported scheduling identity.");
      const create = record.operationType === "create";
      requireInput(!record.locationRetirement || !create && record.operationType !== "delete" && record.fields.Deleted?.value === 1, "Location retirement metadata only applies to paired soft updates.");
      requireInput(create ? record.recordChangeTag === undefined : typeof record.recordChangeTag === "string" && record.recordChangeTag.length > 0 && record.recordChangeTag.length <= 512, "Scheduling updates require exact version tags; creates must not carry one.");
      const keys = Object.keys(record.fields);
      for (const [key, field] of Object.entries(record.fields)) {
        const encrypted = record.recordType === "AlarmTrigger" && LOCATION_ENCRYPTED_FIELDS.includes(key as typeof LOCATION_ENCRYPTED_FIELDS[number]);
        requireInput((encrypted ? field.isEncrypted === true : field.isEncrypted === undefined) &&
          Object.keys(field).every(name => name === "type" || name === "value" || encrypted && name === "isEncrypted"), "Unsupported scheduling field encryption envelope.");
      }
      if (record.operationType === "delete") {
        requireInput(["Alarm", "AlarmTrigger"].includes(record.recordType) && keys.length === 0, "Only exact-tag alarm/trigger retirement can delete records; deletion cannot carry fields.");
      } else if (!create && record.fields.Deleted) {
        requireInput(record.fields.Deleted.type === "INT64" && record.fields.Deleted.value === 1 &&
          (record.recordType === "RecurrenceRule" && !record.locationRetirement && keys.every(key => key === "Deleted" || key === "Reminder") ||
            record.locationRetirement && (record.recordType === "Alarm" && keys.length === 2 && keys.includes("Reminder") || record.recordType === "AlarmTrigger" && keys.length === 1)) &&
          (!record.fields.Reminder || record.fields.Reminder.type === "REFERENCE" && record.fields.Reminder.value === null), "Unsupported scheduling retirement.");
      } else if (!create && record.recordType === "RecurrenceRule") {
        requireInput(validRecurrenceMutation(record.fields), "Unsupported recurrence mutation.");
      } else if (!create && record.recordType === "Alarm") {
        requireInput(keys.length === 1 && record.fields.DueDateResolutionTokenAsNonce?.type === "DOUBLE" && typeof record.fields.DueDateResolutionTokenAsNonce.value === "number" && Number.isFinite(record.fields.DueDateResolutionTokenAsNonce.value) && Math.abs(record.fields.DueDateResolutionTokenAsNonce.value) <= Number.MAX_SAFE_INTEGER, "Unsupported alarm mutation.");
      } else if (!create && record.recordType === "AlarmTrigger") {
        requireInput(keys.length === 1 && record.fields.DateComponentsData?.type === "BYTES" || validLocationMutation(record.fields), "Unsupported trigger mutation.");
        if (record.fields.DateComponentsData) decodeDateComponents(record.fields.DateComponentsData.value);
      } else if (record.recordType === "RecurrenceRule") {
        requireInput(validRecurrenceCreation(record.fields) && record.fields.Reminder?.type === "REFERENCE" &&
          canonicalJSON(record.fields.Reminder.value) === canonicalJSON({ recordName: root.recordName, action: "VALIDATE" }) &&
          Object.values(record.fields).every(field => field.value !== null), "Unsupported recurrence creation template.");
      } else {
        const location = record.recordType === "AlarmTrigger" && record.fields.Type?.value === "Location";
        const expected = record.recordType === "Alarm" ? ["AlarmUID", "TriggerID", "DueDateResolutionTokenAsNonce", "Reminder", "Imported", "Deleted"] : location ? ["ReferenceFrameString", "Radius", "Type", "Proximity", "Address", "Alarm", "Imported", "Title", "Latitude", "Deleted", "Longitude", "LocationUID"] : ["DateComponentsData", "Type", "Alarm", "Imported", "Deleted"];
        requireInput(keys.length === expected.length && keys.every(key => expected.includes(key)) &&
          record.fields.Imported?.type === "INT64" && record.fields.Imported.value === 0 && record.fields.Deleted?.type === "INT64" && record.fields.Deleted.value === 0, "Unsupported scheduling creation template.");
        if (record.recordType === "Alarm") {
          const trigger = creates.find(item => item.recordType === "AlarmTrigger" && item.recordName.slice(13) === record.fields.TriggerID?.value);
          requireInput(record.fields.AlarmUID.type === "STRING" && record.fields.AlarmUID.value === record.recordName.slice(6) && record.fields.TriggerID.type === "STRING" && record.fields.TriggerID.value === trigger?.recordName.slice(13) &&
            record.fields.Reminder.type === "REFERENCE" && canonicalJSON(record.fields.Reminder.value) === canonicalJSON({ recordName: root.recordName, action: "VALIDATE" }) &&
            record.fields.DueDateResolutionTokenAsNonce.type === "DOUBLE" && typeof record.fields.DueDateResolutionTokenAsNonce.value === "number" && Number.isFinite(record.fields.DueDateResolutionTokenAsNonce.value) && (trigger?.fields.Type?.value !== "Location" || record.fields.DueDateResolutionTokenAsNonce.value === 0), "Unsupported alarm creation.");
        } else {
          const alarm = creates.find(item => item.recordType === "Alarm" && item.fields.TriggerID?.value === record.recordName.slice(13));
          requireInput(alarm && record.fields.Type.type === "STRING" && record.fields.Alarm.type === "REFERENCE" && canonicalJSON(record.fields.Alarm.value) === canonicalJSON({ recordName: alarm.recordName, action: "VALIDATE" }), "Unsupported trigger creation references.");
          if (location) {
            requireInput(record.fields.ReferenceFrameString.type === "STRING" && record.fields.ReferenceFrameString.value === "1" &&
              record.fields.LocationUID.type === "STRING" && typeof record.fields.LocationUID.value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(record.fields.LocationUID.value) &&
              validLocationMutation(Object.fromEntries(Object.entries(record.fields).filter(([key]) => ["Radius", "Proximity", "Address", "Title", "Latitude", "Longitude"].includes(key)))), "Unsupported location trigger creation.");
          } else {
            requireInput(record.fields.Type.value === "Date" && record.fields.DateComponentsData.type === "BYTES", "Unsupported date trigger creation.");
            decodeDateComponents(record.fields.DateComponentsData.value);
          }
        }
      }
    }
    return this.executeRecords([{ operationType: "update", record: root }, ...dependencies.map(schedulingOperation)], beforeDispatch, versionGuards);
  }

  private async executeRecords(operations: { operationType: "create" | "update" | "delete"; record: { recordName: string; recordType: string; recordChangeTag?: string; parent?: { recordName: string | null } | null; fields?: Record<string, unknown> } }[],
    beforeDispatch?: () => Promise<void>, versionGuards: CloudKitRecord[] = [], additionalGuardTypes: string[] = [],
    presentationGuards: string[] = [], deletionGuards = false, guardedListBeforeCreate = false): Promise<CloudKitRecordItem[]> {
    requireInput(operations.length > 0 && operations.length + versionGuards.length <= 32, "An atomic write requires mutations and guards within its record budget.");
    const guards = structuredClone(versionGuards);
    const guardOperations = guards.map(record => {
      requireInput(["Reminder", "Alarm", "AlarmTrigger", "RecurrenceRule", ...additionalGuardTypes].includes(record.recordType) && record.recordName.startsWith(`${record.recordType}/`) &&
        record.recordName.length <= 255 && !record.deleted, "A version guard requires an exact live linked record identity.");
      requireInput(record.zoneID?.zoneName === "Reminders" &&
        [this.expectedOwner, DEFAULT_OWNER].includes(record.zoneID.ownerRecordName ?? this.expectedOwner) &&
        (record.zoneID.zoneType === undefined || record.zoneID.zoneType === REMINDERS_ZONE.zoneType),
      "A version guard requires the authenticated private Reminders zone.");
      requireInput(typeof record.recordChangeTag === "string" && record.recordChangeTag.length > 0 && record.recordChangeTag.length <= 512,
        "A version guard requires its exact bounded Apple change tag.");
      requestedRecordName(record.recordName, ["Reminder", "Alarm", "AlarmTrigger", "RecurrenceRule", ...additionalGuardTypes]);
      const deleted = object(record.fields.Deleted, "A version guard requires an explicitly observed Deleted field.");
      requireInput(deleted.type === "INT64" && deleted.value === 0, "A version guard can only reassert an observed nondeleted linked record.");
      return { operationType: "update" as const, record: { recordName: record.recordName, recordType: record.recordType,
        recordChangeTag: record.recordChangeTag, fields: { Deleted: { type: "INT64", value: 0 } } } };
    });
    const group = structuredClone([...operations, ...guardOperations]);
    let wireOperations = group;
    if (guardedListBeforeCreate) {
      const createParents = new Set(operations.filter(operation => operation.operationType === "create" && operation.record.recordType === "Reminder")
        .map(operation => operation.record.parent?.recordName).filter((recordName): recordName is string => typeof recordName === "string"));
      const parentListGuards = guardOperations.filter(operation => operation.record.recordType === "List" && createParents.has(operation.record.recordName));
      requireInput(parentListGuards.length > 0, "A guarded Reminder creation requires its exact parent List version guard.");
      wireOperations = [...parentListGuards, ...operations, ...guardOperations.filter(operation => !parentListGuards.includes(operation))];
    }
    const payload = structuredClone({ zoneID: this.requestZone, atomic: true, operations: wireOperations });
    requireInput(new Set(group.map(operation => operation.record.recordName)).size === group.length, "An atomic write requires exactly one mutation or guard per record.");
    requireInput(new TextEncoder().encode(JSON.stringify(payload)).length <= MAX_REQUEST_BYTES, "The reminder write exceeded its byte budget.");
    await beforeDispatch?.();
    try {
      const result = await this.post("/records/modify", payload);
      const page = pageRecords(result.records, group.length, 32, this.expectedOwner, true, false, [...RECORD_TYPES, ...additionalGuardTypes]);
      if (page.recordErrors.length) {
        requireValue(page.recordErrors.length === group.length && page.records.length === 0 &&
          new Set(page.recordErrors.map(error => error.recordName)).size === group.length &&
          page.recordErrors.every(error => group.some(operation => operation.record.recordName === error.recordName)), "Apple returned inconsistent atomic write errors.");
        const codes = page.recordErrors.map(error => error.serverErrorCode.toUpperCase());
        const conflict = codes.some(code => ["CONFLICT", "SERVER_RECORD_CHANGED", "ALREADY_EXISTS"].includes(code));
        const rejectedConflictGroup = conflict && codes.every(code => ["CONFLICT", "SERVER_RECORD_CHANGED", "ALREADY_EXISTS", "BATCH_REQUEST_FAILED", "ATOMIC_ERROR"].includes(code));
        requireValue(rejectedConflictGroup || new Set(codes).size === 1, "Apple returned mixed atomic write errors.");
        parseTopLevelError({ serverErrorCode: rejectedConflictGroup ? "CONFLICT" : codes[0], recordName: group[0].record.recordName }, { path: "/records/modify", upstreamStatus: 200, hasSessionCookie: this.http.jar.header(this.endpoint).length > 0 });
      }
      requireValue(page.records.length === group.length, "Apple omitted an atomic write confirmation.");
      return group.map(({ operationType, record }) => {
        const confirmed = page.records.find(item => item.recordName === record.recordName);
        if (operationType === "delete") {
          requireValue(confirmed && confirmed.deleted === true && !("recordType" in confirmed) && Object.keys(confirmed.raw).length === 2 && confirmed.raw.recordName === record.recordName && confirmed.raw.deleted === true, "Apple returned an invalid scheduling deletion confirmation.");
          return confirmed;
        }
        requireValue(confirmed && "recordType" in confirmed && confirmed.recordType === record.recordType && !confirmed.deleted && typeof confirmed.recordChangeTag === "string" && confirmed.recordChangeTag.length > 0, "Apple returned an invalid reminder write confirmation.");
        if (operationType === "update") requireValue(confirmed.recordChangeTag !== record.recordChangeTag, "Apple did not advance the reminder version.");
        const guarded = guards.find(guard => guard.recordName === record.recordName);
        if (guarded) {
          const stableFields = deletionGuards && guarded.recordType === "Reminder" ? stableDeletionFields :
            presentationGuards.includes(guarded.recordName) || guarded.recordType === "Reminder" ? stableNativePresentation : (fields: Record<string, unknown>) => fields;
          requireValue(canonicalJSON(stableFields(confirmed.fields)) === canonicalJSON(stableFields(guarded.fields)), "Apple changed the fields of a version-guarded dependency.");
        }
        return confirmed;
      });
    } catch (error) {
      if (error instanceof AppError && ["REAUTH_REQUIRED", "FORBIDDEN", "RATE_LIMITED", "CONFLICT"].includes(error.code)) throw error;
      if (error instanceof AppError && error.code === "PROTOCOL_CHANGED" && error.message === "Apple rejected the reminder write fields. No automatic retry was attempted.") throw error;
      throw new WriteOutcomeUnknownError(group[0].record.recordName);
    }
  }

  private validateWrite(operationType: "create" | "update", record: CloudKitWriteRecord): void {
    requireInput(operationType === "create" || operationType === "update", "Only reminder creation and editing are supported.");
    requireInput(this.owner !== undefined, "Discover the authenticated Reminders zone before writing.");
    requireInput(record.recordType === "Reminder" && record.recordName.length <= 255, "Only bounded Reminder records can be written.");
    requestedRecordName(record.recordName, ["Reminder"]);
    const allowedFields = new Set(["TitleDocument", "NotesDocument", "Priority", "Flagged", "DueDate", "TimeZone", "AllDay", "Completed", "CompletionDate", "Deleted", "ParentReminder", "LastModifiedDate", "ResolutionTokenMap", ...(operationType === "create" ? ["Completed", "CompletionDate", "CreationDate", "Deleted", "Imported", "List"] : [])]);
    requireInput(Object.keys(record.fields).length > 0 && Object.keys(record.fields).every(key => allowedFields.has(key)), "The reminder write contains unsupported fields.");
    if (operationType === "update") requireInput(typeof record.recordChangeTag === "string" && record.recordChangeTag.length > 0 && record.recordChangeTag.length <= 512 && record.parent === undefined, "Reminder edits require an exact change tag and cannot move lists.");
    else requireInput(record.recordChangeTag === undefined && record.parent?.recordName.startsWith("List/"), "Reminder creation requires its list parent.");
    for (const [key, field] of Object.entries(record.fields)) {
      const expected = ["TitleDocument", "NotesDocument", "TimeZone", "ResolutionTokenMap"].includes(key) ? "STRING" : key === "List" || key === "ParentReminder" ? "REFERENCE" : key.endsWith("Date") ? "TIMESTAMP" : "INT64";
      if (key === "ParentReminder") {
        requireInput(field.type === "REFERENCE" && (field.value === null ? operationType === "update" :
          field.value !== null && typeof field.value === "object" && !Array.isArray(field.value) && "recordName" in field.value &&
          typeof field.value.recordName === "string" && "action" in field.value && field.value.action === "VALIDATE" &&
          Object.keys(field.value).length === 2 && field.value.recordName !== record.recordName), "A parent update requires an exact validated Reminder reference or an explicit detach.");
        if (field.value !== null && typeof field.value === "object" && "recordName" in field.value) requestedRecordName(field.value.recordName, ["Reminder"]);
        continue;
      }
      requireInput(field.type === expected && (expected === "STRING" ? typeof field.value === "string" || (key === "TimeZone" && field.value === null) :
        expected === "REFERENCE" ? field.value !== null && typeof field.value === "object" && "recordName" in field.value && field.value.recordName === record.parent?.recordName :
        Number.isSafeInteger(field.value) || (expected === "TIMESTAMP" && field.value === null)), "The reminder write has an unsupported field shape.");
    }
  }

  async listZones(): Promise<CloudKitZoneDiscovery> {
    const result = await this.post("/zones/list", {});
    requireValue(Array.isArray(result.zones) && result.zones.length <= 1_000, "Apple returned a malformed CloudKit zone list.");
    const zones: CloudKitZone[] = [];
    const matches: CloudKitZone[] = [];
    for (const value of result.zones) {
      const raw = object(value, "Apple returned a malformed CloudKit zone.");
      const id = zoneID(raw.zoneID, false, false) ?? (() => { throw new AppError("PROTOCOL_CHANGED", "Apple returned a malformed CloudKit zone."); })();
      if (raw.deleted !== undefined) requireValue(typeof raw.deleted === "boolean", "Apple returned a malformed zone deleted marker.");
      const zone: CloudKitZone = { zoneID: id, deleted: raw.deleted === true };
      zones.push(zone);
      if (id.zoneName === REMINDERS_ZONE.zoneName) {
        // This is the sole bootstrap authority: the authenticated, fixed
        // private database’s zone catalogue, never a returned record.
        zoneID(raw.zoneID, false, true, this.owner ?? null);
        requireValue(raw.serverErrorCode === undefined, "Apple did not return a successful Reminders zone.");
        matches.push(zone);
      }
    }
    requireValue(matches.length <= 1, "Apple returned multiple private Reminders zones.");
    const remindersZone = matches[0] ?? null;
    if (remindersZone && !remindersZone.deleted && this.owner === undefined) this.owner = remindersZone.zoneID.ownerRecordName ?? DEFAULT_OWNER;
    return { zones, remindersZone, available: remindersZone !== null && !remindersZone.deleted, complete: true };
  }

  async probeSharedLists(listIds: string[]) {
    requireInput(listIds.length >= 1 && listIds.length <= 10, "The shared-list diagnostic supports one to ten identifiers.");
    const requested = listIds.map(id => requestedRecordName(id, ["List"]));
    requireInput(new Set(requested).size === requested.length, "The shared-list diagnostic contains duplicate identifiers.");
    const discovered = await this.post("/zones/list", {}, "shared");
    requireValue(Array.isArray(discovered.zones) && discovered.zones.length <= 100, "Apple exceeded the shared-zone discovery budget.");
    const candidates: CloudKitZoneID[] = [];
    let deletedZones = 0;
    const seen = new Set<string>();
    for (const item of discovered.zones) {
      const raw = object(item, "Apple returned a malformed shared zone.");
      const id = zoneID(raw.zoneID, false, false)!;
      requireValue(raw.serverErrorCode === undefined && (raw.deleted === undefined || typeof raw.deleted === "boolean"), "Apple returned an unsuccessful shared zone.");
      const key = JSON.stringify([id.zoneName, id.ownerRecordName]);
      requireValue(!seen.has(key), "Apple returned duplicate shared zones."); seen.add(key);
      if (raw.deleted === true) { deletedZones++; continue; }
      if (id.zoneName !== "Reminders") continue;
      requireValue(typeof id.ownerRecordName === "string" && id.ownerRecordName !== DEFAULT_OWNER, "Apple did not identify the shared zone owner.");
      zoneID(raw.zoneID, false, true, id.ownerRecordName);
      candidates.push(id);
    }
    requireValue(candidates.length <= 3, "The shared-list diagnostic exceeds its three-zone budget.");
    const summaries = [];
    for (const candidate of candidates) {
      const result = await this.post("/records/lookup", { records: requested.map(recordName => ({ recordName })), zoneID: candidate, desiredKeys: LIST_SUMMARY_KEYS }, "shared");
      const page = pageRecords(result.records, requested.length, 10, candidate.ownerRecordName!, false);
      for (const record of page.records) requireValue(requested.includes(record.recordName) && (!("recordType" in record) || record.recordType === "List"), "Apple returned an unrequested shared list.");
      for (const error of page.recordErrors) requireValue(error.recordName !== null && requested.includes(error.recordName), "Apple returned an unrequested shared-list error.");
      const answered = new Set([...page.records.map(record => record.recordName), ...page.recordErrors.map(error => error.recordName)]);
      requireValue(requested.every(id => answered.has(id)), "Apple omitted a requested shared-list result.");
      summaries.push({ matchedInputIndices: page.records.filter(record => !record.deleted).map(record => requested.indexOf(record.recordName) + 1), deletedRecords: page.records.filter(record => record.deleted).length, recordErrors: page.recordErrors.map(error => ({ inputIndex: requested.indexOf(error.recordName!) + 1, code: error.serverErrorCode })) });
    }
    return { database: "shared", zonesDiscovered: discovered.zones.length, deletedZones, remindersZones: candidates.length, otherZones: discovered.zones.length - candidates.length - deletedZones, lookups: summaries, complete: true, contentsReturned: false };
  }

  async lookup(recordNames: string[], listSummary = false): Promise<CloudKitLookupResult> {
    return this.lookupInternal(recordNames, ["List", "Reminder"], listSummary);
  }

  async lookupSchedulingRecords(recordNames: string[]): Promise<CloudKitLookupResult> {
    requireInput(this.owner !== undefined && recordNames.length <= 32, "Scheduling lookup requires a discovered private zone and a bounded graph.");
    return this.lookupInternal(recordNames, ["Reminder", "Alarm", "AlarmTrigger", "RecurrenceRule"], false);
  }

  async lookupHashtags(recordNames: string[]): Promise<CloudKitLookupResult> {
    requireInput(this.owner !== undefined && recordNames.length <= 32, "Tag lookup requires a discovered private zone and bounded tag identities.");
    return this.lookupInternal(recordNames, ["Hashtag"], false);
  }

  async lookupAttachments(recordNames: string[]): Promise<CloudKitLookupResult> {
    requireInput(this.owner !== undefined && recordNames.length <= 32, "Attachment lookup requires a discovered private zone and bounded attachment identities.");
    return this.lookupInternal(recordNames, ["Attachment"], false);
  }

  async lookupListSections(recordNames: string[]): Promise<CloudKitLookupResult> {
    requireInput(this.owner !== undefined && recordNames.length <= 32, "Category lookup requires an owned zone and bounded section identities.");
    return this.lookupInternal(recordNames, ["ListSection"], false);
  }

  downloadSectionAsset(field: unknown): Promise<Uint8Array> {
    return downloadShoppingAsset(field, this.http.send, this.http.signal);
  }

  async uploadSectionAssets(list: CloudKitRecord, data: Record<ShoppingAssetFieldName, Uint8Array>) {
    requireInput(this.owner !== undefined && list.recordType === "List" && list.fields.ShouldCategorizeGroceryItems !== undefined,
      "Shopping asset uploads require an observed private Shopping List.");
    requestedRecordName(list.recordName, ["List"]);
    const fields: ShoppingAssetFieldName[] = ["MembershipsOfRemindersInSectionsAsData", "GroceryLocalCorrectionsAsData"];
    const result = await this.post("/assets/upload", { zoneID: this.requestZone,
      tokens: fields.map(fieldName => ({ recordName: list.recordName, recordType: "List", fieldName })) });
    requireValue(Array.isArray(result.tokens) && result.tokens.length === fields.length, "Apple omitted a Shopping asset token.");
    const uploaded = {} as Record<ShoppingAssetFieldName, Awaited<ReturnType<typeof uploadShoppingAsset>>>;
    for (const fieldName of fields) {
      const matches = result.tokens.filter(token => token && typeof token === "object" && token.fieldName === fieldName);
      requireValue(matches.length === 1, "Apple returned an ambiguous Shopping asset token.");
      uploaded[fieldName] = await uploadShoppingAsset(matches[0] as ShoppingAssetToken, { recordName: list.recordName, fieldName },
        data[fieldName], this.http.send, this.http.signal);
    }
    return uploaded;
  }

  async modifyShoppingCategory(root: CloudKitWriteRecord, list: ListWrite, category: CloudKitRecord, beforeDispatch: () => Promise<void>) {
    this.validateWrite("update", root);
    requireInput(Object.keys(root.fields).length === 2 && ["LastModifiedDate", "ResolutionTokenMap"].every(key => Object.hasOwn(root.fields, key)),
      "Category moves may only touch the reminder's native timestamp tokens.");
    const keys = ["MembershipsOfRemindersInSectionsAsData", "MembershipsOfRemindersInSectionsChecksum", "GroceryLocalCorrectionsAsData", "GroceryLocalCorrectionsChecksum", "ReminderIDs", "ResolutionTokenMap"];
    requireInput(list.recordType === "List" && typeof list.recordChangeTag === "string" && list.recordChangeTag.length > 0 && list.recordChangeTag.length <= 512 &&
      Object.keys(list.fields).length === keys.length && keys.every(key => Object.hasOwn(list.fields, key)), "Category moves require the exact observed List field set and version.");
    requestedRecordName(list.recordName, ["List"]);
    for (const [key, field] of Object.entries(list.fields)) {
      const encryptedChecksum = key.endsWith("Checksum");
      requireInput(Object.keys(field).length === (encryptedChecksum ? 3 : 2) && Object.hasOwn(field, "type") && Object.hasOwn(field, "value") &&
        (!encryptedChecksum || field.isEncrypted === true), "Category fields require exact native wrappers.");
      if (key.endsWith("AsData")) {
        const asset = object(field.value, "Invalid category asset receipt.");
        requireInput(field.type === "ASSETID" && Object.keys(asset).length === 5 && ["fileChecksum", "wrappingKey", "referenceChecksum", "receipt"].every(name => typeof asset[name] === "string" && (asset[name] as string).length > 0 && (asset[name] as string).length <= 8192) &&
          typeof asset.size === "number" && Number.isSafeInteger(asset.size) && asset.size >= 0 && asset.size <= 16_384, "Category assets require bounded upload receipts.");
      } else {
        requireInput(field.type === "STRING" && typeof field.value === "string" && (!key.endsWith("Checksum") || /^[a-f0-9]{128}$/.test(field.value)), "Invalid category checksum or native List field.");
      }
    }
    requireInput(category.recordType === "ListSection" && referenceField(category, "List", "List", this.expectedOwner) === list.recordName,
      "A category move requires its owned destination section version guard.");
    return await this.executeRecords([{ operationType: "update", record: root }, { operationType: "update", record: list }], beforeDispatch,
      [category], ["ListSection"]) as CloudKitRecord[];
  }

  /** The non-indexable ListSection type is available through Apple's type-filtered change feed. */
  async queryListSectionsPage(options: { continuation?: string | null; limit?: number } = {}) {
    requireInput(this.owner !== undefined, "Category discovery requires a discovered owned zone.");
    const limit = boundedLimit(options.limit);
    const cursor = requestedToken(options.continuation, "The category continuation is invalid.");
    const result = await this.post("/changes/zone", {
      zones: [{ zoneID: this.requestZone, ...(cursor ? { syncToken: cursor } : {}) }],
      reverse: true, desiredRecordTypes: ["ListSection"],
      desiredKeys: ["List", "DisplayName", "CanonicalName", "Deleted"], resultsLimit: limit,
    });
    requireValue(Array.isArray(result.zones) && result.zones.length === 1, "Apple returned an unexpected category catalogue zone.");
    const zone = object(result.zones[0], "Apple returned a malformed category catalogue zone.");
    zoneID(zone.zoneID, false, true, this.expectedOwner);
    parseTopLevelError(zone, { path: "/changes/zone", upstreamStatus: 200, hasSessionCookie: true });
    const parsed = pageRecords(zone.records, limit, MAX_PAGE_SIZE, this.expectedOwner, true, true, ["ListSection"]);
    requireValue(parsed.recordErrors.length === 0 && typeof zone.moreComing === "boolean", "Apple returned incomplete category metadata.");
    const continuation = optionalString(zone.syncToken, "Apple returned an invalid category continuation.");
    requireValue(!zone.moreComing || continuation !== null && continuation !== cursor, "Apple did not advance category pagination.");
    return { records: parsed.records, complete: !zone.moreComing, continuation: zone.moreComing ? continuation : null };
  }


  private async lookupInternal(recordNames: string[], allowedTypes: string[], listSummary: boolean): Promise<CloudKitLookupResult> {
    requireInput(Array.isArray(recordNames) && recordNames.length >= 1 && recordNames.length <= MAX_PAGE_SIZE, "The CloudKit lookup size is outside the supported limit.");
    const requestedRecordNames = recordNames.map((name) => requestedRecordName(name, allowedTypes));
    requireInput(!listSummary || requestedRecordNames.every(name => name.startsWith("List/")), "Only list lookups can use the list-summary projection.");
    requireInput(new Set(requestedRecordNames).size === requestedRecordNames.length, "The CloudKit lookup contains duplicate record names.");
    const result = await this.post("/records/lookup", {
      records: requestedRecordNames.map((name) => ({ recordName: name })),
      zoneID: this.requestZone,
      ...(listSummary ? { desiredKeys: LIST_SUMMARY_KEYS } : {}),
    });
    const parsed = pageRecords(result.records, requestedRecordNames.length, MAX_PAGE_SIZE, this.expectedOwner, true, false, allowedTypes);
    const requested = new Set(requestedRecordNames);
    for (const record of parsed.records) requireValue(requested.has(record.recordName), "Apple returned a record that was not requested.");
    for (const error of parsed.recordErrors) requireValue(error.recordName === null || requested.has(error.recordName), "Apple returned an error for a record that was not requested.");
    const answered = new Set([...parsed.records.map((record) => record.recordName), ...parsed.recordErrors.flatMap((error) => error.recordName ? [error.recordName] : [])]);
    const unresolvedRecordNames = requestedRecordNames.filter((name) => !answered.has(name));
    return {
      requestedRecordNames,
      records: parsed.records,
      recordErrors: parsed.recordErrors,
      unresolvedRecordNames,
      complete: parsed.recordErrors.length === 0 && unresolvedRecordNames.length === 0,
    };
  }

  async queryPage(options: { recordType: "List" | "Reminder"; limit?: number; continuation?: string | null }): Promise<CloudKitPage> {
    requireInput(options.recordType === "List" || options.recordType === "Reminder", "The requested Reminders query record type is invalid.");
    const limit = boundedLimit(options.limit);
    const continuation = requestedToken(options.continuation, "The CloudKit continuation marker is invalid.");
    const payload: Record<string, unknown> = { query: { recordType: options.recordType }, zoneID: this.requestZone, resultsLimit: limit };
    if (continuation) payload.continuationMarker = continuation;
    const page = this.queryResponse(await this.post("/records/query", payload), limit, continuation);
    for (const record of page.records) {
      const type = "recordType" in record ? record.recordType : record.recordName.slice(0, record.recordName.indexOf("/"));
      requireValue(type === options.recordType, "Apple returned an unrequested record type in the Reminders query page.");
    }
    return page;
  }

  async queryListsPage(options: { limit?: number; continuation?: string | null } = {}): Promise<CloudKitPage> {
    return this.queryListsPageInternal(options, false);
  }

  private async queryListsPageInternal(options: { limit?: number; continuation?: string | null }, allowRepeatedContinuation: boolean): Promise<CloudKitPage> {
    const limit = boundedLimit(options.limit);
    const continuation = requestedToken(options.continuation, "The CloudKit continuation marker is invalid.");
    if (this.owner === undefined) {
      const discovery = await this.listZones();
      requireValue(discovery.available, "Apple did not return the private Reminders zone.");
    }
    const payload: Record<string, unknown> = {
      query: { recordType: "Lists" },
      zoneID: this.requestZone,
      resultsLimit: limit,
    };
    if (continuation) payload.continuationMarker = continuation;
    const result = await this.post("/records/query", payload);
    // This experimental endpoint uses the observed plural query type while
    // CloudKit still returns singular List records. Membership is deliberately
    // not projected; callers of queryAllLists receive only normalized summaries.
    const page = this.queryResponse(result, limit, continuation, MAX_PAGE_SIZE, allowRepeatedContinuation, true);
    requireValue(result.moreComing === undefined || result.moreComing === null || typeof result.moreComing === "boolean", "Apple returned a malformed list query pagination flag.");
    requireValue(result.moreComing !== true || page.continuation !== null, "Apple reported more list results without a continuation marker.");
    for (const record of page.records) {
      const type = "recordType" in record ? record.recordType : record.recordName.slice(0, record.recordName.indexOf("/"));
      requireValue(type === "List", "Apple returned an unrequested record type in the Reminders list query page.");
    }
    for (const error of page.recordErrors) if (error.recordName !== null) recordName(error.recordName, ["List"]);
    return page;
  }

  async queryAllLists(): Promise<CloudKitAllListsResult> {
    const startedAt = performance.now();
    const summaries = new Map<string, { list: RemindersList; summary: RemindersListSummary }>();
    const seenContinuations = new Set<string>();
    let aggregateBytes = 0;
    let pagesRead = 0;
    let continuation: string | null = null;
    let sawRecordErrors = false;
    let stoppedReason: CloudKitAllListsResult["pendingReason"] = null;

    if (this.owner === undefined) {
      const discovery = await this.listZones();
      requireValue(discovery.available, "Apple did not return the private Reminders zone.");
    }

    for (;;) {
      if (performance.now() - startedAt >= MAX_ALL_LIST_DURATION_MS) {
        stoppedReason = "time_limit";
        break;
      }
      const page = await this.queryListsPageInternal({ limit: MAX_PAGE_SIZE, continuation }, true);
      pagesRead++;
      if (page.recordErrors.length > 0) {
        const hasSessionCookie = this.http.jar.header(this.endpoint).length > 0;
        const topLevelErrorCodes = new Set([
          "AUTHENTICATION_REQUIRED", "NOT_AUTHENTICATED", "INVALID_AUTH_TOKEN", "AUTHENTICATION_FAILED",
          "ACCESS_DENIED", "PERMISSION_FAILURE", "THROTTLED", "REQUEST_RATE_LIMITED", "ZONE_BUSY",
        ]);
        for (const error of page.recordErrors) {
          if (topLevelErrorCodes.has(error.serverErrorCode.toUpperCase())) parseTopLevelError({ serverErrorCode: error.serverErrorCode }, { path: "/records/query", upstreamStatus: 200, hasSessionCookie });
        }
        sawRecordErrors = true;
      }

      for (const record of page.records) {
        const normalized = summarizeListRecord(record);
        const previous = summaries.get(normalized.summary.id);
        if (previous) {
          requireValue(JSON.stringify(previous.summary) === JSON.stringify(normalized.summary), "Apple returned conflicting duplicate Reminders list records.");
          continue;
        }
        if (summaries.size >= MAX_ALL_LIST_IDS) {
          stoppedReason = "list_limit";
          break;
        }
        const bytes = new TextEncoder().encode(JSON.stringify(normalized.summary)).length;
        if (aggregateBytes + bytes > MAX_ALL_LIST_SUMMARY_BYTES) {
          stoppedReason = "summary_byte_limit";
          break;
        }
        summaries.set(normalized.summary.id, normalized);
        aggregateBytes += bytes;
      }
      if (stoppedReason) break;
      if (performance.now() - startedAt >= MAX_ALL_LIST_DURATION_MS) {
        stoppedReason = "time_limit";
        break;
      }
      if (page.continuation === null) break;
      if (seenContinuations.has(page.continuation)) {
        stoppedReason = "continuation_cycle";
        break;
      }
      seenContinuations.add(page.continuation);
      if (pagesRead >= MAX_ALL_LIST_PAGES) {
        stoppedReason = "page_limit";
        break;
      }
      continuation = page.continuation;
    }

    const complete = stoppedReason === null && !sawRecordErrors;
    return {
      lists: [...summaries.values()].map(entry => entry.list),
      complete,
      pagesRead,
      pendingReason: stoppedReason ?? (sawRecordErrors ? "record_errors" : null),
    };
  }

  async queryRemindersPage(options: { listId: string; includeCompleted: boolean; limit?: number; continuation?: string | null; projection?: "search" }): Promise<CloudKitPage> {
    requireInput(typeof options.includeCompleted === "boolean", "The completed-reminder query option must be explicit.");
    const listId = requestedRecordName(options.listId, ["List"]);
    const limit = boundedLimit(options.limit);
    const continuation = requestedToken(options.continuation, "The CloudKit continuation marker is invalid.");
    const payload: Record<string, unknown> = {
      query: {
        recordType: "reminderList",
        filterBy: [
          { comparator: "EQUALS", fieldName: "List", fieldValue: { type: "REFERENCE", value: { recordName: listId, action: "VALIDATE" } } },
          { comparator: "EQUALS", fieldName: "includeCompleted", fieldValue: { type: "INT64", value: options.includeCompleted ? 1 : 0 } },
          { comparator: "EQUALS", fieldName: "LookupValidatingReference", fieldValue: { type: "INT64", value: 1 } },
        ],
      },
      zoneID: this.requestZone,
      resultsLimit: limit,
    };
    if (options.projection === "search") payload.desiredKeys = SEARCH_REMINDER_KEYS;
    if (continuation) payload.continuationMarker = continuation;
    // Upstream does not define whether resultsLimit includes auxiliary records.
    // Bound the flattened response independently; follow Apple's continuation.
    const page = this.queryResponse(await this.post("/records/query", payload), MAX_COMPOUND_RECORDS, continuation, MAX_COMPOUND_RECORDS, false, true);
    const unique = new Map<string, CloudKitRecordItem>();
    for (const record of page.records) {
      const previous = unique.get(record.recordName);
      if (previous) {
        requireValue(canonicalJSON(previous.raw) === canonicalJSON(record.raw), "Apple returned conflicting duplicate records in a compound reminder page.");
        continue;
      }
      unique.set(record.recordName, record);
      if ("recordType" in record && record.recordType === "Reminder") {
        requireValue(normalizeReminder(record, this.expectedOwner).listId === listId, "Apple returned a reminder linked to a different list.");
      }
    }
    return { ...page, records: [...unique.values()] };
  }

  private queryResponse(result: Record<string, unknown>, limit: number, requestedContinuation: string | null, absoluteLimit = MAX_PAGE_SIZE, allowRepeatedContinuation = false, allowDuplicates = false): CloudKitPage {
    const parsed = pageRecords(result.records, limit, absoluteLimit, this.expectedOwner, true, allowDuplicates);
    const next = optionalString(result.continuationMarker, "Apple returned a malformed query continuation marker.");
    if (next !== null) {
      validateToken(next, "Apple returned a malformed query continuation marker.");
      requireValue(allowRepeatedContinuation || next !== requestedContinuation, "Apple repeated a query continuation marker.");
    }
    const paginationComplete = next === null;
    const pendingReason = next !== null ? "continuation" : parsed.recordErrors.length ? "record_errors" : null;
    return { ...parsed, paginationComplete, complete: paginationComplete && parsed.recordErrors.length === 0, continuation: next, pendingReason };
  }
}

function canonicalListFieldValue(key: string, value: unknown): string {
  if (["Color", "BadgeEmblem", "ResolutionTokenMap"].includes(key) && typeof value === "string") {
    try { return canonicalJSON(JSON.parse(value) as unknown); }
    catch { /* Keep malformed values exact; callers will reject them separately. */ }
  }
  return canonicalJSON(value);
}
