import { AppError } from "../errors.ts";
import { normalizeReminder } from "../icloud/cloudkit.ts";
import { jsonBytes } from "../lib/canonical.ts";
import { buildReminderFieldUpdate, type UpdateReminderInputData } from "./writes.ts";
import { schedulingOperation, schedulingPlan, type SchedulingWrite } from "./scheduling-plan.ts";
import type { CloudKitRecord } from "../icloud/cloudkit.ts";
import type { SchedulingGraph } from "./linked-records.ts";
import { scheduleSummary } from "./schedule-policy.ts";

export function planReminderUpdate(graph: SchedulingGraph, input: UpdateReminderInputData, owner: string, now: number) {
  const before = normalizeReminder(graph.reminder, owner);
  if (before.completed !== false) throw new AppError("CONFLICT", "Target the open active occurrence explicitly; completed history cannot be rescheduled.", 409);
  const beforeSummary = scheduleSummary(before, graph.records, graph.reminder);
  const write = buildReminderFieldUpdate(input, graph.reminder, owner, now);
  const scheduling = input.changes.locationAlarm !== undefined || input.changes.earlyReminder !== undefined || input.changes.recurrence !== undefined || ["DueDate", "TimeZone", "AllDay"].some(key => Object.hasOwn(write.fields, key));
  let dependencies: SchedulingWrite[] = [], guards: CloudKitRecord[] = [];
  try {
    if (scheduling && graph.unsupportedReason) throw new AppError("UNSUPPORTED_FEATURE", graph.unsupportedReason);
    if (scheduling && (input.changes.locationAlarm !== undefined || input.changes.earlyReminder !== undefined || input.changes.recurrence || before.parentReminderId || (before.alarmIds?.length ?? 0) || (before.recurrenceRuleIds?.length ?? 0) || before.allDay === true || input.changes.allDay === true)) {
      ({ dependencies, guards } = schedulingPlan(graph, write, input, owner, now));
    }
  }
  catch (error) {
    if (error instanceof AppError && error.code === "UNSUPPORTED_FEATURE") return {
      supported: false as const, classification: "unverified-linked-schedule" as const,
      before: beforeSummary, after: null, unsupportedReason: graph.unsupportedReason ?? error.message,
      graphFingerprint: graph.fingerprint, versions: [], operationCount: 0, requestBytes: 0, write: null,
    };
    throw error;
  }
  const after = {
    dueDate: write.fields.DueDate ? write.fields.DueDate.value === null ? null : new Date(Number(write.fields.DueDate.value)).toISOString() : before.dueDate,
    timeZone: write.fields.TimeZone ? write.fields.TimeZone.value as string | null : before.timeZone,
    allDay: write.fields.AllDay ? write.fields.AllDay.value === 1 : before.allDay,
    recurrence: input.changes.dueDate === null && dependencies.some(record => record.recordType === "RecurrenceRule") ? null : input.changes.recurrence ?? beforeSummary.recurrence,
    locationAlarm: input.changes.locationAlarm ?? beforeSummary.locationAlarm,
    earlyReminder: input.changes.earlyReminder !== undefined ? input.changes.earlyReminder : beforeSummary.earlyReminder,
  };
  const zoneID = { zoneName: "Reminders", zoneType: "REGULAR_CUSTOM_ZONE", ...(owner !== "__defaultOwner__" ? { ownerRecordName: owner } : {}) };
  const operations = [{ operationType: "update", record: write },
    ...dependencies.map(schedulingOperation),
    ...guards.map(record => ({ operationType: "update", record: { recordName: record.recordName, recordType: record.recordType,
      recordChangeTag: record.recordChangeTag, fields: { Deleted: { type: "INT64", value: 0 } } } }))];
  const requestBytes = jsonBytes({ zoneID, atomic: true, operations });
  if (requestBytes > 65_536 || operations.length > 32) throw new AppError("UNSUPPORTED_FEATURE", "The complete atomic update exceeds its record or request byte budget.");
  return { supported: true as const, classification: dependencies.length || guards.length ? "linked-date" as const : "single-record" as const, before: beforeSummary, after,
    unsupportedReason: null, graphFingerprint: graph.fingerprint,
    versions: [write, ...dependencies, ...guards].filter(record => record.recordChangeTag).map(record => ({ id: record.recordName, recordChangeTag: record.recordChangeTag! })), operationCount: operations.length,
    requestBytes, write, dependencies, guards };
}
