import { z } from "zod";
import { AppError } from "../errors.ts";
import { normalizeReminder, referenceField, type CloudKitRecord } from "../icloud/cloudkit.ts";
import type { SchedulingGraph } from "./linked-records.ts";

export const LocationAlarmChange = z.object({ proximity: z.enum(["arriving", "leaving"]) }).strict();
function field(record: CloudKitRecord, key: string, type: string): unknown {
  const value = record.fields[key];
  if (!value || typeof value !== "object" || !("type" in value) || !("value" in value) || value.type !== type) throw new AppError("UNSUPPORTED_FEATURE", `Unsupported location field ${record.recordType}.${key}.`);
  return value.value;
}
export function inspectLocationAlarms(graph: SchedulingGraph, owner: string) {
  const reminder = normalizeReminder(graph.reminder, owner);
  const alarms = graph.records.filter(record => record.recordType === "Alarm"), triggers = graph.records.filter(record => record.recordType === "AlarmTrigger");
  if (alarms.length !== (reminder.alarmIds?.length ?? 0) || triggers.length !== alarms.length || alarms.some(record => !reminder.alarmIds?.includes(record.recordName))) throw new AppError("UNSUPPORTED_FEATURE", "The complete alarm graph must contain one exact trigger per linked alarm.");
  const locations: { alarm: CloudKitRecord; trigger: CloudKitRecord; proximity: "arriving" | "leaving" }[] = [];
  for (const alarm of alarms) {
    const triggerId = field(alarm, "TriggerID", "STRING");
    const trigger = triggers.find(record => record.recordName === triggerId || record.recordName.slice(13) === triggerId);
    if (!trigger) throw new AppError("UNSUPPORTED_FEATURE", "A linked alarm trigger is missing.");
    const type = field(trigger, "Type", "STRING");
    if (type === "Date") continue;
    if (type !== "Location") throw new AppError("UNSUPPORTED_FEATURE", "This alarm uses an unsupported trigger type.");
    const alarmKeys = ["AlarmUID", "DueDateResolutionTokenAsNonce", "Reminder", "TriggerID", "Imported", "Deleted"];
    const triggerKeys = ["ReferenceFrameString", "Radius", "Type", "Proximity", "Address", "Alarm", "Imported", "Title", "Latitude", "Deleted", "Longitude", "LocationUID"];
    if (Object.keys(alarm.fields).length !== alarmKeys.length || Object.keys(alarm.fields).some(key => !alarmKeys.includes(key)) ||
      Object.keys(trigger.fields).length !== triggerKeys.length || Object.keys(trigger.fields).some(key => !triggerKeys.includes(key)) ||
      field(alarm, "AlarmUID", "STRING") !== alarm.recordName.slice(6) || field(alarm, "DueDateResolutionTokenAsNonce", "DOUBLE") !== 0 ||
      referenceField(alarm, "Reminder", "Reminder", owner) !== reminder.id || referenceField(trigger, "Alarm", "Alarm", owner) !== alarm.recordName ||
      field(trigger, "ReferenceFrameString", "STRING") !== "1" || !z.string().uuid().safeParse(field(trigger, "LocationUID", "STRING")).success) throw new AppError("UNSUPPORTED_FEATURE", "The location alarm does not match the observed bidirectional recipe.");
    for (const record of [alarm, trigger]) {
      if (!record.recordChangeTag || record.deleted || field(record, "Deleted", "INT64") !== 0) throw new AppError("CONFLICT", "A location participant changed or was deleted.", 409);
      if (field(record, "Imported", "INT64") !== 0) throw new AppError("UNSUPPORTED_FEATURE", "Imported location alarms require a different recipe.");
    }
    for (const key of ["Address", "Title"]) {
      const value = field(trigger, key, "STRING");
      if (typeof value !== "string" || new TextEncoder().encode(value).length > 8192) throw new AppError("UNSUPPORTED_FEATURE", "The location label exceeds its preservation budget.");
    }
    for (const [key, min, max] of [["Latitude", -90, 90], ["Longitude", -180, 180], ["Radius", Number.MIN_VALUE, 1_000_000]] as const) {
      const value = field(trigger, key, "DOUBLE");
      if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw new AppError("UNSUPPORTED_FEATURE", "The location coordinates or radius are invalid.");
    }
    const proximity = field(trigger, "Proximity", "INT64");
    if (proximity !== 1 && proximity !== 2) throw new AppError("UNSUPPORTED_FEATURE", "Only observed arriving/leaving location proximity is supported.");
    locations.push({ alarm, trigger, proximity: proximity === 1 ? "arriving" : "leaving" });
  }
  if (locations.length > 1 || alarms.length - locations.length > 1) throw new AppError("UNSUPPORTED_FEATURE", "Only one absolute date alarm and one location alarm are supported.");
  const ids = new Set(locations.flatMap(({ alarm, trigger }) => [alarm.recordName, trigger.recordName]));
  const dateIds = alarms.filter(record => !ids.has(record.recordName)).map(record => record.recordName.slice(6));
  const dateReminder = { ...graph.reminder, fields: { ...graph.reminder.fields, AlarmIDs: { type: dateIds.length ? "STRING_LIST" : "UNKNOWN_LIST", value: dateIds } } };
  const dateGraph = { ...graph, reminder: dateReminder, records: graph.records.filter(record => !ids.has(record.recordName)).map(record => record.recordName === graph.reminder.recordName ? dateReminder : record) };
  return { locations, dateGraph, locationRecords: graph.records.filter(record => ids.has(record.recordName)) };
}
