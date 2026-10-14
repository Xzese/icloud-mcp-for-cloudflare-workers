import { z } from "zod";
import { DriveItemSchema, type DriveClient } from "../icloud/drive.ts";
import { DriveFolderListingDiagnostics, DriveListingReason } from "./listing.ts";
import { TraverseDriveOptions } from "./schemas.ts";
import { MAX_ENVELOPE_PLAINTEXT_BYTES } from "../crypto/envelopes.ts";

const count = z.number().int().nonnegative().safe();
const Folder = z.object({ id: z.string(), shareContext: z.string().uuid().optional(), segments: z.array(z.string()).max(64) }).strict();
export const TraversalItem = DriveItemSchema.extend({ relativePath: z.string(), depth: count }).strict();
export const TraversalReason = z.enum([...DriveListingReason.options, "continuation_required", "traversal_item_limit", "traversal_folder_limit", "traversal_depth_limit", "traversal_state_limit"]);
export const TraversalState = z.object({
  version: z.literal(1), input: TraverseDriveOptions,
  queue: z.array(Folder).max(5000), scheduled: z.array(z.string()).max(5000),
  pending: z.object({ folder: Folder, items: z.array(DriveItemSchema).max(1000), offset: count }).strict().nullable(),
  visited: count.max(100_000), foldersVisited: count.max(5000), returned: count.max(100_000),
  incompleteFolders: z.array(DriveFolderListingDiagnostics).max(5000),
  limits: z.array(z.enum(["traversal_item_limit", "traversal_folder_limit", "traversal_depth_limit", "traversal_state_limit"])),
}).strict();
export const TraversalResult = z.object({
  items: z.array(TraversalItem).max(200), complete: z.boolean(), reasons: z.array(TraversalReason),
  incompleteFolders: z.array(DriveFolderListingDiagnostics), continuation: z.string().uuid().nullable(),
  scope: z.literal("selected-folder-tree"), consistency: z.literal("live-pages-not-snapshot"),
  foldersRead: count, progress: z.object({ visited: count, foldersVisited: count, returned: count, queuedFolders: count }).strict(), generation: count,
}).strict();
type State = z.infer<typeof TraversalState>;
const key = (folder: { id: string; shareContext?: string }) => JSON.stringify([folder.id, folder.shareContext ?? null]);
export function newTraversal(input: z.infer<typeof TraverseDriveOptions>): State {
  const folder = { id: input.folderId, shareContext: input.shareContext, segments: [] };
  return { version: 1, input, queue: [folder], scheduled: [key(folder)], pending: null, visited: 0, foldersVisited: 0, returned: 0, incompleteFolders: [], limits: [] };
}

export async function traversalPage(client: Pick<DriveClient, "listItems">, state: State) {
  const items: z.infer<typeof TraversalItem>[] = [], scheduled = new Set(state.scheduled), limits = new Set(state.limits);
  const query = state.input.query?.toLowerCase();
  let foldersRead = 0, queueOffset = 0;
  while (items.length < state.input.limit) {
    if (state.visited >= state.input.maxItems) {
      if (state.pending || queueOffset < state.queue.length) limits.add("traversal_item_limit");
      break;
    }
    if (state.pending) {
      const pending = state.pending;
      const item = pending.items[pending.offset++]!;
      const segments = [...pending.folder.segments, item.name];
      state.visited++;
      if (item.type === "folder") {
        const child = { id: item.id, shareContext: item.shareContext, segments };
        if (!scheduled.has(key(child))) {
          if (segments.length >= state.input.maxDepth) limits.add("traversal_depth_limit");
          else if (scheduled.size >= state.input.maxFolders) limits.add("traversal_folder_limit");
          else { scheduled.add(key(child)); state.queue.push(child); }
        }
      }
      if (query === undefined || item.name.toLowerCase().includes(query)) {
        items.push({ ...item, relativePath: segments.join("/"), depth: segments.length }); state.returned++;
      }
      if (pending.offset === pending.items.length) state.pending = null;
      continue;
    }
    if (queueOffset >= state.queue.length || foldersRead >= 3) break;
    const folder = state.queue[queueOffset++]!;
    const page = await client.listItems(folder.id, folder.shareContext);
    foldersRead++; state.foldersVisited++;
    if (!page.complete) state.incompleteFolders.push({ folderId: page.folder.id, shareContext: page.folder.shareContext, complete: false, reasons: page.reasons, counts: page.counts });
    if (page.items.length) state.pending = { folder, items: page.items, offset: 0 };
  }
  state.queue = state.queue.slice(queueOffset);
  state.scheduled = [...scheduled];
  // Omit already emitted metadata from the next encrypted checkpoint.
  if (state.pending) { state.pending.items = state.pending.items.slice(state.pending.offset); state.pending.offset = 0; }
  if (state.visited >= state.input.maxItems && (state.pending || state.queue.length)) limits.add("traversal_item_limit");
  state.limits = [...limits];
  let canContinue = Boolean(state.pending || state.queue.length) && !limits.has("traversal_item_limit");
  if (canContinue && new TextEncoder().encode(JSON.stringify(state)).byteLength > MAX_ENVELOPE_PLAINTEXT_BYTES) {
    limits.add("traversal_state_limit"); canContinue = false;
  }
  state.limits = [...limits];
  const reasons = new Set<z.infer<typeof TraversalReason>>(state.incompleteFolders.flatMap(folder => folder.reasons));
  limits.forEach(reason => reasons.add(reason));
  if (canContinue) reasons.add("continuation_required");
  return { state, canContinue, result: {
    items, complete: reasons.size === 0, reasons: [...reasons], incompleteFolders: state.incompleteFolders,
    scope: "selected-folder-tree" as const, consistency: "live-pages-not-snapshot" as const, foldersRead,
    progress: { visited: state.visited, foldersVisited: state.foldersVisited, returned: state.returned, queuedFolders: state.queue.length + (state.pending ? 1 : 0) },
  } };
}
