import { AppError } from "../errors.ts";
import { intrinsicParentIdentity, normalizeList, normalizeReminder, type CloudKitRecord, type CloudKitRemindersClient } from "../icloud/cloudkit.ts";
import type { ListWrite } from "./list-writes.ts";
import { canonicalJSON } from "../lib/canonical.ts";
import { stableNativePresentation } from "../lib/native-presentation.ts";
import { inspectListChildren, requireNoReadErrors } from "./subtasks.ts";
import { assertOwnedReminder, ReminderTargetInput, buildLifecycleReminder, updateResolutionTokenMap, type CloudKitWriteRecord, type ReminderTargetInputData } from "./writes.ts";

export interface LifecyclePlan {
  writes: CloudKitWriteRecord[];
  records: CloudKitRecord[];
  guards: CloudKitRecord[];
  listWrite?: ListWrite;
}

function ordinary(record: CloudKitRecord, owner: string, listId: string, requireCompletionDate = true, allowAlarms = false) {
  assertOwnedReminder(record, owner);
  const reminder = normalizeReminder(record, owner, true);
  if (record.deleted || reminder.deleted !== false || reminder.completed === null || !record.recordChangeTag) {
    throw new AppError("CONFLICT", "The complete live family and its exact versions could not be established.", 409);
  }
  if (reminder.listId !== listId) throw new AppError("FORBIDDEN", "Lifecycle families cannot cross lists.", 403);
  if ((!allowAlarms && (reminder.alarmIds?.length ?? 0)) || (reminder.recurrenceRuleIds?.length ?? 0) ||
    Object.keys(record.fields).some(field => /parent|child|subtask/i.test(field) && field !== "ParentReminder")) {
    throw new AppError("UNSUPPORTED_FEATURE", "Lifecycle families require ordinary nonrecurring, unalarmed reminders without unknown relationship fields.");
  }
  if (requireCompletionDate && reminder.completed !== (reminder.completedDate !== null)) {
    throw new AppError("PROTOCOL_CHANGED", "The family contains an inconsistent completion timestamp.");
  }
  return reminder;
}

export interface LifecycleFamily { records: CloudKitRecord[]; rootId: string; }

/** Complete bounded discovery shared by separately validated lifecycle recipes. */
export async function inspectLifecycleFamily(client: Pick<CloudKitRemindersClient, "lookup" | "queryRemindersPage">,
  action: "complete" | "reopen" | "delete", input: ReminderTargetInputData, current: CloudKitRecord, list: CloudKitRecord, owner: string, allowAlarms = false): Promise<LifecycleFamily> {
  input = ReminderTargetInput.parse(input);
  const target = ordinary(current, owner, input.listId, action !== "delete", allowAlarms);
  if (current.recordName !== input.reminderId || current.recordChangeTag !== input.recordChangeTag ||
    action !== "delete" && target.completed !== (action === "reopen")) throw new AppError("CONFLICT", "The lifecycle target changed before family inspection.", 409);
  if (list.recordName !== input.listId) throw new AppError("FORBIDDEN", "The family must use the exact selected List.", 403);
  const relationships = await inspectListChildren(client, owner, list);
  const rootId = target.parentReminderId ?? current.recordName;
  const childIds = relationships.get(rootId) ?? [];
  if (childIds.includes(rootId) || target.parentReminderId && !childIds.includes(current.recordName) ||
    childIds.some(id => relationships.has(id))) {
    throw new AppError("UNSUPPORTED_FEATURE", "The family is cyclic, incomplete or nested beyond one level.");
  }
  const ids = [rootId, ...childIds];
  if (ids.length + 1 > 32) throw new AppError("UNSUPPORTED_FEATURE", "The whole family and List guard exceed the atomic record budget.");
  const found = await client.lookup(ids);
  requireNoReadErrors(found.recordErrors);
  if (!found.complete || found.unresolvedRecordNames.length || found.records.length !== ids.length ||
    new Set(found.records.map(record => record.recordName)).size !== ids.length ||
    found.records.some(record => !("recordType" in record) || record.recordType !== "Reminder" || !ids.includes(record.recordName))) {
    throw new AppError("CONFLICT", "Every family member must resolve by exact identity before dispatch.", 409);
  }
  const records = ids.map(id => {
    const record = found.records.find(record => record.recordName === id)! as CloudKitRecord;
    const reminder = ordinary(record, owner, input.listId, action !== "delete", allowAlarms);
    if (reminder.parentReminderId !== (id === rootId ? null : rootId)) {
      throw new AppError("CONFLICT", "The inspected family relationship changed or is nested; no mutation was dispatched.", 409);
    }
    return { ...record, zoneID: record.zoneID ?? { zoneName: "Reminders", ownerRecordName: owner } };
  });
  const exactTarget = records.find(record => record.recordName === input.reminderId)!;
  if (exactTarget.recordChangeTag !== input.recordChangeTag || canonicalJSON(stableNativePresentation(current.fields)) !== canonicalJSON(stableNativePresentation(exactTarget.fields)) ||
    intrinsicParentIdentity(current, owner) !== intrinsicParentIdentity(exactTarget, owner)) {
    throw new AppError("CONFLICT", "The target fields changed during family inspection; no mutation was dispatched.", 409);
  }
  return { records, rootId };
}

/** Native one-level completion semantics. Inspection never splits an oversized atomic family. */
export async function planLifecycle(client: Pick<CloudKitRemindersClient, "lookup" | "queryRemindersPage">,
  action: "complete" | "reopen" | "delete", input: ReminderTargetInputData, current: CloudKitRecord, list: CloudKitRecord,
  owner: string, now = Date.now(), inspected?: LifecycleFamily): Promise<LifecyclePlan> {
  const { records } = inspected ?? await inspectLifecycleFamily(client, action, input, current, list, owner);
  records.forEach(record => ordinary(record, owner, input.listId, action !== "delete"));
  const exactTarget = records.find(record => record.recordName === input.reminderId)!;
  const target = normalizeReminder(exactTarget, owner);
  const writes = [buildLifecycleReminder(action, input, exactTarget, owner, now, true)];
  if (action === "delete" && target.parentReminderId) {
    const root = records[0];
    writes.push({ recordName: root.recordName, recordType: "Reminder", recordChangeTag: root.recordChangeTag, fields: {
      LastModifiedDate: { type: "TIMESTAMP", value: now },
      ResolutionTokenMap: { type: "STRING", value: updateResolutionTokenMap(root, ["lastModifiedDate"], now) },
    } });
  } else if (!target.parentReminderId) {
    const completionDate = normalizeReminder(exactTarget, owner).completedDate;
    for (const child of records.slice(1)) {
      if (action === "delete") {
        writes.push({ recordName: child.recordName, recordType: "Reminder", recordChangeTag: child.recordChangeTag,
          fields: { Deleted: { type: "INT64", value: 1 } } });
        continue;
      }
      const reminder = normalizeReminder(child, owner);
      if (action === "complete" ? reminder.completed === false : reminder.completed === true && reminder.completedDate === completionDate) {
        writes.push(buildLifecycleReminder(action, { listId: input.listId, reminderId: child.recordName, recordChangeTag: child.recordChangeTag! }, child, owner, now, true));
      }
    }
  }
  let listWrite: ListWrite | undefined;
  if (action === "delete") {
    const membership = normalizeList(list).reminderIds;
    if (membership === null || new Set(membership).size !== membership.length) throw new AppError("UNSUPPORTED_FEATURE", "Native deletion requires complete, unambiguous List membership.");
    if (membership.includes(input.reminderId)) {
      const raw = JSON.parse(String((list.fields.ReminderIDs as { value: string }).value)) as string[];
      listWrite = { recordName: list.recordName, recordType: "List", recordChangeTag: list.recordChangeTag, fields: {
        ReminderIDs: { type: "STRING", value: JSON.stringify(raw.filter((_, index) => membership[index] !== input.reminderId)) },
        ResolutionTokenMap: { type: "STRING", value: updateResolutionTokenMap(list, ["reminderIDsMergeableOrdering"], now) },
      } };
    }
  }
  return { writes, records, guards: [
    ...records.filter(record => !writes.some(write => write.recordName === record.recordName)),
    ...(!listWrite ? [{ ...list, zoneID: list.zoneID ?? { zoneName: "Reminders", ownerRecordName: owner } }] : []),
  ], listWrite };
}
