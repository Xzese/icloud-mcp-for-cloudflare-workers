import { AppError, WriteOutcomeUnknownError } from "../errors.ts";
import { canonicalJSON, jsonBytes } from "../lib/canonical.ts";
import { stableNativePresentation } from "../lib/native-presentation.ts";
import { intrinsicParentIdentity, isKnownEmptyDeletionCollection, normalizeList, normalizeReminder, referenceField, type CloudKitRecord } from "../icloud/cloudkit.ts";
import { dateComponents, decodeDateComponents, dueDateNonce } from "./linked-date.ts";
import type { SchedulingGraph } from "./linked-records.ts";
import { assertOwnedReminder, ReminderTargetInput, updateResolutionTokenMap, type CloudKitWriteRecord, type ReminderTargetInputData } from "./writes.ts";
import type { ListWrite } from "./list-writes.ts";

type Fields = CloudKitWriteRecord["fields"];
type Action = "complete" | "reopen" | "delete";
export interface DateAlarmLifecyclePlan {
  action: Action; input: ReminderTargetInputData; graph: SchedulingGraph; list: CloudKitRecord; timestamp: number;
  replicas: { root: Record<string, string>; list: Record<string, string> };
  write: CloudKitWriteRecord; listWrite?: ListWrite;
  operations: { operationType: "update"; record: { recordName: string; recordType: string; recordChangeTag?: string; fields: Fields; parent?: { recordName: null } } }[];
  expected: CloudKitRecord[];
}
function field(record: CloudKitRecord, key: string, type: string) {
  const wrapper = record.fields[key] as { type?: unknown; value?: unknown } | undefined;
  if (!wrapper || wrapper.type !== type) throw new AppError("UNSUPPORTED_FEATURE", `The absolute-date lifecycle requires an observed ${record.recordType}.${key} ${type} field.`);
  return wrapper.value;
}
export function dateAlarmLifecycleResolution(record: CloudKitRecord, keys: string[], timestamp: number, replicas: Record<string, string>) {
  const updated = JSON.parse(updateResolutionTokenMap(record, keys, timestamp));
  const source = typeof fieldOptional(record, "ResolutionTokenMap") === "string" ? JSON.parse(String(fieldOptional(record, "ResolutionTokenMap"))).map : {};
  if (Object.keys(replicas).some(key => !keys.includes(key) || source[key] || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(replicas[key])))
    throw new AppError("VALIDATION_ERROR", "Unexpected retained lifecycle token replicas.", 400);
  for (const key of keys) if (!source[key]) { replicas[key] ??= updated.map[key].replicaID; updated.map[key].replicaID = replicas[key]; }
  return JSON.stringify(updated);
}
function reference(record: CloudKitRecord, key: string, type: string, owner: string) {
  const wrapper = record.fields[key] as { type?: unknown; value?: unknown } | undefined, value = wrapper?.value;
  if (!wrapper || wrapper.type !== "REFERENCE" || Object.keys(wrapper).some(key => !["type", "value"].includes(key)) ||
    !value || typeof value !== "object" || Array.isArray(value) || (value as { action?: unknown }).action !== "VALIDATE" ||
    Object.keys(value).some(key => !["recordName", "action", "zoneID"].includes(key))) throw new AppError("UNSUPPORTED_FEATURE", "The absolute-date lifecycle contains an unknown relationship wrapper.");
  const zone = (value as { zoneID?: unknown }).zoneID;
  if (zone !== undefined && (!zone || typeof zone !== "object" || Array.isArray(zone) || Object.keys(zone).some(key => !["zoneName", "zoneType", "ownerRecordName"].includes(key))))
    throw new AppError("UNSUPPORTED_FEATURE", "The absolute-date lifecycle contains unknown reference-zone metadata.");
  return referenceField(record, key, type, owner);
}
function intrinsic(record: CloudKitRecord, owner: string) {
  if (record.recordType === "List") return canonicalJSON(record.raw.parent ?? null);
  if (record.recordType === "Reminder") return intrinsicParentIdentity(record, owner);
  const parent = record.raw.parent;
  if (parent === undefined || parent === null) return null;
  if (!parent || typeof parent !== "object" || Array.isArray(parent) || Object.keys(parent).some(key => !["recordName", "action", "zoneID"].includes(key)))
    throw new AppError("UNSUPPORTED_FEATURE", "The absolute-date lifecycle contains an unknown intrinsic parent.");
  const { zoneID, ...metadata } = parent as Record<string, unknown>;
  if (zoneID !== undefined && (!zoneID || typeof zoneID !== "object" || Array.isArray(zoneID) || Object.keys(zoneID).some(key => !["zoneName", "zoneType", "ownerRecordName"].includes(key))))
    throw new AppError("UNSUPPORTED_FEATURE", "The absolute-date lifecycle contains unknown intrinsic-parent zone metadata.");
  const key = record.recordType === "Alarm" ? "Reminder" : "Alarm", type = key;
  const name = referenceField({ ...record, fields: { Intrinsic: { type: "REFERENCE", value: parent } } }, "Intrinsic", type, owner);
  if (name !== reference(record, key, type, owner)) throw new AppError("UNSUPPORTED_FEATURE", "The absolute-date participant's intrinsic parent disagrees with its backlink.");
  return canonicalJSON({ ...metadata, recordName: name });
}
function stableFields(record: CloudKitRecord, owner: string) {
  const fields = Object.fromEntries(Object.entries(stableNativePresentation(record.fields)).filter(([key, value]) => !isKnownEmptyDeletionCollection(key, value)));
  const token = fields.ResolutionTokenMap as { type?: unknown; value?: unknown } | undefined;
  if (token) fields.ResolutionTokenMap = { ...token, value: JSON.parse(String(field(record, "ResolutionTokenMap", "STRING"))) };
  const references = record.recordType === "Reminder" ? [["List", "List"], ["ParentReminder", "Reminder"]] :
    record.recordType === "Alarm" ? [["Reminder", "Reminder"]] : record.recordType === "AlarmTrigger" ? [["Alarm", "Alarm"]] : [];
  for (const [key, type] of references) {
    const wrapper = fields[key] as { type?: unknown; value?: unknown } | undefined;
    if (!wrapper) continue;
    if (wrapper.type === "REFERENCE" && wrapper.value === null && record.recordType === "Reminder") {
      if (Object.keys(wrapper).some(key => !["type", "value"].includes(key))) throw new AppError("UNSUPPORTED_FEATURE", "Unknown empty relationship metadata.");
      delete fields[key];
    }
    else fields[key] = { type: "REFERENCE", value: { recordName: reference(record, key, type, owner), action: "VALIDATE" } };
  }
  if (record.recordType === "Reminder") {
    const reminder = normalizeReminder(record, owner, true);
    if (reminder.alarmIds?.length) {
      const ids = record.fields.AlarmIDs as Record<string, unknown>;
      if (Object.keys(ids).some(key => !["type", "value"].includes(key))) throw new AppError("UNSUPPORTED_FEATURE", "Unknown alarm relationship metadata.");
      fields.AlarmIDs = { type: "STRING_LIST", value: [...reminder.alarmIds].sort() };
    }
    const completion = fields.CompletionDate as { type?: unknown; value?: unknown } | undefined;
    if (completion?.type === "TIMESTAMP" && completion.value === null && Object.keys(completion).every(key => ["type", "value"].includes(key))) delete fields.CompletionDate;
  }
  return fields;
}
export function verifyLifecycleParticipants(expected: CloudKitRecord[], records: CloudKitRecord[], owner: string, targetId: string) {
  try {
    if (records.length !== expected.length || new Set(records.map(record => record.recordName)).size !== records.length) throw new Error("Incomplete receipt.");
    for (const before of expected) {
      const after = records.find(record => record.recordName === before.recordName);
      if (!after || after.recordType !== before.recordType || !after.recordChangeTag || after.recordChangeTag === before.recordChangeTag || after.deleted ||
        canonicalJSON(stableFields(after, owner)) !== canonicalJSON(stableFields(before, owner)) || intrinsic(after, owner) !== intrinsic(before, owner)) throw new Error("Changed participant.");
    }
  } catch { throw new WriteOutcomeUnknownError(targetId); }
}
export function verifyDateAlarmLifecycle(plan: DateAlarmLifecyclePlan, records: CloudKitRecord[], owner: string) {
  verifyLifecycleParticipants(plan.expected, records, owner, plan.write.recordName);
}
export function validateDateAlarmParticipant(record: CloudKitRecord, owner: string) {
  const deleted = record.fields.Deleted;
  if (!deleted || typeof deleted !== "object" || Array.isArray(deleted) || Object.keys(deleted).some(key => !["type", "value"].includes(key)))
    throw new AppError("UNSUPPORTED_FEATURE", "The lifecycle cannot replace unknown deletion-marker metadata.");
  if (!record.recordName.startsWith(`${record.recordType}/`) || record.recordName.length > 255 || !record.recordChangeTag || record.recordChangeTag.length > 512 ||
    record.deleted || record.raw.share != null || record.zoneID?.zoneName !== "Reminders" ||
    ![owner, "__defaultOwner__"].includes(record.zoneID.ownerRecordName ?? owner) || record.zoneID.zoneType !== undefined && record.zoneID.zoneType !== "REGULAR_CUSTOM_ZONE" ||
    field(record, "Deleted", "INT64") !== 0 || ["Alarm", "AlarmTrigger"].includes(record.recordType) && field(record, "Imported", "INT64") !== 0)
    throw new AppError("CONFLICT", "An absolute-date participant is unavailable, deleted or outside the authenticated zone.", 409);
  intrinsic(record, owner); stableFields(record, owner);
}
/** Validates a pair on the original member snapshot; family ownership is separately scoped. */
export function validateAbsoluteDatePair(root: CloudKitRecord, records: CloudKitRecord[], owner: string) {
  const reminder = normalizeReminder(root, owner, true);
  const alarm = records.find(record => record.recordName === reminder.alarmIds?.[0]), trigger = records.find(record => record.recordType === "AlarmTrigger");
  if (reminder.alarmIds?.length !== 1 || reminder.allDay !== false || !reminder.dueDate || !reminder.timeZone || records.length !== 2 ||
    !alarm || alarm.recordType !== "Alarm" || !trigger || new Set(records.map(record => record.recordName)).size !== 2 ||
    Object.keys(alarm.fields).some(key => !["AlarmUID", "TriggerID", "DueDateResolutionTokenAsNonce", "Reminder", "Imported", "Deleted"].includes(key)) ||
    Object.keys(trigger.fields).some(key => !["DateComponentsData", "Type", "Alarm", "Imported", "Deleted"].includes(key)) ||
    reference(alarm, "Reminder", "Reminder", owner) !== root.recordName || reference(trigger, "Alarm", "Alarm", owner) !== alarm.recordName ||
    field(alarm, "AlarmUID", "STRING") !== alarm.recordName.slice(6) || ![trigger.recordName, trigger.recordName.slice(13)].includes(String(field(alarm, "TriggerID", "STRING"))) ||
    field(trigger, "Type", "STRING") !== "Date") throw new AppError("UNSUPPORTED_FEATURE", "The lifecycle graph is not exactly the observed bidirectional absolute-date pair.");
  for (const record of [root, alarm, trigger]) validateDateAlarmParticipant(record, owner);
  const components = decodeDateComponents(field(trigger, "DateComponentsData", "BYTES"));
  if (canonicalJSON(components) !== canonicalJSON(dateComponents(reminder.dueDate, reminder.timeZone, Object.hasOwn(components, "nanosecond"))) ||
    field(alarm, "DueDateResolutionTokenAsNonce", "DOUBLE") !== dueDateNonce(field(root, "ResolutionTokenMap", "STRING")))
    throw new AppError("CONFLICT", "The reminder due date, resolution nonce and absolute alarm components disagree.", 409);
  return [alarm, trigger];
}

/** One childless private root and exactly one bidirectional timed date pair. */
export function planDateAlarmLifecycle(action: Action, input: ReminderTargetInputData, graph: SchedulingGraph, sourceList: CloudKitRecord,
  owner: string, timestamp = Date.now(), retainedReplicas?: DateAlarmLifecyclePlan["replicas"]): DateAlarmLifecyclePlan {
  input = ReminderTargetInput.parse(input);
  if (!["complete", "reopen", "delete"].includes(action)) throw new AppError("VALIDATION_ERROR", "Unknown date-alarm lifecycle action.", 400);
  const root = graph.reminder;
  assertOwnedReminder(root, owner);
  if (root.recordName !== input.reminderId || root.recordChangeTag !== input.recordChangeTag || !root.recordChangeTag || root.recordChangeTag.length > 512)
    throw new AppError("CONFLICT", "The alarmed reminder changed before its lifecycle action.", 409);
  const reminder = normalizeReminder(root, owner, true);
  if (root.deleted || reminder.deleted !== false || reminder.completed === null || reminder.completed !== (reminder.completedDate !== null) ||
    action !== "delete" && reminder.completed !== (action === "reopen")) throw new AppError("CONFLICT", "The alarmed reminder no longer has the required live completion state.", 409);
  const list = sourceList.zoneID === undefined ? { ...sourceList, zoneID: { zoneName: "Reminders", zoneType: "REGULAR_CUSTOM_ZONE", ownerRecordName: owner } } : sourceList;
  if (reminder.listId !== input.listId || list.recordName !== input.listId) throw new AppError("FORBIDDEN", "The absolute-date lifecycle cannot cross Lists.", 403);
  if (!graph.complete || graph.records.length !== 3 || graph.schedulingParent || reminder.parentReminderId !== null || reminder.alarmIds?.length !== 1 ||
    (reminder.recurrenceRuleIds?.length ?? 0) || (reminder.attachmentIds?.length ?? 0) || (reminder.hashtagIds?.length ?? 0) || reminder.startDate !== null ||
    reminder.allDay !== false || !reminder.dueDate || !reminder.timeZone ||
    Object.keys(root.fields).some(key => /parent|child|subtask/i.test(key) && key !== "ParentReminder") ||
    Object.entries(root.fields).some(([key, raw]) => { const wrapper = raw as { type?: unknown; value?: unknown } | undefined;
      return wrapper?.value != null && (wrapper.type === "REFERENCE" && !["List", "ParentReminder"].includes(key) ||
        ["STRING_LIST", "UNKNOWN_LIST"].includes(String(wrapper.type)) && Array.isArray(wrapper.value) && wrapper.value.length > 0 && key !== "AlarmIDs"); }) ||
    Object.hasOwn(root.fields, "DueDateDeltaAlertsData") && (fieldOptional(root, "DueDateDeltaAlertsData") !== null || (root.fields.DueDateDeltaAlertsData as { type?: unknown })?.type !== "BYTES") ||
    Object.hasOwn(root.fields, "AssignmentIDs") && !isKnownEmptyDeletionCollection("AssignmentIDs", root.fields.AssignmentIDs) ||
    normalizeList(list, false).deleted !== false || normalizeList(list, false).isGroup !== false || !list.recordChangeTag || list.recordChangeTag.length > 512 || list.raw.share != null)
    throw new AppError("UNSUPPORTED_FEATURE", "Absolute-date lifecycle requires a private ordinary childless root without recurrence, early reminders, assignments, tags or attachments.");
  const [alarm, trigger] = validateAbsoluteDatePair(root, graph.records.filter(record => record.recordName !== root.recordName), owner);
  validateDateAlarmParticipant(list, owner);
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new AppError("VALIDATION_ERROR", "The lifecycle timestamp is invalid.", 400);
  const fields: Fields = { LastModifiedDate: { type: "TIMESTAMP", value: timestamp } };
  const replicas = structuredClone(retainedReplicas ?? { root: {}, list: {} });
  const tokens = ["lastModifiedDate"];
  if (action === "delete") { fields.Deleted = { type: "INT64", value: 1 }; fields.List = { type: "REFERENCE", value: null }; tokens.push("list"); }
  else { fields.Completed = { type: "INT64", value: action === "complete" ? 1 : 0 }; fields.CompletionDate = { type: "TIMESTAMP", value: action === "complete" ? timestamp : null }; tokens.push("completed", "completionDate"); }
  fields.ResolutionTokenMap = { type: "STRING", value: dateAlarmLifecycleResolution(root, tokens, timestamp, replicas.root) };
  const write: CloudKitWriteRecord = { recordName: root.recordName, recordType: "Reminder", recordChangeTag: root.recordChangeTag, fields, ...(action === "delete" ? { parent: null } : {}) };
  let listWrite: ListWrite | undefined;
  if (action === "delete") {
    const members = normalizeList(list).reminderIds;
    if (!members || new Set(members).size !== members.length) throw new AppError("UNSUPPORTED_FEATURE", "Deletion requires complete unambiguous List membership.");
    if (members.includes(root.recordName)) listWrite = { recordName: list.recordName, recordType: "List", recordChangeTag: list.recordChangeTag, fields: {
      ReminderIDs: { type: "STRING", value: JSON.stringify((JSON.parse(String(field(list, "ReminderIDs", "STRING"))) as string[]).filter((_, index) => members[index] !== root.recordName)) },
      ResolutionTokenMap: { type: "STRING", value: dateAlarmLifecycleResolution(list, ["reminderIDsMergeableOrdering"], timestamp, replicas.list) },
    } };
  }
  const operations: DateAlarmLifecyclePlan["operations"] = [
    { operationType: "update", record: { ...write, parent: action === "delete" ? { recordName: null } : undefined } },
    ...[alarm, trigger].map(record => ({ operationType: "update" as const, record: { recordName: record.recordName, recordType: record.recordType, recordChangeTag: record.recordChangeTag,
      fields: { Deleted: { type: "INT64", value: action === "delete" ? 1 : 0 } } } })),
    { operationType: "update", record: listWrite ?? { recordName: list.recordName, recordType: "List", recordChangeTag: list.recordChangeTag, fields: { Deleted: { type: "INT64", value: 0 } } } },
  ];
  if (jsonBytes({ zoneID: { zoneName: "Reminders", zoneType: "REGULAR_CUSTOM_ZONE", ownerRecordName: owner }, atomic: true, operations }) > 65_536)
    throw new AppError("UNSUPPORTED_FEATURE", "The entire absolute-date lifecycle exceeds its atomic byte budget.");
  const expected = operations.map(operation => { const before = [root, alarm, trigger, list].find(record => record.recordName === operation.record.recordName)!;
    return { ...before, fields: { ...before.fields, ...operation.record.fields }, raw: operation.record.parent ? { ...before.raw, parent: null } : before.raw }; });
  return { action, input, graph, list, timestamp, replicas, write, listWrite, operations, expected };
}
function fieldOptional(record: CloudKitRecord, key: string) { return (record.fields[key] as { value?: unknown } | undefined)?.value; }
