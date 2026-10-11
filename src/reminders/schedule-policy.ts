import { z } from "zod";
import type { CloudKitRecord } from "../icloud/cloudkit.ts";
import { earlyReminderPayload } from "./early-reminder.ts";

// Recipes use explicit values rather than implicit calendar or anchor policies.
export const SchedulePolicy = z.object({}).strict();
export const scheduleSummary = (reminder: { dueDate: string | null; timeZone: string | null; allDay: boolean | null }, records: CloudKitRecord[] = [], root?: CloudKitRecord) => {
  const rule = records.find(record => record.recordType === "RecurrenceRule");
  const fieldValue = (key: string) => {
    const field = rule?.fields[key];
    return field && typeof field === "object" && "value" in field && "type" in field && field.type === "INT64" && typeof field.value === "number" ? field.value : null;
  };
  const frequency = fieldValue("Frequency"), interval = fieldValue("Interval");
  const recurrence = rule && frequency !== null && [0, 1, 2, 3].includes(frequency) && interval !== null ? { frequency: ["daily", "weekly", "monthly", "yearly"][frequency], interval } : null;
  let earlyReminder: { unit: "minutes" | "hours"; count: number } | null = null;
  if (root && Object.hasOwn(root.fields, "DueDateDeltaAlertsData")) {
    try { const alert = earlyReminderPayload(root).dueDateDeltaAlerts[0]; earlyReminder = { unit: alert.dueDateDeltaUnit === 0 ? "minutes" : "hours", count: -alert.dueDateDeltaCount }; }
    catch { /* Unknown payload contents remain private and unclassified. */ }
  }
  let locationAlarm: { proximity: "arriving" | "leaving" } | null = null;
  const location = records.find(record => record.recordType === "AlarmTrigger" && record.fields.Type && typeof record.fields.Type === "object" && "value" in record.fields.Type && record.fields.Type.value === "Location");
  const proximity = location?.fields.Proximity;
  if (proximity && typeof proximity === "object" && "type" in proximity && proximity.type === "INT64" && "value" in proximity && (proximity.value === 1 || proximity.value === 2)) locationAlarm = { proximity: proximity.value === 1 ? "arriving" : "leaving" };
  return { locationAlarm, dueDate: reminder.dueDate, timeZone: reminder.timeZone, allDay: reminder.allDay, recurrence, earlyReminder };
};
