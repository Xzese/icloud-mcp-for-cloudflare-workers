import { locationSummary } from "./location-alarm.ts";
import { z } from "zod";
import type { CloudKitRecord } from "../icloud/cloudkit.ts";
import { readRecurrence, type RecurrenceState } from "./recurrence.ts";
import { earlyReminderPayload } from "./early-reminder.ts";

// Recipes use explicit values rather than implicit calendar or anchor policies.
export const SchedulePolicy = z.object({}).strict();
export const scheduleSummary = (reminder: { dueDate: string | null; timeZone: string | null; allDay: boolean | null }, records: CloudKitRecord[] = [], root?: CloudKitRecord) => {
  const rule = records.find(record => record.recordType === "RecurrenceRule");
  let recurrence: RecurrenceState | null = null;
  if (rule) { try { recurrence = readRecurrence(rule); } catch { /* Unknown rules remain unclassified. */ } }
  let earlyReminder: { unit: "minutes" | "hours"; count: number } | null = null;
  if (root && Object.hasOwn(root.fields, "DueDateDeltaAlertsData")) {
    try { const alert = earlyReminderPayload(root).dueDateDeltaAlerts[0]; earlyReminder = { unit: alert.dueDateDeltaUnit === 0 ? "minutes" : "hours", count: -alert.dueDateDeltaCount }; }
    catch { /* Unknown payload contents remain private and unclassified. */ }
  }
  let locationAlarm: ReturnType<typeof locationSummary> | null = null;
  const location = records.find(record => record.recordType === "AlarmTrigger" && record.fields.Type && typeof record.fields.Type === "object" && "value" in record.fields.Type && record.fields.Type.value === "Location");
  if (location) { try { locationAlarm = locationSummary(location); } catch { /* Unknown shapes remain unsupported by the planner. */ } }
  return { locationAlarm, dueDate: reminder.dueDate, timeZone: reminder.timeZone, allDay: reminder.allDay, recurrence, earlyReminder };
};
