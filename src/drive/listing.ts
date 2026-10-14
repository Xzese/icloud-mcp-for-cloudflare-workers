import { z } from "zod";

export const DriveListingReason = z.enum([
  "missing_direct_children_count", "upstream_count_mismatch", "item_limit",
  "excluded_shared_entries", "excluded_app_library_entries", "excluded_other_zone_entries",
]);
const count = z.number().int().nonnegative().safe();
export const DriveListingDiagnostics = z.object({
  complete: z.boolean(),
  reasons: z.array(DriveListingReason),
  counts: z.object({
    expected: count.nullable(), received: count, processed: count, returned: count,
    excluded: count, excludedShared: count, excludedAppLibrary: count, excludedOtherZone: count,
    unprocessed: count,
  }).strict(),
}).strict();
export const DriveFolderListingDiagnostics = DriveListingDiagnostics.extend({ folderId: z.string(), shareContext: z.string().uuid().optional() }).strict();
export const DriveSearchReason = z.enum([...DriveListingReason.options, "continuation_required", "search_item_limit", "listing_details_unavailable"]);
