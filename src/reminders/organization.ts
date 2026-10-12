import { z } from "zod";
import { AppError } from "../errors.ts";
import { referenceField, type CloudKitRecord } from "../icloud/cloudkit.ts";
import { updateResolutionTokenMap, assertOwnedReminder, type CloudKitWriteRecord } from "./writes.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTROL_OR_WHITESPACE = /[\s\u0000-\u001f\u007f-\u009f]/u;

function validHttpURL(value: string): boolean {
  if (value.length > 2_048 || CONTROL_OR_WHITESPACE.test(value)) return false;
  try {
    const parsed = new URL(value);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && !parsed.username && !parsed.password;
  } catch { return false; }
}

const URLValue = z.string().min(1).max(2_048).refine(validHttpURL, "URL must be an HTTP(S) URL without credentials or whitespace.");
export const LiteralTagName = z.string().min(1).max(128).refine(value => !CONTROL_OR_WHITESPACE.test(value) &&
  !/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u.test(value),
  "Tag names must be exact literal names without whitespace, controls, or invalid Unicode.");

export const URLChanges = z.object({ url: URLValue.nullable().describe("One separate credential-free HTTP(S) URL, or null to remove the URL.") }).strict();
export const TagChanges = z.object({ tags: z.array(LiteralTagName).max(16).refine(values => new Set(values).size === values.length,
  "Tag names must be unique.").describe("Complete selection of up to 16 exact literal tag names; use an empty array to remove all tags.") }).strict();

export type OrganizationMutationRecord = {
  recordName: string;
  recordType: "Attachment" | "Hashtag";
  recordChangeTag?: string;
  fields: Record<string, { type: string; value: unknown; isEncrypted?: boolean }>;
};

export interface OrganizationPlan {
  root: CloudKitWriteRecord;
  dependencies: { operationType: "create" | "update"; record: OrganizationMutationRecord }[];
  guards: CloudKitRecord[];
}

function fail(code: "CONFLICT" | "UNSUPPORTED_FEATURE" | "PROTOCOL_CHANGED" | "FORBIDDEN" | "VALIDATION_ERROR", message: string): never {
  throw new AppError(code, message, code === "FORBIDDEN" ? 403 : code === "CONFLICT" ? 409 : 422);
}

function wrapper(record: CloudKitRecord, key: string, type: string, required = true): Record<string, unknown> | undefined {
  const field = record.fields[key];
  if (field === undefined && !required) return undefined;
  if (!field || typeof field !== "object" || Array.isArray(field) || !("type" in field) || field.type !== type || !("value" in field)) {
    fail("UNSUPPORTED_FEATURE", `The observed ${record.recordType}.${key} field is unsupported.`);
  }
  return field as Record<string, unknown>;
}

function fieldValue(record: CloudKitRecord, key: string, type: string, required = true): unknown {
  return wrapper(record, key, type, required)?.value;
}

function exactVersion(record: CloudKitRecord): string {
  if (typeof record.recordChangeTag !== "string" || !record.recordChangeTag || record.recordChangeTag.length > 512) {
    fail("CONFLICT", "A related organization record has no exact version tag.");
  }
  return record.recordChangeTag;
}

function ownedRelated(record: CloudKitRecord, owner: string, type: "Attachment" | "Hashtag", reminderId: string): void {
  if (record.recordType !== type || !record.recordName.startsWith(`${type}/`) || record.deleted === true) {
    fail("PROTOCOL_CHANGED", `Apple returned an unexpected ${type} relationship record.`);
  }
  const recordOwner = record.zoneID?.ownerRecordName;
  if (recordOwner !== undefined && recordOwner !== "__defaultOwner__" && recordOwner !== owner) {
    fail("FORBIDDEN", `The ${type.toLowerCase()} belongs to a different CloudKit owner.`);
  }
  if (record.zoneID && (record.zoneID.zoneName !== "Reminders" ||
    (record.zoneID.zoneType !== undefined && record.zoneID.zoneType !== "REGULAR_CUSTOM_ZONE"))) {
    fail("FORBIDDEN", `The ${type.toLowerCase()} belongs to a different CloudKit zone.`);
  }
  if (referenceField(record, "Reminder", "Reminder", owner) !== reminderId || fieldValue(record, "Deleted", "INT64") !== 0) {
    fail("PROTOCOL_CHANGED", `The ${type.toLowerCase()} is not an active relationship owned by the selected reminder.`);
  }
  exactVersion(record);
}

function bareUUID(id: string, type: "Attachment" | "Hashtag"): string {
  const bare = id.startsWith(`${type}/`) ? id.slice(type.length + 1) : id;
  if (!UUID.test(bare)) fail("UNSUPPORTED_FEATURE", `The reminder contains an unsupported ${type} identity.`);
  return bare;
}

function linkedIds(root: CloudKitRecord, key: "AttachmentIDs" | "HashtagIDs", type: "Attachment" | "Hashtag"): string[] {
  const field = root.fields[key];
  if (field === undefined || field === null) return [];
  if (typeof field !== "object" || Array.isArray(field) || !("type" in field) || !("value" in field) ||
    !["STRING_LIST", "UNKNOWN_LIST"].includes(String(field.type)) || !Array.isArray(field.value) ||
    field.value.length > 31 || (field.type === "UNKNOWN_LIST" && field.value.length !== 0)) {
    fail("UNSUPPORTED_FEATURE", `The reminder's ${key} relationship list is outside the organization write budget.`);
  }
  const values = field.value as unknown[];
  if (values.some(id => typeof id !== "string")) fail("PROTOCOL_CHANGED", `Apple returned malformed ${key} relationship data.`);
  const result = values.map(id => bareUUID(id as string, type));
  if (new Set(result.map(value => value.toLowerCase())).size !== result.length) fail("PROTOCOL_CHANGED", `Apple returned duplicate ${key} relationships.`);
  return result;
}

function rootForOrganization(root: CloudKitRecord, owner: string, expectedTag?: string): void {
  assertOwnedReminder(root, owner);
  if (root.recordType !== "Reminder" || root.deleted === true || !root.recordChangeTag ||
    (expectedTag !== undefined && root.recordChangeTag !== expectedTag)) {
    fail("CONFLICT", "The reminder changed before its organization update.");
  }
  const deleted = fieldValue(root, "Deleted", "INT64");
  if (deleted !== 0) fail("CONFLICT", "Organization changes require a nondeleted reminder.");
}

function completeRecords(root: CloudKitRecord, ids: string[], records: CloudKitRecord[], owner: string,
  type: "Attachment" | "Hashtag"): CloudKitRecord[] {
  if (ids.length !== records.length) fail("UNSUPPORTED_FEATURE", `The exact ${type.toLowerCase()} relationships could not all be resolved.`);
  const byName = new Map(records.map(record => [record.recordName, record]));
  if (byName.size !== ids.length) fail("PROTOCOL_CHANGED", `Apple returned duplicate ${type.toLowerCase()} records.`);
  return ids.map(id => {
    const record = byName.get(`${type}/${id}`);
    if (!record) fail("PROTOCOL_CHANGED", `Apple omitted an exact ${type.toLowerCase()} relationship record.`);
    ownedRelated(record, owner, type, root.recordName);
    // The API lookup may omit zone metadata. The authenticated private owner is
    // the only authority permitted to bind that absent zone for a write guard.
    return { ...record, zoneID: record.zoneID ?? { zoneName: "Reminders", zoneType: "REGULAR_CUSTOM_ZONE", ownerRecordName: owner } };
  });
}

function readURL(record: CloudKitRecord): string | null {
  const optionalField = (key: string): { type: unknown; value: unknown } | undefined => {
    const field = record.fields[key];
    if (field === undefined) return undefined;
    if (!field || typeof field !== "object" || Array.isArray(field) || !("type" in field) || typeof field.type !== "string" || !("value" in field)) {
      fail("PROTOCOL_CHANGED", `Apple returned a malformed ${record.recordType}.${key} field.`);
    }
    return field as { type: unknown; value: unknown };
  };
  const typeHint = optionalField("Type"), utiHint = optionalField("UTI");
  if (typeHint?.value !== "URL" && utiHint?.value !== "public.url") return null;
  const type = typeHint?.type === "STRING" ? typeHint.value : undefined;
  const uti = utiHint?.type === "STRING" ? utiHint.value : undefined;
  const url = wrapper(record, "URL", "STRING");
  if (type !== "URL" || uti !== "public.url" || fieldValue(record, "Imported", "INT64") !== 0 ||
    url?.isEncrypted !== true || typeof url.value !== "string" || !validHttpURL(url.value)) {
    fail("UNSUPPORTED_FEATURE", "This attachment is not the observed native URL attachment recipe.");
  }
  return url.value;
}

/** Search must know that every selected attachment is either a URL or a classified non-URL. */
function readSearchURL(record: CloudKitRecord): string | null {
  const type = wrapper(record, "Type", "STRING");
  const uti = wrapper(record, "UTI", "STRING");
  if (typeof type?.value !== "string" || typeof uti?.value !== "string") {
    fail("UNSUPPORTED_FEATURE", "A selected attachment has incomplete URL classification metadata.");
  }
  const hasURLField = Object.hasOwn(record.fields, "URL");
  if (hasURLField || type.value === "URL" || uti.value === "public.url") {
    if (type.value !== "URL" || uti.value !== "public.url") {
      fail("UNSUPPORTED_FEATURE", "A selected attachment has ambiguous or inconsistent URL classification metadata.");
    }
    return readURL(record);
  }
  if (type.value === "Image" && (uti.value === "public.jpeg" || uti.value === "public.png")) return null;
  fail("UNSUPPORTED_FEATURE", "A selected attachment has ambiguous or inconsistent URL classification metadata.");
}

function readTag(record: CloudKitRecord): string {
  const name = wrapper(record, "Name", "STRING");
  if (fieldValue(record, "Type", "INT64") !== 0 || fieldValue(record, "Imported", "INT64") !== 0 ||
    name?.isEncrypted !== true || typeof name.value !== "string") {
    fail("UNSUPPORTED_FEATURE", "This hashtag is not the observed native tag recipe.");
  }
  const parsed = LiteralTagName.safeParse(name.value);
  if (!parsed.success) fail("UNSUPPORTED_FEATURE", "The existing hashtag name is outside the supported literal format.");
  return parsed.data;
}

function newRootWrite(root: CloudKitRecord, field: "AttachmentIDs" | "HashtagIDs", ids: string[], now: number): CloudKitWriteRecord {
  if (!Number.isSafeInteger(now) || !root.recordChangeTag) fail("VALIDATION_ERROR", "The organization write timestamp or reminder version is invalid.");
  return {
    recordName: root.recordName,
    recordType: "Reminder",
    recordChangeTag: root.recordChangeTag,
    fields: {
      [field]: { type: "STRING_LIST", value: ids },
      LastModifiedDate: { type: "TIMESTAMP", value: now },
      ResolutionTokenMap: { type: "STRING", value: updateResolutionTokenMap(root, ["lastModifiedDate"], now) },
    },
  };
}

function retirement(type: "Attachment" | "Hashtag", record: CloudKitRecord): OrganizationPlan["dependencies"][number] {
  return { operationType: "update", record: {
    recordName: record.recordName,
    recordType: type,
    recordChangeTag: exactVersion(record),
    fields: { Deleted: { type: "INT64", value: 1 }, Reminder: { type: "REFERENCE", value: null } },
  } };
}

export function planURLChange(root: CloudKitRecord, attachmentRecords: CloudKitRecord[], changes: z.input<typeof URLChanges>, owner: string,
  expectedTag: string, now = Date.now()): OrganizationPlan {
  const input = URLChanges.parse(changes);
  rootForOrganization(root, owner, expectedTag);
  const ids = linkedIds(root, "AttachmentIDs", "Attachment");
  const records = completeRecords(root, ids, attachmentRecords, owner, "Attachment");
  const urls = records.map(record => ({ record, url: readURL(record) })).filter((value): value is { record: CloudKitRecord; url: string } => value.url !== null);
  if (urls.length > 1) fail("UNSUPPORTED_FEATURE", "The reminder has multiple active URL attachments; no URL was changed.");
  const currentURL = urls[0]?.url ?? null;
  if (currentURL === input.url) fail("CONFLICT", "The requested URL is already present on this reminder.");

  const retired = urls[0]?.record;
  const retained = records.filter(record => record !== retired);
  const nextIds = retained.map(record => bareUUID(record.recordName, "Attachment"));
  const dependencies: OrganizationPlan["dependencies"] = [];
  if (input.url !== null) {
    const id = crypto.randomUUID();
    if (!UUID.test(id) || ids.some(existing => existing.toLowerCase() === id.toLowerCase())) fail("PROTOCOL_CHANGED", "The URL attachment identity generator returned a duplicate or invalid UUID.");
    nextIds.push(id);
    dependencies.push({ operationType: "create", record: {
      recordName: `Attachment/${id}`,
      recordType: "Attachment",
      fields: {
        Type: { type: "STRING", value: "URL" }, UTI: { type: "STRING", value: "public.url" },
        Imported: { type: "INT64", value: 0 }, Deleted: { type: "INT64", value: 0 },
        URL: { type: "STRING", value: input.url, isEncrypted: true },
        Reminder: { type: "REFERENCE", value: { recordName: root.recordName, action: "VALIDATE" } },
      },
    } });
  }
  if (retired) dependencies.push(retirement("Attachment", retired));
  const guards = records.filter(record => record !== retired);
  if (dependencies.length + guards.length + 1 > 32) fail("UNSUPPORTED_FEATURE", "The URL write exceeds the atomic record budget.");
  const rootWrite = newRootWrite(root, "AttachmentIDs", nextIds, now);
  if (new TextEncoder().encode(JSON.stringify({ root: rootWrite, dependencies, guards })).length > 65_536) {
    fail("UNSUPPORTED_FEATURE", "The URL write exceeds the atomic byte budget.");
  }
  return { root: rootWrite, dependencies, guards };
}

export function planTagChange(root: CloudKitRecord, hashtagRecords: CloudKitRecord[], changes: z.input<typeof TagChanges>, owner: string,
  expectedTag: string, now = Date.now()): OrganizationPlan {
  const input = TagChanges.parse(changes);
  rootForOrganization(root, owner, expectedTag);
  const ids = linkedIds(root, "HashtagIDs", "Hashtag");
  const records = completeRecords(root, ids, hashtagRecords, owner, "Hashtag");
  const byName = new Map<string, CloudKitRecord>();
  for (const record of records) {
    const name = readTag(record);
    if (byName.has(name)) fail("UNSUPPORTED_FEATURE", "The reminder has duplicate hashtag names; no tags were changed.");
    byName.set(name, record);
  }
  const desired = input.tags.map(name => ({ name, current: byName.get(name) }));
  const retained = desired.filter(item => item.current);
  const removed = records.filter(record => !input.tags.includes(readTag(record)));
  const createdCount = desired.filter(item => !item.current).length;
  if (1 + retained.length + removed.length + createdCount > 32) fail("UNSUPPORTED_FEATURE", "The tag replacement exceeds the atomic record budget.");
  if (removed.length === 0 && createdCount === 0 && ids.map(id => id.toLowerCase()).join(",") ===
    desired.map(item => item.current ? bareUUID(item.current.recordName, "Hashtag").toLowerCase() : "").join(",")) {
    fail("CONFLICT", "The requested tags are already present on this reminder.");
  }
  const nextIds: string[] = [];
  const dependencies: OrganizationPlan["dependencies"] = [];
  const guards = retained.map(item => item.current!);
  for (const item of desired) {
    if (item.current) {
      nextIds.push(bareUUID(item.current.recordName, "Hashtag"));
      continue;
    }
    const id = crypto.randomUUID();
    if (!UUID.test(id) || ids.some(existing => existing.toLowerCase() === id.toLowerCase()) || nextIds.some(existing => existing.toLowerCase() === id.toLowerCase())) {
      fail("PROTOCOL_CHANGED", "The hashtag identity generator returned a duplicate or invalid UUID.");
    }
    nextIds.push(id);
    dependencies.push({ operationType: "create", record: {
      recordName: `Hashtag/${id}`,
      recordType: "Hashtag",
      fields: {
        CreationDate: { type: "TIMESTAMP", value: now }, Type: { type: "INT64", value: 0 },
        Imported: { type: "INT64", value: 0 }, Deleted: { type: "INT64", value: 0 },
        Name: { type: "STRING", value: item.name, isEncrypted: true },
        Reminder: { type: "REFERENCE", value: { recordName: root.recordName, action: "VALIDATE" } },
      },
    } });
  }
  dependencies.push(...removed.map(record => retirement("Hashtag", record)));
  const rootWrite = newRootWrite(root, "HashtagIDs", nextIds, now);
  if (new TextEncoder().encode(JSON.stringify({ root: rootWrite, dependencies, guards })).length > 65_536) {
    fail("UNSUPPORTED_FEATURE", "The tag write exceeds the atomic byte budget.");
  }
  return { root: rootWrite, dependencies, guards };
}

export interface URLAttachment { id: string; url: string }
export interface ReminderTag { id: string; name: string }

export function normalizeURLAttachment(record: CloudKitRecord, reminderId: string, owner: string): URLAttachment {
  ownedRelated(record, owner, "Attachment", reminderId);
  const url = readURL(record);
  if (url === null) fail("UNSUPPORTED_FEATURE", "Only observed URL attachments can be normalized as URLs.");
  return { id: record.recordName, url };
}

export function normalizeReminderTag(record: CloudKitRecord, reminderId: string, owner: string): ReminderTag {
  ownedRelated(record, owner, "Hashtag", reminderId);
  return { id: record.recordName, name: readTag(record) };
}

export function readReminderOrganization(root: CloudKitRecord, attachments: CloudKitRecord[], hashtags: CloudKitRecord[], owner: string) {
  rootForOrganization(root, owner);
  const attachmentRecords = completeRecords(root, linkedIds(root, "AttachmentIDs", "Attachment"), attachments, owner, "Attachment");
  const tagRecords = completeRecords(root, linkedIds(root, "HashtagIDs", "Hashtag"), hashtags, owner, "Hashtag");
  const urls = attachmentRecords.flatMap(record => {
    const url = readURL(record);
    return url === null ? [] : [{ id: record.recordName, url }];
  });
  if (urls.length > 1) fail("UNSUPPORTED_FEATURE", "The reminder has multiple active URL attachments.");
  const tags = tagRecords.map(record => normalizeReminderTag(record, root.recordName, owner));
  if (new Set(tags.map(tag => tag.name)).size !== tags.length) fail("UNSUPPORTED_FEATURE", "The reminder has duplicate tag names.");
  return { reminderId: root.recordName, recordChangeTag: root.recordChangeTag!, url: urls[0] ?? null, tags,
    otherAttachmentIds: attachmentRecords.filter(record => !urls.some(url => url.id === record.recordName)).map(record => record.recordName) };
}

export type OrganizationFilterSelection = "url" | "tags";

/** Return only the selected native relationship identities. Unselected link lists remain opaque. */
export function reminderOrganizationIds(root: CloudKitRecord, owner: string, selected: OrganizationFilterSelection): string[] {
  rootForOrganization(root, owner);
  return selected === "url" ? linkedIds(root, "AttachmentIDs", "Attachment") : linkedIds(root, "HashtagIDs", "Hashtag");
}

/** Validate and normalize one selected relationship graph without reading the other relationship type. */
export function readReminderOrganizationSelection(root: CloudKitRecord, records: CloudKitRecord[], owner: string,
  selected: OrganizationFilterSelection): { url: string | null } | { tags: string[] } {
  rootForOrganization(root, owner);
  if (selected === "url") {
    const attachments = completeRecords(root, linkedIds(root, "AttachmentIDs", "Attachment"), records, owner, "Attachment");
    const urls = attachments.flatMap(record => {
      const url = readSearchURL(record);
      return url === null ? [] : [url];
    });
    if (urls.length > 1) fail("UNSUPPORTED_FEATURE", "The reminder has multiple active URL attachments.");
    return { url: urls[0] ?? null };
  }
  const hashtags = completeRecords(root, linkedIds(root, "HashtagIDs", "Hashtag"), records, owner, "Hashtag");
  const tags = hashtags.map(record => normalizeReminderTag(record, root.recordName, owner).name);
  if (new Set(tags).size !== tags.length) fail("UNSUPPORTED_FEATURE", "The reminder has duplicate tag names.");
  return { tags };
}
