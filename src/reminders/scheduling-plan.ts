import { AppError, WriteOutcomeUnknownError } from "../errors.ts";
import { inspectLocationAlarms } from "./location-alarm.ts";
import { earlyReminderPayload, editEarlyReminder } from "./early-reminder.ts";
import { b64, utf8 } from "../crypto/bytes.ts";
import { normalizeReminder, referenceField, type CloudKitRecord, type CloudKitRecordItem } from "../icloud/cloudkit.ts";
import { canonicalJSON } from "../lib/canonical.ts";
import { dateComponents, dueDateNonce, linkedDatePlan } from "./linked-date.ts";
import type { SchedulingGraph } from "./linked-records.ts";
import { updateResolutionTokenMap, type CloudKitWriteRecord, type UpdateReminderInputData } from "./writes.ts";

export interface SchedulingWrite {
  recordName: string;
  recordType: "Alarm" | "AlarmTrigger" | "RecurrenceRule";
  recordChangeTag?: string;
  operationType?: "create" | "update" | "delete";
  fields: Record<string, { type: string; value: unknown }>;
}
function value(record: CloudKitRecord, key: string, type: string) {
  const field = record.fields[key];
  if (!field || typeof field !== "object" || !("type" in field) || !("value" in field) || field.type !== type) throw new AppError("UNSUPPORTED_FEATURE", `Unsupported scheduling field ${record.recordType}.${key}.`);
  return field.value;
}
function live(record: CloudKitRecord) {
  if (!record.recordChangeTag || record.deleted || value(record, "Deleted", "INT64") !== 0) throw new AppError("CONFLICT", "A scheduling participant changed or was deleted.", 409);
}
export function schedulingPlan(graph: SchedulingGraph, write: CloudKitWriteRecord, input: UpdateReminderInputData, owner: string, now: number) {
  const reminder = normalizeReminder(graph.reminder, owner), changes = input.changes;
  if (!graph.complete || graph.unsupportedReason || reminder.parentReminderId && graph.schedulingParent?.recordName !== reminder.parentReminderId || reminder.completed !== false || reminder.deleted !== false || reminder.startDate !== null ||
    (reminder.alarmIds?.length ?? 0) > 2 || (reminder.recurrenceRuleIds?.length ?? 0) > 1) {
    throw new AppError("UNSUPPORTED_FEATURE", "This schedule requires an unsupported nested, relative, multiple-alarm or start-date recipe.");
  }
  const { locations, dateGraph, locationRecords } = inspectLocationAlarms(graph, owner);
  if (locations.length && (changes.dueDate === null || changes.allDay !== undefined)) throw new AppError("UNSUPPORTED_FEATURE", "Clearing or converting a date with a location alarm requires a different native recipe.");
  const dateReminder = normalizeReminder(dateGraph.reminder, owner);
  const early = Object.hasOwn(graph.reminder.fields, "DueDateDeltaAlertsData") ? earlyReminderPayload(graph.reminder) : null;
  if (early && (changes.dueDate === null || changes.allDay !== undefined)) throw new AppError("UNSUPPORTED_FEATURE", "Clearing or converting a date with an early reminder requires a different native recipe.");
  const rule = graph.records.find(record => record.recordType === "RecurrenceRule");
  if (rule) {
    live(rule);
    if (referenceField(rule, "Reminder", "Reminder", owner) !== reminder.id) throw new AppError("PROTOCOL_CHANGED", "The recurrence belongs to a different reminder.");
  }
  let dependencies: SchedulingWrite[] = [], guards: CloudKitRecord[] = [];
  // Validate the full current absolute-date graph before changing or retiring it.
  if (dateReminder.alarmIds?.length) {
    const currentWrite = { ...write, fields: { ResolutionTokenMap: graph.reminder.fields.ResolutionTokenMap as CloudKitWriteRecord["fields"][string] } };
    linkedDatePlan(dateGraph, currentWrite, owner);
  } else if (dateGraph.records.length !== (rule ? 2 : 1) + (graph.schedulingParent ? 1 : 0)) throw new AppError("UNSUPPORTED_FEATURE", "The graph contains unexpected scheduling participants.");
  const afterAllDay = changes.allDay ?? reminder.allDay;
  if (afterAllDay === true && changes.dueDate !== undefined && changes.dueDate !== null &&
    (Date.parse(changes.dueDate) % 86_400_000 !== 0 || !changes.dueDate.endsWith("Z"))) throw new AppError("VALIDATION_ERROR", "An all-day calendar date must be supplied explicitly at midnight UTC.", 400);
  if (afterAllDay === true && changes.timeZone !== undefined) throw new AppError("UNSUPPORTED_FEATURE", "All-day scheduling has no stored time zone; omit timeZone.");
  if (rule && reminder.allDay === false && !dateReminder.alarmIds?.length && changes.allDay !== true &&
    ["DueDate", "TimeZone"].some(key => Object.hasOwn(write.fields, key))) throw new AppError("UNSUPPORTED_FEATURE", "This timed recurrence has no verified date-alarm graph.");
  const token = (...keys: string[]) => {
    const map = JSON.parse(String(write.fields.ResolutionTokenMap.value));
    const extras = JSON.parse(updateResolutionTokenMap(graph.reminder, keys, now));
    for (const key of keys) map.map[key] = extras.map[key];
    write.fields.ResolutionTokenMap = { type: "STRING", value: JSON.stringify(map) };
  };
  const retire = (record: CloudKitRecord): SchedulingWrite => ({ recordName: record.recordName, recordType: record.recordType as SchedulingWrite["recordType"], recordChangeTag: record.recordChangeTag!,
    ...(record.recordType === "RecurrenceRule" ? { fields: { Deleted: { type: "INT64", value: 1 }, Reminder: { type: "REFERENCE", value: null } } } : { operationType: "delete", fields: {} }),
  });
  const retirementOrder = (records: CloudKitRecord[]) => [...records].sort((a, b) => (a.recordType === "AlarmTrigger" ? 0 : a.recordType === "Alarm" ? 1 : 2) - (b.recordType === "AlarmTrigger" ? 0 : b.recordType === "Alarm" ? 1 : 2));
  if (changes.dueDate === null) {
    if (changes.recurrence) throw new AppError("VALIDATION_ERROR", "Clearing a linked date also removes its recurrence; do not combine it with a recurrence edit.", 400);
    if (changes.timeZone !== undefined || changes.allDay !== undefined) throw new AppError("UNSUPPORTED_FEATURE", "Linked date clearing preserves the current time-zone and all-day fields.");
    for (const [key, ids] of [["AlarmIDs", reminder.alarmIds], ["RecurrenceRuleIDs", reminder.recurrenceRuleIds]] as const) if (ids?.length) write.fields[key] = { type: "UNKNOWN_LIST", value: [] };
    token("recurrenceRuleIDs");
    dependencies = retirementOrder(graph.records.filter(record => record.recordType !== "Reminder")).map(retire);
  } else if (changes.allDay === true && reminder.allDay === false) {
    if (!changes.dueDate || Date.parse(changes.dueDate) % 86_400_000 !== 0 || !changes.dueDate.endsWith("Z")) throw new AppError("VALIDATION_ERROR", "All-day conversion requires the requested calendar date as an explicit midnight-UTC dueDate.", 400);
    if (changes.timeZone !== undefined) throw new AppError("VALIDATION_ERROR", "All-day conversion removes the stored time zone; omit timeZone.", 400);
    write.fields.TimeZone = { type: "STRING", value: null };
    write.fields.AlarmIDs = { type: "UNKNOWN_LIST", value: [] };
    token("timeZone");
    dependencies = retirementOrder(graph.records.filter(record => ["Alarm", "AlarmTrigger"].includes(record.recordType))).map(retire);
    if (rule) guards.push(rule);
  } else if (changes.allDay === false && reminder.allDay === true) {
    if (!changes.dueDate || !changes.timeZone || reminder.alarmIds?.length) throw new AppError("VALIDATION_ERROR", "Timed conversion requires an explicit dueDate and IANA timeZone on an all-day reminder without alarms.", 400);
    const alarmUID = crypto.randomUUID().toUpperCase(), triggerUID = crypto.randomUUID().toUpperCase();
    const alarmId = `Alarm/${alarmUID}`, triggerId = `AlarmTrigger/${triggerUID}`;
    write.fields.AlarmIDs = { type: "STRING_LIST", value: [alarmUID] };
    token("dueDate", "timeZone", "allDay");
    dependencies = [
      { operationType: "create", recordName: alarmId, recordType: "Alarm", fields: {
        AlarmUID: { type: "STRING", value: alarmUID }, TriggerID: { type: "STRING", value: triggerUID },
        DueDateResolutionTokenAsNonce: { type: "DOUBLE", value: dueDateNonce(write.fields.ResolutionTokenMap.value) },
        Reminder: { type: "REFERENCE", value: { recordName: reminder.id, action: "VALIDATE" } }, Imported: { type: "INT64", value: 0 }, Deleted: { type: "INT64", value: 0 },
      } },
      { operationType: "create", recordName: triggerId, recordType: "AlarmTrigger", fields: {
        Type: { type: "STRING", value: "Date" }, Alarm: { type: "REFERENCE", value: { recordName: alarmId, action: "VALIDATE" } },
        DateComponentsData: { type: "BYTES", value: b64(utf8(JSON.stringify(dateComponents(changes.dueDate, changes.timeZone)))) },
        Imported: { type: "INT64", value: 0 }, Deleted: { type: "INT64", value: 0 },
      } },
    ];
    if (rule) guards.push(rule);
  } else if (["DueDate", "TimeZone", "AllDay"].some(key => Object.hasOwn(write.fields, key)) && dateReminder.alarmIds?.length) {
    ({ dependencies, guards } = linkedDatePlan(dateGraph, write, owner));
  } else guards = graph.records.filter(record => record.recordType !== "Reminder");
  if (locations.length && ["DueDate", "TimeZone"].some(key => Object.hasOwn(write.fields, key)) && !dateReminder.alarmIds?.length) throw new AppError("UNSUPPORTED_FEATURE", "Adding a date alarm to a location-only graph requires a different native recipe.");
  for (const record of locationRecords) if (!guards.some(guard => guard.recordName === record.recordName)) guards.push(record);
  if (changes.locationAlarm) {
    const location = locations[0];
    if (!location) throw new AppError("UNSUPPORTED_FEATURE", "Location creation requires native place selection; only an existing reviewed location alarm can be edited.");
    if (location.proximity === changes.locationAlarm.proximity) throw new AppError("VALIDATION_ERROR", "The location proximity is unchanged.", 400);
    guards = guards.filter(record => record.recordName !== location.trigger.recordName);
    dependencies.push({ recordName: location.trigger.recordName, recordType: "AlarmTrigger", recordChangeTag: location.trigger.recordChangeTag!, fields: { Proximity: { type: "INT64", value: changes.locationAlarm.proximity === "arriving" ? 1 : 2 } } });
  }
  if (changes.recurrence) {
    if (!rule || reminder.dueDate === null || ![0, 1, 2, 3].includes(Number(value(rule, "Frequency", "INT64"))) || ![1, 2].includes(Number(value(rule, "Interval", "INT64"))) ||
      value(rule, "OccurrenceCount", "INT64") !== 0 || value(rule, "FirstDayOfTheWeek", "INT64") !== 0 ||
      Object.keys(rule.fields).some(key => !["Reminder", "Frequency", "Interval", "OccurrenceCount", "FirstDayOfTheWeek", "Imported", "Deleted"].includes(key))) {
      throw new AppError("UNSUPPORTED_FEATURE", "Only an existing simple daily, weekly, monthly or yearly rule supports this recurrence edit.");
    }
    const frequency = ["daily", "weekly", "monthly", "yearly"].indexOf(changes.recurrence.frequency);
    if (frequency !== 1 && changes.recurrence.interval !== 1) throw new AppError("UNSUPPORTED_FEATURE", "Only weekly recurrence has an observed multi-period interval.");
    if (value(rule, "Interval", "INT64") === changes.recurrence.interval && value(rule, "Frequency", "INT64") === frequency) throw new AppError("VALIDATION_ERROR", "The recurrence interval is unchanged.", 400);
    guards = guards.filter(record => record.recordName !== rule.recordName);
    dependencies.push({ recordName: rule.recordName, recordType: "RecurrenceRule", recordChangeTag: rule.recordChangeTag!, fields: { ...(value(rule, "Frequency", "INT64") !== frequency ? { Frequency: { type: "INT64", value: frequency } } : {}), ...(value(rule, "Interval", "INT64") !== changes.recurrence.interval ? { Interval: { type: "INT64", value: changes.recurrence.interval } } : {}) } });
  }
  if (changes.earlyReminder !== undefined) {
    if (reminder.dueDate === null || reminder.allDay !== false) throw new AppError("UNSUPPORTED_FEATURE", "Early reminder edits require an existing timed date.");
    if (!early) throw new AppError("UNSUPPORTED_FEATURE", "Early reminder creation requires private account metadata that is not inferred.");
    write.fields.DueDateDeltaAlertsData = changes.earlyReminder === null ? { type: "ENCRYPTED_BYTES", value: null } : editEarlyReminder(graph.reminder, changes.earlyReminder);
  }
  if (graph.schedulingParent) {
    live(graph.schedulingParent);
    if (!guards.some(record => record.recordName === graph.schedulingParent!.recordName)) guards.push(graph.schedulingParent);
  }
  return { dependencies, guards };
}
export function schedulingOperation({ operationType, ...record }: SchedulingWrite) {
  return { operationType: operationType ?? "update" as const, record: operationType === "delete" ? { recordName: record.recordName, recordType: record.recordType, recordChangeTag: record.recordChangeTag } : record };
}
export function verifySchedulingWrite(write: SchedulingWrite, before: CloudKitRecord | undefined, confirmed: CloudKitRecordItem, expectedOwner = confirmed.zoneID?.ownerRecordName ?? "__defaultOwner__") {
  if (write.operationType === "delete") {
    if (confirmed.recordName !== write.recordName || confirmed.deleted !== true || "recordType" in confirmed ||
      Object.keys(confirmed.raw).length !== 2 || confirmed.raw.recordName !== write.recordName || confirmed.raw.deleted !== true) throw new WriteOutcomeUnknownError(write.recordName);
    return;
  }
  if (!("recordType" in confirmed)) throw new WriteOutcomeUnknownError(write.recordName);
  const expected = { ...before?.fields, ...write.fields };
  const actual = { ...confirmed.fields };
  // CloudKit expands newly written references with the validated request zone.
  if (write.operationType === "create") for (const [key, field] of Object.entries(write.fields)) {
    if (field.type !== "REFERENCE") continue;
    const type = key === "Reminder" ? "Reminder" : "Alarm";
    const id = referenceField(confirmed, key, type, expectedOwner);
    if (!field.value || typeof field.value !== "object" || !("recordName" in field.value) || id !== field.value.recordName) throw new WriteOutcomeUnknownError(write.recordName);
    const wrapper = confirmed.fields[key] as { type: string; value: Record<string, unknown> };
    if (wrapper.value.action !== "VALIDATE" || Object.keys(wrapper.value).some(name => !["recordName", "action", "zoneID"].includes(name))) throw new WriteOutcomeUnknownError(write.recordName);
    actual[key] = { type: "REFERENCE", value: { recordName: id, action: "VALIDATE" } };
  }
  for (const [key, field] of Object.entries(expected)) if (field && typeof field === "object" && "value" in field && field.value === null && !Object.hasOwn(confirmed.fields, key)) delete expected[key];
  if (confirmed.recordName !== write.recordName || confirmed.recordType !== write.recordType || confirmed.deleted || !confirmed.recordChangeTag ||
    confirmed.recordChangeTag === write.recordChangeTag || canonicalJSON(actual) !== canonicalJSON(expected)) throw new WriteOutcomeUnknownError(write.recordName);
}
