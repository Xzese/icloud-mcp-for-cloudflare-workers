import { z } from "zod";
import { AppError, WriteOutcomeUnknownError } from "../errors.ts";
import { b64, unb64, utf8 } from "../crypto/bytes.ts";
import { referenceField, normalizeReminder, type CloudKitRecord } from "../icloud/cloudkit.ts";
import { canonicalJSON } from "../lib/canonical.ts";
import type { SchedulingGraph } from "./linked-records.ts";
import type { CloudKitWriteRecord } from "./writes.ts";

const TimeZone = z.object({ identifier: z.string().min(1).max(128).refine(value => {
  try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; }
  catch { return false; }
}) }).strict();
export const DateComponents = z.object({
  era: z.literal(1), year: z.number().int().min(1).max(9999), month: z.number().int().min(1).max(12),
  day: z.number().int().min(1).max(31), hour: z.number().int().min(0).max(23),
  minute: z.number().int().min(0).max(59), second: z.number().int().min(0).max(59), timeZone: TimeZone,
  nanosecond: z.literal(0).optional(),
}).strict().refine(value => {
  const date = new Date(0);
  date.setUTCFullYear(value.year, value.month - 1, value.day);
  return date.getUTCFullYear() === value.year && date.getUTCMonth() === value.month - 1 && date.getUTCDate() === value.day;
}, "Date components must form a valid Gregorian date.");
export interface LinkedDateWrite {
  recordName: string;
  recordType: "Alarm" | "AlarmTrigger";
  recordChangeTag: string;
  fields: Record<string, { type: string; value: unknown }>;
}
function field(record: CloudKitRecord, name: string, type: string): unknown {
  const wrapper = record.fields[name];
  if (!wrapper || typeof wrapper !== "object" || !("type" in wrapper) || wrapper.type !== type || !("value" in wrapper)) {
    throw new AppError("UNSUPPORTED_FEATURE", `The date recipe requires an observed ${record.recordType}.${name} ${type} field.`);
  }
  return wrapper.value;
}
export function dateComponents(due: string, timeZone: string, includeZeroNanosecond = false) {
  const date = new Date(due);
  if (!Number.isSafeInteger(date.getTime()) || date.getUTCMilliseconds() !== 0 || date.getUTCFullYear() < 1 || date.getUTCFullYear() > 9999) {
    throw new AppError("VALIDATION_ERROR", "Linked dates require an explicit instant with whole-second precision in years 1-9999.", 400);
  }
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-US-u-ca-gregory-nu-latn", { timeZone, era: "short", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  } catch { throw new AppError("VALIDATION_ERROR", "The linked date requires a valid IANA time zone.", 400); }
  const parts = formatter.formatToParts(date);
  if (parts.find(part => part.type === "era")?.value !== "AD") throw new AppError("VALIDATION_ERROR", "The linked date is outside the supported Gregorian calendar range.", 400);
  const value = (type: string) => Number(parts.find(part => part.type === type)?.value);
  const result = DateComponents.safeParse({ era: 1, year: value("year"), month: value("month"), day: value("day"),
    hour: value("hour"), minute: value("minute"), second: value("second"), timeZone: { identifier: timeZone }, ...(includeZeroNanosecond ? { nanosecond: 0 } : {}) });
  if (!result.success) throw new AppError("VALIDATION_ERROR", "The linked date is outside the supported Gregorian calendar range.", 400);
  // The trigger format has no UTC-offset/fold field. Refuse a repeated local
  // time rather than claim it can distinguish the two fall-back occurrences.
  const localMillis = (millis: number) => {
    const parts = formatter.formatToParts(new Date(millis));
    const value = (type: string) => Number(parts.find(part => part.type === type)?.value);
    const date = new Date(0), year = value("year");
    date.setUTCFullYear(parts.find(part => part.type === "era")?.value === "AD" ? year : 1 - year, value("month") - 1, value("day"));
    date.setUTCHours(value("hour"), value("minute"), value("second"), 0);
    return date.getTime();
  };
  const offsets = new Set<number>(), local = localMillis(date.getTime());
  for (let hours = -48; hours <= 48; hours += 6) {
    const sample = date.getTime() + hours * 3_600_000;
    offsets.add(localMillis(sample) - sample);
  }
  for (const offset of offsets) {
    const candidate = local - offset;
    if (candidate !== date.getTime() && localMillis(candidate) === local) throw new AppError("UNSUPPORTED_FEATURE", "This local time occurs twice during a time-zone transition; the date-trigger format cannot preserve the requested offset.");
  }
  return result.data;
}
export function decodeDateComponents(value: unknown) {
  if (typeof value !== "string") throw new AppError("UNSUPPORTED_FEATURE", "The date trigger is not base64 JSON.");
  let decoded: unknown;
  try { decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(unb64(value, 8192))); }
  catch { throw new AppError("UNSUPPORTED_FEATURE", "The date trigger is not bounded UTF-8 JSON."); }
  const result = DateComponents.safeParse(decoded);
  if (!result.success) throw new AppError("UNSUPPORTED_FEATURE", "This trigger uses unsupported date-component fields or calendar semantics.");
  return result.data;
}
export function dueDateNonce(encoded: unknown) {
  if (typeof encoded !== "string" || utf8(encoded).length > 65_536) throw new AppError("PROTOCOL_CHANGED", "The due-date resolution map is invalid.");
  let decoded: unknown;
  try { decoded = JSON.parse(encoded); }
  catch { throw new AppError("PROTOCOL_CHANGED", "The due-date resolution map is malformed."); }
  const token = z.object({ map: z.object({ dueDate: z.object({
    counter: z.number().int().safe().positive(), modificationTime: z.number().finite(),
    replicaID: z.string().uuid(),
  }).passthrough() }).passthrough() }).passthrough().safeParse(decoded);
  if (!token.success) throw new AppError("UNSUPPORTED_FEATURE", "The date recipe requires a valid observed dueDate resolution token.");
  const nonce = token.data.map.dueDate.counter * 100_000_000_000 + token.data.map.dueDate.modificationTime;
  if (!Number.isFinite(nonce) || Math.abs(nonce) > Number.MAX_SAFE_INTEGER) throw new AppError("UNSUPPORTED_FEATURE", "The due-date nonce exceeds supported numeric precision.");
  return nonce;
}
export function linkedDatePlan(graph: SchedulingGraph, write: CloudKitWriteRecord, owner: string) {
  const reminder = normalizeReminder(graph.reminder, owner);
  const due = write.fields.DueDate ? write.fields.DueDate.value : reminder.dueDate === null ? null : Date.parse(reminder.dueDate);
  const zone = write.fields.TimeZone ? write.fields.TimeZone.value : reminder.timeZone;
  const allDay = write.fields.AllDay ? write.fields.AllDay.value === 1 : reminder.allDay;
  if (!graph.complete || reminder.parentReminderId && graph.schedulingParent?.recordName !== reminder.parentReminderId || reminder.completed !== false || reminder.deleted !== false ||
    reminder.startDate !== null || reminder.allDay !== false || allDay !== false || reminder.dueDate === null || !reminder.timeZone ||
    typeof due !== "number" || !Number.isSafeInteger(due) || typeof zone !== "string" ||
    reminder.alarmIds?.length !== 1 || (reminder.recurrenceRuleIds?.length ?? 0) > 1) {
    throw new AppError("UNSUPPORTED_FEATURE", "Linked date changes currently require an open, timed root with one absolute date alarm. Clearing dates, all-day conversion, start dates, multiple alarms and nested schedules require different recipes.");
  }
  const alarm = graph.records.find(record => record.recordName === reminder.alarmIds![0]);
  const triggers = graph.records.filter(record => record.recordType === "AlarmTrigger");
  const rule = graph.records.find(record => record.recordType === "RecurrenceRule");
  if (!alarm || alarm.recordType !== "Alarm" || triggers.length !== 1 || graph.records.length !== (rule ? 4 : 3) + (graph.schedulingParent ? 1 : 0)) {
    throw new AppError("UNSUPPORTED_FEATURE", "The date graph does not contain exactly the expected current alarm, trigger and optional recurrence.");
  }
  const trigger = triggers[0];
  const expectedTriggerId = field(alarm, "TriggerID", "STRING");
  const allowedAlarm = new Set(["AlarmUID", "DueDateResolutionTokenAsNonce", "Reminder", "TriggerID", "Imported", "Deleted"]);
  const allowedTrigger = new Set(["DateComponentsData", "Type", "Alarm", "Imported", "Deleted"]);
  if (Object.keys(alarm.fields).some(key => !allowedAlarm.has(key)) || Object.keys(trigger.fields).some(key => !allowedTrigger.has(key)) ||
    referenceField(alarm, "Reminder", "Reminder", owner) !== reminder.id || referenceField(trigger, "Alarm", "Alarm", owner) !== alarm.recordName ||
    expectedTriggerId !== trigger.recordName.slice("AlarmTrigger/".length) && expectedTriggerId !== trigger.recordName ||
    field(trigger, "Type", "STRING") !== "Date" || field(alarm, "AlarmUID", "STRING") !== alarm.recordName.slice("Alarm/".length)) {
    throw new AppError("UNSUPPORTED_FEATURE", "The alarm is not the observed bidirectional absolute-date recipe.");
  }
  for (const record of [alarm, trigger, ...(rule ? [rule] : [])]) {
    if (!record.recordChangeTag || record.deleted || field(record, "Deleted", "INT64") !== 0) throw new AppError("CONFLICT", "A scheduling participant changed or was deleted.", 409);
  }
  if (rule && referenceField(rule, "Reminder", "Reminder", owner) !== reminder.id) throw new AppError("PROTOCOL_CHANGED", "The recurrence belongs to a different reminder.");
  const oldComponents = decodeDateComponents(field(trigger, "DateComponentsData", "BYTES"));
  const includeZeroNanosecond = Object.hasOwn(oldComponents, "nanosecond");
  if (canonicalJSON(oldComponents) !== canonicalJSON(dateComponents(reminder.dueDate, reminder.timeZone, includeZeroNanosecond)) ||
    field(alarm, "DueDateResolutionTokenAsNonce", "DOUBLE") !== dueDateNonce(field(graph.reminder, "ResolutionTokenMap", "STRING"))) {
    throw new AppError("CONFLICT", "The current date, resolution token and alarm/trigger disagree; wait for synchronization and review again.", 409);
  }
  const tokenMap = write.fields.ResolutionTokenMap.value;
  const dependencies: LinkedDateWrite[] = [
    { recordName: alarm.recordName, recordType: "Alarm", recordChangeTag: alarm.recordChangeTag!, fields: {
      DueDateResolutionTokenAsNonce: { type: "DOUBLE", value: dueDateNonce(tokenMap) },
    } },
    { recordName: trigger.recordName, recordType: "AlarmTrigger", recordChangeTag: trigger.recordChangeTag!, fields: {
      DateComponentsData: { type: "BYTES", value: b64(utf8(JSON.stringify(dateComponents(new Date(due).toISOString(), zone, includeZeroNanosecond)))) },
    } },
  ];
  return { dependencies, guards: rule ? [rule] : [] };
}
export function verifyLinkedDateWrite(write: LinkedDateWrite, before: CloudKitRecord, confirmed: CloudKitRecord) {
  if (confirmed.recordName !== write.recordName || confirmed.recordType !== write.recordType || confirmed.deleted ||
    !confirmed.recordChangeTag || confirmed.recordChangeTag === write.recordChangeTag ||
    canonicalJSON(confirmed.fields) !== canonicalJSON({ ...before.fields, ...write.fields })) {
    throw new WriteOutcomeUnknownError(write.recordName);
  }
}
