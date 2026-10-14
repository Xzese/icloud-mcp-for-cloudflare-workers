import { z } from "zod";
import { AppError } from "../errors.ts";
import { CloudKitRateLimitedError, normalizeList, normalizeReminder, normalizeReminderRelationships, type CloudKitRecord, type CloudKitRemindersClient } from "../icloud/cloudkit.ts";
import { jsonBytes } from "../lib/canonical.ts";
import { omitField } from "../lib/omit-field.ts";
import { CreateReminderInput, ReminderTargetInput, assertOwnedReminder, buildCreateReminder, updateResolutionTokenMap, type CloudKitWriteRecord } from "./writes.ts";
import { MAX_LIST_MEMBERS } from "../icloud/budgets.ts";
type RelationshipClient = Pick<CloudKitRemindersClient, "lookup" | "queryRemindersPage"> & Partial<Pick<CloudKitRemindersClient, "lookupRelationshipRecords">>;

export const ParentReminderInput = ReminderTargetInput.omit({ listId: true }).describe("Exact open root reminder ID and current version tag from the same list. Nested, recurring and alarmed parents are unsupported.");
export const CreateSubtaskInput = CreateReminderInput.extend({
  parentReminder: ParentReminderInput,
}).strict();
export const SetReminderParentInput = ReminderTargetInput.extend({
  parentReminder: ParentReminderInput.nullable().describe("Destination root reminder and current tag in the same list; null removes the existing parent and returns this reminder to the list's top level."),
}).strict();

function requireSimple(record: CloudKitRecord, listId: string, owner: string) {
  assertOwnedReminder(record, owner);
  const reminder = normalizeReminder(record, owner);
  if (reminder.listId !== listId) throw new AppError("FORBIDDEN", "Subtask relationships cannot cross lists.", 403);
  if (reminder.completed !== false || reminder.deleted !== false || record.deleted || !reminder.recordChangeTag) {
    throw new AppError("CONFLICT", "Subtask changes require exact open, nondeleted reminders.", 409);
  }
  if (reminder.dueDate !== null || reminder.startDate !== null || reminder.timeZone !== null || reminder.allDay !== false ||
    (reminder.alarmIds?.length ?? 0) || (reminder.recurrenceRuleIds?.length ?? 0) ||
    Object.keys(record.fields).some(field => /child|subtask/i.test(field))) {
    throw new AppError("UNSUPPORTED_FEATURE", "Initial subtask support requires undated, non-recurring, unalarmed reminders without unknown child fields.");
  }
  return reminder;
}

export function requireNoReadErrors(errors: { serverErrorCode: string }[]) {
  for (const error of errors) {
    const code = error.serverErrorCode.toUpperCase();
    if (["AUTHENTICATION_REQUIRED", "NOT_AUTHENTICATED", "INVALID_AUTH_TOKEN", "AUTHENTICATION_FAILED"].includes(code)) {
      throw new AppError("REAUTH_REQUIRED", "Apple rejected the relationship inspection. Reconnect your Apple account.", 409);
    }
    if (["ACCESS_DENIED", "PERMISSION_FAILURE", "PERMISSION_DENIED"].includes(code)) throw new AppError("FORBIDDEN", "Apple denied access to the relationship inspection.", 403);
    if (["THROTTLED", "REQUEST_RATE_LIMITED", "ZONE_BUSY"].includes(code)) throw new CloudKitRateLimitedError(null);
  }
  if (errors.length) throw new AppError("UNSUPPORTED_FEATURE", "The relationship inspection returned record errors; no mutation was dispatched.");
}

async function scanListReminders(client: Pick<CloudKitRemindersClient, "queryRemindersPage">, owner: string, listId: string, largeInventory = false): Promise<CloudKitRecord[]> {
  let continuation: string | null = null, bytes = 0, count = 0;
  const seen = new Set<string>(), remindersSeen = new Set<string>(), reminders: CloudKitRecord[] = [];
  for (let index = 0; index < (largeInventory ? 10 : 5); index++) {
    const page = await client.queryRemindersPage({ listId, includeCompleted: true, limit: 200, continuation,
      ...(largeInventory ? { projection: "relationships" as const } : {}) });
    requireNoReadErrors(page.recordErrors);
    for (const record of page.records) {
      bytes += jsonBytes(record);
      if (bytes > (largeInventory ? 8_388_608 : 262_144) || ++count > (largeInventory ? 10_000 : 1000)) throw new AppError("UNSUPPORTED_FEATURE", "The complete child check exceeds its inspection budget.");
      if (record.recordName.startsWith("Reminder/")) {
        if (remindersSeen.has(record.recordName)) throw new AppError("PROTOCOL_CHANGED", "The child check returned a duplicate reminder identity.");
        remindersSeen.add(record.recordName);
      }
      if ("recordType" in record) {
        assertOwnedReminder(record, owner);
        // reminderList is a compound query: linked scheduling/organization
        // records may repeat across pages. They consume the full scan budget
        // but have no role in discovering ParentReminder relationships.
        if (["Alarm", "AlarmTrigger", "RecurrenceRule", "Attachment", "Hashtag"].includes(record.recordType)) continue;
      }
      if ("recordType" in record && record.recordType === "Reminder" && !record.deleted) {
        if (Object.keys(record.fields).some(field => /parent|child|subtask/i.test(field) && field !== "ParentReminder")) {
          throw new AppError("UNSUPPORTED_FEATURE", "Unknown relationship fields prevent a complete child inspection.");
        }
        const reminder = normalizeReminderRelationships(record, owner);
        if (reminder.deleted === true) continue;
        if (reminder.listId !== listId) throw new AppError("PROTOCOL_CHANGED", "The child check returned a reminder from another list.");
        reminders.push(record);
      } else if (!record.deleted) throw new AppError("PROTOCOL_CHANGED", "The child check returned an unexpected record type.");
    }
    if (page.paginationComplete) {
      if (!page.complete) throw new AppError("UNSUPPORTED_FEATURE", "The child check is incomplete; no mutation was dispatched.");
      return reminders;
    }
    if (!page.continuation || seen.has(page.continuation)) throw new AppError("PROTOCOL_CHANGED", "The child-check continuation did not advance.");
    continuation = page.continuation; seen.add(continuation);
  }
  throw new AppError("UNSUPPORTED_FEATURE", "The child check did not finish; absence of descendants is not established.");
}

function childRelationships(records: CloudKitRecord[], owner: string) {
  const children = new Map<string, string[]>();
  for (const record of records) {
    const parent = normalizeReminderRelationships(record, owner).parentReminderId;
    if (parent) children.set(parent, [...children.get(parent) ?? [], record.recordName]);
  }
  return children;
}

/** Query-only discovery; mutation inspection also resolves the native inventory below. */
export async function listChildren(client: Pick<CloudKitRemindersClient, "queryRemindersPage">, owner: string, listId: string) {
  return childRelationships(await scanListReminders(client, owner, listId), owner);
}

/** Resolve query and native membership identities exactly, without trusting index freshness. */
export async function inspectListChildren(client: RelationshipClient,
  owner: string, list: CloudKitRecord): Promise<Map<string, string[]>> {
  assertOwnedReminder(list, owner);
  const snapshot = normalizeList(list);
  if (list.deleted || snapshot.deleted !== false || snapshot.isGroup === true || !list.recordChangeTag ||
    snapshot.reminderIds === null || new Set(snapshot.reminderIds).size !== snapshot.reminderIds.length) {
    throw new AppError("UNSUPPORTED_FEATURE", "Relationship inspection requires an exact live List with explicit, unambiguous membership.");
  }
  const largeInventory = snapshot.reminderIds.length > 1000;
  const queried = await scanListReminders(client, owner, list.recordName, largeInventory);
  const queryIds = new Set(queried.map(record => record.recordName));
  const ids = [...new Set([...queryIds, ...snapshot.reminderIds])];
  if (ids.length > (largeInventory ? MAX_LIST_MEMBERS : 1000)) throw new AppError("UNSUPPORTED_FEATURE", "The exact membership check exceeds its inspection budget.");
  const exact: CloudKitRecord[] = [];
  let bytes = 0;
  const batchSize = 200;
  const concurrency = largeInventory ? 4 : 1;
  for (let start = 0; start < ids.length; start += batchSize * concurrency) {
    const batches = Array.from({ length: Math.min(concurrency, Math.ceil((ids.length - start) / batchSize)) },
      (_, index) => ids.slice(start + index * batchSize, start + (index + 1) * batchSize));
    // Drain every read before raising any failure or releasing the session lease.
    const results = await Promise.allSettled(batches.map(batch => largeInventory && client.lookupRelationshipRecords
      ? client.lookupRelationshipRecords(batch) : client.lookup(batch)));
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failures.length) throw (failures.find(result => result.reason instanceof AppError &&
      ["REAUTH_REQUIRED", "FORBIDDEN"].includes(result.reason.code)) ?? failures[0]).reason;
    for (const [index, result] of results.entries()) {
      if (result.status !== "fulfilled") throw new AppError("PROTOCOL_CHANGED", "An exact membership read did not settle.");
      const batch = batches[index], found = result.value;
      const missing = found.recordErrors.filter(error => error.serverErrorCode.toUpperCase() === "NOT_FOUND" &&
        error.recordName !== null && batch.includes(error.recordName));
      requireNoReadErrors(found.recordErrors.filter(error => !missing.includes(error)));
      const answers = [...found.records.map(record => record.recordName), ...missing.map(error => error.recordName!)];
      if (found.unresolvedRecordNames.length || answers.length !== batch.length || new Set(answers).size !== batch.length ||
        answers.some(id => !batch.includes(id)) || !found.complete && missing.length === 0) {
        throw new AppError("CONFLICT", "Every membership identity must resolve before relationship planning.", 409);
      }
      // Native ordering can retain retired IDs; definite absence is safe only for those entries.
      if (missing.some(error => queryIds.has(error.recordName!))) {
        throw new AppError("CONFLICT", "A queried reminder disappeared during relationship inspection.", 409);
      }
      for (const record of found.records) {
        bytes += jsonBytes(record);
        if (bytes > (largeInventory ? 8_388_608 : 262_144)) throw new AppError("UNSUPPORTED_FEATURE", "The exact membership check exceeds its inspection budget.");
        if (record.deleted) continue;
        if (!("recordType" in record) || record.recordType !== "Reminder") throw new AppError("PROTOCOL_CHANGED", "The membership lookup returned an unexpected record type.");
        assertOwnedReminder(record, owner);
        const reminder = normalizeReminderRelationships(record, owner);
        if (reminder.deleted === true) continue;
        if (reminder.deleted !== false || reminder.listId !== list.recordName || !record.recordChangeTag) {
          throw new AppError("CONFLICT", "The exact live membership changed or could not be established.", 409);
        }
        if (Object.keys(record.fields).some(field => /parent|child|subtask/i.test(field) && field !== "ParentReminder")) {
          throw new AppError("UNSUPPORTED_FEATURE", "Unknown relationship fields prevent complete membership inspection.");
        }
        exact.push(record);
      }
    }
  }
  return childRelationships(exact, owner);
}

export const HAS_SUBTASKS_MESSAGE = "This reminder has subtasks. Moving or deleting a parent is unsupported.";
export async function requireNoChildren(client: RelationshipClient, owner: string, list: CloudKitRecord, reminderId: string) {
  if ((await inspectListChildren(client, owner, list)).has(reminderId)) throw new AppError("UNSUPPORTED_FEATURE", HAS_SUBTASKS_MESSAGE);
}

export async function subtaskParents(client: Pick<CloudKitRemindersClient, "lookup" | "queryRemindersPage">,
  owner: string, listId: string, current: CloudKitRecord | null, parent: z.infer<typeof ParentReminderInput> | null, list: CloudKitRecord) {
  const target = current ? requireSimple(current, listId, owner) : null;
  if (parent?.reminderId === current?.recordName) throw new AppError("VALIDATION_ERROR", "A reminder cannot be its own parent.", 400);
  if (target && target.parentReminderId === (parent?.reminderId ?? null)) throw new AppError("VALIDATION_ERROR", "The requested parent relationship is already present.", 400);
  const ids = [...new Set([target?.parentReminderId, parent?.reminderId].filter((id): id is string => !!id))];
  const parents: CloudKitRecord[] = [];
  if (ids.length) {
    const found = await client.lookup(ids);
    requireNoReadErrors(found.recordErrors);
    if (!found.complete || found.recordErrors.length || found.unresolvedRecordNames.length || found.records.length !== ids.length ||
      new Set(found.records.map(record => record.recordName)).size !== ids.length) throw new AppError("CONFLICT", "The affected parents could not all be resolved.", 409);
    for (const record of found.records) {
      if (!("recordType" in record) || record.recordType !== "Reminder" || !ids.includes(record.recordName)) {
        throw new AppError("PROTOCOL_CHANGED", "Apple returned an unexpected parent record.");
      }
      const reminder = requireSimple(record, listId, owner);
      if (reminder.parentReminderId) throw new AppError("UNSUPPORTED_FEATURE", "Only one level of subtasks is supported; the destination and previous parent must be root reminders.");
      if (parent?.reminderId === record.recordName && parent.recordChangeTag !== record.recordChangeTag) {
        throw new AppError("CONFLICT", "The destination parent changed; no relationship was modified.", 409);
      }
      parents.push({ ...record, zoneID: record.zoneID ?? { zoneName: "Reminders", ownerRecordName: owner } });
    }
  }
  if (current) await requireNoChildren(client, owner, list, current.recordName);
  return parents;
}

export function buildCreateSubtask(input: z.infer<typeof CreateSubtaskInput>, now = Date.now()): CloudKitWriteRecord {
  const parsed = CreateSubtaskInput.parse(input);
  if (parsed.dueDate != null || parsed.timeZone != null || parsed.allDay) {
    throw new AppError("UNSUPPORTED_FEATURE", "Initial subtask creation supports undated reminders only.");
  }
  const write = buildCreateReminder(omitField(parsed, "parentReminder"), now);
  if (write.recordName === parsed.parentReminder.reminderId) throw new AppError("VALIDATION_ERROR", "A reminder cannot be its own parent.", 400);
  write.fields.ParentReminder = { type: "REFERENCE", value: { recordName: parsed.parentReminder.reminderId, action: "VALIDATE" } };
  return write;
}

export function buildSetReminderParent(input: z.infer<typeof SetReminderParentInput>, current: CloudKitRecord, owner: string, now = Date.now()): CloudKitWriteRecord {
  const parsed = SetReminderParentInput.parse(input);
  const reminder = requireSimple(current, parsed.listId, owner);
  if (current.recordName !== parsed.reminderId || current.recordChangeTag !== parsed.recordChangeTag) {
    throw new AppError("CONFLICT", "The reminder changed before its parent update.", 409);
  }
  if (parsed.parentReminder?.reminderId === parsed.reminderId) throw new AppError("VALIDATION_ERROR", "A reminder cannot be its own parent.", 400);
  if ((parsed.parentReminder?.reminderId ?? null) === reminder.parentReminderId) throw new AppError("VALIDATION_ERROR", "The requested parent relationship is already present.", 400);
  if (!Number.isSafeInteger(now)) throw new AppError("VALIDATION_ERROR", "The parent update timestamp is invalid.", 400);
  return { recordName: parsed.reminderId, recordType: "Reminder", recordChangeTag: parsed.recordChangeTag, fields: {
    ParentReminder: { type: "REFERENCE", value: parsed.parentReminder ? { recordName: parsed.parentReminder.reminderId, action: "VALIDATE" } : null },
    LastModifiedDate: { type: "TIMESTAMP", value: now },
    ResolutionTokenMap: { type: "STRING", value: updateResolutionTokenMap(current, ["parentReminder", "lastModifiedDate"], now) },
  } };
}
