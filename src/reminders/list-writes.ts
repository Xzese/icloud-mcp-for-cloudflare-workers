import { z } from "zod";
import { AppError } from "../errors.ts";
import { createResolutionTokenMap, updateResolutionTokenMap } from "./writes.ts";
import { normalizeList, type CloudKitRecord } from "../icloud/cloudkit.ts";

const safeName = z.string().min(1).max(256).refine(value =>
  value.trim().length > 0 && !/[\u0000-\u001f\u007f-\u009f]/.test(value) &&
  !/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u.test(value),
  "List names must contain visible text and no invalid control characters.");
const listId = z.string().min(6).max(255).regex(/^List\/[\x21-\x2e\x30-\x7e]+$/)
  .describe("Exact list ID returned by a Reminders list read; do not use a title or invent an ID.");
const version = z.string().min(1).max(512).refine(value => !/[\u0000-\u001f\u007f]/.test(value))
  .describe("Current Apple version tag returned by the list read. A stale tag returns CONFLICT; refresh before making a new write.");
const name = safeName.describe("Visible, nonblank list name, up to 256 characters.");
export const CreateListInput = z.object({ name, idempotencyKey: z.string().uuid()
  .describe("Generate one UUID for this new list and retain it to reconcile an uncertain creation; never replace it for the same attempt.") }).strict();
export const RenameListInput = z.object({ listId, recordChangeTag: version, name }).strict();
export const DeleteListInput = z.object({ listId, recordChangeTag: version, confirmName: safeName
  .describe("Exact current list name required to confirm deletion.") }).strict();
export type ListOperation = "create" | "rename" | "delete";
export type ListWrite = { recordName: string; recordType: "List"; recordChangeTag?: string;
  fields: Record<string, { type: string; value: unknown; isEncrypted?: boolean }> };

const CREATE_TOKEN_FIELDS = ["minimumSupportedVersion", "sortingStyle", "parentAccount", "name",
  "shouldAutoCategorizeItems", "shouldCategorizeGroceryItems", "reminderIDsMergeableOrdering"] as const;

export function requireMutableList(record: CloudKitRecord, expectedOwner: string, tag?: string) {
  if (record.recordType !== "List" || record.deleted || record.zoneID?.zoneName !== "Reminders" ||
    (record.zoneID.zoneType !== undefined && record.zoneID.zoneType !== "REGULAR_CUSTOM_ZONE") ||
    (record.raw.share !== undefined && record.raw.share !== null) ||
    ![undefined, "__defaultOwner__", expectedOwner].includes(record.zoneID?.ownerRecordName)) {
    throw new AppError("FORBIDDEN", "The requested list is not an owned private Reminders list.", 403);
  }
  const normalized = normalizeList(record, false);
  if (normalized.deleted || normalized.isGroup !== false || !normalized.title || !record.recordChangeTag)
    throw new AppError("UNSUPPORTED_FEATURE", "Only owned, named, non-group lists with a version tag are supported.");
  if (tag !== undefined && tag !== record.recordChangeTag)
    throw new AppError("CONFLICT", "The list version changed. Refresh the list before continuing.", 409);
  return normalized;
}

export function buildCreateList(value: z.infer<typeof CreateListInput>, now = Date.now()): ListWrite {
  const input = CreateListInput.parse(value);
  return { recordName: `List/${input.idempotencyKey.toUpperCase()}`, recordType: "List", fields: {
    Name: { type: "STRING", value: input.name, isEncrypted: true },
    SortingStyle: { type: "STRING", value: "manual" },
    IsLinkedToAccount: { type: "INT64", value: 1 },
    Imported: { type: "INT64", value: 0 },
    IsGroup: { type: "INT64", value: 0 },
    Deleted: { type: "INT64", value: 0 },
    ReminderIDs: { type: "STRING", value: "[]" },
    ShouldAutoCategorizeItems: { type: "INT64", value: 0, isEncrypted: true },
    ShouldCategorizeGroceryItems: { type: "INT64", value: 0, isEncrypted: true },
    ResolutionTokenMap: { type: "STRING", value: createResolutionTokenMap(CREATE_TOKEN_FIELDS, now) },
  } };
}

export function buildRenameList(value: z.infer<typeof RenameListInput>, current: CloudKitRecord, owner: string, now = Date.now()): ListWrite {
  const input = RenameListInput.parse(value);
  if (current.recordName !== input.listId) throw new AppError("CONFLICT", "The list identity changed.", 409);
  const before = requireMutableList(current, owner, input.recordChangeTag);
  if (before.title === input.name) throw new AppError("CONFLICT", "The list already has this name.", 409);
  return { recordName: input.listId, recordType: "List", recordChangeTag: input.recordChangeTag, fields: {
    Name: { type: "STRING", value: input.name, isEncrypted: true },
    ResolutionTokenMap: { type: "STRING", value: updateResolutionTokenMap(current, ["name"], now) },
  } };
}

export function buildDeleteList(value: z.infer<typeof DeleteListInput>, current: CloudKitRecord, owner: string, now = Date.now()): ListWrite {
  const input = DeleteListInput.parse(value);
  if (current.recordName !== input.listId) throw new AppError("CONFLICT", "The list identity changed.", 409);
  const before = requireMutableList(current, owner, input.recordChangeTag);
  if (before.title !== input.confirmName) throw new AppError("CONFLICT", "The confirmed name does not match the current list.", 409);
  return { recordName: input.listId, recordType: "List", recordChangeTag: input.recordChangeTag, fields: {
    Deleted: { type: "INT64", value: 1 },
    IsLinkedToAccount: { type: "INT64", value: 0 },
    ResolutionTokenMap: { type: "STRING", value: updateResolutionTokenMap(current, ["parentAccount"], now) },
  } };
}
