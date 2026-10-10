import { AppError } from "../errors.ts";
import { normalizeReminder } from "../icloud/cloudkit.ts";
import { jsonBytes } from "../lib/canonical.ts";
import { buildReminderFieldUpdate, type UpdateReminderInputData } from "./writes.ts";
import { linkedDatePlan, type LinkedDateWrite } from "./linked-date.ts";
import type { CloudKitRecord } from "../icloud/cloudkit.ts";
import type { SchedulingGraph } from "./linked-records.ts";
import { scheduleSummary } from "./schedule-policy.ts";

export function planReminderUpdate(graph: SchedulingGraph, input: UpdateReminderInputData, owner: string, now: number) {
  const before = normalizeReminder(graph.reminder, owner);
  if (before.completed !== false) throw new AppError("CONFLICT", "Target the open active occurrence explicitly; completed history cannot be rescheduled.", 409);
  const write = buildReminderFieldUpdate(input, graph.reminder, owner, now);
  const scheduling = ["DueDate", "TimeZone", "AllDay"].some(key => Object.hasOwn(write.fields, key));
  let dependencies: LinkedDateWrite[] = [], guards: CloudKitRecord[] = [];
  try {
    if (scheduling && graph.unsupportedReason) throw new AppError("UNSUPPORTED_FEATURE", graph.unsupportedReason);
    if (scheduling && ((before.alarmIds?.length ?? 0) || (before.recurrenceRuleIds?.length ?? 0))) {
      ({ dependencies, guards } = linkedDatePlan(graph, write, owner));
    }
  }
  catch (error) {
    if (error instanceof AppError && error.code === "UNSUPPORTED_FEATURE") return {
      supported: false as const, classification: "unverified-linked-schedule" as const,
      before: scheduleSummary(before), after: null, unsupportedReason: graph.unsupportedReason ?? error.message,
      graphFingerprint: graph.fingerprint, versions: [], operationCount: 0, requestBytes: 0, write: null,
    };
    throw error;
  }
  const after = {
    dueDate: write.fields.DueDate ? write.fields.DueDate.value === null ? null : new Date(Number(write.fields.DueDate.value)).toISOString() : before.dueDate,
    timeZone: write.fields.TimeZone ? write.fields.TimeZone.value as string | null : before.timeZone,
    allDay: write.fields.AllDay ? write.fields.AllDay.value === 1 : before.allDay,
  };
  const zoneID = { zoneName: "Reminders", zoneType: "REGULAR_CUSTOM_ZONE", ...(owner !== "__defaultOwner__" ? { ownerRecordName: owner } : {}) };
  const operations = [{ operationType: "update", record: write },
    ...dependencies.map(record => ({ operationType: "update", record })),
    ...guards.map(record => ({ operationType: "update", record: { recordName: record.recordName, recordType: record.recordType,
      recordChangeTag: record.recordChangeTag, fields: { Deleted: { type: "INT64", value: 0 } } } }))];
  const requestBytes = jsonBytes({ zoneID, atomic: true, operations });
  if (requestBytes > 65_536) throw new AppError("UNSUPPORTED_FEATURE", "The complete atomic update exceeds the request byte budget.");
  return { supported: true as const, classification: dependencies.length ? "linked-date" as const : "single-record" as const, before: scheduleSummary(before), after,
    unsupportedReason: null, graphFingerprint: graph.fingerprint,
    versions: [write, ...dependencies, ...guards].map(record => ({ id: record.recordName, recordChangeTag: record.recordChangeTag! })), operationCount: operations.length,
    requestBytes, write, dependencies, guards };
}
