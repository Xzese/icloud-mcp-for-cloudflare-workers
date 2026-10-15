import { AppError, WriteOutcomeUnknownError } from "../errors.ts";
import { b64, utf8 } from "../crypto/bytes.ts";
import { fingerprint } from "../lib/canonical.ts";
import { stableNativePresentation } from "../lib/native-presentation.ts";
import { normalizeList, normalizeReminder, referenceField, intrinsicParentIdentity, isKnownEmptyDeletionCollection, type CloudKitRecord, type CloudKitRecordItem } from "../icloud/cloudkit.ts";
import type { RecurringIntent } from "../persistence/apple-sessions.ts";
import type { SchedulingGraph } from "./linked-records.ts";
import { dateComponents, dateComponentsForSource, decodeDateComponents, dueDateNonce, inspectRootAbsoluteDatePair, linkedDatePlan } from "./linked-date.ts";
import { MAX_RECURRENCE_INTERVAL, readCompletionRecurrence } from "./recurrence.ts";
import { RecurrenceCalendarTimeZone, recurrenceEndCalendarLabel } from "./recurrence-calendar.ts";
import { decodeDocument } from "./crdt.ts";
import { updateResolutionTokenMap, type CloudKitWriteRecord } from "./writes.ts";
import type { ListWrite } from "./list-writes.ts";
import { withinCloudKitRequestBudget } from "../icloud/budgets.ts";
import { earlyReminderPayload } from "./early-reminder.ts";

type Fields = CloudKitWriteRecord["fields"];
export type RecurringOperation = { operationType: "create" | "update" | "delete"; record: {
  recordName: string; recordType: string; recordChangeTag?: string; fields: Fields; parent?: { recordName: string } | null } };
export interface RecurringCompletionPlan {
  graph: SchedulingGraph; list: CloudKitRecord; ids: RecurringIntent["ids"]; timestamp: number;
  mode: "advance" | "final" | "reopen";
  recurrenceCalendarTimeZone?: string;
  intrinsicParentGuards?: true;
  active: CloudKitWriteRecord; history?: CloudKitWriteRecord; membership?: ListWrite;
  operations: RecurringOperation[]; guards: CloudKitRecord[];
  sourceFingerprint: string; expected: RecurringIntent["expected"]; retired: string[];
}
export function recurringIdentities() {
  const id = () => crypto.randomUUID().toUpperCase();
  return { history: id(), activeAlarm: id(), activeTrigger: id(), historyAlarm: id(), historyTrigger: id(), replicas: Array.from({ length: 24 }, id) };
}
function value(record: CloudKitRecord, name: string) { return (record.fields[name] as { value?: unknown } | undefined)?.value; }
function resolution(record: CloudKitRecord, keys: string[], timestamp: number, replicas: string[]) {
  const updated = JSON.parse(updateResolutionTokenMap(record, keys, timestamp));
  const original = typeof value(record, "ResolutionTokenMap") === "string" ? JSON.parse(String(value(record, "ResolutionTokenMap"))).map : {};
  keys.forEach((key, index) => { if (!original[key]) updated.map[key].replicaID = replicas[index]; });
  return JSON.stringify(updated);
}

export function nextRecurringDue(due: string, zone: string | null, allDay: boolean, kind: "weekly" | "last-day-monthly" | "monthly-29" | "monthly" | "daily", interval = 1) {
  if (!Number.isSafeInteger(interval) || interval < 1 || interval > MAX_RECURRENCE_INTERVAL)
    throw new AppError("UNSUPPORTED_FEATURE", "The recurrence interval must be an integer from 1 to 999.");
  const utc = (year: number, month: number, day: number, hour = 0, minute = 0, second = 0) => {
    const result = new Date(0); result.setUTCFullYear(year, month, day); result.setUTCHours(hour, minute, second, 0); return result;
  };
  if (kind === "last-day-monthly" || kind === "daily" && allDay) {
    const old = new Date(due);
    if (!Number.isSafeInteger(old.getTime()) || old.getUTCFullYear() < 1 || old.getUTCFullYear() > 9999 || !allDay || zone !== null || old.getUTCHours() || old.getUTCMinutes() || old.getUTCSeconds() || old.getUTCMilliseconds() ||
      kind === "last-day-monthly" && old.getUTCDate() !== utc(old.getUTCFullYear(), old.getUTCMonth() + 1, 0).getUTCDate()) throw new AppError("UNSUPPORTED_FEATURE", "This completion requires an all-day calendar anchor without a time zone.");
    const next = kind === "daily" ? utc(old.getUTCFullYear(), old.getUTCMonth(), old.getUTCDate() + interval) : utc(old.getUTCFullYear(), old.getUTCMonth() + interval + 1, 0);
    if (next.getUTCFullYear() < 1 || next.getUTCFullYear() > 9999) throw new AppError("UNSUPPORTED_FEATURE", "The next occurrence is outside the calendar range.");
    return next.toISOString();
  }
  if (allDay || !zone || (kind === "daily" || kind === "monthly-29" || kind === "monthly") && !RecurrenceCalendarTimeZone.safeParse(zone).success)
    throw new AppError("UNSUPPORTED_FEATURE", "Timed completion requires a stored IANA-zone occurrence.");
  const old = dateComponents(due, zone);
  let local = utc(old.year, old.month - 1, old.day + (kind === "daily" ? interval : 7 * interval), old.hour, old.minute, old.second);
  if (kind === "monthly") {
    if (old.day > utc(old.year, old.month + interval, 0).getUTCDate())
      throw new AppError("UNSUPPORTED_FEATURE", "A monthly day absent from the target month requires a separate native calendar recipe.");
    local = utc(old.year, old.month - 1 + interval, old.day, old.hour, old.minute, old.second);
  }
  if (kind === "monthly-29") {
    // Native final selection from [28,29]: February falls back to 28,
    // and a moved earlier occurrence advances within the same month.
    const candidate = (month: number) => utc(old.year, month, Math.min(29, utc(old.year, month + 1, 0).getUTCDate()), old.hour, old.minute, old.second);
    local = candidate(old.month - 1);
    if (local.getTime() <= utc(old.year, old.month - 1, old.day, old.hour, old.minute, old.second).getTime()) local = candidate(old.month - 1 + interval);
  }
  if (local.getUTCFullYear() < 1 || local.getUTCFullYear() > 9999) throw new AppError("UNSUPPORTED_FEATURE", "The next occurrence is outside the calendar range.");
  const formatter = new Intl.DateTimeFormat("en-US-u-ca-gregory-nu-latn", { timeZone: zone, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric", hourCycle: "h23" });
  const wall = (instant: number) => {
    const parts = formatter.formatToParts(new Date(instant)), get = (key: string) => Number(parts.find(part => part.type === key)?.value);
    return utc(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")).getTime();
  };
  const offsets = new Set<number>();
  for (let hours = -48; hours <= 48; hours += 6) { const sample = local.getTime() + hours * 3_600_000; offsets.add(wall(sample) - sample); }
  const candidates = [...offsets].map(offset => local.getTime() - offset).filter(instant => wall(instant) === local.getTime());
  if (candidates.length !== 1) throw new AppError("UNSUPPORTED_FEATURE", "The next recurrence lands in a missing or repeated local time.");
  const next = new Date(candidates[0]).toISOString(); dateComponents(next, zone); return next;
}
function requireWeeklyEndCadence(due: string, end: number, zone: string, interval: number) {
  if (!RecurrenceCalendarTimeZone.safeParse(zone).success) throw new AppError("UNSUPPORTED_FEATURE", "An ended weekly rule requires a stored named IANA time zone.");
  let from: ReturnType<typeof dateComponents>, to: ReturnType<typeof dateComponents>;
  try { from = dateComponents(due, zone); to = dateComponents(new Date(end).toISOString(), zone); }
  catch { throw new AppError("UNSUPPORTED_FEATURE", "The weekly occurrence and end require unique whole-second IANA-zone calendar instants."); }
  const label = (value: typeof from) => { const result = new Date(0); result.setUTCFullYear(value.year, value.month - 1, value.day); result.setUTCHours(0, 0, 0, 0); return result.getTime(); };
  if (end < Date.parse(due) || from.hour !== to.hour || from.minute !== to.minute || from.second !== to.second || (label(to) - label(from)) % (7 * interval * 86_400_000) !== 0)
    throw new AppError("UNSUPPORTED_FEATURE", "The weekly end must be an exact occurrence on the same IANA-zone weekly calendar cadence and local clock.");
}

/** Projection allows native presentation regeneration and strictly typed empty collections only. */
export function recurringFields(record: CloudKitRecord, owner: string, strictPresentation = false) {
  const fields = Object.fromEntries(Object.entries(stableNativePresentation(record.fields)).filter(([key, field]) =>
    (strictPresentation || !["UrgentPresentationAlarmsAsData", "UrgentPresentationAlarmsChecksum"].includes(key)) && !isKnownEmptyDeletionCollection(key, field)));
  for (const key of ["TitleDocument", "NotesDocument"]) {
    const wrapper = fields[key] as { type?: unknown; value?: unknown } | undefined;
    if (wrapper) {
      if (!["STRING", "ENCRYPTED_BYTES"].includes(String(wrapper.type)) || typeof wrapper.value !== "string") throw new WriteOutcomeUnknownError(record.recordName);
      decodeDocument(wrapper.value); fields[key] = { ...(strictPresentation ? wrapper : {}), type: "STRING", value: wrapper.value };
    }
  }
  const tokens = fields.ResolutionTokenMap as { type?: unknown; value?: unknown } | undefined;
  if (tokens) {
    if (tokens.type !== "STRING" || typeof tokens.value !== "string") throw new WriteOutcomeUnknownError(record.recordName);
    fields.ResolutionTokenMap = { ...(strictPresentation ? tokens : {}), type: "STRING", value: JSON.parse(tokens.value) };
  }
  if (strictPresentation) for (const key of ["List", "ParentReminder", "AlarmIDs", "RecurrenceRuleIDs"]) {
    const wrapper = record.fields[key];
    if (wrapper && (typeof wrapper !== "object" || Array.isArray(wrapper) || Object.keys(wrapper).some(key => !["type", "value"].includes(key))))
      throw new AppError("UNSUPPORTED_FEATURE", "The retained root has unknown relationship-wrapper metadata.");
  }
  for (const key of ["CompletionDate", "ParentReminder", ...(strictPresentation && normalizeReminder(record, owner, true).deleted === true ? ["List"] : [])]) {
    const wrapper = fields[key] as { type?: unknown; value?: unknown } | undefined;
    if (wrapper?.value === null && wrapper.type === (key === "CompletionDate" ? "TIMESTAMP" : "REFERENCE") &&
      (!strictPresentation || Object.keys(wrapper).every(key => ["type", "value"].includes(key)))) delete fields[key];
  }
  for (const [key, type] of [["List", "List"], ["ParentReminder", "Reminder"]]) if (fields[key]) {
    const wrapper = fields[key] as { type: string; value: Record<string, unknown> };
    if (Object.keys(wrapper.value).some(key => !["recordName", "action", "zoneID"].includes(key))) throw new WriteOutcomeUnknownError(record.recordName);
    fields[key] = { type: "REFERENCE", value: { recordName: referenceField(record, key, type, owner), action: "VALIDATE" } };
  }
  const normalized = strictPresentation ? normalizeReminder(record, owner, true) : normalizeReminder(record, owner);
  for (const [key, ids] of [["AlarmIDs", normalized.alarmIds], ["RecurrenceRuleIDs", normalized.recurrenceRuleIds]] as const) {
    if (ids?.length) fields[key] = { type: "STRING_LIST", value: [...ids].sort() };
  }
  return fields;
}
function retainedIntrinsicIdentity(record: CloudKitRecord, owner: string) {
  if (record.recordType === "Reminder") return intrinsicParentIdentity(record, owner);
  if (record.recordType === "List") return record.raw.parent ?? null;
  const parent = record.raw.parent;
  if (parent === undefined || parent === null) return null;
  if (typeof parent !== "object" || Array.isArray(parent) || Object.keys(parent).some(key => !["recordName", "action", "zoneID"].includes(key)))
    throw new AppError("UNSUPPORTED_FEATURE", "The retained recurring participant has unknown intrinsic-parent metadata.");
  const { zoneID, ...metadata } = parent as Record<string, unknown>;
  if (zoneID !== undefined && (!zoneID || typeof zoneID !== "object" || Array.isArray(zoneID) || Object.keys(zoneID).some(key => !["zoneName", "zoneType", "ownerRecordName"].includes(key))))
    throw new AppError("UNSUPPORTED_FEATURE", "The retained recurring participant has unknown intrinsic-parent zone metadata.");
  const key = record.recordType === "AlarmTrigger" ? "Alarm" : "Reminder";
  const name = referenceField({ ...record, fields: { Parent: { type: "REFERENCE", value: parent } } }, "Parent", key, owner);
  if (name !== referenceField(record, key, key, owner)) throw new AppError("UNSUPPORTED_FEATURE", "The retained recurring intrinsic parent disagrees with its backlink.");
  return { ...metadata, recordName: name };
}
export async function recurringRecordHash(record: CloudKitRecord, owner: string, intrinsicParentGuards = false) {
  const fields = record.recordType === "Reminder" ? recurringFields(record, owner, intrinsicParentGuards) : { ...stableNativePresentation(record.fields) };
  // Fresh pair references may expand to this same authenticated zone in Apple's
  // receipt. The unchanged rule retains its exact source representation/hash.
  const relatedReference = record.recordType === "Alarm" || intrinsicParentGuards && record.recordType === "RecurrenceRule" ? ["Reminder", "Reminder"] : record.recordType === "AlarmTrigger" ? ["Alarm", "Alarm"] : null;
  if (relatedReference) {
    const [key, type] = relatedReference, wrapper = fields[key] as { type?: unknown; value?: unknown } | undefined;
    const value = wrapper?.value;
    if (!wrapper || wrapper.type !== "REFERENCE" || Object.keys(wrapper).some(key => !["type", "value"].includes(key)) ||
      !value || typeof value !== "object" || Array.isArray(value) || (value as { action?: unknown }).action !== "VALIDATE" ||
      Object.keys(value).some(key => !["recordName", "action", "zoneID"].includes(key))) throw new WriteOutcomeUnknownError(record.recordName);
    const zone = (value as { zoneID?: unknown }).zoneID;
    if (zone !== undefined && (!zone || typeof zone !== "object" || Array.isArray(zone) ||
      Object.keys(zone).some(key => !["zoneName", "zoneType", "ownerRecordName"].includes(key)))) throw new WriteOutcomeUnknownError(record.recordName);
    fields[key] = { type: "REFERENCE", value: { recordName: referenceField(record, key, type, owner), action: "VALIDATE" } };
  }
  return fingerprint({ id: record.recordName, type: record.recordType,
    ...(intrinsicParentGuards ? { parent: retainedIntrinsicIdentity(record, owner) } : record.recordType === "Reminder" ? { parent: intrinsicParentIdentity(record, owner) } : {}),
    fields });
}
export async function verifyRecurringExpected(expected: RecurringIntent["expected"], records: CloudKitRecordItem[], owner: string, intrinsicParentGuards = false) {
  for (const entry of expected) {
    const record = records.find(record => record.recordName === entry.id);
    try {
      if (!record || !("recordType" in record) || record.recordType !== entry.type || !record.recordChangeTag || record.deleted ||
        await recurringRecordHash(record, owner, intrinsicParentGuards) !== entry.hash ||
        entry.presentationHash !== undefined && await recurringPresentationHash(record) !== entry.presentationHash) throw new WriteOutcomeUnknownError(entry.id);
    } catch { throw new WriteOutcomeUnknownError(entry.id); }
  }
}

function recurringPresentationHash(record: CloudKitRecord) {
  // Include complete wrappers and metadata, and distinguish absence from any
  // replacement. Only proven signed download URLs may drift on read-back.
  return fingerprint(stableNativePresentation(Object.fromEntries(Object.entries(record.fields)
    .filter(([key]) => ["UrgentPresentationAlarmsAsData", "UrgentPresentationAlarmsChecksum"].includes(key)))));
}

export async function planRecurringCompletion(graph: SchedulingGraph, list: CloudKitRecord, owner: string,
  retainedIds: RecurringIntent["ids"] | undefined, timestamp: number, action: "complete" | "reopen" = "complete", recurrenceCalendarTimeZone?: string): Promise<RecurringCompletionPlan> {
  if (recurrenceCalendarTimeZone !== undefined) recurrenceCalendarTimeZone = RecurrenceCalendarTimeZone.parse(recurrenceCalendarTimeZone);
  // Exact private-zone List lookups may omit the record-level zone. Bind only
  // that omission to the authenticated lookup; never replace an explicit zone.
  if (list.zoneID === undefined) list = { ...list, zoneID: { zoneName: "Reminders", zoneType: "REGULAR_CUSTOM_ZONE", ownerRecordName: owner } };
  const source = graph.reminder, reminder = normalizeReminder(source, owner);
  const rules = graph.records.filter(record => record.recordType === "RecurrenceRule");
  if (Object.keys(source.fields).some(key => /parent|child|subtask/i.test(key) && key !== "ParentReminder"))
    throw new AppError("UNSUPPORTED_FEATURE", "Recurring completion found unreviewed native parent/child metadata.");
  if (Object.entries(source.fields).some(([key, raw]) => {
    const wrapper = raw as { type?: unknown; value?: unknown } | null;
    return wrapper?.value != null && (wrapper.type === "REFERENCE" && !["List", "ParentReminder"].includes(key) ||
      ["STRING_LIST", "UNKNOWN_LIST"].includes(String(wrapper.type)) && Array.isArray(wrapper.value) && wrapper.value.length > 0 &&
        !["AlarmIDs", "RecurrenceRuleIDs", "AttachmentIDs", "HashtagIDs", "AssignmentIDs"].includes(key));
  })) throw new AppError("UNSUPPORTED_FEATURE", "Recurring completion found unreviewed native relationship fields.");
  if (value(source, "AssignmentIDs") != null && !isKnownEmptyDeletionCollection("AssignmentIDs", source.fields.AssignmentIDs))
    throw new AppError("UNSUPPORTED_FEATURE", "Recurring completion found native assignment metadata.");
  if (!graph.complete || rules.length !== 1 || reminder.recurrenceRuleIds?.length !== 1 || rules[0].recordName !== reminder.recurrenceRuleIds[0] ||
    reminder.completed !== (action === "reopen") || reminder.deleted !== false || reminder.parentReminderId !== null || reminder.startDate !== null || !reminder.dueDate ||
    (reminder.attachmentIds?.length ?? 0) || (reminder.hashtagIds?.length ?? 0) ||
    referenceField(rules[0], "Reminder", "Reminder", owner) !== source.recordName || normalizeList(list, false).deleted !== false || normalizeList(list, false).isGroup !== false ||
    !list.recordChangeTag || list.recordChangeTag.length > 512 || list.raw.share != null || list.recordName !== reminder.listId) {
    throw new AppError("UNSUPPORTED_FEATURE", "Recurring completion requires one exact ordinary root and its owned recurrence without subtasks, assignments, tags or attachments.");
  }
  const { kind, interval, endDate } = readCompletionRecurrence(rules[0]), alarmed = (reminder.alarmIds?.length ?? 0) !== 0;
  const timedDaily = kind === "daily" && reminder.allDay !== true;
  const timedMonthly = kind === "monthly-29" || kind === "monthly";
  const early = value(source, "DueDateDeltaAlertsData") == null ? undefined : earlyReminderPayload(source);
  if (kind === "monthly-29" && !early) throw new AppError("UNSUPPORTED_FEATURE", "This monthly completion requires the observed one-day early alert.");
  if (early && (!timedMonthly || early.dueDateDeltaAlerts[0].dueDateDeltaUnit !== 2 || early.dueDateDeltaAlerts[0].dueDateDeltaCount !== -1))
    throw new AppError("UNSUPPORTED_FEATURE", "Recurring completion requires the observed monthly one-day early alert.");
  let monthlyPair: CloudKitRecord[] = [];
  if (timedDaily || timedMonthly) {
    if (endDate !== null || reminder.allDay !== false || !RecurrenceCalendarTimeZone.safeParse(reminder.timeZone).success || !alarmed)
      throw new AppError("UNSUPPORTED_FEATURE", "Timed daily or observed monthly completion requires a non-ended root with a stored IANA zone and one absolute date pair.");
    const pair = inspectRootAbsoluteDatePair(graph, owner, timedMonthly ? { acknowledgedCompletionAt: timestamp } : {});
    if (timedMonthly) monthlyPair = pair;
  }
  if (alarmed && (kind !== "weekly" && !timedDaily && !timedMonthly || reminder.alarmIds?.length !== 1) || graph.records.length !== (alarmed ? 4 : 2)) throw new AppError("UNSUPPORTED_FEATURE", "This recurring alarm graph needs another completion recipe.");
  const due = Date.parse(reminder.dueDate);
  if (recurrenceCalendarTimeZone !== undefined && (kind !== "daily" || endDate === null || reminder.allDay !== true || reminder.timeZone !== null || alarmed))
    throw new AppError("UNSUPPORTED_FEATURE", "recurrenceCalendarTimeZone applies only to an ended all-day daily root without alarms.");
  const weeklyEnd = kind === "weekly" && endDate !== null;
  if (weeklyEnd) {
    if (reminder.allDay !== false || !reminder.timeZone) throw new AppError("UNSUPPORTED_FEATURE", "Ended weekly completion requires a timed IANA-zone root.");
    requireWeeklyEndCadence(reminder.dueDate, endDate, reminder.timeZone, interval);
  }
  const retainedPair = weeklyEnd && alarmed ? inspectRootAbsoluteDatePair(graph, owner) : [];
  const endLabel = endDate === null ? null : weeklyEnd ? endDate : recurrenceEndCalendarLabel(endDate, recurrenceCalendarTimeZone);
  if (endLabel !== null && !weeklyEnd && (kind !== "daily" || reminder.allDay !== true || reminder.timeZone !== null || due % 86_400_000 !== 0 || due > endLabel || alarmed))
    throw new AppError("UNSUPPORTED_FEATURE", "An ended daily occurrence requires its exact all-day UTC due-date label and inclusive end calendar label without alarms.");
  if (endLabel !== null && !weeklyEnd && (endLabel - due) % (interval * 86_400_000) !== 0)
    throw new AppError("UNSUPPORTED_FEATURE", "The daily end must be on the same calendar cadence as its repeat interval.");
  if (action === "reopen" && (endLabel === null || due !== endLabel || reminder.completedDate === null))
    throw new AppError("UNSUPPORTED_FEATURE", "Recurring reopening requires the completed exact final occurrence of the supported ended rule.");
  const mode = action === "reopen" ? "reopen" : endLabel !== null && due === endLabel ? "final" : "advance";
  const calendar = recurrenceCalendarTimeZone === undefined ? {} : { recurrenceCalendarTimeZone };
  const ids = retainedIds ?? (mode === "advance" ? recurringIdentities() : { replicas: Array.from({ length: 24 }, () => crypto.randomUUID().toUpperCase()) });
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new AppError("UNSUPPORTED_FEATURE", "The recurring occurrence timestamp is invalid.");
  if (mode !== "advance") {
    if (Object.keys(ids).some(key => key !== "replicas")) throw new AppError("CONFLICT", "An in-place occurrence cannot reuse advancing record identities.", 409);
    if (weeklyEnd) for (const key of ["Completed", "CompletionDate", "LastModifiedDate", "ResolutionTokenMap"]) {
      const wrapper = source.fields[key];
      if (wrapper && (typeof wrapper !== "object" || Array.isArray(wrapper) || Object.keys(wrapper).some(key => !["type", "value"].includes(key))))
        throw new AppError("UNSUPPORTED_FEATURE", "The terminal occurrence has unknown metadata on a changed field wrapper.");
    }
    const active: CloudKitWriteRecord = { recordName: source.recordName, recordType: "Reminder", recordChangeTag: source.recordChangeTag, fields: {
      Completed: { type: "INT64", value: mode === "final" ? 1 : 0 }, CompletionDate: { type: "TIMESTAMP", value: mode === "final" ? timestamp : null },
      LastModifiedDate: { type: "TIMESTAMP", value: timestamp },
      ResolutionTokenMap: { type: "STRING", value: resolution(source, ["completed", "completionDate", "lastModifiedDate"], timestamp, ids.replicas.slice(16)) },
    } };
    if (weeklyEnd) for (const record of [source, ...retainedPair, rules[0], list]) {
      if (!record.recordName.startsWith(`${record.recordType}/`) || record.recordName.length > 255 || !record.recordChangeTag || record.recordChangeTag.length > 512 || record.deleted || record.raw.share != null ||
        record.zoneID?.zoneName !== "Reminders" || ![owner, "__defaultOwner__"].includes(record.zoneID.ownerRecordName ?? owner) ||
        record.zoneID.zoneType !== undefined && record.zoneID.zoneType !== "REGULAR_CUSTOM_ZONE" ||
        (record.fields.Deleted as { type?: unknown; value?: unknown } | undefined)?.type !== "INT64" || value(record, "Deleted") !== 0)
        throw new AppError("CONFLICT", "Every retained terminal participant requires its exact owned live version.", 409);
      retainedIntrinsicIdentity(record, owner);
    }
    return finishRecurringPlan({ graph, list, ids, timestamp, mode, ...calendar, ...(weeklyEnd ? { intrinsicParentGuards: true as const } : {}),
      active, operations: [{ operationType: "update", record: active }], guards: [...retainedPair, rules[0], list], retired: [] }, owner);
  }
  if (!ids.history || !ids.activeAlarm || !ids.activeTrigger || !ids.historyAlarm || !ids.historyTrigger)
    throw new AppError("CONFLICT", "An advancing occurrence requires its retained record identities.", 409);
  const next = nextRecurringDue(reminder.dueDate, reminder.timeZone, reminder.allDay === true, kind, interval);
  if (Date.parse(next) <= timestamp) throw new AppError("UNSUPPORTED_FEATURE", "Skipping overdue recurring occurrences requires a separate recipe.");
  const active: CloudKitWriteRecord = { recordName: source.recordName, recordType: "Reminder", recordChangeTag: source.recordChangeTag, fields: {
    Completed: { type: "INT64", value: 0 }, CompletionDate: { type: "TIMESTAMP", value: null }, DueDate: { type: "TIMESTAMP", value: Date.parse(next) },
    LastModifiedDate: { type: "TIMESTAMP", value: timestamp },
    ResolutionTokenMap: { type: "STRING", value: resolution(source, ["completed", "completionDate", "dueDate", "lastModifiedDate"], timestamp, ids.replicas.slice(16)) },
  } };
  const copied: Fields = {};
  for (const key of ["AllDay", "CreationDate", "Flagged", "Priority", "DueDate", "TimeZone", "TitleDocument", "NotesDocument"]) {
    const wrapper = source.fields[key] as { type?: unknown; value?: unknown } | undefined;
    if (!wrapper) continue;
    if (key.endsWith("Document")) {
      if (!["STRING", "ENCRYPTED_BYTES"].includes(String(wrapper.type)) || typeof wrapper.value !== "string") throw new AppError("UNSUPPORTED_FEATURE", "History requires source-proven encoded document bytes.");
      decodeDocument(wrapper.value); copied[key] = { type: "STRING", value: wrapper.value };
    } else copied[key] = { type: String(wrapper.type), value: wrapper.value };
  }
  if (!copied.TitleDocument || copied.CreationDate?.type !== "TIMESTAMP" || !Number.isSafeInteger(copied.CreationDate.value)) throw new AppError("UNSUPPORTED_FEATURE", "History requires the exact title and original creation timestamp.");
  if (timedMonthly) copied.CreationDate = { type: "TIMESTAMP", value: timestamp };
  if (early) {
    // Native completion preserves the active alert, creation and acknowledgement,
    // but gives the history alert a fresh identity under its fresh reminder.
    // Slot 22 is disjoint from the history (0..13), active (16..19) and
    // membership (20) resolution-token replicas and is retained in the intent.
    copied.DueDateDeltaAlertsData = { type: "ENCRYPTED_BYTES", value: b64(utf8(JSON.stringify({
      ...early, reminderIdentifier: ids.history,
      dueDateDeltaAlerts: [{ ...early.dueDateDeltaAlerts[0], identifier: ids.replicas[22] }],
    }))) };
  }
  const keys = ["allDay", "completed", "completionDate", "creationDate", "flagged", "lastModifiedDate", "list", "minimumSupportedVersion", "priority", "titleDocument", "dueDate",
    ...(copied.NotesDocument ? ["notesDocument"] : []), ...(copied.TimeZone ? ["timeZone"] : []),
    ...(early ? ["dueDateDeltaAlertsData"] : [])];
  const tokenMap = JSON.stringify({ map: Object.fromEntries(keys.map((key, index) => [key, { counter: 1, modificationTime: timestamp / 1000 - 978_307_200, replicaID: ids.replicas[index] }])) });
  const history: CloudKitWriteRecord = { recordName: `Reminder/${ids.history}`, recordType: "Reminder", parent: { recordName: list.recordName }, fields: {
    ...copied, Completed: { type: "INT64", value: 1 }, CompletionDate: { type: "TIMESTAMP", value: timestamp }, Deleted: { type: "INT64", value: 0 },
    Imported: { type: "INT64", value: 0 }, LastModifiedDate: { type: "TIMESTAMP", value: timestamp }, ResolutionTokenMap: { type: "STRING", value: tokenMap },
    List: { type: "REFERENCE", value: { recordName: list.recordName, action: "VALIDATE" } },
    ...Object.fromEntries(["AlarmIDs", "HashtagIDs", "AttachmentIDs", "AssignmentIDs", "RecurrenceRuleIDs"].map(key => [key, { type: "UNKNOWN_LIST", value: [] }])),
  } };
  const members = normalizeList(list).reminderIds;
  if (!members || new Set(members).size !== members.length || members.includes(history.recordName)) throw new AppError("CONFLICT", "Recurring completion requires an exact, unambiguous List membership.", 409);
  const raw = JSON.parse(String(value(list, "ReminderIDs"))) as string[], index = members.indexOf(source.recordName);
  const order = [...raw];
  if (index === -1) order.push(ids.history, source.recordName.slice(9)); else order.splice(index, 0, raw[index].includes("/") ? history.recordName : ids.history);
  const membership: ListWrite = { recordName: list.recordName, recordType: "List", recordChangeTag: list.recordChangeTag, fields: {
    ReminderIDs: { type: "STRING", value: JSON.stringify(order) }, ResolutionTokenMap: { type: "STRING", value: resolution(list, ["reminderIDsMergeableOrdering"], timestamp, ids.replicas.slice(20)) },
  } };
  const operations: RecurringOperation[] = [{ operationType: "update", record: active }, { operationType: "create", record: history }, { operationType: "update", record: membership }];
  const retired: string[] = [];
  if (alarmed) {
    const old = timedMonthly ? monthlyPair.map(record => ({
      recordName: record.recordName, recordType: record.recordType, recordChangeTag: record.recordChangeTag!, fields: {},
    })) : linkedDatePlan(graph, active, owner).dependencies;
    const oldComponents = decodeDateComponents(value(graph.records.find(record => record.recordType === "AlarmTrigger")!, "DateComponentsData"));
    for (const record of [...old].reverse()) { retired.push(record.recordName); operations.push({ operationType: "delete", record: { ...record, fields: {} } }); }
    const pair = (root: CloudKitWriteRecord, due: string, alarm: string, trigger: string) => {
      root.fields.AlarmIDs = { type: "STRING_LIST", value: [alarm] };
      operations.push({ operationType: "create", record: { recordName: `Alarm/${alarm}`, recordType: "Alarm", fields: {
        AlarmUID: { type: "STRING", value: alarm }, TriggerID: { type: "STRING", value: trigger }, DueDateResolutionTokenAsNonce: { type: "DOUBLE", value: dueDateNonce(root.fields.ResolutionTokenMap.value) },
        Reminder: { type: "REFERENCE", value: { recordName: root.recordName, action: "VALIDATE" } }, Imported: { type: "INT64", value: 0 }, Deleted: { type: "INT64", value: 0 },
      } } }, { operationType: "create", record: { recordName: `AlarmTrigger/${trigger}`, recordType: "AlarmTrigger", fields: {
        DateComponentsData: { type: "BYTES", value: b64(utf8(JSON.stringify(dateComponentsForSource(due, reminder.timeZone!, oldComponents)))) }, Type: { type: "STRING", value: "Date" },
        Alarm: { type: "REFERENCE", value: { recordName: `Alarm/${alarm}`, action: "VALIDATE" } }, Imported: { type: "INT64", value: 0 }, Deleted: { type: "INT64", value: 0 },
      } } });
    };
    pair(active, next, ids.activeAlarm, ids.activeTrigger); pair(history, reminder.dueDate, ids.historyAlarm, ids.historyTrigger);
  }
  return finishRecurringPlan({ graph, list, ids, timestamp, mode, ...calendar, active, history, membership, operations, guards: [rules[0]], retired }, owner, timedDaily || timedMonthly);
}

async function finishRecurringPlan(plan: Omit<RecurringCompletionPlan, "sourceFingerprint" | "expected">, owner: string, preserveSourcePresentation = false): Promise<RecurringCompletionPlan> {
  const { graph, list, operations, guards } = plan;
  const expected: RecurringIntent["expected"] = [];
  for (const operation of operations.filter(operation => operation.operationType !== "delete")) {
    const before = graph.records.find(record => record.recordName === operation.record.recordName) ?? (operation.record.recordName === list.recordName ? list : undefined);
    const record: CloudKitRecord = { ...operation.record,
      raw: { ...before?.raw, ...(operation.record.parent === undefined ? {} : { parent: operation.record.parent }) },
      fields: { ...before?.fields, ...operation.record.fields } };
    expected.push({ id: record.recordName, type: record.recordType as RecurringIntent["expected"][number]["type"], hash: await recurringRecordHash(record, owner, plan.intrinsicParentGuards),
      ...(preserveSourcePresentation && before?.recordType === "Reminder" && operation.operationType === "update" ? { presentationHash: await recurringPresentationHash(before) } : {}) });
  }
  for (const guard of guards) expected.push({ id: guard.recordName, type: guard.recordType as RecurringIntent["expected"][number]["type"], hash: await recurringRecordHash(guard, owner, plan.intrinsicParentGuards) });
  const guardedOperations = guards.map(guard => ({ operationType: "update", record: { recordName: guard.recordName, recordType: guard.recordType,
    recordChangeTag: guard.recordChangeTag, fields: { Deleted: { type: "INT64", value: 0 } } } }));
  if (operations.length + guardedOperations.length > 32 || !withinCloudKitRequestBudget({ zoneID: { zoneName: "Reminders", zoneType: "REGULAR_CUSTOM_ZONE", ownerRecordName: owner },
    atomic: true, operations: [...operations, ...guardedOperations] })) throw new AppError("UNSUPPORTED_FEATURE", "The entire recurring occurrence exceeds its atomic request budget.");
  const sourceFingerprint = await fingerprint([list, ...graph.records].map(record => ({ id: record.recordName, type: record.recordType, version: record.recordChangeTag,
    ...(plan.intrinsicParentGuards ? { parent: retainedIntrinsicIdentity(record, owner) } : record.recordType === "Reminder" ? { parent: intrinsicParentIdentity(record, owner) } : {}),
    fields: stableNativePresentation(record.fields) } )).sort((a, b) => a.id.localeCompare(b.id)));
  return { ...plan, sourceFingerprint, expected };
}
