import { z } from "zod";

const identifier = z.string().min(1).max(256).regex(/^[A-Za-z0-9._-]+$/);
// Provider sharing descriptors stay encrypted server-side. Bound opaque JSON
// without exposing owner identities or participant data to clients.
function boundedDescriptor(value: unknown, depth = 0): boolean {
  if (depth > 4) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "string") return value.length <= 1024 && !/[\u0000-\u001f\u007f]/.test(value);
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= 32 && value.every(entry => boundedDescriptor(entry, depth + 1));
  return !!value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype && Object.entries(value).length <= 32 &&
    Object.entries(value).every(([key, entry]) => /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key) && boundedDescriptor(entry, depth + 1));
}
export const DriveShareID = z.union([
  z.string().min(1).max(512).regex(/^[A-Za-z0-9._:-]+$/),
  z.record(z.unknown()).refine(value => Object.keys(value).length > 0 && boundedDescriptor(value) && new TextEncoder().encode(JSON.stringify(value)).length <= 8192),
]);
export const DriveDocwsItemID = z.string().min(1).max(512).regex(/^[A-Za-z0-9._:-]+$/).refine(value => value !== "." && value !== "..");
const reference = z.object({ itemId: DriveDocwsItemID, documentId: identifier, parentId: z.string().max(512).nullable() }).strict();
export const DriveSharedContext = z.object({ shareID: DriveShareID, ownerRecordName: identifier.optional(),
  references: z.record(reference).refine(value => Object.keys(value).length <= 2000 && new TextEncoder().encode(JSON.stringify(value)).length <= 256_000).optional(),
}).strict();
export type SharedContext = z.infer<typeof DriveSharedContext>;
export interface DriveSharedStore {
  save(context: SharedContext): Promise<string>;
  load(id: string): Promise<SharedContext>;
}
export const SharedContextId = z.string().uuid().transform(value => value.toLowerCase())
  .describe("Opaque shareContext returned with a shared Drive item. Pass it with that item's ID for subsequent reads; expires after ten minutes or a settings/account change.");
