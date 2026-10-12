import { AppError, WriteOutcomeUnknownError } from "../errors.ts";
import { readRecurrence, readPreservedRecurrence, recurrenceEdit, recurrenceCreation } from "./recurrence.ts";
import { inspectLocationAlarms, locationFields, LocationAlarmSummary } from "./location-alarm.ts";
import { earlyReminderPayload, editEarlyReminder, createEarlyReminder } from "./early-reminder.ts";
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
  locationRetirement?: { alarmId: string; triggerId: string };
  fields: Record<string, { type: string; value: unknown; isEncrypted?: true }>;
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
  if (changes.locationAlarm !== undefined && (changes.dueDate === null || changes.allDay !== undefined)) throw new AppError("VALIDATION_ERROR", "Clear or convert the date while preserving the location alarm; edit or remove the location in a separate reviewed request.", 400);
  const dateReminder = normalizeReminder(dateGraph.reminder, owner);
  const earlyField = graph.reminder.fields.DueDateDeltaAlertsData as { type?: string; value?: unknown } | undefined;
  const early = Object.hasOwn(graph.reminder.fields, "DueDateDeltaAlertsData") && !(earlyField?.type === "ENCRYPTED_BYTES" && earlyField.value === null) ? earlyReminderPayload(graph.reminder) : null;
  if (changes.dueDate === null && changes.earlyReminder) throw new AppError("VALIDATION_ERROR", "Clearing the date removes its early reminder; do not combine it with an offset edit.", 400);
  const rule = graph.records.find(record => record.recordType === "RecurrenceRule");
  if (rule) {
    live(rule);
    if (changes.recurrence !== undefined || changes.allDay !== undefined || changes.dueDate === null) readRecurrence(rule);
    else readPreservedRecurrence(rule);
    if (referenceField(rule, "Reminder", "Reminder", owner) !== reminder.id) throw new AppError("PROTOCOL_CHANGED", "The recurrence belongs to a different reminder.");
  }
  let dependencies: SchedulingWrite[] = [], guards: CloudKitRecord[] = [];
  // Validate the full current absolute-date graph before changing or retiring it.
  if (dateReminder.alarmIds?.length) {
    const currentWrite = { ...write, fields: { ResolutionTokenMap: graph.reminder.fields.ResolutionTokenMap as CloudKitWriteRecord["fields"][string] } };
    linkedDatePlan(dateGraph, currentWrite, owner);
  } else if (dateGraph.records.length !== (rule ? 2 : 1) + (graph.schedulingParent ? 1 : 0)) throw new AppError("UNSUPPORTED_FEATURE", "The graph contains unexpected scheduling participants.");
  const afterAllDay = changes.allDay ?? reminder.allDay;
  const hourlyRule = rule && readPreservedRecurrence(rule).frequency === "hourly" ? rule : undefined;
  if (afterAllDay === true && changes.recurrence?.frequency === "hourly") throw new AppError("VALIDATION_ERROR", "Hourly recurrence requires a timed date and cannot be created or edited on an all-day date.", 400);
  if (hourlyRule && changes.allDay === true && changes.recurrence) throw new AppError("VALIDATION_ERROR", "All-day conversion removes hourly recurrence; change its frequency in a separate reviewed request.", 400);
  if (hourlyRule && reminder.allDay === true && changes.allDay !== false && changes.dueDate !== null && changes.recurrence === undefined) throw new AppError("UNSUPPORTED_FEATURE", "The current hourly/all-day combination is outside the observed native recipe.");
  if (afterAllDay === true && changes.dueDate !== undefined && changes.dueDate !== null &&
    (Date.parse(changes.dueDate) % 86_400_000 !== 0 || !changes.dueDate.endsWith("Z"))) throw new AppError("VALIDATION_ERROR", "An all-day calendar date must be supplied explicitly at midnight UTC.", 400);
  if (afterAllDay === true && changes.timeZone !== undefined) throw new AppError("UNSUPPORTED_FEATURE", "All-day scheduling has no stored time zone; omit timeZone.");
  if (rule && reminder.allDay === false && !dateReminder.alarmIds?.length && changes.allDay !== true && changes.dueDate !== null &&
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
    if (dateReminder.alarmIds?.length) write.fields.AlarmIDs = { type: locations.length ? "STRING_LIST" : "UNKNOWN_LIST", value: locations.map(location => location.alarm.recordName.slice(6)) };
    if (rule) { write.fields.RecurrenceRuleIDs = { type: "UNKNOWN_LIST", value: [] }; token("recurrenceRuleIDs"); }
    if (early) { write.fields.DueDateDeltaAlertsData = { type: "ENCRYPTED_BYTES", value: null }; token("dueDateDeltaAlertsData"); }
    dependencies = retirementOrder(dateGraph.records.filter(record => record.recordType !== "Reminder")).map(retire);
  } else if (changes.allDay === true && reminder.allDay === false) {
    if (!changes.dueDate || Date.parse(changes.dueDate) % 86_400_000 !== 0 || !changes.dueDate.endsWith("Z")) throw new AppError("VALIDATION_ERROR", "All-day conversion requires the requested calendar date as an explicit midnight-UTC dueDate.", 400);
    if (changes.timeZone !== undefined) throw new AppError("VALIDATION_ERROR", "All-day conversion removes the stored time zone; omit timeZone.", 400);
    write.fields.TimeZone = { type: "STRING", value: null };
    write.fields.AlarmIDs = { type: locations.length ? "STRING_LIST" : "UNKNOWN_LIST", value: locations.map(location => location.alarm.recordName.slice(6)) };
    token("timeZone");
    dependencies = retirementOrder(dateGraph.records.filter(record => ["Alarm", "AlarmTrigger"].includes(record.recordType))).map(retire);
    if (hourlyRule) {
      dependencies.push(retire(hourlyRule));
      write.fields.RecurrenceRuleIDs = { type: "UNKNOWN_LIST", value: [] };
      token("recurrenceRuleIDs");
    } else if (rule) guards.push(rule);
  } else if (changes.allDay === false && reminder.allDay === true || afterAllDay === false && reminder.dueDate === null && locations.length > 0 && !dateReminder.alarmIds?.length && changes.dueDate !== undefined) {
    if (!changes.dueDate || !changes.timeZone || dateReminder.alarmIds?.length) throw new AppError("VALIDATION_ERROR", "Adding a timed date alarm requires explicit dueDate and IANA timeZone without an existing date alarm.", 400);
    const alarmUID = crypto.randomUUID().toUpperCase(), triggerUID = crypto.randomUUID().toUpperCase();
    const alarmId = `Alarm/${alarmUID}`, triggerId = `AlarmTrigger/${triggerUID}`;
    write.fields.AlarmIDs = { type: "STRING_LIST", value: [...(reminder.alarmIds ?? []).map(id => id.slice(6)), alarmUID] };
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
  if (locations.length && changes.dueDate !== null && !dependencies.some(record => record.operationType === "create" && record.recordType === "Alarm") && afterAllDay !== true && ["DueDate", "TimeZone"].some(key => Object.hasOwn(write.fields, key)) && !dateReminder.alarmIds?.length) throw new AppError("UNSUPPORTED_FEATURE", "Adding a date alarm to a location-only graph requires a different native recipe.");
  for (const record of locationRecords) if (!guards.some(guard => guard.recordName === record.recordName)) guards.push(record);
  if (changes.locationAlarm !== undefined) {
    const location = locations[0], change = changes.locationAlarm;
    if (change === null) {
      if (!location) throw new AppError("VALIDATION_ERROR", "There is no location alarm to remove.", 400);
      const alarmIds = (reminder.alarmIds ?? []).filter(id => id !== location.alarm.recordName);
      write.fields.AlarmIDs = { type: alarmIds.length ? "STRING_LIST" : "UNKNOWN_LIST", value: alarmIds.map(id => id.slice(6)) };
      guards = guards.filter(record => !locationRecords.some(locationRecord => locationRecord.recordName === record.recordName));
      const locationRetirement = { alarmId: location.alarm.recordName, triggerId: location.trigger.recordName };
      dependencies.push({ recordName: location.alarm.recordName, recordType: "Alarm", recordChangeTag: location.alarm.recordChangeTag!, locationRetirement,
        fields: { Deleted: { type: "INT64", value: 1 }, Reminder: { type: "REFERENCE", value: null } } },
        { recordName: location.trigger.recordName, recordType: "AlarmTrigger", recordChangeTag: location.trigger.recordChangeTag!, locationRetirement, fields: { Deleted: { type: "INT64", value: 1 } } });
    } else if (location) {
      const fields = locationFields(change);
      for (const key of Object.keys(fields)) if (canonicalJSON(fields[key]) === canonicalJSON(location.trigger.fields[key])) delete fields[key];
      if (!Object.keys(fields).length) throw new AppError("VALIDATION_ERROR", "The location alarm is unchanged.", 400);
      // Keep a place edit complete at the transport boundary, even when one component is unchanged.
      if (change.place) Object.assign(fields, locationFields({ place: change.place }));
      guards = guards.filter(record => record.recordName !== location.trigger.recordName);
      dependencies.push({ recordName: location.trigger.recordName, recordType: "AlarmTrigger", recordChangeTag: location.trigger.recordChangeTag!, fields });
    } else {
      const full = LocationAlarmSummary.safeParse(change);
      if (!full.success) throw new AppError("VALIDATION_ERROR", "Location creation requires complete place, proximity and radiusMeters.", 400);
      const alarmUID = crypto.randomUUID().toUpperCase(), triggerUID = crypto.randomUUID().toUpperCase();
      const alarmId = `Alarm/${alarmUID}`, triggerId = `AlarmTrigger/${triggerUID}`;
      const existingIds = (write.fields.AlarmIDs?.value ?? (reminder.alarmIds ?? []).map(id => id.slice(6))) as string[];
      write.fields.AlarmIDs = { type: "STRING_LIST", value: [...existingIds, alarmUID] };
      dependencies.push({ operationType: "create", recordName: alarmId, recordType: "Alarm", fields: {
        AlarmUID: { type: "STRING", value: alarmUID }, TriggerID: { type: "STRING", value: triggerUID }, DueDateResolutionTokenAsNonce: { type: "DOUBLE", value: 0 },
        Reminder: { type: "REFERENCE", value: { recordName: reminder.id, action: "VALIDATE" } }, Imported: { type: "INT64", value: 0 }, Deleted: { type: "INT64", value: 0 },
      } }, { operationType: "create", recordName: triggerId, recordType: "AlarmTrigger", fields: {
        ...locationFields(full.data), Type: { type: "STRING", value: "Location" }, ReferenceFrameString: { type: "STRING", value: "1", isEncrypted: true }, LocationUID: { type: "STRING", value: crypto.randomUUID().toUpperCase() },
        Alarm: { type: "REFERENCE", value: { recordName: alarmId, action: "VALIDATE" } }, Imported: { type: "INT64", value: 0 }, Deleted: { type: "INT64", value: 0 },
      } });
    }
  }
  if (changes.recurrence !== undefined && changes.dueDate !== null && !dependencies.some(record => record.recordType === "RecurrenceRule" && record.fields.Deleted?.value === 1)) {
    if (changes.recurrence === null) {
      if (!rule) throw new AppError("VALIDATION_ERROR", "There is no recurrence to remove.", 400);
      guards = guards.filter(record => record.recordName !== rule.recordName);
      dependencies.push(retire(rule));
      write.fields.RecurrenceRuleIDs = { type: "UNKNOWN_LIST", value: [] };
      token("recurrenceRuleIDs");
    } else if (rule) {
      const { fields } = recurrenceEdit(rule, changes.recurrence);
      if (!Object.keys(fields).length) throw new AppError("VALIDATION_ERROR", "The recurrence is unchanged.", 400);
      guards = guards.filter(record => record.recordName !== rule.recordName);
      dependencies.push({ recordName: rule.recordName, recordType: "RecurrenceRule", recordChangeTag: rule.recordChangeTag!, fields });
    } else {
      if ((changes.dueDate ?? reminder.dueDate) === null || afterAllDay !== true && !dateReminder.alarmIds?.length && !dependencies.some(record => record.operationType === "create" && record.recordType === "Alarm")) throw new AppError("UNSUPPORTED_FEATURE", "Recurrence creation requires a known all-day date or complete absolute-date graph.");
      const ruleUID = crypto.randomUUID().toUpperCase();
      write.fields.RecurrenceRuleIDs = { type: "STRING_LIST", value: [ruleUID] };
      token("recurrenceRuleIDs");
      dependencies.push({ operationType: "create", recordName: `RecurrenceRule/${ruleUID}`, recordType: "RecurrenceRule", fields: recurrenceCreation(reminder.id, changes.recurrence) });
    }
  }
  if (changes.earlyReminder !== undefined && changes.dueDate !== null) {
    if (reminder.dueDate === null) throw new AppError("UNSUPPORTED_FEATURE", "Early reminder edits require an existing date.");
    if (!early) {
      if (changes.earlyReminder === null) throw new AppError("VALIDATION_ERROR", "There is no early reminder to remove.", 400);
      const source = graph.earlyReminderWitness;
      if (!source) throw new AppError("UNSUPPORTED_FEATURE", "Early reminder creation requires an exact versioned same-list private metadata source.");
      live(source);
      const sourceReminder = normalizeReminder(source, owner);
      if (sourceReminder.listId !== reminder.listId || sourceReminder.completed !== false || sourceReminder.deleted !== false || sourceReminder.parentReminderId !== null ||
        source.zoneID?.zoneName !== "Reminders" || ![owner, "__defaultOwner__"].includes(source.zoneID.ownerRecordName ?? owner)) throw new AppError("CONFLICT", "The early reminder source must remain an open root in the same private list.", 409);
      const existingSource = graph.records.find(record => record.recordName === source.recordName);
      if (existingSource && (existingSource.recordChangeTag !== source.recordChangeTag || canonicalJSON(existingSource.fields) !== canonicalJSON(source.fields))) throw new AppError("CONFLICT", "The early reminder source version differs from the scheduling graph.", 409);
      write.fields.DueDateDeltaAlertsData = createEarlyReminder(graph.reminder, source, changes.earlyReminder, now);
      if (!guards.some(record => record.recordName === source.recordName)) guards.push(source);
    } else write.fields.DueDateDeltaAlertsData = changes.earlyReminder === null ? { type: "ENCRYPTED_BYTES", value: null } : editEarlyReminder(graph.reminder, changes.earlyReminder);
  }
  if (graph.schedulingParent) {
    live(graph.schedulingParent);
    if (!guards.some(record => record.recordName === graph.schedulingParent!.recordName)) guards.push(graph.schedulingParent);
  }
  return { dependencies, guards };
}
export function schedulingOperation(write: SchedulingWrite) {
  const { operationType, ...record } = write;
  delete record.locationRetirement;
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
