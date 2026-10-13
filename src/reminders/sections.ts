import { z } from "zod";
import { AppError } from "../errors.ts";
import { normalizeList, referenceField, type CloudKitLookupResult, type CloudKitRecord, type CloudKitRecordItem, type CloudKitRemindersClient } from "../icloud/cloudkit.ts";
import { assertOwnedReminder } from "./writes.ts";
import { requireMutableList } from "./list-writes.ts";
import { categorySummary, loadShoppingAssets } from "./shopping-plan.ts";
import { ListId } from "./identifiers.ts";

const SECTION_ID = /^ListSection\/[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;
const UNKNOWN_ITEM_CODES = new Set(["UNKNOWN_ITEM", "NOT_FOUND"]);
const AUTH_CODES = new Set(["AUTHENTICATION_REQUIRED", "NOT_AUTHENTICATED", "INVALID_AUTH_TOKEN", "AUTHENTICATION_FAILED"]);
const ACCESS_CODES = new Set(["ACCESS_DENIED", "PERMISSION_FAILURE", "PERMISSION_DENIED"]);

const safeGeneration = z.number().int().nonnegative().safe();
const versionTag = z.string().min(1).max(512);
const uuid = z.string().uuid();
const sha256 = z.string().regex(/^[a-f0-9]{64}$/i);

export const GetReminderListSectionsRequest = z.object({
  expectedGeneration: safeGeneration.optional().describe("Current Apple session generation from connection_status; binds the request to that session."),
  listId: ListId.describe("Exact ID of an existing owned private Standard Reminders list, never its title."),
  limit: z.number().int().min(1).max(200).default(200).describe("Maximum native section feed page size, 1–200; retain this limit when continuing."),
  continuation: uuid.nullable().optional().describe("Single-use section continuation UUID; keep the same list and session."),
}).strict();

export type GetReminderListSectionsRequestData = z.infer<typeof GetReminderListSectionsRequest>;

export const SectionScanSchema = z.object({
  permissionRevision: z.number().int().nonnegative().safe().optional(),
  token: uuid,
  expiresAt: z.number().int().positive().safe(),
  accountHash: sha256,
  listId: ListId,
  listRecordChangeTag: versionTag,
  limit: z.number().int().min(1).max(200),
  cursor: z.string().min(1).max(8192),
  seen: z.array(sha256).max(1000),
  pages: z.number().int().min(1).max(1000),
}).strict();

export type SectionScan = z.infer<typeof SectionScanSchema>;

export type StandardSectionsClient = Pick<CloudKitRemindersClient,
  "remindersZoneOwner" | "lookup" | "lookupListSections" | "queryListSectionsPage" | "downloadSectionAsset">;

export interface ReadStandardSectionsPageOptions {
  /** Opaque native CloudKit zone sync token returned by the previous feed page. */
  cursor?: string | null;
  /** List version from the preceding application page, when continuing a scan. */
  expectedListRecordChangeTag?: string;
  limit?: number;
}

export interface StandardSectionSummary {
  sectionId: string;
  name: string;
  canonicalName: string | null;
  recordChangeTag: string;
}

export interface StandardSectionMembership {
  reminderId: string;
  sectionId: string;
}

export interface ReadStandardSectionsPageResult {
  listRecordChangeTag: string;
  sections: StandardSectionSummary[];
  memberships: StandardSectionMembership[];
  orderedSectionIds: string[];
  orderingStatus: "explicit" | "not_materialized";
  complete: boolean;
  nativeContinuation: string | null;
}

function protocol(message: string): never {
  throw new AppError("PROTOCOL_CHANGED", message);
}

function conflict(message: string): never {
  throw new AppError("CONFLICT", message, 409);
}

function fieldValue(record: CloudKitRecord, key: string, type: string, optional = false): unknown {
  const field = record.fields[key];
  if (optional && field === undefined) return undefined;
  if (!field || typeof field !== "object" || Array.isArray(field) || !("type" in field) || field.type !== type || !("value" in field)) {
    protocol(`The native ${record.recordType}.${key} shape is unsupported.`);
  }
  return field.value;
}

function trustedZoneRecord(record: CloudKitRecord, owner: string): CloudKitRecord {
  if (record.zoneID === undefined) {
    // Exact lookups are scoped to this client's authenticated private zone.
    // CloudKit sometimes omits zoneID in lookup results, so bind only that
    // omitted metadata to the request scope; a present zone is still checked.
    return { ...record, zoneID: { zoneName: "Reminders", zoneType: "REGULAR_CUSTOM_ZONE", ownerRecordName: owner } };
  }
  if (record.zoneID.zoneName !== "Reminders" || record.zoneID.zoneType !== undefined && record.zoneID.zoneType !== "REGULAR_CUSTOM_ZONE" ||
    record.zoneID.ownerRecordName !== undefined && ![owner, "__defaultOwner__"].includes(record.zoneID.ownerRecordName)) {
    throw new AppError("FORBIDDEN", "A section record is outside the selected owned private list.", 403);
  }
  return record;
}

function assertStandardList(record: CloudKitRecord, owner: string, listId: string, expectedTag?: string) {
  if (record.recordName !== listId || record.recordType !== "List") conflict("The requested List identity changed.");
  const trusted = trustedZoneRecord(record, owner);
  assertOwnedReminder(trusted, owner);
  const normalized = requireMutableList(trusted, owner, expectedTag);
  const groceryFlag = fieldValue(trusted, "ShouldCategorizeGroceryItems", "INT64", true);
  if (groceryFlag === 1) throw new AppError("UNSUPPORTED_FEATURE", "Shopping lists do not support Standard sections.");
  if (groceryFlag !== 0) protocol("Apple did not identify this list as a Standard list.");
  const autoCategorize = fieldValue(trusted, "ShouldAutoCategorizeItems", "INT64", true);
  if (autoCategorize !== undefined && autoCategorize !== 0) {
    if (autoCategorize === 1) throw new AppError("UNSUPPORTED_FEATURE", "Automatically categorized lists do not support Standard sections.");
    protocol("Apple returned an unsupported list categorization setting.");
  }
  if (Object.keys(trusted.fields).some(key => /smart/i.test(key))) {
    throw new AppError("UNSUPPORTED_FEATURE", "Native Smart Lists do not support Standard sections.");
  }
  return { record: trusted, normalized };
}

function resolveLookupResult(result: CloudKitLookupResult, requested: string[]): Map<string, CloudKitRecordItem | undefined> {
  if (!result || !Array.isArray(result.requestedRecordNames) || !Array.isArray(result.records) ||
    !Array.isArray(result.recordErrors) || !Array.isArray(result.unresolvedRecordNames) ||
    result.requestedRecordNames.length !== requested.length || result.requestedRecordNames.some((name, index) => name !== requested[index])) {
    protocol("Apple returned an incomplete exact lookup result.");
  }
  const wanted = new Set(requested);
  const records = new Map<string, CloudKitRecordItem>();
  for (const record of result.records) {
    if (!wanted.has(record.recordName) || records.has(record.recordName)) protocol("Apple returned an unexpected exact lookup record.");
    records.set(record.recordName, record);
  }
  const errors = new Map<string, string>();
  for (const error of result.recordErrors) {
    if (!error.recordName || !wanted.has(error.recordName) || errors.has(error.recordName)) protocol("Apple returned an unexpected exact lookup error.");
    errors.set(error.recordName, error.serverErrorCode.toUpperCase());
  }
  for (const name of result.unresolvedRecordNames) {
    if (!wanted.has(name) || records.has(name) || errors.has(name)) protocol("Apple returned an inconsistent exact lookup result.");
  }
  for (const name of requested) {
    if (records.has(name) && errors.has(name)) protocol("Apple returned conflicting exact lookup results.");
  }
  return new Map(requested.map(name => [name, records.get(name)]));
}

function lookupError(result: CloudKitLookupResult, id: string): string | null {
  return result.recordErrors.find(error => error.recordName === id)?.serverErrorCode.toUpperCase() ?? null;
}

function mapLookupError(code: string): never {
  if (AUTH_CODES.has(code)) throw new AppError("REAUTH_REQUIRED", "Apple rejected the exact section read. Reconnect your Apple account.", 409);
  if (ACCESS_CODES.has(code)) throw new AppError("FORBIDDEN", "Apple denied access to a section in the selected list.", 403);
  protocol("Apple rejected an exact section lookup.");
}

async function exactList(client: StandardSectionsClient, listId: string, owner: string, expectedTag?: string) {
  const result = await client.lookup([listId]);
  const resolved = resolveLookupResult(result, [listId]);
  const error = lookupError(result, listId);
  if (error) {
    if (UNKNOWN_ITEM_CODES.has(error)) conflict("The selected list no longer exists.");
    mapLookupError(error);
  }
  const item = resolved.get(listId);
  if (!item || !("recordType" in item) || item.deleted) conflict("The selected list is no longer available.");
  const list = assertStandardList(item, owner, listId, expectedTag);
  return { ...list, recordChangeTag: item.recordChangeTag! };
}

function canonicalSectionId(value: string): string {
  if (!SECTION_ID.test(value)) protocol("Apple returned an unsupported ListSection identity.");
  const [prefix, uuid] = value.split("/");
  return `${prefix}/${uuid.toUpperCase()}`;
}

function markedDeleted(record: CloudKitRecord): boolean {
  const value = fieldValue(record, "Deleted", "INT64", true);
  if (value === undefined) return false;
  if (value !== 0 && value !== 1) protocol("Apple returned an unsupported section deletion marker.");
  return value === 1;
}

function isTombstone(item: CloudKitRecordItem): boolean {
  return !("recordType" in item) && item.deleted === true;
}

/** Read one bounded page of native sections for an owned Standard list. */
export async function readStandardSectionsPage(client: StandardSectionsClient, listId: string,
  options: ReadStandardSectionsPageOptions = {}): Promise<ReadStandardSectionsPageResult> {
  if (!ListId.safeParse(listId).success) throw new AppError("VALIDATION_ERROR", "Supply an exact List/<id> record name.", 400);
  const limit = options.limit ?? 200;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new AppError("VALIDATION_ERROR", "The section page limit must be between 1 and 200.", 400);
  const cursor = options.cursor ?? null;
  if (cursor !== null && (typeof cursor !== "string" || cursor.length < 1 || cursor.length > 8192)) {
    throw new AppError("VALIDATION_ERROR", "The native section cursor is invalid.", 400);
  }
  if (options.expectedListRecordChangeTag !== undefined && (typeof options.expectedListRecordChangeTag !== "string" ||
    options.expectedListRecordChangeTag.length < 1 || options.expectedListRecordChangeTag.length > 512 || /[\u0000-\u001f\u007f]/.test(options.expectedListRecordChangeTag))) {
    throw new AppError("VALIDATION_ERROR", "The expected List version is invalid.", 400);
  }
  const owner = client.remindersZoneOwner;
  if (!owner) throw new AppError("OWNER_NOT_CONFIGURED", "The owned Reminders zone has not been established.", 409);

  const first = await exactList(client, listId, owner, options.expectedListRecordChangeTag);
  const listSnapshot = normalizeList(first.record);
  if (listSnapshot.reminderIds === null) throw new AppError("UNSUPPORTED_FEATURE", "The Standard list has no explicit native ReminderIDs membership.");
  const state = await loadShoppingAssets(client, first.record);
  const page = await client.queryListSectionsPage({ continuation: cursor, limit });
  if (!page || !Array.isArray(page.records) || typeof page.complete !== "boolean" ||
    page.continuation !== null && typeof page.continuation !== "string" || page.complete && page.continuation !== null ||
    !page.complete && (typeof page.continuation !== "string" || page.continuation.length === 0)) {
    protocol("Apple returned malformed section pagination metadata.");
  }

  const explicitIds = new Set<string>();
  for (const membership of state.memberships.memberships) explicitIds.add(`ListSection/${membership.groupID}`);
  for (const sectionId of state.ordering.orderedIdentifiers) explicitIds.add(`ListSection/${sectionId}`);
  const feedIds = new Set<string>();
  for (const item of page.records) {
    if (!("recordType" in item)) continue;
    if (item.recordType !== "ListSection") protocol("Apple returned an unrequested section record type.");
    if (item.deleted) continue;
    const scoped = trustedZoneRecord(item, owner);
    const parent = referenceField(scoped, "List", "List", owner);
    if (parent !== listId) continue;
    feedIds.add(canonicalSectionId(item.recordName));
  }

  const allIds = new Set([...explicitIds, ...feedIds]);
  if (allIds.size > 200) throw new AppError("UNSUPPORTED_FEATURE", "The Standard list exceeds the 200 section inspection limit.");
  const resolvedSections = new Map<string, StandardSectionSummary>();
  const requestedIds = [...allIds];
  for (let start = 0; start < requestedIds.length; start += 32) {
    const chunk = requestedIds.slice(start, start + 32);
    const result = await client.lookupListSections(chunk);
    const items = resolveLookupResult(result, chunk);
    for (const id of chunk) {
      const code = lookupError(result, id);
      const isExplicit = explicitIds.has(id);
      if (code) {
        if (UNKNOWN_ITEM_CODES.has(code)) {
          if (isExplicit) conflict("An explicit section membership or ordering reference no longer resolves.");
          continue;
        }
        mapLookupError(code);
      }
      const item = items.get(id);
      if (!item) {
        protocol("Apple omitted an exact section lookup result. Section pagination was not advanced.");
      }
      if (isTombstone(item)) continue;
      if (!("recordType" in item) || item.recordType !== "ListSection" || item.recordName !== id) {
        protocol("Apple returned an unexpected exact ListSection record.");
      }
      if (item.deleted) continue;
      const section = trustedZoneRecord(item, owner);
      if (markedDeleted(section)) continue;
      const parent = referenceField(section, "List", "List", owner);
      if (parent !== listId) {
        if (isExplicit) conflict("An explicit section reference no longer belongs to the selected list.");
        continue;
      }
      const summary = categorySummary(section, owner, listId);
      resolvedSections.set(id, {
        sectionId: summary.categoryId,
        name: summary.name,
        canonicalName: summary.canonicalName,
        recordChangeTag: summary.recordChangeTag,
      });
    }
  }

  const latest = await exactList(client, listId, owner, first.recordChangeTag);
  if (latest.recordChangeTag !== first.recordChangeTag) conflict("The Standard list changed during section pagination.");
  const currentReminderIds = new Set(listSnapshot.reminderIds);
  const memberships = state.memberships.memberships.flatMap(entry => {
    const reminderId = `Reminder/${entry.memberID}`;
    const sectionId = `ListSection/${entry.groupID}`;
    return currentReminderIds.has(reminderId) && resolvedSections.has(sectionId) ? [{ reminderId, sectionId }] : [];
  });
  const orderedSectionIds = state.ordering.orderedIdentifiers
    .map(id => `ListSection/${id}`)
    .filter(id => resolvedSections.has(id));

  return {
    listRecordChangeTag: first.recordChangeTag,
    sections: [...resolvedSections.values()],
    memberships,
    orderedSectionIds,
    orderingStatus: first.record.fields.SectionIDsOrderingAsData === undefined ? "not_materialized" : "explicit",
    complete: page.complete,
    nativeContinuation: page.continuation,
  };
}
