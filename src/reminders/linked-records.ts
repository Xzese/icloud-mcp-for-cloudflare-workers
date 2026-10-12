import { AppError } from "../errors.ts";
import { normalizeReminder, type CloudKitLookupResult, type CloudKitRecord } from "../icloud/cloudkit.ts";
import { fingerprint, jsonBytes } from "../lib/canonical.ts";

export const SCHEDULING_TYPES = ["Reminder", "Alarm", "AlarmTrigger", "RecurrenceRule"] as const;
export const GRAPH_LIMITS = { records: 32, bytes: 262_144, depth: 3 } as const;
export interface SchedulingGraph {
  reminder: CloudKitRecord;
  records: CloudKitRecord[];
  edges: { from: string; to: string }[];
  fingerprint: string;
  complete: boolean;
  unsupportedReason: string | null;
  schedulingParent?: CloudKitRecord;
  earlyReminderWitness?: CloudKitRecord;
}

function graphFingerprint(graph: Pick<SchedulingGraph, "records" | "edges">, earlyReminderWitness?: CloudKitRecord) {
  const value: Record<string, unknown> = {
    records: [...graph.records].sort((a, b) => a.recordName.localeCompare(b.recordName)).map(record => ({
      id: record.recordName, type: record.recordType, version: record.recordChangeTag, zone: record.zoneID, fields: record.fields,
    })),
    edges: [...graph.edges].sort((a, b) => a.to.localeCompare(b.to)),
  };
  if (earlyReminderWitness) value.earlyReminderWitness = {
    id: earlyReminderWitness.recordName,
    type: earlyReminderWitness.recordType,
    version: earlyReminderWitness.recordChangeTag,
    zone: earlyReminderWitness.zoneID,
    fields: earlyReminderWitness.fields,
  };
  return fingerprint(value);
}

export async function attachEarlyReminderWitness(graph: SchedulingGraph, witness: CloudKitRecord): Promise<SchedulingGraph> {
  if (witness.recordType !== "Reminder" || !witness.recordName.startsWith("Reminder/") || witness.recordName === graph.reminder.recordName ||
    !witness.recordChangeTag || witness.deleted === true || witness.zoneID?.zoneName !== "Reminders" ||
    witness.zoneID.ownerRecordName !== graph.reminder.zoneID?.ownerRecordName) {
    throw new AppError("CONFLICT", "The early reminder metadata source changed or is outside the target's private Reminders zone.", 409);
  }
  const attached = { ...graph, earlyReminderWitness: witness };
  attached.fingerprint = await graphFingerprint(attached, witness);
  return attached;
}

export async function loadSchedulingGraph(
  reminder: CloudKitRecord, owner: string,
  lookup: (ids: string[]) => Promise<CloudKitLookupResult>,
): Promise<SchedulingGraph> {
  const normalized = normalizeReminder(reminder, owner);
  const records = new Map<string, CloudKitRecord>();
  const edges: SchedulingGraph["edges"] = [];
  let bytes = 0;
  const add = (record: CloudKitRecord) => {
    if (!SCHEDULING_TYPES.some(type => type === record.recordType) || !record.recordName.startsWith(`${record.recordType}/`) || !record.recordChangeTag || record.deleted ||
      record.zoneID?.zoneName !== "Reminders" || record.zoneID.zoneType !== undefined && record.zoneID.zoneType !== "REGULAR_CUSTOM_ZONE" || ![owner, "__defaultOwner__"].includes(record.zoneID.ownerRecordName ?? owner)) {
      throw new AppError("PROTOCOL_CHANGED", "The scheduling graph has an invalid identity, zone, state or version.");
    }
    if (records.has(record.recordName)) throw new AppError("PROTOCOL_CHANGED", "The scheduling graph contains duplicate or cyclic links.");
    bytes += jsonBytes({ fields: record.fields, id: record.recordName, version: record.recordChangeTag });
    if (bytes > GRAPH_LIMITS.bytes || records.size >= GRAPH_LIMITS.records) throw new AppError("UNSUPPORTED_FEATURE", "The scheduling graph exceeds its bounded inspection budget.");
    records.set(record.recordName, record);
  };
  add(reminder);
  const ids = [...normalized.alarmIds ?? [], ...normalized.recurrenceRuleIds ?? []];
  if (ids.length > GRAPH_LIMITS.records - 1 || new Set(ids).size !== ids.length) throw new AppError("UNSUPPORTED_FEATURE", "The scheduling graph has too many or duplicated links.");
  if (ids.length) {
    const result = await lookup(ids);
    if (!result.complete || result.recordErrors.length || result.unresolvedRecordNames.length || result.records.length !== ids.length) throw new AppError("UNSUPPORTED_FEATURE", "The complete scheduling graph could not be resolved.");
    for (const record of result.records) {
      if (!("recordType" in record) || !ids.includes(record.recordName)) throw new AppError("PROTOCOL_CHANGED", "The scheduling graph returned an unexpected record.");
      add({ ...record, zoneID: record.zoneID ?? reminder.zoneID });
      edges.push({ from: reminder.recordName, to: record.recordName });
    }
  }
  const triggerIds = [...records.values()].filter(record => record.recordType === "Alarm").map(record => {
    const field = record.fields.TriggerID;
    if (!field || typeof field !== "object" || !("type" in field) || field.type !== "STRING" || !("value" in field) ||
      typeof field.value !== "string" || !/^(?:AlarmTrigger\/)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(field.value)) {
      throw new AppError("UNSUPPORTED_FEATURE", "The linked alarm has an unsupported trigger identity.");
    }
    const id = field.value.startsWith("AlarmTrigger/") ? field.value : `AlarmTrigger/${field.value}`;
    edges.push({ from: record.recordName, to: id });
    return id;
  });
  if (triggerIds.length) {
    if (new Set(triggerIds).size !== triggerIds.length || records.size + triggerIds.length > GRAPH_LIMITS.records) {
      throw new AppError("UNSUPPORTED_FEATURE", "The linked triggers are duplicated or exceed the graph budget.");
    }
    const result = await lookup(triggerIds);
    if (!result.complete || result.recordErrors.length || result.unresolvedRecordNames.length || result.records.length !== triggerIds.length) {
      throw new AppError("UNSUPPORTED_FEATURE", "The linked alarm triggers could not all be resolved.");
    }
    for (const record of result.records) {
      if (!("recordType" in record) || record.recordType !== "AlarmTrigger" || !triggerIds.includes(record.recordName)) throw new AppError("PROTOCOL_CHANGED", "The trigger lookup returned an unexpected record.");
      add({ ...record, zoneID: record.zoneID ?? reminder.zoneID });
    }
  }
  let schedulingParent: CloudKitRecord | undefined;
  if (normalized.parentReminderId) {
    const found = await lookup([normalized.parentReminderId]);
    if (!found.complete || found.recordErrors.length || found.unresolvedRecordNames.length || found.records.length !== 1 || !("recordType" in found.records[0])) throw new AppError("CONFLICT", "The exact scheduling parent could not be resolved.", 409);
    schedulingParent = { ...found.records[0], zoneID: found.records[0].zoneID ?? reminder.zoneID };
    const parent = normalizeReminder(schedulingParent, owner);
    if (schedulingParent.recordName !== normalized.parentReminderId || parent.listId !== normalized.listId || parent.completed !== false || parent.deleted !== false || parent.parentReminderId) throw new AppError("UNSUPPORTED_FEATURE", "Subtask scheduling requires an open root parent in the same list.");
    add(schedulingParent);
    edges.push({ from: reminder.recordName, to: schedulingParent.recordName });
  }
  const unsupportedReason = null;
  const sorted = [...records.values()].sort((a, b) => a.recordName.localeCompare(b.recordName));
  return { reminder, records: sorted, edges, complete: true,
    unsupportedReason, ...(schedulingParent ? { schedulingParent } : {}), fingerprint: await graphFingerprint({ records: sorted, edges }) };
}
