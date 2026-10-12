import { z } from "zod";
import type { Reminder } from "../icloud/cloudkit.ts";
import { LiteralTagName } from "./organization.ts";

const isoDateTime = z.string().datetime({ offset: true });
const listId = z.string().min(6).max(512).regex(/^List\/[^/\u0000-\u0020\u007f]+$/);

const SearchFilterFields = z.object({
  text: z.string().min(1).max(512).refine(value => value.trim().length > 0, "Search text cannot be blank.")
    .describe("Case-insensitive substring of the reminder title or notes.").optional(),
  status: z.enum(["open", "completed", "all"]).default("open").describe("Reminder completion status; defaults to open."),
  flagged: z.boolean().describe("Filter by whether the reminder is flagged.").optional(),
  priority: z.union([z.literal(0), z.literal(1), z.literal(5), z.literal(9)])
    .describe("Filter by native priority (0, 1, 5, or 9).").optional(),
  dueFrom: isoDateTime.describe("Inclusive lower bound for the due date, as ISO 8601.").optional(),
  dueTo: isoDateTime.describe("Inclusive upper bound for the due date, as ISO 8601.").optional(),
  listId: listId.describe("Exact owned List/ ID; do not supply the list title.").optional(),
  tags: z.array(LiteralTagName).min(1).max(16).refine(values => new Set(values).size === values.length, "Tag filters must contain unique exact literal names.")
    .describe("1–16 unique, exact case-sensitive native tag names.").optional(),
  tagMatch: z.enum(["all", "any"]).describe("How supplied tags match; omission means all tags are required.").optional(),
  hasTags: z.boolean().describe("Filter by whether tag relationships exist; this does not inspect title or notes.").optional(),
  hasUrl: z.boolean().describe("Filter by a separate native URL attachment; ordinary attachments, title and notes do not count.").optional(),
  urlText: z.string().min(1).max(2_048).refine(value => value.trim().length > 0, "URL text cannot be blank.")
    .describe("Case-insensitive substring of the separate native URL attachment.").optional(),
}).strict();

export function validateSearchFilterConstraints(filters: z.infer<typeof SearchFilterFields>, ctx: z.RefinementCtx): void {
  if (filters.tagMatch !== undefined && filters.tags === undefined) {
    ctx.addIssue({ code: "custom", message: "tagMatch requires tags.", path: ["tagMatch"] });
  }
  if (filters.tags !== undefined && filters.hasTags === false) {
    ctx.addIssue({ code: "custom", message: "tags cannot be combined with hasTags=false.", path: ["hasTags"] });
  }
  if (filters.urlText !== undefined && filters.hasUrl === false) {
    ctx.addIssue({ code: "custom", message: "urlText cannot be combined with hasUrl=false.", path: ["hasUrl"] });
  }
  if (filters.dueFrom !== undefined && filters.dueTo !== undefined && Date.parse(filters.dueFrom) > Date.parse(filters.dueTo)) {
    ctx.addIssue({ code: "custom", message: "dueFrom must be earlier than or equal to dueTo.", path: ["dueTo"] });
  }
}

export const SearchFilterFieldsSchema = SearchFilterFields;
export const SearchFilters = SearchFilterFields.superRefine(validateSearchFilterConstraints);

export type ReminderSearchFilters = z.infer<typeof SearchFilters>;

export function matchesReminderSearch(reminder: Reminder, filters: ReminderSearchFilters): boolean {
  if (reminder.deleted === true) return false;
  if (filters.status === "open" && reminder.completed === true) return false;
  if (filters.status === "completed" && reminder.completed !== true) return false;
  if (filters.flagged !== undefined && reminder.flagged !== filters.flagged) return false;
  if (filters.priority !== undefined && reminder.priority !== filters.priority) return false;

  if (filters.text !== undefined) {
    const query = filters.text.toLowerCase();
    if (!reminder.title?.toLowerCase().includes(query) && !reminder.notes?.toLowerCase().includes(query)) return false;
  }

  if (filters.dueFrom !== undefined || filters.dueTo !== undefined) {
    if (reminder.dueDate === null) return false;
    const due = Date.parse(reminder.dueDate);
    if (!Number.isFinite(due) || filters.dueFrom !== undefined && due < Date.parse(filters.dueFrom) || filters.dueTo !== undefined && due > Date.parse(filters.dueTo)) return false;
  }
  return true;
}

export function matchesReminderOrganizationSearch(organization: { tags?: string[]; url?: string | null }, filters: ReminderSearchFilters): boolean {
  if (filters.tags !== undefined) {
    const names = organization.tags;
    if (!names) return false;
    const match = filters.tagMatch ?? "all";
    if (match === "all" ? !filters.tags.every(tag => names.includes(tag)) : !filters.tags.some(tag => names.includes(tag))) return false;
  }
  if (filters.hasTags !== undefined) {
    if (!organization.tags || (organization.tags.length > 0) !== filters.hasTags) return false;
  }
  if (filters.hasUrl !== undefined) {
    if (organization.url === undefined || (organization.url !== null) !== filters.hasUrl) return false;
  }
  if (filters.urlText !== undefined) {
    if (organization.url === undefined || organization.url === null || !organization.url.toLowerCase().includes(filters.urlText.toLowerCase())) return false;
  }
  return true;
}
