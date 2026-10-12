import { z } from "zod";
import { AppError } from "../errors.ts";
import { CloudKitRateLimitedError, normalizeReminder, type CloudKitRecord, type CloudKitRemindersClient } from "../icloud/cloudkit.ts";
import { jsonBytes } from "../lib/canonical.ts";
import { omitField } from "../lib/omit-field.ts";
import { CreateReminderInput, ReminderTargetInput, assertOwnedReminder, buildCreateReminder, updateResolutionTokenMap, type CloudKitWriteRecord } from "./writes.ts";

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

function requireNoReadErrors(errors: { serverErrorCode: string }[]) {
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

/** Complete bounded scan of one list, returning every nondeleted parent ID and its nondeleted child IDs. */
export async function listChildren(client: Pick<CloudKitRemindersClient, "queryRemindersPage">, owner: string, listId: string): Promise<Map<string, string[]>> {
  let continuation: string | null = null, bytes = 0, count = 0;
  const seen = new Set<string>(), children = new Map<string, string[]>();
  for (let index = 0; index < 5; index++) {
    const page = await client.queryRemindersPage({ listId, includeCompleted: true, limit: 200, continuation });
    requireNoReadErrors(page.recordErrors);
    for (const record of page.records) {
      bytes += jsonBytes(record);
      if (bytes > 262_144 || ++count > 1000) throw new AppError("UNSUPPORTED_FEATURE", "The complete child check exceeds its inspection budget.");
      if ("recordType" in record && record.recordType === "Reminder" && !record.deleted) {
        const reminder = normalizeReminder(record, owner);
        if (reminder.listId !== listId) throw new AppError("PROTOCOL_CHANGED", "The child check returned a reminder from another list.");
        if (reminder.parentReminderId && reminder.deleted !== true) children.set(reminder.parentReminderId, [...children.get(reminder.parentReminderId) ?? [], record.recordName]);
      }
    }
    if (page.paginationComplete) {
      if (!page.complete) throw new AppError("UNSUPPORTED_FEATURE", "The child check is incomplete; no mutation was dispatched.");
      return children;
    }
    if (!page.continuation || seen.has(page.continuation)) throw new AppError("PROTOCOL_CHANGED", "The child-check continuation did not advance.");
    continuation = page.continuation; seen.add(continuation);
  }
  throw new AppError("UNSUPPORTED_FEATURE", "The child check did not finish; absence of descendants is not established.");
}

export const HAS_SUBTASKS_MESSAGE = "This reminder has subtasks. Moving a parent, descendant cascades and parent lifecycle actions are unsupported.";
export async function requireNoChildren(client: Pick<CloudKitRemindersClient, "queryRemindersPage">, owner: string, listId: string, reminderId: string) {
  if ((await listChildren(client, owner, listId)).has(reminderId)) throw new AppError("UNSUPPORTED_FEATURE", HAS_SUBTASKS_MESSAGE);
}

export async function subtaskParents(client: Pick<CloudKitRemindersClient, "lookup" | "queryRemindersPage">,
  owner: string, listId: string, current: CloudKitRecord | null, parent: z.infer<typeof ParentReminderInput> | null) {
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
  if (current) await requireNoChildren(client, owner, listId, current.recordName);
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
