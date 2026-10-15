import { z } from "zod";
import { AppError } from "../errors.ts";
import { b64, utf8 } from "../crypto/bytes.ts";
import { fingerprint, jsonBytes } from "../lib/canonical.ts";
import { normalizeList, normalizeReminder, referenceField, isKnownEmptyDeletionCollection, type CloudKitRecord } from "../icloud/cloudkit.ts";
import type { RecurringIntent } from "../persistence/apple-sessions.ts";
import type { SchedulingGraph } from "./linked-records.ts";
import { RecurrenceCalendarTimeZone, recurrenceEndCalendarLabel } from "./recurrence-calendar.ts";
import { readCompletionRecurrence } from "./recurrence.ts";
import { dateComponentsForSource, decodeDateComponents, dueDateNonce } from "./linked-date.ts";
import { validateAbsoluteDatePair, validateDateAlarmParticipant } from "./date-alarm-lifecycle.ts";
import { nextRecurringDue, recurringRecordHash, type RecurringOperation } from "./recurring-lifecycle.ts";
import { updateResolutionTokenMap, type CloudKitWriteRecord } from "./writes.ts";

export const RecurringDeletionScope = z.enum(["occurrence", "all_future"]).describe("Required only for supported recurring deletion. occurrence skips the active occurrence, advancing its same ID without history, or retires an occurrence on its supported inclusive end calendar day; timed weekly replaces its exact pair, while all-day daily and the observed last-day monthly rule have no pair or new record IDs. all_future detaches the active root and soft-deletes its current rule and any supported date pair, preserving earlier history. Refused for ordinary reminders. Retain identical scope and original ID/tag arguments for read-only uncertain-outcome reconciliation.");
export interface RecurringDeletionPlan {
  graph: SchedulingGraph; list: CloudKitRecord; scope: z.infer<typeof RecurringDeletionScope>; timestamp: number;
  recipe?: "all_day_daily" | "all_day_daily_ended" | "timed_weekly_ended" | "all_day_last_day_monthly";
  terminal?: true; recurrenceCalendarTimeZone?: string;
  ids: RecurringIntent["ids"]; active: CloudKitWriteRecord; operations: RecurringOperation[];
  sourceFingerprint: string; expected: RecurringIntent["expected"]; retired: string[];
}
const value = (record: CloudKitRecord, key: string) => (record.fields[key] as { value?: unknown } | undefined)?.value;
function resolution(record: CloudKitRecord, keys: string[], timestamp: number, replicas: string[]) {
  const updated = JSON.parse(updateResolutionTokenMap(record, keys, timestamp));
  const original = typeof value(record, "ResolutionTokenMap") === "string" ? JSON.parse(String(value(record, "ResolutionTokenMap"))).map : {};
  keys.forEach((key, index) => { if (!original[key]) updated.map[key].replicaID = replicas[index]; });
  return JSON.stringify(updated);
}
function knownChangedWrappers(record: CloudKitRecord, keys: string[]) {
  for (const key of keys) {
    const wrapper = record.fields[key];
    if (wrapper && (typeof wrapper !== "object" || Array.isArray(wrapper) || Object.keys(wrapper).some(key => !["type", "value"].includes(key))))
      throw new AppError("UNSUPPORTED_FEATURE", "Recurring deletion cannot discard unknown changed-field metadata.");
  }
}

/** Distinct native recurring deletion recipes; completion/history semantics are never reused. */
export async function planRecurringDeletion(graph: SchedulingGraph, sourceList: CloudKitRecord, owner: string, scopeInput: z.infer<typeof RecurringDeletionScope>,
  retainedIds: RecurringIntent["ids"] | undefined, timestamp: number, recurrenceCalendarTimeZone?: string): Promise<RecurringDeletionPlan> {
  const scope = RecurringDeletionScope.parse(scopeInput), source = graph.reminder, reminder = normalizeReminder(source, owner);
  const list = sourceList.zoneID === undefined ? { ...sourceList, zoneID: { zoneName: "Reminders", zoneType: "REGULAR_CUSTOM_ZONE", ownerRecordName: owner } } : sourceList;
  const rule = graph.records.find(record => record.recordType === "RecurrenceRule");
  if (!graph.complete || graph.schedulingParent || ![2, 4].includes(graph.records.length) || new Set(graph.records.map(record => record.recordName)).size !== graph.records.length ||
    !graph.records.some(record => record.recordName === source.recordName && record.recordType === "Reminder") ||
    reminder.completed !== false || reminder.completedDate !== null || reminder.deleted !== false || reminder.parentReminderId !== null || reminder.startDate !== null ||
    reminder.recurrenceRuleIds?.length !== 1 || !rule || rule.recordName !== reminder.recurrenceRuleIds[0] || !reminder.dueDate ||
    (reminder.attachmentIds?.length ?? 0) || (reminder.hashtagIds?.length ?? 0) ||
    Object.hasOwn(source.fields, "AssignmentIDs") && !isKnownEmptyDeletionCollection("AssignmentIDs", source.fields.AssignmentIDs) ||
    Object.hasOwn(source.fields, "DueDateDeltaAlertsData") && (value(source, "DueDateDeltaAlertsData") !== null || (source.fields.DueDateDeltaAlertsData as { type?: unknown }).type !== "BYTES") ||
    Object.keys(source.fields).some(key => /parent|child|subtask/i.test(key) && key !== "ParentReminder") ||
    Object.entries(source.fields).some(([key, raw]) => { const wrapper = raw as { type?: unknown; value?: unknown } | undefined;
      return wrapper?.value != null && (wrapper.type === "REFERENCE" && !["List", "ParentReminder"].includes(key) ||
        ["STRING_LIST", "UNKNOWN_LIST"].includes(String(wrapper.type)) && Array.isArray(wrapper.value) && wrapper.value.length > 0 && !["AlarmIDs", "RecurrenceRuleIDs"].includes(key)); }) ||
    list.recordType !== "List" || list.recordName !== reminder.listId || normalizeList(list, false).deleted !== false || normalizeList(list, false).isGroup !== false ||
    referenceField(rule, "Reminder", "Reminder", owner) !== source.recordName || !Number.isSafeInteger(timestamp) || timestamp < 0)
    throw new AppError("UNSUPPORTED_FEATURE", "Recurring deletion requires one exact childless open root with its owned supported rule and complete schedule.");
  const recurrence = readCompletionRecurrence(rule);
  // Deletion has separate observed recipes; completion interval support must
  // never make a multi-interval deletion advance by only one unit.
  if (recurrence.interval !== 1) throw new AppError("UNSUPPORTED_FEATURE", "Recurring deletion currently requires interval one.");
  const unpairedAllDay = reminder.allDay === true && reminder.timeZone === null && !(reminder.alarmIds?.length) && graph.records.length === 2 &&
    Date.parse(reminder.dueDate) % 86_400_000 === 0 && new Date(reminder.dueDate).getUTCFullYear() >= 1 && new Date(reminder.dueDate).getUTCFullYear() <= 9999;
  const daily = recurrence.kind === "daily" && unpairedAllDay;
  const due = new Date(reminder.dueDate), monthEnd = new Date(due); monthEnd.setUTCDate(1); monthEnd.setUTCMonth(monthEnd.getUTCMonth() + 1); monthEnd.setUTCDate(0);
  const monthly = recurrence.kind === "last-day-monthly" && recurrence.endDate === null && unpairedAllDay && due.getUTCDate() === monthEnd.getUTCDate();
  const weekly = recurrence.kind === "weekly" && reminder.allDay === false && !!reminder.timeZone && /^[A-Za-z][A-Za-z0-9._+-]*(?:\/[A-Za-z0-9._+-]+)*$/.test(reminder.timeZone) && reminder.alarmIds?.length === 1 && graph.records.length === 4;
  if (!daily && !weekly && !monthly) throw new AppError("UNSUPPORTED_FEATURE", "Recurring deletion with this end condition or schedule needs separate native evidence.");
  if (recurrenceCalendarTimeZone !== undefined) {
    RecurrenceCalendarTimeZone.parse(recurrenceCalendarTimeZone);
    if (!daily || recurrence.endDate === null) throw new AppError("UNSUPPORTED_FEATURE", "recurrenceCalendarTimeZone requires the supported ended all-day daily deletion recipe.");
  }
  const ended = recurrence.endDate !== null;
  const endLabel = ended ? recurrenceEndCalendarLabel(recurrence.endDate!, weekly ? reminder.timeZone! : recurrenceCalendarTimeZone) : undefined;
  const dueLabel = weekly && ended ? recurrenceEndCalendarLabel(Date.parse(reminder.dueDate), reminder.timeZone!) : Date.parse(reminder.dueDate);
  if (endLabel !== undefined && dueLabel > endLabel) throw new AppError("UNSUPPORTED_FEATURE", "The active occurrence is beyond its inclusive end calendar date.");
  const terminal = ended && (scope === "all_future" || dueLabel === endLabel);
  const retiring = scope === "all_future" || terminal;
  const recipe = monthly ? "all_day_last_day_monthly" as const : daily ? ended ? "all_day_daily_ended" as const : "all_day_daily" as const : ended ? "timed_weekly_ended" as const : undefined;
  const next = retiring ? undefined : nextRecurringDue(reminder.dueDate, reminder.timeZone, daily || monthly, monthly ? "last-day-monthly" : daily ? "daily" : "weekly");
  const pair = weekly ? validateAbsoluteDatePair(source, graph.records.filter(record => ["Alarm", "AlarmTrigger"].includes(record.recordType)), owner) : [];
  const snapshots = [source, ...pair, rule, list];
  for (const record of snapshots) {
    if (!record.recordName.startsWith(`${record.recordType}/`) || record.recordName.length > 255 || !record.recordChangeTag || record.recordChangeTag.length > 512 ||
      record.deleted || record.raw.share != null || record.zoneID?.zoneName !== "Reminders" || ![owner, "__defaultOwner__"].includes(record.zoneID.ownerRecordName ?? owner) ||
      record.zoneID.zoneType !== undefined && record.zoneID.zoneType !== "REGULAR_CUSTOM_ZONE" ||
      (record.fields.Deleted as { type?: unknown; value?: unknown } | undefined)?.type !== "INT64" || value(record, "Deleted") !== 0)
      throw new AppError("CONFLICT", "Every recurring deletion participant requires its exact owned live version.", 409);
    knownChangedWrappers(record, ["Deleted"]);
    if (record !== rule) validateDateAlarmParticipant(record, owner);
    await recurringRecordHash(record, owner, true);
  }
  if (jsonBytes(snapshots.map(record => ({ id: record.recordName, fields: record.fields, parent: record.raw.parent }))) > 262_144)
    throw new AppError("UNSUPPORTED_FEATURE", "The recurring deletion graph exceeds its bounded inspection budget.");
  if (next !== undefined && weekly && ended && Date.parse(next) > recurrence.endDate!)
    throw new AppError("VALIDATION_ERROR", "The next weekly occurrence exceeds the raw EndDate before its final calendar day. Request explicit recurringDeletionScope=all_future to retire this series, or separately review and edit its end date.", 400);
  if (next !== undefined && daily && endLabel !== undefined && Date.parse(next) > endLabel) throw new AppError("UNSUPPORTED_FEATURE", "The next daily occurrence exceeds its inclusive end calendar date.");
  if (next !== undefined && Date.parse(next) <= timestamp) throw new AppError("UNSUPPORTED_FEATURE", "Skipping overdue recurring deletion occurrences requires another recipe.");
  const id = () => crypto.randomUUID().toUpperCase();
  const savedIds = z.object({ activeAlarm: z.string().uuid().optional(), activeTrigger: z.string().uuid().optional(), replicas: z.array(z.string().uuid()).length(24) }).strict()
    .safeParse(retainedIds ?? { ...(!retiring && weekly ? { activeAlarm: id(), activeTrigger: id() } : {}), replicas: Array.from({ length: 24 }, id) });
  if (!savedIds.success) throw new AppError("CONFLICT", "The retained deletion identities are invalid.", 409);
  const ids = savedIds.data;
  if (ids.replicas.length !== 24 || Object.keys(ids).some(key => !["replicas", ...(!retiring && weekly ? ["activeAlarm", "activeTrigger"] : [])].includes(key)) ||
    !retiring && weekly && (!ids.activeAlarm || !ids.activeTrigger || ids.activeAlarm === ids.activeTrigger || snapshots.some(record =>
      record.recordName === `Alarm/${ids.activeAlarm}` || record.recordName === `AlarmTrigger/${ids.activeTrigger}`)))
    throw new AppError("CONFLICT", "The retained deletion identities do not match this explicit scope.", 409);
  const active: CloudKitWriteRecord = { recordName: source.recordName, recordType: "Reminder", recordChangeTag: source.recordChangeTag, fields: {
    LastModifiedDate: { type: "TIMESTAMP", value: timestamp },
  } };
  const operations: RecurringOperation[] = [{ operationType: "update", record: active }], retired: string[] = [];
  if (!retiring) {

    Object.assign(active.fields, { DueDate: { type: "TIMESTAMP", value: Date.parse(next!) }, ...(weekly ? { AlarmIDs: { type: "STRING_LIST", value: [ids.activeAlarm!] } } : {}),
      ResolutionTokenMap: { type: "STRING", value: resolution(source, ["dueDate", "lastModifiedDate"], timestamp, ids.replicas) } });
    if (weekly) {
      for (const record of [...pair].reverse()) { retired.push(record.recordName); operations.push({ operationType: "delete", record: { recordName: record.recordName, recordType: record.recordType, recordChangeTag: record.recordChangeTag, fields: {} } }); }
      const alarm = `Alarm/${ids.activeAlarm}`, trigger = `AlarmTrigger/${ids.activeTrigger}`;
      const oldComponents = decodeDateComponents(value(pair[1], "DateComponentsData"));
      operations.push({ operationType: "create", record: { recordName: alarm, recordType: "Alarm", parent: { recordName: source.recordName }, fields: {
        AlarmUID: { type: "STRING", value: ids.activeAlarm }, TriggerID: { type: "STRING", value: ids.activeTrigger }, DueDateResolutionTokenAsNonce: { type: "DOUBLE", value: dueDateNonce(active.fields.ResolutionTokenMap.value) },
        Reminder: { type: "REFERENCE", value: { recordName: source.recordName, action: "VALIDATE" } }, Imported: { type: "INT64", value: 0 }, Deleted: { type: "INT64", value: 0 },
      } } }, { operationType: "create", record: { recordName: trigger, recordType: "AlarmTrigger", parent: { recordName: alarm }, fields: {
        DateComponentsData: { type: "BYTES", value: b64(utf8(JSON.stringify(dateComponentsForSource(next!, reminder.timeZone!, oldComponents)))) }, Type: { type: "STRING", value: "Date" },
        Alarm: { type: "REFERENCE", value: { recordName: alarm, action: "VALIDATE" } }, Imported: { type: "INT64", value: 0 }, Deleted: { type: "INT64", value: 0 },
      } } });
    }
    for (const record of [rule, list]) operations.push({ operationType: "update", record: { recordName: record.recordName, recordType: record.recordType, recordChangeTag: record.recordChangeTag, fields: { Deleted: { type: "INT64", value: 0 } } } });
  } else {
    active.parent = null;
    Object.assign(active.fields, { Deleted: { type: "INT64", value: 1 }, List: { type: "REFERENCE", value: null },
      ResolutionTokenMap: { type: "STRING", value: resolution(source, ["list", "lastModifiedDate"], timestamp, ids.replicas) } });
    for (const record of [...pair, rule]) operations.push({ operationType: "update", record: { recordName: record.recordName, recordType: record.recordType, recordChangeTag: record.recordChangeTag, fields: { Deleted: { type: "INT64", value: 1 } } } });
    const members = normalizeList(list).reminderIds;
    if (!members || new Set(members).size !== members.length) throw new AppError("UNSUPPORTED_FEATURE", "All-future deletion requires exact unambiguous List membership.");
    const included = members.includes(source.recordName);
    const fields: CloudKitWriteRecord["fields"] = included || daily || monthly || ended ? {
      ...(included ? { ReminderIDs: { type: "STRING", value: JSON.stringify((JSON.parse(String(value(list, "ReminderIDs"))) as string[]).filter((_, index) => members[index] !== source.recordName)) } } : {}),
      ResolutionTokenMap: { type: "STRING", value: resolution(list, ["reminderIDsMergeableOrdering"], timestamp, ids.replicas.slice(20)) },
    } : { Deleted: { type: "INT64", value: 0 } };
    knownChangedWrappers(list, Object.keys(fields));
    operations.push({ operationType: "update", record: { recordName: list.recordName, recordType: "List", recordChangeTag: list.recordChangeTag, fields } });
  }
  knownChangedWrappers(source, Object.keys(active.fields));
  const wire = operations.map(operation => operation.record.parent === null ? { ...operation, record: { ...operation.record, parent: { recordName: null } } } : operation);
  if (operations.length > 32 || jsonBytes({ zoneID: { zoneName: "Reminders", zoneType: "REGULAR_CUSTOM_ZONE", ownerRecordName: owner }, atomic: true, operations: wire }) > 65_536)
    throw new AppError("UNSUPPORTED_FEATURE", "The whole recurring deletion exceeds its atomic request budget.");
  const expected: RecurringIntent["expected"] = [];
  for (const operation of operations.filter(operation => operation.operationType !== "delete")) {
    const before = snapshots.find(record => record.recordName === operation.record.recordName);
    const record: CloudKitRecord = { ...operation.record, raw: { ...before?.raw, ...(operation.record.parent === undefined ? {} : { parent: operation.record.parent }) }, fields: { ...before?.fields, ...operation.record.fields } };
    expected.push({ id: record.recordName, type: record.recordType as RecurringIntent["expected"][number]["type"], hash: await recurringRecordHash(record, owner, true) });
  }
  const sourceFingerprint = await fingerprint({ scope, ...(recipe === undefined ? {} : { recipe }), ...(terminal ? { terminal: true } : {}), ...(recurrenceCalendarTimeZone === undefined ? {} : { recurrenceCalendarTimeZone }), records: await Promise.all(snapshots.map(async record => ({ id: record.recordName, version: record.recordChangeTag, hash: await recurringRecordHash(record, owner, true) }))) });
  return { graph, list, scope, timestamp, ...(recipe === undefined ? {} : { recipe }), ...(terminal ? { terminal: true as const } : {}), ...(recurrenceCalendarTimeZone === undefined ? {} : { recurrenceCalendarTimeZone }), ids, active, operations, expected, retired, sourceFingerprint };
}
