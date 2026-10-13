import { z } from "zod";
import { AppError } from "../errors.ts";
import { normalizeList, normalizeReminder, type CloudKitRecord } from "../icloud/cloudkit.ts";
import { requireMutableList, type ListWrite } from "./list-writes.ts";
import { ReminderTargetInput, assertOwnedReminder, buildCreateReminder, updateResolutionTokenMap, type CloudKitWriteRecord } from "./writes.ts";
import { normalizeReminderTag, normalizeURLAttachment, planTagChange, planURLChange, type OrganizationPlan } from "./organization.ts";
import { ListId } from "./identifiers.ts";

export const MoveReminderInput = ReminderTargetInput.extend({
  destinationListId: ListId.describe("Exact destination owned private list ID."),
  sourceListChangeTag: ReminderTargetInput.shape.recordChangeTag.describe("Current source list tag from get_reminder_list."),
  destinationListChangeTag: ReminderTargetInput.shape.recordChangeTag.describe("Current destination list tag from get_reminder_list."),
}).strict();
export const CopyReminderInput = MoveReminderInput.extend({
  idempotencyKey: z.string().uuid().describe("One stable UUID for the copied reminder. Retain it after uncertainty; reconcile that identity before another request."),
}).strict();

export interface TransferPlan {
  root: CloudKitWriteRecord;
  memberships: ListWrite[];
  listSnapshots: CloudKitRecord[];
  dependencies: { operationType: "create"; record: OrganizationPlan["dependencies"][number]["record"] }[];
  guards: CloudKitRecord[];
}

export function requireOrdinaryTransfer(root: CloudKitRecord, owner: string, input: z.infer<typeof MoveReminderInput>) {
  assertOwnedReminder(root, owner);
  const reminder = normalizeReminder(root, owner);
  if (root.recordType !== "Reminder" || root.recordName !== input.reminderId || root.recordChangeTag !== input.recordChangeTag ||
      reminder.listId !== input.listId || reminder.completed !== false || reminder.deleted !== false || root.deleted) {
    throw new AppError("CONFLICT", "The transfer source changed or is no longer an open reminder in the source list.", 409);
  }
  if (reminder.parentReminderId || reminder.dueDate || reminder.startDate || reminder.timeZone || reminder.allDay === true ||
      reminder.alarmIds?.length || reminder.recurrenceRuleIds?.length || Object.hasOwn(root.fields, "DueDateDeltaAlertsData") ||
      Object.keys(root.fields).some(key => /child|subtask|assignment|section/i.test(key) && key !== "AssignmentIDs") ||
      Array.isArray((root.fields.AssignmentIDs as { value?: unknown })?.value) && (root.fields.AssignmentIDs as { value: unknown[] }).value.length > 0) {
    throw new AppError("UNSUPPORTED_FEATURE", "Transfers currently support undated ordinary root reminders without recurrence, alarms, assignment, sections or descendants.");
  }
  if (input.listId === input.destinationListId) throw new AppError("VALIDATION_ERROR", "Choose a different destination list.", 400);
  return reminder;
}

function listMembers(record: CloudKitRecord, owner: string, id: string, tag: string): string[] {
  if (record.recordName !== id) throw new AppError("CONFLICT", "The transfer list identity changed.", 409);
  requireMutableList(record, owner, tag);
  const members = normalizeList(record).reminderIds;
  if (members === null || members.some(member => !/^Reminder\/[0-9a-f-]{36}$/i.test(member)) || new Set(members.map(member => member.toUpperCase())).size !== members.length) {
    throw new AppError("UNSUPPORTED_FEATURE", "Transfer requires explicit, bounded, unique list membership.");
  }
  return members;
}

function membershipWrite(record: CloudKitRecord, members: string[], now: number): ListWrite {
  if (members.length > 2000) throw new AppError("UNSUPPORTED_FEATURE", "Destination list membership exceeds the transfer budget.");
  const field = record.fields.ReminderIDs as { type?: unknown; value?: unknown };
  if (field?.type !== "STRING" || typeof field.value !== "string") throw new AppError("UNSUPPORTED_FEATURE", "Transfer requires native JSON list membership.");
  const previous = JSON.parse(field.value) as string[];
  const representation = new Map(previous.map(id => [(id.startsWith("Reminder/") ? id : `Reminder/${id}`).toUpperCase(), id]));
  return { recordName: record.recordName, recordType: "List", recordChangeTag: record.recordChangeTag, fields: {
    ReminderIDs: { type: "STRING", value: JSON.stringify(members.map(id => representation.get(id.toUpperCase()) ?? id.slice("Reminder/".length))) },
    ResolutionTokenMap: { type: "STRING", value: updateResolutionTokenMap(record, ["reminderIDsMergeableOrdering"], now) },
  } };
}

function scoped(record: CloudKitRecord, owner: string): CloudKitRecord {
  return { ...record, zoneID: record.zoneID ?? { zoneName: "Reminders", zoneType: "REGULAR_CUSTOM_ZONE", ownerRecordName: owner } };
}

export function planReminderTransfer(action: "move" | "copy", input: z.infer<typeof MoveReminderInput> | z.infer<typeof CopyReminderInput>,
  source: CloudKitRecord, sourceList: CloudKitRecord, destinationList: CloudKitRecord, attachments: CloudKitRecord[], hashtags: CloudKitRecord[], owner: string, now = Date.now()): TransferPlan {
  const parsed = action === "copy" ? CopyReminderInput.parse(input) : MoveReminderInput.parse(input);
  const reminder = requireOrdinaryTransfer(source, owner, parsed);
  const from = listMembers(sourceList, owner, parsed.listId, parsed.sourceListChangeTag);
  const to = listMembers(destinationList, owner, parsed.destinationListId, parsed.destinationListChangeTag);
  if (!from.some(id => id.toUpperCase() === parsed.reminderId.toUpperCase()) || to.some(id => id.toUpperCase() === parsed.reminderId.toUpperCase())) {
    throw new AppError("CONFLICT", "Source and destination membership no longer agree with the requested transfer.", 409);
  }
  if (attachments.length !== (reminder.attachmentIds?.length ?? 0) || hashtags.length !== (reminder.hashtagIds?.length ?? 0)) {
    throw new AppError("UNSUPPORTED_FEATURE", "The transfer's related records were not completely resolved.");
  }
  const urls = attachments.map(record => normalizeURLAttachment(record, reminder.id, owner));
  const tags = hashtags.map(record => normalizeReminderTag(record, reminder.id, owner));
  if (urls.length > 1) throw new AppError("UNSUPPORTED_FEATURE", "Only one URL and ordinary tag records can be transferred; other attachments are excluded.");
  const related = [...attachments, ...hashtags].map(record => scoped(record, owner));
  if (action === "move") {
    const root: CloudKitWriteRecord = { recordName: reminder.id, recordType: "Reminder", recordChangeTag: parsed.recordChangeTag,
      parent: { recordName: parsed.destinationListId }, fields: {
        List: { type: "REFERENCE", value: { recordName: parsed.destinationListId, action: "VALIDATE" } },
        LastModifiedDate: { type: "TIMESTAMP", value: now },
        ResolutionTokenMap: { type: "STRING", value: updateResolutionTokenMap(source, ["list", "lastModifiedDate"], now) },
      } };
    return { root, memberships: [membershipWrite(sourceList, from.filter(id => id.toUpperCase() !== reminder.id.toUpperCase()), now), membershipWrite(destinationList, [...to, reminder.id], now)],
      listSnapshots: [sourceList, destinationList], dependencies: [], guards: related };
  }
  const copy = parsed as z.infer<typeof CopyReminderInput>;
  const priority = reminder.priority ?? 0;
  if (![0, 1, 5, 9].includes(priority)) throw new AppError("UNSUPPORTED_FEATURE", "The source priority cannot be copied faithfully.");
  let root = buildCreateReminder({ listId: copy.destinationListId, idempotencyKey: copy.idempotencyKey,
    title: reminder.title ?? "", notes: reminder.notes ?? "", priority: priority as 0 | 1 | 5 | 9, flagged: reminder.flagged ?? false, allDay: false }, now);
  if (root.recordName.toUpperCase() === reminder.id.toUpperCase() || to.some(id => id.toUpperCase() === root.recordName.toUpperCase())) {
    throw new AppError("CONFLICT", "The copy identity already belongs to an existing reminder.", 409);
  }
  const dependencies: OrganizationPlan["dependencies"] = [];
  const virtual = (): CloudKitRecord => ({ ...root, recordChangeTag: "copy-preparation", zoneID: { zoneName: "Reminders", ownerRecordName: owner }, raw: {} });
  if (urls.length) {
    const urlPlan = planURLChange(virtual(), [], { url: urls[0].url }, owner, "copy-preparation", now);
    root = { ...root, fields: { ...root.fields, AttachmentIDs: urlPlan.root.fields.AttachmentIDs } };
    dependencies.push(...urlPlan.dependencies);
  }
  if (tags.length) {
    const tagPlan = planTagChange(virtual(), [], { tags: tags.map(tag => tag.name) }, owner, "copy-preparation", now);
    root = { ...root, fields: { ...root.fields, HashtagIDs: tagPlan.root.fields.HashtagIDs } };
    dependencies.push(...tagPlan.dependencies);
  }
  const creations = dependencies.map(item => {
    if (item.operationType !== "create") throw new AppError("PROTOCOL_CHANGED", "A fresh copy cannot retire a source relationship.");
    return { ...item, operationType: "create" as const };
  });
  return { root, memberships: [membershipWrite(destinationList, [...to, root.recordName], now)], listSnapshots: [destinationList], dependencies: creations,
    guards: [scoped(source, owner), scoped(sourceList, owner), ...related] };
}
