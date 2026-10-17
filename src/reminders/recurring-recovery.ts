import { z } from "zod";
import { AppError } from "../errors.ts";
import { canonicalJSON } from "../lib/canonical.ts";
import type { CloudKitRemindersClient, CloudKitRecord } from "../icloud/cloudkit.ts";
import { RecurringCompletionRequestSchema, type RecurringIntent } from "../persistence/apple-sessions.ts";
import { loadSchedulingGraph } from "./linked-records.ts";
import { planRecurringCompletion, verifyRecurringExpected, type RecurringCompletionPlan } from "./recurring-lifecycle.ts";

/** Reuse the original atomic operations only when every source version is identical and every created ID is definitely absent.
 * A delayed first POST and this POST contend on the same source versions and create IDs, so at most one can commit. */
export async function requireUnchangedRecurringRetry(client: Pick<CloudKitRemindersClient, "lookup" | "lookupSchedulingRecords">,
  intent: RecurringIntent, plan: RecurringCompletionPlan) {
  const refuse = () => new AppError("CONFLICT", "The original occurrence cannot be retried: its exact source or retained identities changed, or creation absence is unproven. Inspect the reminder; do not use a new version or operation identity.", 409);
  if (intent.phase !== "dispatched" || intent.operation || intent.mode !== undefined || plan.mode !== "advance" || intent.sourceFingerprint !== plan.sourceFingerprint ||
    canonicalJSON(intent.expected) !== canonicalJSON(plan.expected) || canonicalJSON(intent.retired) !== canonicalJSON(plan.retired) ||
    canonicalJSON(intent.ids) !== canonicalJSON(plan.ids) || intent.timestamp !== plan.timestamp ||
    intent.intrinsicParentGuards !== plan.intrinsicParentGuards || intent.recurrenceCalendarTimeZone !== plan.recurrenceCalendarTimeZone) throw refuse();
  const created = plan.operations.filter(operation => operation.operationType === "create").map(operation => operation.record);
  for (const records of [created.filter(record => record.recordType === "Reminder"), created.filter(record => record.recordType !== "Reminder")]) {
    if (!records.length) continue;
    const ids = records.map(record => record.recordName);
    const found = records[0].recordType === "Reminder" ? await client.lookup(ids) : await client.lookupSchedulingRecords(ids);
    if (found.records.length || found.unresolvedRecordNames.length || found.recordErrors.length !== ids.length ||
      new Set(found.recordErrors.map(error => error.recordName)).size !== ids.length ||
      found.recordErrors.some(error => !error.recordName || !ids.includes(error.recordName) || !["UNKNOWN_ITEM", "NOT_FOUND"].includes(error.serverErrorCode))) throw refuse();
  }
}

export const RecurringRecoveryOutput = z.object({
  originalRequest: RecurringCompletionRequestSchema.optional(),
  phase: z.enum(["prepared", "dispatched"]),
  attemptedAt: z.number().int().nonnegative().safe(),
  outcome: z.enum(["confirmed", "unresolved"]),
  sourceUnchanged: z.boolean(),
  missingExpectedIds: z.array(z.string()).max(8),
  changedExpectedIds: z.array(z.string()).max(8),
  unresolvedIds: z.array(z.string()).max(10),
  retiredIdsStillPresent: z.array(z.string()).max(2),
}).strict();

/** Diagnose an existing intent using exact reads only; never allocates or dispatches a write. */
export async function inspectRecurringRecovery(client: Pick<CloudKitRemindersClient, "lookup" | "lookupSchedulingRecords">,
  intent: RecurringIntent, current: CloudKitRecord, list: CloudKitRecord, owner: string) {
  const result = RecurringRecoveryOutput.parse({ phase: intent.phase, attemptedAt: intent.timestamp, outcome: "unresolved", sourceUnchanged: false,
    missingExpectedIds: [], changedExpectedIds: [], unresolvedIds: [], retiredIdsStillPresent: [],
    ...(intent.completionRequest ? { originalRequest: intent.completionRequest } : {}) });
  const ordinary = intent.expected.filter(item => ["Reminder", "List"].includes(item.type)).map(item => item.id);
  const linked = intent.expected.filter(item => !["Reminder", "List"].includes(item.type)).map(item => item.id);
  const pages = [await client.lookup(ordinary), await client.lookupSchedulingRecords(linked)];
  const found = pages.flatMap(page => page.records);
  for (const expected of intent.expected) {
    const records = found.filter(record => record.recordName === expected.id);
    if (!records.length) {
      const errors = pages.flatMap(page => page.recordErrors).filter(error => error.recordName === expected.id);
      if (errors.length === 1 && ["UNKNOWN_ITEM", "NOT_FOUND"].includes(errors[0].serverErrorCode)) result.missingExpectedIds.push(expected.id);
      else result.unresolvedIds.push(expected.id);
    } else {
      try { await verifyRecurringExpected([expected], records, owner, intent.intrinsicParentGuards); }
      catch { result.changedExpectedIds.push(expected.id); }
    }
  }
  if (intent.retired.length) {
    const retired = await client.lookupSchedulingRecords(intent.retired);
    for (const id of intent.retired) {
      if (retired.records.some(record => record.recordName === id)) result.retiredIdsStillPresent.push(id);
      else if (retired.recordErrors.filter(error => error.recordName === id && ["UNKNOWN_ITEM", "NOT_FOUND"].includes(error.serverErrorCode)).length !== 1)
        result.unresolvedIds.push(id);
    }
  }
  if (pages.every(page => page.complete) && !result.missingExpectedIds.length && !result.changedExpectedIds.length &&
    !result.unresolvedIds.length && !result.retiredIdsStillPresent.length) result.outcome = "confirmed";
  try {
    const graph = await loadSchedulingGraph({ ...current, zoneID: current.zoneID ?? { zoneName: "Reminders", ownerRecordName: owner } }, owner,
      ids => client.lookupSchedulingRecords(ids));
    const plan = await planRecurringCompletion(graph, list, owner, intent.ids, intent.timestamp, intent.mode === "reopen" ? "reopen" : "complete", intent.recurrenceCalendarTimeZone);
    result.sourceUnchanged = plan.sourceFingerprint === intent.sourceFingerprint;
  } catch { /* A failed source proof is never permission to retry. */ }
  return result;
}
