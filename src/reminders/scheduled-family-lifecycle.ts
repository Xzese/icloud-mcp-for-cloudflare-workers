import { AppError } from "../errors.ts";
import { normalizeList, normalizeReminder, type CloudKitRecord, type CloudKitRemindersClient, isKnownEmptyDeletionCollection } from "../icloud/cloudkit.ts";
import { jsonBytes } from "../lib/canonical.ts";
import type { LifecycleFamily } from "./lifecycle.ts";
import { validateAbsoluteDatePair, validateDateAlarmParticipant, dateAlarmLifecycleResolution, type DateAlarmLifecyclePlan } from "./date-alarm-lifecycle.ts";
import { assertOwnedReminder, ReminderTargetInput, type ReminderTargetInputData, type CloudKitWriteRecord } from "./writes.ts";

type Action = "complete" | "reopen" | "delete";
export interface ScheduledFamilyLifecyclePlan {
  action: Action; input: ReminderTargetInputData; family: LifecycleFamily; pairs: CloudKitRecord[]; list: CloudKitRecord; timestamp: number;
  replicas: Record<string, Record<string, string>>;
  writes: CloudKitWriteRecord[];
  operations: DateAlarmLifecyclePlan["operations"];
  expected: CloudKitRecord[];
}
const field = (record: CloudKitRecord, key: string) => (record.fields[key] as { value?: unknown } | undefined)?.value;

function member(record: CloudKitRecord, family: LifecycleFamily, listId: string, owner: string) {
  assertOwnedReminder(record, owner); validateDateAlarmParticipant(record, owner);
  const reminder = normalizeReminder(record, owner, true);
  if (reminder.listId !== listId) throw new AppError("FORBIDDEN", "Scheduled lifecycle families cannot cross Lists.", 403);
  if (reminder.completed === null || reminder.completed !== (reminder.completedDate !== null) ||
    reminder.parentReminderId !== (record.recordName === family.rootId ? null : family.rootId) ||
    (reminder.recurrenceRuleIds?.length ?? 0) || (reminder.alarmIds?.length ?? 0) > 1 || reminder.startDate !== null ||
    reminder.alarmIds?.length && !/^[A-Za-z][A-Za-z0-9._+-]*(?:\/[A-Za-z0-9._+-]+)*$/.test(reminder.timeZone ?? "") ||
    (reminder.attachmentIds?.length ?? 0) || (reminder.hashtagIds?.length ?? 0) ||
    Object.hasOwn(record.fields, "AssignmentIDs") && !isKnownEmptyDeletionCollection("AssignmentIDs", record.fields.AssignmentIDs) ||
    Object.hasOwn(record.fields, "DueDateDeltaAlertsData") && (field(record, "DueDateDeltaAlertsData") !== null || (record.fields.DueDateDeltaAlertsData as { type?: unknown }).type !== "BYTES") ||
    Object.keys(record.fields).some(key => /parent|child|subtask/i.test(key) && key !== "ParentReminder") ||
    Object.entries(record.fields).some(([key, raw]) => { const wrapper = raw as { type?: unknown; value?: unknown } | undefined;
      return wrapper?.value != null && (wrapper.type === "REFERENCE" && !["List", "ParentReminder"].includes(key) ||
        ["STRING_LIST", "UNKNOWN_LIST"].includes(String(wrapper.type)) && Array.isArray(wrapper.value) && wrapper.value.length > 0 && key !== "AlarmIDs"); }))
    throw new AppError("UNSUPPORTED_FEATURE", "Scheduled lifecycle requires one-level ordinary members without recurrence, early/location alarms, assignments, tags or attachments.");
  return reminder;
}

/** Resolve every exact pair after complete discovery; no inferred or parentless member snapshots. */
export async function loadScheduledFamilyPairs(client: Pick<CloudKitRemindersClient, "lookupSchedulingRecords">, family: LifecycleFamily, owner: string) {
  const alarmIds = family.records.flatMap(record => normalizeReminder(record, owner).alarmIds ?? []);
  if (!alarmIds.length || new Set(alarmIds).size !== alarmIds.length || family.records.length + 2 * alarmIds.length + 1 > 32)
    throw new AppError("UNSUPPORTED_FEATURE", "The whole scheduled family must fit one atomic record group.");
  const exact = async (ids: string[], type: string) => {
    const found = await client.lookupSchedulingRecords(ids);
    if (!found.complete || found.recordErrors.length || found.unresolvedRecordNames.length || found.records.length !== ids.length ||
      new Set(found.records.map(record => record.recordName)).size !== ids.length || found.records.some(record => !("recordType" in record) || record.recordType !== type || !ids.includes(record.recordName)))
      throw new AppError("CONFLICT", "Every scheduled family participant must resolve by exact identity before dispatch.", 409);
    return found.records.map(record => ({ ...record as CloudKitRecord, zoneID: (record as CloudKitRecord).zoneID ?? { zoneName: "Reminders", ownerRecordName: owner } }));
  };
  const alarms = await exact(alarmIds, "Alarm");
  const triggerIds = alarms.map(alarm => {
    const wrapper = alarm.fields.TriggerID as { type?: unknown; value?: unknown } | undefined;
    if (wrapper?.type !== "STRING" || typeof wrapper.value !== "string" || !/^(?:AlarmTrigger\/)?[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(wrapper.value))
      throw new AppError("UNSUPPORTED_FEATURE", "A scheduled family alarm has an unknown trigger identity.");
    return wrapper.value.startsWith("AlarmTrigger/") ? wrapper.value : `AlarmTrigger/${wrapper.value}`;
  });
  if (new Set(triggerIds).size !== triggerIds.length) throw new AppError("UNSUPPORTED_FEATURE", "Scheduled family date pairs cannot share trigger identities.");
  return [...alarms, ...await exact(triggerIds, "AlarmTrigger")];
}

/** Strict composite native recipe rebuilt from its original exact family and pair snapshots. */
export function planScheduledFamilyLifecycle(action: Action, input: ReminderTargetInputData, family: LifecycleFamily, pairs: CloudKitRecord[], sourceList: CloudKitRecord,
  owner: string, timestamp = Date.now(), retainedReplicas?: ScheduledFamilyLifecyclePlan["replicas"]): ScheduledFamilyLifecyclePlan {
  input = ReminderTargetInput.parse(input);
  const list = sourceList.zoneID === undefined ? { ...sourceList, zoneID: { zoneName: "Reminders", zoneType: "REGULAR_CUSTOM_ZONE", ownerRecordName: owner } } : sourceList;
  validateDateAlarmParticipant(list, owner);
  if (list.recordName !== input.listId || list.recordType !== "List" || normalizeList(list, false).deleted !== false || normalizeList(list, false).isGroup !== false ||
    !family.records.length || family.records[0].recordName !== family.rootId || new Set(family.records.map(record => record.recordName)).size !== family.records.length)
    throw new AppError("UNSUPPORTED_FEATURE", "The exact one-level scheduled family and live standard List are required.");
  const target = family.records.find(record => record.recordName === input.reminderId);
  if (!target || target.recordChangeTag !== input.recordChangeTag || !Number.isSafeInteger(timestamp) || timestamp < 0)
    throw new AppError("CONFLICT", "The scheduled lifecycle target or timestamp changed before dispatch.", 409);
  const reminders = family.records.map(record => member(record, family, input.listId, owner));
  const selected = reminders.find(reminder => reminder.id === input.reminderId)!;
  if (action !== "delete" && selected.completed !== (action === "reopen")) throw new AppError("CONFLICT", "The scheduled target no longer has the required completion state.", 409);
  const matchedPairs: CloudKitRecord[] = [];
  const pairOwners = new Map<string, string>();
  for (const [index, reminder] of reminders.entries()) if (reminder.alarmIds?.length) {
    const alarm = pairs.find(record => record.recordName === reminder.alarmIds![0]);
    const triggerId = alarm && field(alarm, "TriggerID");
    const trigger = pairs.find(record => record.recordName === (typeof triggerId === "string" && triggerId.startsWith("AlarmTrigger/") ? triggerId : `AlarmTrigger/${triggerId}`));
    if (!alarm || !trigger) throw new AppError("CONFLICT", "The complete member date pair is missing.", 409);
    const pair = validateAbsoluteDatePair(family.records[index], [alarm, trigger], owner);
    pair.forEach(record => pairOwners.set(record.recordName, reminder.id)); matchedPairs.push(...pair);
  }
  const snapshots = [...family.records, ...matchedPairs, list];
  if (!matchedPairs.length || matchedPairs.length !== pairs.length || new Set(snapshots.map(record => record.recordName)).size !== snapshots.length || snapshots.length > 32 ||
    jsonBytes(snapshots.map(record => ({ id: record.recordName, version: record.recordChangeTag, fields: record.fields, parent: record.raw.parent }))) > 262_144)
    throw new AppError("UNSUPPORTED_FEATURE", "The complete scheduled family exceeds its unique-record or inspection byte budget.");
  const replicas = structuredClone(retainedReplicas ?? {});
  const writes: CloudKitWriteRecord[] = [];
  const changed = [target, ...(action === "delete" && selected.parentReminderId ? [family.records[0]] : !selected.parentReminderId ? family.records.filter(record => {
    if (record === target) return false;
    const reminder = normalizeReminder(record, owner);
    return action === "delete" || (action === "complete" ? reminder.completed === false : reminder.completed === true && reminder.completedDate === selected.completedDate);
  }) : [])];
  for (const record of changed) {
    let fields: CloudKitWriteRecord["fields"];
    if (action === "delete" && record !== target && !selected.parentReminderId) fields = { Deleted: { type: "INT64", value: 1 } };
    else {
      fields = { LastModifiedDate: { type: "TIMESTAMP", value: timestamp } };
      const tokens = ["lastModifiedDate"];
      if (action === "delete" && record === target) {
        fields.Deleted = { type: "INT64", value: 1 }; fields.List = { type: "REFERENCE", value: null }; tokens.push("list");
        if (selected.parentReminderId) { fields.ParentReminder = { type: "REFERENCE", value: null }; tokens.push("parentReminder"); }
      }
      else if (action !== "delete") { fields.Completed = { type: "INT64", value: action === "complete" ? 1 : 0 }; fields.CompletionDate = { type: "TIMESTAMP", value: action === "complete" ? timestamp : null }; tokens.push("completed", "completionDate"); }
      for (const key of [...Object.keys(fields), "ResolutionTokenMap"]) {
        const wrapper = record.fields[key];
        if (wrapper && (typeof wrapper !== "object" || Array.isArray(wrapper) || Object.keys(wrapper).some(key => !["type", "value"].includes(key))))
          throw new AppError("UNSUPPORTED_FEATURE", "The scheduled lifecycle cannot discard unknown changed-field metadata.");
      }
      replicas[record.recordName] ??= {};
      fields.ResolutionTokenMap = { type: "STRING", value: dateAlarmLifecycleResolution(record, tokens, timestamp, replicas[record.recordName]) };
    }
    writes.push({ recordName: record.recordName, recordType: "Reminder", recordChangeTag: record.recordChangeTag, fields, ...(action === "delete" && record === target ? { parent: null } : {}) });
  }
  const operations: ScheduledFamilyLifecyclePlan["operations"] = snapshots.map(record => {
    const write = writes.find(write => write.recordName === record.recordName);
    return { operationType: "update", record: write ? { ...write, parent: write.parent === null ? { recordName: null } : undefined } : {
      recordName: record.recordName, recordType: record.recordType, recordChangeTag: record.recordChangeTag,
      fields: { Deleted: { type: "INT64", value: action === "delete" && pairOwners.has(record.recordName) && (!selected.parentReminderId || pairOwners.get(record.recordName) === target.recordName) ? 1 : 0 } },
    } };
  });
  // Place the approved target first so all uncertain-outcome errors identify it.
  operations.sort((a, b) => a.record.recordName === target.recordName ? -1 : b.record.recordName === target.recordName ? 1 : 0);
  if (action === "delete") {
    const members = normalizeList(list).reminderIds;
    if (!members || new Set(members).size !== members.length) throw new AppError("UNSUPPORTED_FEATURE", "Scheduled deletion requires complete unambiguous List membership.");
    if (members.includes(target.recordName)) {
      for (const key of ["ReminderIDs", "ResolutionTokenMap"]) {
        const wrapper = list.fields[key];
        if (!wrapper || typeof wrapper !== "object" || Array.isArray(wrapper) || Object.keys(wrapper).some(key => !["type", "value"].includes(key)))
          throw new AppError("UNSUPPORTED_FEATURE", "The scheduled deletion cannot discard unknown List membership/token metadata.");
      }
      replicas[list.recordName] ??= {};
      const listOperation = operations.find(operation => operation.record.recordName === list.recordName)!;
      listOperation.record.fields = {
        ReminderIDs: { type: "STRING", value: JSON.stringify((JSON.parse(String(field(list, "ReminderIDs"))) as string[]).filter((_, index) => members[index] !== target.recordName)) },
        ResolutionTokenMap: { type: "STRING", value: dateAlarmLifecycleResolution(list, ["reminderIDsMergeableOrdering"], timestamp, replicas[list.recordName]) },
      };
    }
  }
  if (Object.keys(replicas).some(id => !writes.some(write => write.recordName === id) && id !== list.recordName) ||
    jsonBytes({ zoneID: { zoneName: "Reminders", zoneType: "REGULAR_CUSTOM_ZONE", ownerRecordName: owner }, atomic: true, operations }) > 65_536)
    throw new AppError("UNSUPPORTED_FEATURE", "The whole scheduled lifecycle exceeds its atomic request budget or retained token scope.");
  const expected = operations.map(operation => {
    const before = snapshots.find(record => record.recordName === operation.record.recordName)!;
    return { ...before, fields: { ...before.fields, ...operation.record.fields }, raw: operation.record.parent ? { ...before.raw, parent: null } : before.raw };
  });
  return { action, input, family, pairs, list, timestamp, replicas, writes, operations, expected };
}
