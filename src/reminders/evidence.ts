import { z } from "zod";
import { AppError, WriteOutcomeUnknownError } from "../errors.ts";
import { canonicalJSON, fingerprint, jsonBytes } from "../lib/canonical.ts";
import { normalizeReminder, type CloudKitRemindersClient, type CloudKitRecord, type CloudKitLookupResult } from "../icloud/cloudkit.ts";
import { ReminderTargetInput } from "./writes.ts";
import { GRAPH_LIMITS, SCHEDULING_TYPES } from "./linked-records.ts";

export const EvidenceInput = ReminderTargetInput.omit({ recordChangeTag: true }).extend({
  expectedGeneration: z.number().int().nonnegative().safe(),
  caseId: z.string().uuid().toLowerCase(),
}).strict();
export const AtomicProtectionInput = EvidenceInput.extend({
  dependencyType: z.enum(["Alarm", "AlarmTrigger", "RecurrenceRule"]),
  confirmVersionGuardWrites: z.literal(true),
}).strict();
export const evidenceTitle = (caseId: string) => `MCP protocol ${caseId}`;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const schedulingId = (value: string) => /^(Reminder|Alarm|AlarmTrigger|RecurrenceRule)\/[^/\u0000-\u0020\u007f]{1,250}$/.test(value);
const safeValues = new Set(["DueDate", "TimeZone", "AllDay", "Completed", "CompletionDate", "Deleted", "Priority", "Flagged"]);
function safeScalar(value: unknown, field: string) {
  if (!safeValues.has(field)) return false;
  if (typeof value === "number") return Number.isSafeInteger(value);
  if (typeof value === "boolean") return true;
  if (typeof value !== "string") return false;
  if (field !== "TimeZone") return /^-?\d{1,16}$/.test(value);
  try { new Intl.DateTimeFormat("en", { timeZone: value }).format(0); return true; }
  catch { return false; }
}
export interface EvidenceGraph {
  rootRecordName?: string;
  records: CloudKitRecord[];
  edges: { from: string; field: string; to: string }[];
}

export async function verifyAtomicProtection(graph: EvidenceGraph, owner: string, dependencyType: z.infer<typeof AtomicProtectionInput>["dependencyType"],
  client: Pick<CloudKitRemindersClient, "modifyRecords" | "lookupSchedulingRecords">, beforeDispatch: () => Promise<void>) {
  const root = graph.records.find(record => record.recordName === graph.rootRecordName);
  if (!root || root.recordType !== "Reminder") throw new AppError("UNSUPPORTED_FEATURE", "The atomic test requires its exact synthetic root.");
  const reminder = normalizeReminder(root, owner);
  const guards = graph.records.filter(record => record.recordName !== root.recordName);
  if (reminder.completed !== false || reminder.deleted !== false || reminder.parentReminderId || graph.records.length !== 4 ||
    guards.length !== 3 || !["Alarm", "AlarmTrigger", "RecurrenceRule"].every(type => guards.filter(record => record.recordType === type).length === 1)) {
    throw new AppError("UNSUPPORTED_FEATURE", "The atomic test requires one open synthetic reminder with one recurrence, alarm and trigger.");
  }
  const dependency = guards.find(record => record.recordType === dependencyType)!;
  const alarm = guards.find(record => record.recordType === "Alarm")!, trigger = guards.find(record => record.recordType === "AlarmTrigger")!;
  const rule = guards.find(record => record.recordType === "RecurrenceRule")!;
  const reference = (record: CloudKitRecord, field: string, id: string) => {
    const value = record.fields[field];
    return object(value) && value.type === "REFERENCE" && object(value.value) && value.value.recordName === id;
  };
  const triggerId = alarm.fields.TriggerID;
  if (canonicalJSON(reminder.alarmIds) !== canonicalJSON([alarm.recordName]) ||
    canonicalJSON(reminder.recurrenceRuleIds) !== canonicalJSON([rule.recordName]) ||
    !reference(alarm, "Reminder", root.recordName) || !reference(rule, "Reminder", root.recordName) ||
    !reference(trigger, "Alarm", alarm.recordName) || !object(triggerId) || triggerId.type !== "STRING" ||
    (triggerId.value !== trigger.recordName && triggerId.value !== trigger.recordName.slice("AlarmTrigger/".length))) {
    throw new AppError("UNSUPPORTED_FEATURE", "The atomic test requires exact bidirectional synthetic scheduling relationships.");
  }
  const ids = graph.records.map(record => record.recordName);
  const reread = async () => {
    const found = await client.lookupSchedulingRecords(ids);
    if (!found.complete || found.recordErrors.length || found.unresolvedRecordNames.length || found.records.length !== ids.length ||
      new Set(found.records.map(record => record.recordName)).size !== ids.length) throw new AppError("CONFLICT", "The complete atomic test group could not be reread.");
    return graph.records.map(before => {
      const current = found.records.find(record => record.recordName === before.recordName);
      if (!current || !("recordType" in current) || current.recordType !== before.recordType || current.deleted ||
        canonicalJSON(current.fields) !== canonicalJSON(before.fields)) throw new AppError("CONFLICT", "Atomic test fields or identities changed; stop without further writes.");
      return { ...current, zoneID: current.zoneID ?? before.zoneID };
    });
  };
  // Reassert only an observed live marker; no scheduling field or token is rewritten.
  const advanced = await client.modifyRecords([{ operationType: "update", record: { recordName: root.recordName, recordType: "Reminder",
    recordChangeTag: root.recordChangeTag, fields: { Deleted: { type: "INT64", value: 0 } } } }], beforeDispatch, [dependency]);
  const fresh = await reread();
  for (const record of fresh) {
    const expected = advanced.find(value => value.recordName === record.recordName) ?? graph.records.find(value => value.recordName === record.recordName)!;
    if (record.recordChangeTag !== expected.recordChangeTag) throw new AppError("CONFLICT", "Atomic test versions drifted after the guard write; no stale attempt was sent.");
  }
  const freshRoot = fresh.find(record => record.recordName === root.recordName)!;
  const staleGuards = fresh.filter(record => record.recordName !== root.recordName).map(record => record.recordName === dependency.recordName ? dependency : record);
  try {
    await client.modifyRecords([{ operationType: "update", record: { recordName: root.recordName, recordType: "Reminder",
      recordChangeTag: freshRoot.recordChangeTag, fields: { Deleted: { type: "INT64", value: 0 } } } }], beforeDispatch, staleGuards);
    throw new WriteOutcomeUnknownError(root.recordName);
  } catch (error) {
    if (!(error instanceof AppError) || error.code !== "CONFLICT") throw error;
  }
  const after = await reread();
  if (after.some(record => record.recordChangeTag !== fresh.find(value => value.recordName === record.recordName)!.recordChangeTag)) {
    throw new WriteOutcomeUnknownError(root.recordName);
  }
  return { dependencyType, validGuardAccepted: true, staleGuardRejected: true, groupFieldsAndVersionsUnchangedAfterRejection: true,
    guardedDependencies: 3, modifyRequests: 2, writesPerformed: true, probeMutation: "nondeleted-marker",
    schedulingFieldsRewritten: false, writableRecipeApproved: false };
}

// Diagnostic traversal records observed references, not a writable scheduling recipe.
export async function captureEvidenceGraph(root: CloudKitRecord, owner: string, listId: string, caseId: string,
  lookup: (ids: string[]) => Promise<CloudKitLookupResult>): Promise<EvidenceGraph> {
  const records = new Map<string, CloudKitRecord>(), edges: EvidenceGraph["edges"] = [];
  const edgeKeys = new Set<string>();
  let pending = [root], bytes = 0;
  for (let depth = 0; pending.length; depth++) {
    if (depth > GRAPH_LIMITS.depth) throw new AppError("UNSUPPORTED_FEATURE", "The evidence graph exceeds its depth budget.");
    const next = new Set<string>();
    for (const record of pending) {
      if (records.has(record.recordName) || !schedulingId(record.recordName) || !SCHEDULING_TYPES.some(type => type === record.recordType) ||
        !record.recordName.startsWith(`${record.recordType}/`) || !record.recordChangeTag || record.deleted ||
        record.zoneID?.zoneName !== "Reminders" || ![owner, "__defaultOwner__"].includes(record.zoneID.ownerRecordName ?? owner)) {
        throw new AppError("PROTOCOL_CHANGED", "Evidence contains an invalid record identity, version, state or zone.");
      }
      const link = (to: string, field: string) => {
        const edge = { from: record.recordName, field, to }, key = canonicalJSON(edge);
        if (!edgeKeys.has(key)) { edges.push(edge); edgeKeys.add(key); }
        if (!records.has(to)) next.add(to);
      };
      if (record.recordType === "Reminder") {
        const reminder = normalizeReminder(record, owner);
        if (reminder.listId !== listId || !(reminder.title === evidenceTitle(caseId) || reminder.title?.startsWith(`${evidenceTitle(caseId)} `))) {
          throw new AppError("FORBIDDEN", "Evidence capture is restricted to this case's explicitly named synthetic reminders in the selected list.");
        }
        for (const id of reminder.alarmIds ?? []) link(id, "AlarmIDs");
        for (const id of reminder.recurrenceRuleIds ?? []) link(id, "RecurrenceRuleIDs");
        if (reminder.parentReminderId) link(reminder.parentReminderId, "ParentReminder");
      }
      if (record.recordType === "Alarm" && record.fields.TriggerID !== undefined) {
        const trigger = record.fields.TriggerID;
        if (!object(trigger) || trigger.type !== "STRING" || typeof trigger.value !== "string" ||
          !/^(?:AlarmTrigger\/)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trigger.value)) {
          throw new AppError("UNSUPPORTED_FEATURE", "The diagnostic alarm trigger identity has an unverified shape.");
        }
        const id = trigger.value.startsWith("AlarmTrigger/") ? trigger.value : `AlarmTrigger/${trigger.value}`;
        link(id, "TriggerID");
      }
      bytes += jsonBytes(record);
      if (bytes > GRAPH_LIMITS.bytes || records.size >= GRAPH_LIMITS.records) throw new AppError("UNSUPPORTED_FEATURE", "The evidence graph exceeds its record or byte budget.");
      records.set(record.recordName, record);
      const visit = (value: unknown, field: string, level = 0) => {
        if (level > 8) throw new AppError("UNSUPPORTED_FEATURE", "An evidence field exceeds its structural depth budget.");
        if (typeof value === "string" && schedulingId(value)) {
          link(value, field);
        } else if (Array.isArray(value)) value.forEach(item => visit(item, field, level + 1));
        else if (object(value)) {
          if (value.zoneID !== undefined) {
            const zone = value.zoneID;
            if (!object(zone) || zone.zoneName !== "Reminders" || (zone.ownerRecordName !== undefined && ![owner, "__defaultOwner__"].includes(String(zone.ownerRecordName)))) {
              throw new AppError("FORBIDDEN", "Evidence contains a foreign-zone relationship.");
            }
          }
          for (const [key, child] of Object.entries(value)) if (key !== "zoneID") visit(child, field, level + 1);
        }
      };
      for (const [field, value] of Object.entries(record.fields)) visit(value, field);
    }
    const ids = [...next].filter(id => !records.has(id)).sort();
    if (ids.length + records.size > GRAPH_LIMITS.records) throw new AppError("UNSUPPORTED_FEATURE", "The evidence references exceed the graph budget.");
    if (!ids.length) break;
    const found = await lookup(ids);
    if (!found.complete || found.recordErrors.length || found.unresolvedRecordNames.length || found.records.length !== ids.length) {
      throw new AppError("UNSUPPORTED_FEATURE", "The explicitly referenced evidence records could not all be resolved.");
    }
    pending = found.records.map(record => {
      if (!("recordType" in record) || !ids.includes(record.recordName)) throw new AppError("PROTOCOL_CHANGED", "Evidence lookup returned an unexpected record.");
      return record;
    });
  }
  // A second exact read detects ordinary synchronization drift, not commit-time safety.
  const ordered = [...records.values()].sort((a, b) => a.recordName.localeCompare(b.recordName));
  const fresh = await lookup(ordered.map(record => record.recordName));
  if (!fresh.complete || fresh.records.length !== ordered.length || fresh.recordErrors.length || fresh.unresolvedRecordNames.length) {
    throw new AppError("CONFLICT", "The evidence could not be fully reread. No stable capture was saved and no write was sent.");
  }
  for (const record of ordered) {
    const current = fresh.records.find(value => value.recordName === record.recordName);
    if (!current || !("recordType" in current) || current.recordType !== record.recordType || current.deleted) {
      throw new AppError("CONFLICT", "An evidence record changed identity, type or deletion state during capture. No stable capture was saved and no write was sent.");
    }
    const versionChanged = current.recordChangeTag !== record.recordChangeTag;
    const changedFields = [...new Set([...Object.keys(record.fields), ...Object.keys(current.fields)])]
      .filter(field => canonicalJSON(current.fields[field] ?? null) !== canonicalJSON(record.fields[field] ?? null));
    if (versionChanged || canonicalJSON(current.fields) !== canonicalJSON(record.fields)) {
      const safeNames = changedFields.slice(0, 8).map(field => /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(field) ? field : "unknown-field");
      throw new AppError("CONFLICT", `The ${record.recordType} evidence reread differs (version changed: ${versionChanged}; fields: ${safeNames.join(", ") || "none"}). Wait for synchronization; no stable capture was saved and no write was sent.`);
    }
  }
  return { rootRecordName: root.recordName, records: ordered, edges: edges.sort((a, b) => canonicalJSON(a).localeCompare(canonicalJSON(b))) };
}

export async function sanitizeEvidence(graph: EvidenceGraph, caseId: string, generation: number) {
  const alias = async (value: unknown) => `opaque-${(await fingerprint({ caseId, value })).slice(0, 24)}`;
  const id = async (value: string) => `${value.split("/")[0]}/${await alias(value)}`;
  const sanitize = async (value: unknown, field: string): Promise<unknown> => {
    if (value === null || value === undefined) return null;
    if (typeof value === "string") {
      if (/^(List|Reminder|Alarm|AlarmTrigger|RecurrenceRule|Attachment|Hashtag)\//.test(value)) return id(value);
      if (safeScalar(value, field)) return value;
      return alias(value);
    }
    if (typeof value === "number" || typeof value === "boolean") return safeScalar(value, field) ? value : alias(value);
    if (Array.isArray(value)) return Promise.all(value.map(child => sanitize(child, field)));
    if (object(value)) {
      const entries = await Promise.all(Object.entries(value).map(async ([key, child]) => {
        const name = /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(key) ? key : await alias(key);
        if (key === "ownerRecordName" || key === "userRecordName") return [name, "synthetic-owner"];
        if (key === "type" && typeof child === "string" && /^[A-Z][A-Z0-9_]{0,31}$/.test(child)) return [name, child];
        if (key === "zoneName") return [name, "Reminders"];
        return [name, await sanitize(child, field)];
      }));
      return Object.fromEntries(entries);
    }
    throw new AppError("PROTOCOL_CHANGED", "Evidence contains a non-JSON field.");
  };
  const records = await Promise.all(graph.records.map(async record => ({
    recordName: await id(record.recordName), recordType: record.recordType,
    recordChangeTag: await alias(record.recordChangeTag), zoneID: { zoneName: "Reminders", ownerRecordName: "synthetic-owner" },
    fields: Object.fromEntries(await Promise.all(Object.entries(record.fields).map(async ([field, value]) =>
      [/^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(field) ? field : await alias(field), await sanitize(value, field)]))), deleted: false,
  })));
  // Preserve scheduling values only through the explicit allowlist; all other values
  // retain shape and equality aliases, never text, binary documents or credentials.
  return {
    schemaVersion: 1 as const, caseId, generation, capturedAt: Date.now(), source: "live-apple-api" as const,
    rootRecordName: graph.rootRecordName ? await id(graph.rootRecordName) : null,
    explicitlyReferencedRecordsResolved: true, writableGraphProven: false, appleAppVerified: false,
    limitations: ["No proof of unreferenced children, successor identity or commit-time dependency protection.",
      "Opaque values preserve shape/equality only; nonce derivation and unknown field semantics require separately reviewed evidence."],
    records, edges: await Promise.all(graph.edges.map(async edge => ({ from: await id(edge.from), field: /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(edge.field) ? edge.field : await alias(edge.field), to: await id(edge.to) }))),
  };
}
