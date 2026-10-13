import { z } from "zod";
import { AppError } from "../errors.ts";
import { normalizeReminder, type CloudKitRecord } from "../icloud/cloudkit.ts";
import { BulkUpdateInput, type BulkChangeItemData } from "../jobs/schemas.ts";
import { decodeDocument } from "./crdt.ts";
import { planReminderUpdate } from "./mutation-plan.ts";
import { assertOwnedReminder, buildLifecycleReminder, type CloudKitWriteRecord } from "./writes.ts";

/** Bulk manifests authorize one ordinary root, never an implicit family or linked schedule. */
export function requireBulkChangeTarget(current: CloudKitRecord, owner: string): void {
  assertOwnedReminder(current, owner);
  const reminder = normalizeReminder(current, owner);
  const early = current.fields.DueDateDeltaAlertsData as { type?: unknown; value?: unknown } | undefined;
  if (reminder.parentReminderId || reminder.startDate || reminder.alarmIds?.length || reminder.recurrenceRuleIds?.length ||
    Object.hasOwn(current.fields, "DueDateDeltaAlertsData") && !(early?.type === "ENCRYPTED_BYTES" && early.value === null) ||
    Object.keys(current.fields).some(key => /parent|child|subtask/i.test(key) && key !== "ParentReminder")) {
    throw new AppError("UNSUPPORTED_FEATURE", "Bulk updates and completion require an ordinary childless root without recurrence, alarms, early reminders, start dates or unknown family relationships.");
  }
}

export function planBulkChange(item: BulkChangeItemData, current: CloudKitRecord, owner: string, now = Date.now()): CloudKitWriteRecord {
  requireBulkChangeTarget(current, owner);
  if (item.kind === "bulk_complete") return buildLifecycleReminder("complete", item.input, current, owner, now);
  const input = BulkUpdateInput.parse(item.input);
  const plan = planReminderUpdate({ reminder: current, records: [current], edges: [], complete: true,
    unsupportedReason: null, fingerprint: "" }, input, owner, now);
  if (!plan.supported) throw new AppError("UNSUPPORTED_FEATURE", plan.unsupportedReason);
  if (plan.dependencies.length || plan.guards.length || plan.write.fields.RecurrenceRuleIDs || plan.write.fields.DueDateDeltaAlertsData || plan.write.fields.AlarmIDs) {
    throw new AppError("UNSUPPORTED_FEATURE", "This date transition changes linked scheduling fields. Prepare and review it individually with prepare_reminder_update.");
  }
  return plan.write;
}

const StoredWrite = z.object({
  recordName: z.string(), recordType: z.literal("Reminder"), recordChangeTag: z.string(),
  fields: z.record(z.object({ type: z.string(), value: z.unknown() }).strict()),
}).strict();

/** Observation is not a receipt: compare the persisted plan, including implicit calendar changes. */
export function observeBulkChange(item: BulkChangeItemData, value: unknown, current: CloudKitRecord | null, owner: string): boolean {
  const parsed = StoredWrite.safeParse(value);
  if (!parsed.success || parsed.data.recordName !== item.input.reminderId || parsed.data.recordChangeTag !== item.input.recordChangeTag) {
    throw new AppError("PROTOCOL_CHANGED", "The saved job mutation does not match this exact approved reminder version.");
  }
  const fields = parsed.data.fields;
  const contentKeys = item.kind === "bulk_complete" ? ["Completed", "CompletionDate"] :
    ["TitleDocument", "NotesDocument", "Priority", "Flagged", "DueDate", "TimeZone", "AllDay"];
  if (Object.keys(fields).some(key => ![...contentKeys, "LastModifiedDate", "ResolutionTokenMap"].includes(key)) ||
    !contentKeys.some(key => Object.hasOwn(fields, key)) ||
    item.kind === "bulk_complete" && (fields.Completed?.value !== 1 || !Object.hasOwn(fields, "CompletionDate"))) {
    throw new AppError("PROTOCOL_CHANGED", "The saved job mutation has an unsupported field set.");
  }
  if (!current || current.deleted) return false;
  assertOwnedReminder(current, owner);
  const reminder = normalizeReminder(current, owner, true);
  if (reminder.id !== item.input.reminderId || reminder.listId !== item.input.listId || reminder.deleted !== false ||
    reminder.parentReminderId !== null || reminder.completed !== (item.kind === "bulk_complete")) return false;
  const observed: Record<string, { type: string; value: unknown }> = {
    Priority: { type: "INT64", value: reminder.priority }, Flagged: { type: "INT64", value: reminder.flagged === null ? null : Number(reminder.flagged) },
    AllDay: { type: "INT64", value: reminder.allDay === null ? null : Number(reminder.allDay) },
    DueDate: { type: "TIMESTAMP", value: reminder.dueDate === null ? null : Date.parse(reminder.dueDate) },
    TimeZone: { type: "STRING", value: reminder.timeZone },
    Completed: { type: "INT64", value: reminder.completed === null ? null : Number(reminder.completed) },
    CompletionDate: { type: "TIMESTAMP", value: reminder.completedDate === null ? null : Date.parse(reminder.completedDate) },
  };
  for (const key of contentKeys) {
    const expected = fields[key];
    if (!expected) continue;
    if (key === "TitleDocument" || key === "NotesDocument") {
      if (expected.type !== "STRING" || typeof expected.value !== "string" || decodeDocument(expected.value).text !== (key === "TitleDocument" ? reminder.title : reminder.notes)) return false;
    } else if (expected.type !== observed[key].type || expected.value !== observed[key].value) return false;
  }
  return true;
}
