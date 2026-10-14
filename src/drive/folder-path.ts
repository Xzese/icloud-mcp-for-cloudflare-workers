import { z } from "zod";
import { DriveItemSchema, type DriveClient, type DriveItem } from "../icloud/drive.ts";
import { DriveFolderListingDiagnostics } from "./listing.ts";

export const DriveFolderPathResult = z.object({
  status: z.enum(["resolved", "not_found", "ambiguous", "unresolved"]),
  reason: z.enum(["parent_listing_incomplete", "ambiguous_name", "folder_not_found"]).nullable(),
  folder: DriveItemSchema.nullable(),
  resolvedPath: z.string(),
  remainingSegments: z.array(z.string()),
  choices: z.array(DriveItemSchema),
  parentListing: DriveFolderListingDiagnostics,
  foldersRead: z.number().int().positive().max(64),
  consistency: z.literal("live-pages-not-snapshot"),
}).strict();

// Canonical equivalence and deterministic case conversion only. Compatibility
// folding, accent removal and locale collation could select a different name.
const canonical = (name: string) => name.normalize("NFC");
const folded = (name: string) => canonical(name).toLowerCase().normalize("NFC");

export async function resolveDriveFolderPath(client: Pick<DriveClient, "listItems">, folderId: string, path: string, shareContext?: string): Promise<z.infer<typeof DriveFolderPathResult>> {
  const segments = path.split("/"), resolved: string[] = [];
  for (let index = 0; index < segments.length; index++) {
    const page = await client.listItems(folderId, shareContext);
    const base = {
      folder: null, resolvedPath: resolved.join("/"), remainingSegments: segments.slice(index), choices: [] as DriveItem[],
      parentListing: { folderId: page.folder.id, shareContext: page.folder.shareContext, complete: page.complete, reasons: page.reasons, counts: page.counts },
      foldersRead: index + 1, consistency: "live-pages-not-snapshot" as const,
    };
    // Even a visible exact name cannot prove uniqueness in an incomplete parent.
    if (!page.complete) return { ...base, status: "unresolved", reason: "parent_listing_incomplete" };
    const name = segments[index]!;
    const folders = page.items.filter(item => item.type === "folder");
    let matches = folders.filter(item => item.name === name);
    if (!matches.length) matches = folders.filter(item => canonical(item.name) === canonical(name));
    if (!matches.length) matches = folders.filter(item => folded(item.name) === folded(name));
    if (!matches.length) return { ...base, status: "not_found", reason: "folder_not_found" };
    if (matches.length > 1) return { ...base, status: "ambiguous", reason: "ambiguous_name", choices: matches.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0) };
    const folder = matches[0]!;
    resolved.push(folder.name);
    if (index === segments.length - 1) return { ...base, status: "resolved", reason: null, folder, resolvedPath: resolved.join("/"), remainingSegments: [] };
    folderId = folder.id;
    shareContext = folder.shareContext;
  }
  throw new Error("A validated folder path must contain at least one segment.");
}
