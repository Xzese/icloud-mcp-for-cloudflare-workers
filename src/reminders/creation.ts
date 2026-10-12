import { AppError } from "../errors.ts";
import { normalizeList, type CloudKitRecord } from "../icloud/cloudkit.ts";
import { requireMutableList, type ListWrite } from "./list-writes.ts";
import { updateResolutionTokenMap, type CloudKitWriteRecord } from "./writes.ts";

/** Keep new identities discoverable before Apple's compound query index catches up. */
export function creationMembership(reminder: CloudKitWriteRecord, list: CloudKitRecord, owner: string): ListWrite {
  requireMutableList(list, owner);
  if (reminder.parent?.recordName !== list.recordName || reminder.fields.List?.value === null ||
    (reminder.fields.List?.value as { recordName?: unknown })?.recordName !== list.recordName) {
    throw new AppError("FORBIDDEN", "Creation must use its exact owned parent List.", 403);
  }
  const members = normalizeList(list).reminderIds;
  if (members === null || members.length >= 2000 || new Set(members.map(id => id.toUpperCase())).size !== members.length) {
    throw new AppError("UNSUPPORTED_FEATURE", "Creation requires explicit, bounded and unambiguous native List membership.");
  }
  if (members.some(id => id.toUpperCase() === reminder.recordName.toUpperCase())) {
    throw new AppError("CONFLICT", "The creation identity is already in List ordering; reconcile that exact reminder first.", 409);
  }
  const previous = JSON.parse(String((list.fields.ReminderIDs as { value: unknown }).value)) as string[];
  const timestamp = reminder.fields.CreationDate?.value;
  if (!Number.isSafeInteger(timestamp)) throw new AppError("VALIDATION_ERROR", "Creation requires its retained timestamp.", 400);
  return { recordName: list.recordName, recordType: "List", recordChangeTag: list.recordChangeTag, fields: {
    ReminderIDs: { type: "STRING", value: JSON.stringify([...previous, reminder.recordName.slice("Reminder/".length)]) },
    ResolutionTokenMap: { type: "STRING", value: updateResolutionTokenMap(list, ["reminderIDsMergeableOrdering"], Number(timestamp)) },
  } };
}
