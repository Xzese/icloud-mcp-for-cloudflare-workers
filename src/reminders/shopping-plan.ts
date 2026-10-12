import { AppError } from "../errors.ts";
import { canonicalJSON } from "../lib/canonical.ts";
import { stableNativePresentation } from "../lib/native-presentation.ts";
import { normalizeList, normalizeReminder, referenceField, intrinsicParentIdentity, type CloudKitRecord, type CloudKitRemindersClient } from "../icloud/cloudkit.ts";
import { requireMutableList, type ListWrite } from "./list-writes.ts";
import { assertOwnedReminder, updateResolutionTokenMap, type CloudKitWriteRecord } from "./writes.ts";
import { decodeSectionMemberships, decodeGroceryCorrections, decodeSectionOrdering, encodeSectionMemberships, encodeGroceryCorrections,
  membershipsChecksum, groceryCorrectionsChecksum, type ShoppingSectionMemberships, type ShoppingGroceryCorrections,
  type SetShoppingCategoryRequestData } from "./shopping-categories.ts";

function value(record: CloudKitRecord, key: string, type: string, optional = false): unknown {
  const field = record.fields[key];
  if (optional && field === undefined) return undefined;
  if (!field || typeof field !== "object" || Array.isArray(field) || !("type" in field) || field.type !== type || !("value" in field))
    throw new AppError("UNSUPPORTED_FEATURE", `The native ${record.recordType}.${key} shape is unsupported.`);
  return field.value;
}

export function requireShoppingList(record: CloudKitRecord, owner: string, tag?: string) {
  requireMutableList(record, owner, tag);
  if (value(record, "ShouldCategorizeGroceryItems", "INT64") !== 1)
    throw new AppError("UNSUPPORTED_FEATURE", "Choose an existing owned Shopping list.");
  return normalizeList(record);
}

export function categorySummary(record: CloudKitRecord, owner: string, listId: string, tag?: string) {
  if (record.recordType !== "ListSection" || !/^ListSection\/[0-9A-F-]{36}$/.test(record.recordName) || record.deleted ||
    record.raw.share != null || record.zoneID?.zoneName !== "Reminders" ||
    ![undefined, "REGULAR_CUSTOM_ZONE"].includes(record.zoneID.zoneType) ||
    ![undefined, "__defaultOwner__", owner].includes(record.zoneID.ownerRecordName) || referenceField(record, "List", "List", owner) !== listId)
    throw new AppError("FORBIDDEN", "The category is not part of the selected owned private list.", 403);
  if (!record.recordChangeTag || tag !== undefined && tag !== record.recordChangeTag || value(record, "Deleted", "INT64") !== 0)
    throw new AppError("CONFLICT", "The destination category changed. Read its current state.", 409);
  const intrinsicParent = intrinsicParentIdentity(record, owner);
  if (tag !== undefined && intrinsicParent === null) throw new AppError("UNSUPPORTED_FEATURE", "The category has no verified native parent.");
  const name = value(record, "DisplayName", "STRING"), canonicalName = value(record, "CanonicalName", "STRING", true);
  if (typeof name !== "string" || name.length < 1 || name.length > 256 ||
    canonicalName !== undefined && (typeof canonicalName !== "string" || canonicalName.length > 256))
    throw new AppError("PROTOCOL_CHANGED", "Apple returned invalid category names.");
  return { categoryId: record.recordName, name, canonicalName: canonicalName ?? null, recordChangeTag: record.recordChangeTag };
}

export async function loadShoppingAssets(client: Pick<CloudKitRemindersClient, "downloadSectionAsset">, list: CloudKitRecord, includeCorrections = false) {
  let memberships: ShoppingSectionMemberships = { minimumSupportedVersion: 20230430, memberships: [] };
  if (list.fields.MembershipsOfRemindersInSectionsAsData !== undefined) {
    memberships = decodeSectionMemberships(await client.downloadSectionAsset(list.fields.MembershipsOfRemindersInSectionsAsData));
    if (value(list, "MembershipsOfRemindersInSectionsChecksum", "STRING") !== await membershipsChecksum(memberships))
      throw new AppError("PROTOCOL_CHANGED", "The native category membership checksum did not match.");
  } else if (list.fields.MembershipsOfRemindersInSectionsChecksum !== undefined)
    throw new AppError("UNSUPPORTED_FEATURE", "Category membership metadata is incomplete.");
  const ordering = list.fields.SectionIDsOrderingAsData === undefined ? { minimumSupportedVersion: 20230430 as const, orderedIdentifiers: [] } :
    decodeSectionOrdering(await client.downloadSectionAsset(list.fields.SectionIDsOrderingAsData));
  let corrections: ShoppingGroceryCorrections = { lastResetDate: null, memberships: {} };
  if (includeCorrections && list.fields.GroceryLocalCorrectionsAsData !== undefined) {
    corrections = decodeGroceryCorrections(await client.downloadSectionAsset(list.fields.GroceryLocalCorrectionsAsData));
    if (value(list, "GroceryLocalCorrectionsChecksum", "STRING") !== await groceryCorrectionsChecksum(corrections))
      throw new AppError("PROTOCOL_CHANGED", "The native grocery learning checksum did not match.");
  } else if (includeCorrections && list.fields.GroceryLocalCorrectionsChecksum !== undefined)
    throw new AppError("UNSUPPORTED_FEATURE", "Grocery learning metadata is incomplete.");
  return { memberships, ordering, corrections };
}

export async function planShoppingCategory(input: SetShoppingCategoryRequestData, root: CloudKitRecord, list: CloudKitRecord,
  category: CloudKitRecord, state: Awaited<ReturnType<typeof loadShoppingAssets>>, owner: string, now = Date.now()) {
  const normalizedList = requireShoppingList(list, owner, input.listRecordChangeTag);
  categorySummary(category, owner, input.listId, input.categoryRecordChangeTag);
  assertOwnedReminder(root, owner);
  const reminder = normalizeReminder(root, owner);
  if (root.recordName !== input.reminderId || list.recordName !== input.listId || category.recordName !== input.categoryId ||
    root.recordChangeTag !== input.recordChangeTag || reminder.listId !== input.listId || reminder.completed !== false || reminder.deleted !== false)
    throw new AppError("CONFLICT", "The selected reminder or Shopping list changed.", 409);
  // Rewriting a wrapper must not discard encryption or future native metadata.
  for (const [record, keys] of [[root, ["LastModifiedDate", "ResolutionTokenMap"]],
    [list, ["MembershipsOfRemindersInSectionsAsData", "MembershipsOfRemindersInSectionsChecksum", "GroceryLocalCorrectionsAsData", "GroceryLocalCorrectionsChecksum", "ReminderIDs", "ResolutionTokenMap"]],
    [category, ["Deleted"]]] as const) {
    for (const key of keys) {
      const field = record.fields[key];
      if (field === undefined && key.startsWith("GroceryLocalCorrections")) continue;
      const encryptedChecksum = key.endsWith("Checksum");
      if (!field || typeof field !== "object" || Array.isArray(field) || Object.keys(field).length !== (encryptedChecksum ? 3 : 2) ||
        !Object.hasOwn(field, "type") || !Object.hasOwn(field, "value") || encryptedChecksum && (!("isEncrypted" in field) || field.isEncrypted !== true))
        throw new AppError("UNSUPPORTED_FEATURE", "Unknown native field metadata prevents a category move.");
    }
  }
  const assignments = root.fields.AssignmentIDs;
  if (assignments !== undefined && (!assignments || typeof assignments !== "object" || Array.isArray(assignments) ||
    !("type" in assignments) || !["UNKNOWN_LIST", "STRING_LIST"].includes(String(assignments.type)) || !("value" in assignments) ||
    !Array.isArray(assignments.value) || assignments.value.length !== 0 || Object.keys(assignments).length !== 2))
    throw new AppError("UNSUPPORTED_FEATURE", "The reminder's assignment metadata is not a known empty collection.");
  if (reminder.parentReminderId || reminder.dueDate || reminder.startDate || reminder.timeZone || reminder.allDay === true ||
    reminder.alarmIds?.length || reminder.recurrenceRuleIds?.length ||
    Object.keys(root.fields).some(key => /child|subtask|assignment|section/i.test(key) && key !== "AssignmentIDs") ||
    Array.isArray((root.fields.AssignmentIDs as { value?: unknown })?.value) && (root.fields.AssignmentIDs as { value: unknown[] }).value.length)
    throw new AppError("UNSUPPORTED_FEATURE", "Category moves currently require ordinary open undated root reminders without alarms, recurrence or assignment.");
  const title = reminder.title;
  if (!title || title.length > 256 || !/^[\x20-\x7e]+$/.test(title) || !title.trim() || title.toLowerCase() === "__proto__")
    throw new AppError("UNSUPPORTED_FEATURE", "The native grocery learning recipe currently supports visible ASCII reminder titles.");
  const idsField = list.fields.ReminderIDs as { type?: unknown; value?: unknown } | undefined;
  const members = normalizedList.reminderIds;
  if (idsField?.type !== "STRING" || typeof idsField.value !== "string" || !members || members.length > 2000 ||
    members.some(id => !/^Reminder\/[0-9A-F-]{36}$/.test(id)) || new Set(members).size !== members.length || !members.includes(input.reminderId))
    throw new AppError("UNSUPPORTED_FEATURE", "Category moves require explicit unique native List membership.");
  const memberID = input.reminderId.slice("Reminder/".length), groupID = input.categoryId.slice("ListSection/".length);
  if (!/^[0-9A-F-]{36}$/.test(memberID)) throw new AppError("UNSUPPORTED_FEATURE", "The reminder has an unsupported native identity.");
  if (state.memberships.memberships.find(entry => entry.memberID === memberID)?.groupID === groupID)
    throw new AppError("CONFLICT", "The reminder already belongs to this category.", 409);
  const modifiedOn = now / 1000 - 978307200;
  const memberships = { ...state.memberships, memberships: [...state.memberships.memberships.filter(entry => entry.memberID !== memberID), { memberID, groupID, modifiedOn }] };
  const corrections = { ...state.corrections, memberships: { ...state.corrections.memberships, [title.toLowerCase()]: { identifier: groupID, modifiedOn } } };
  const data = { MembershipsOfRemindersInSectionsAsData: encodeSectionMemberships(memberships), GroceryLocalCorrectionsAsData: encodeGroceryCorrections(corrections) };
  const rootWrite: CloudKitWriteRecord = { recordName: root.recordName, recordType: "Reminder", recordChangeTag: root.recordChangeTag,
    fields: { LastModifiedDate: { type: "TIMESTAMP", value: now }, ResolutionTokenMap: { type: "STRING", value: updateResolutionTokenMap(root, ["lastModifiedDate"], now) } } };
  const rawMembers = JSON.parse(idsField.value) as string[];
  const selectedRepresentation = rawMembers.find(id => (id.startsWith("Reminder/") ? id : `Reminder/${id}`) === input.reminderId)!;
  const fields: ListWrite["fields"] = {
    MembershipsOfRemindersInSectionsChecksum: { type: "STRING", value: await membershipsChecksum(memberships), isEncrypted: true },
    GroceryLocalCorrectionsChecksum: { type: "STRING", value: await groceryCorrectionsChecksum(corrections), isEncrypted: true },
    ReminderIDs: { type: "STRING", value: JSON.stringify([...rawMembers.filter(id => id !== selectedRepresentation), selectedRepresentation]) },
    ResolutionTokenMap: { type: "STRING", value: updateResolutionTokenMap(list,
      ["membershipsOfRemindersInSectionsChecksum", "autoCategorizationLocalCorrectionsChecksum", "reminderIDsMergeableOrdering"], now) },
  };
  return { rootWrite, fields, data, memberships, corrections };
}

export function verifyShoppingPreservation(before: CloudKitRecord, after: CloudKitRecord, changedFields: string[], owner: string) {
  const unchanged = (record: CloudKitRecord) => Object.fromEntries(Object.entries(stableNativePresentation(record.fields)).filter(([key]) => !changedFields.includes(key)));
  const parent = (record: CloudKitRecord) => ["Reminder", "ListSection"].includes(record.recordType) ? intrinsicParentIdentity(record, owner) : canonicalJSON(record.raw.parent ?? null);
  if (before.recordName !== after.recordName || before.recordType !== after.recordType || before.recordChangeTag === after.recordChangeTag ||
    canonicalJSON(unchanged(before)) !== canonicalJSON(unchanged(after)) || parent(before) !== parent(after))
    throw new AppError("PROTOCOL_CHANGED", "The category move did not preserve the native record context.");
}
