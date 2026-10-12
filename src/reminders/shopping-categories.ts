import { z } from "zod";
import { AppError } from "../errors.ts";

export const SHOPPING_PROTOCOL_VERSION = 20230430 as const;
export const SHOPPING_ASSET_MAX_BYTES = 16 * 1024;
export const SHOPPING_ASSET_MAX_ENTRIES = 200;

const UPPERCASE_UUID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/;
const APPLE_EPOCH_SECONDS = 978_307_200;

function dateDescription(seconds: number): string | null {
  if (!Number.isFinite(seconds)) return null;
  const milliseconds = (Math.floor(seconds) + APPLE_EPOCH_SECONDS) * 1_000;
  if (!Number.isFinite(milliseconds)) return null;
  const date = new Date(milliseconds);
  if (!Number.isFinite(date.getTime())) return null;
  const iso = date.toISOString();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(iso)) return null;
  return `${iso.slice(0, 19).replace("T", " ")} +0000`;
}

const appleSeconds = z.number().finite().refine(value => dateDescription(value) !== null,
  "Expected finite Apple-reference seconds in the supported date range.");
const uuid = z.string().regex(UPPERCASE_UUID, "Expected an uppercase canonical UUID.");

export const ShoppingSectionMembership = z.object({
  memberID: uuid,
  groupID: uuid,
  modifiedOn: appleSeconds,
}).strict();

export const ShoppingSectionMemberships = z.object({
  minimumSupportedVersion: z.literal(SHOPPING_PROTOCOL_VERSION),
  memberships: z.array(ShoppingSectionMembership).max(SHOPPING_ASSET_MAX_ENTRIES)
    .refine(entries => new Set(entries.map(entry => entry.memberID)).size === entries.length,
      "Reminder identifiers must be unique."),
}).strict();

const correctionKey = z.string().min(1).max(256).regex(/^[\x20-\x7e]+$/)
  .refine(value => value !== "__proto__" && value === value.toLowerCase() && value.trim().length > 0,
    "Expected a visible lowercase printable ASCII reminder title.");

function supportedCorrectionKey(value: string): boolean {
  return value !== "__proto__" && value.length <= 256 && /^[\x20-\x7e]+$/.test(value) && value === value.toLowerCase() && value.trim().length > 0;
}

export const ShoppingGroceryCorrection = z.object({
  identifier: uuid,
  modifiedOn: appleSeconds,
}).strict();

export const ShoppingGroceryCorrections = z.object({
  lastResetDate: z.null(),
  memberships: z.record(correctionKey, ShoppingGroceryCorrection).refine(value =>
    Object.keys(value).length <= SHOPPING_ASSET_MAX_ENTRIES, "Too many grocery corrections."),
}).strict();

export const ShoppingSectionOrdering = z.object({
  minimumSupportedVersion: z.literal(SHOPPING_PROTOCOL_VERSION),
  orderedIdentifiers: z.array(uuid).max(SHOPPING_ASSET_MAX_ENTRIES)
    .refine(identifiers => new Set(identifiers).size === identifiers.length, "Section identifiers must be unique."),
}).strict();

export type ShoppingSectionMembership = z.infer<typeof ShoppingSectionMembership>;
export type ShoppingSectionMemberships = z.infer<typeof ShoppingSectionMemberships>;
export type ShoppingGroceryCorrection = z.infer<typeof ShoppingGroceryCorrection>;
export type ShoppingGroceryCorrections = z.infer<typeof ShoppingGroceryCorrections>;
export type ShoppingSectionOrdering = z.infer<typeof ShoppingSectionOrdering>;

function protocolChanged(message: string): never {
  throw new AppError("PROTOCOL_CHANGED", message);
}

function unsupported(message: string): never {
  throw new AppError("UNSUPPORTED_FEATURE", message);
}

function parseAsset(bytes: Uint8Array, label: string): unknown {
  if (!(bytes instanceof Uint8Array)) protocolChanged(`${label} must be supplied as UTF-8 bytes.`);
  if (bytes.byteLength > SHOPPING_ASSET_MAX_BYTES) unsupported(`${label} exceeds the supported asset byte budget.`);
  let source: string;
  try { source = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { protocolChanged(`${label} is not valid UTF-8.`); }
  try { return JSON.parse(source) as unknown; }
  catch { protocolChanged(`${label} is not valid JSON.`); }
}

function parseWithSchema<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) protocolChanged(`${label} has an unsupported native shape.`);
  return parsed.data;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function checkSupportedVersion(value: unknown, label: string): void {
  if (!isRecord(value)) return;
  if ("minimumSupportedVersion" in value && value.minimumSupportedVersion !== SHOPPING_PROTOCOL_VERSION) {
    unsupported(`${label} uses an unsupported minimum version.`);
  }
}

function checkEntryBudget(value: unknown, key: string, label: string): void {
  if (!isRecord(value) || !Array.isArray(value[key])) return;
  if (value[key].length > SHOPPING_ASSET_MAX_ENTRIES) unsupported(`${label} exceeds the supported entry budget.`);
}

export function decodeSectionMemberships(bytes: Uint8Array): ShoppingSectionMemberships {
  const value = parseAsset(bytes, "Section memberships");
  checkSupportedVersion(value, "Section memberships");
  checkEntryBudget(value, "memberships", "Section memberships");
  if (isRecord(value) && Array.isArray(value.memberships)) {
    const memberIDs = value.memberships.flatMap(entry => isRecord(entry) && typeof entry.memberID === "string" ? [entry.memberID] : []);
    if (new Set(memberIDs).size !== memberIDs.length) unsupported("Section memberships contain duplicate reminder identifiers.");
  }
  const result = parseWithSchema(ShoppingSectionMemberships, value, "Section memberships");
  return result;
}

export function decodeGroceryCorrections(bytes: Uint8Array): ShoppingGroceryCorrections {
  const value = parseAsset(bytes, "Grocery corrections");
  if (isRecord(value) && "lastResetDate" in value && value.lastResetDate !== null) {
    unsupported("A non-null grocery correction reset date is unsupported.");
  }
  if (isRecord(value) && isRecord(value.memberships) && Object.keys(value.memberships).length > SHOPPING_ASSET_MAX_ENTRIES) {
    unsupported("Grocery corrections exceed the supported entry budget.");
  }
  if (isRecord(value) && isRecord(value.memberships) && Object.keys(value.memberships).some(key => !supportedCorrectionKey(key))) {
    unsupported("A grocery correction uses an unsupported title key.");
  }
  return parseWithSchema(ShoppingGroceryCorrections, value, "Grocery corrections");
}

export function decodeSectionOrdering(bytes: Uint8Array): ShoppingSectionOrdering {
  const value = parseAsset(bytes, "Section ordering");
  checkSupportedVersion(value, "Section ordering");
  checkEntryBudget(value, "orderedIdentifiers", "Section ordering");
  if (isRecord(value) && Array.isArray(value.orderedIdentifiers)) {
    const identifiers = value.orderedIdentifiers.filter((entry): entry is string => typeof entry === "string");
    if (new Set(identifiers).size !== identifiers.length) unsupported("Section ordering contains duplicate identifiers.");
  }
  const result = parseWithSchema(ShoppingSectionOrdering, value, "Section ordering");
  return result;
}

function compareDescending(left: string, right: string): number {
  return left < right ? 1 : left > right ? -1 : 0;
}

function digestStringArray(values: string[]): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(values));
  return crypto.subtle.digest("SHA-512", bytes).then(digest =>
    Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("")
  );
}

export function membershipsChecksum(memberships: ShoppingSectionMembership[] | ShoppingSectionMemberships): Promise<string> {
  const entries = Array.isArray(memberships)
    ? parseWithSchema(z.array(ShoppingSectionMembership).max(SHOPPING_ASSET_MAX_ENTRIES), memberships, "Section memberships")
    : parseWithSchema(ShoppingSectionMemberships, memberships, "Section memberships").memberships;
  if (entries.length > SHOPPING_ASSET_MAX_ENTRIES) unsupported("Section memberships exceed the supported entry budget.");
  const memberIDs = entries.map(entry => entry.memberID);
  if (new Set(memberIDs).size !== memberIDs.length) unsupported("Section memberships contain duplicate reminder identifiers.");
  const values = entries.slice().sort((a, b) => compareDescending(a.memberID, b.memberID)).map(entry => {
    const date = dateDescription(entry.modifiedOn);
    if (date === null) unsupported("A section membership has an unsupported modification date.");
    return `memberIdentifier:${entry.memberID},groupIdentifier:${entry.groupID},modifiedOn:${date}`;
  });
  return digestStringArray(values);
}

export function groceryCorrectionsChecksum(corrections: ShoppingGroceryCorrections): Promise<string> {
  if (isRecord(corrections) && "lastResetDate" in corrections && corrections.lastResetDate !== null) {
    unsupported("A non-null grocery correction reset date is unsupported.");
  }
  if (isRecord(corrections) && isRecord(corrections.memberships) && Object.keys(corrections.memberships).some(key => !supportedCorrectionKey(key))) {
    unsupported("A grocery correction uses an unsupported title key.");
  }
  const parsed = parseWithSchema(ShoppingGroceryCorrections, corrections, "Grocery corrections");
  const values = ["lastResetDate:nil"];
  for (const key of Object.keys(parsed.memberships).sort(compareDescending)) {
    const entry = parsed.memberships[key];
    const date = dateDescription(entry.modifiedOn);
    if (date === null) unsupported("A grocery correction has an unsupported modification date.");
    values.push(`${key}:{Optional("identifier:Optional(${entry.identifier}),modifiedOn:Optional(${date})")}`);
  }
  return digestStringArray(values);
}

function encodeAsset<T>(schema: z.ZodType<T>, value: unknown, label: string): Uint8Array {
  const encoded = new TextEncoder().encode(JSON.stringify(parseWithSchema(schema, value, label)));
  if (encoded.byteLength > SHOPPING_ASSET_MAX_BYTES) unsupported(`${label} exceeds the supported asset byte budget.`);
  return encoded;
}

export function encodeSectionMemberships(value: ShoppingSectionMemberships): Uint8Array {
  if (isRecord(value) && Array.isArray(value.memberships)) {
    const memberIDs = value.memberships.flatMap(entry => isRecord(entry) && typeof entry.memberID === "string" ? [entry.memberID] : []);
    if (new Set(memberIDs).size !== memberIDs.length) unsupported("Section memberships contain duplicate reminder identifiers.");
  }
  const parsed = parseWithSchema(ShoppingSectionMemberships, value, "Section memberships");
  if (parsed.memberships.length > SHOPPING_ASSET_MAX_ENTRIES) unsupported("Section memberships exceed the entry budget.");
  return encodeAsset(ShoppingSectionMemberships, parsed, "Section memberships");
}

export function encodeGroceryCorrections(value: ShoppingGroceryCorrections): Uint8Array {
  if (isRecord(value) && "lastResetDate" in value && value.lastResetDate !== null) {
    unsupported("A non-null grocery correction reset date is unsupported.");
  }
  if (isRecord(value) && isRecord(value.memberships) && Object.keys(value.memberships).some(key => !supportedCorrectionKey(key))) {
    unsupported("A grocery correction uses an unsupported title key.");
  }
  return encodeAsset(ShoppingGroceryCorrections, value, "Grocery corrections");
}

export function encodeSectionOrdering(value: ShoppingSectionOrdering): Uint8Array {
  if (isRecord(value) && Array.isArray(value.orderedIdentifiers)) {
    const identifiers = value.orderedIdentifiers.filter((entry): entry is string => typeof entry === "string");
    if (new Set(identifiers).size !== identifiers.length) unsupported("Section ordering contains duplicate identifiers.");
  }
  const parsed = parseWithSchema(ShoppingSectionOrdering, value, "Section ordering");
  if (parsed.orderedIdentifiers.length > SHOPPING_ASSET_MAX_ENTRIES) unsupported("Section ordering exceeds the entry budget.");
  return encodeAsset(ShoppingSectionOrdering, parsed, "Section ordering");
}

const expectedGeneration = z.number().int().nonnegative().safe().describe("Current Apple session generation from connection_status; binds the request to that session.");
const canonicalListId = z.string().min(6).max(255).regex(/^List\/[\x21-\x2e\x30-\x7e]+$/,
  "Expected a canonical List/<ASCII suffix> ID.").describe("Exact ID of an existing owned private Shopping list, never its title.");
const canonicalReminderId = z.string().min(10).max(255).regex(/^Reminder\/[\x21-\x2e\x30-\x7e]+$/,
  "Expected a canonical Reminder/<ASCII suffix> ID.").describe("Exact reminder ID returned by a current read of this Shopping list.");
const canonicalListSectionId = z.string().regex(/^ListSection\/[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/,
  "Expected a ListSection/<UUID> ID.").transform(value => `ListSection/${value.slice("ListSection/".length).toUpperCase()}`)
  .describe("Exact existing destination category ID returned by get_shopping_categories for this same list.");
const recordChangeTag = z.string().min(1).max(512).refine(value => !/[\u0000-\u001f\u007f]/.test(value))
  .describe("Current exact Apple version tag; stale versions conflict without automatic refresh.");

export const GetShoppingCategoriesRequest = z.object({
  expectedGeneration: expectedGeneration.optional().describe("Optional current Apple session generation from connection_status."),
  listId: canonicalListId,
  continuation: z.string().uuid().nullable().optional().describe("Single-use category continuation; keep the same list and session."),
  limit: z.number().int().min(1).max(200).default(200).describe("Maximum native catalogue page size, 1–200; retain this limit when continuing."),
}).strict();

export const SetShoppingCategoryRequest = z.object({
  expectedGeneration,
  listId: canonicalListId,
  reminderId: canonicalReminderId,
  recordChangeTag: recordChangeTag.describe("Current reminder version from get_reminder or a list read."),
  listRecordChangeTag: recordChangeTag.describe("Current List version returned as listRecordChangeTag by get_shopping_categories."),
  categoryId: canonicalListSectionId,
  categoryRecordChangeTag: recordChangeTag.describe("Current destination category version returned by get_shopping_categories."),
}).strict();

export type GetShoppingCategoriesRequestData = z.infer<typeof GetShoppingCategoriesRequest>;
export type SetShoppingCategoryRequestData = z.infer<typeof SetShoppingCategoryRequest>;

// Keep the narrow schemas available to integration code that must compare IDs
// with the same canonical forms accepted by the request contracts.
export { canonicalListId, canonicalListSectionId };
