import { z } from "zod";
import type { Reminder } from "../icloud/cloudkit.ts";
import { SearchFilters, type ReminderSearchFilters } from "./search.ts";

const dateTime = z.string().datetime({ offset: true });
const timeZoneSchema = z.string().min(1).max(128).refine(value => {
  try { new Intl.DateTimeFormat("en", { timeZone: value }).format(0); return true; } catch { return false; }
}, "timeZone must be a valid IANA time zone.");

export const ReminderCollectionInput = z.object({
  view: z.enum(["all", "overdue", "today", "upcoming", "untagged"]).default("all").describe("Connector view; all applies only the supplied search filters."),
  timeZone: timeZoneSchema.describe("Explicit IANA timezone for calendar-day boundaries."),
  referenceInstant: dateTime.describe("One explicit ISO instant used throughout this live collection."),
  upcomingDays: z.number().int().min(1).max(90).default(7).describe("Upcoming window in calendar days, excluding today; default 7."),
  sortBy: z.enum(["due", "priority", "title", "created"]).default("due").describe("Sort complete results by this field, with deterministic ID ties; missing values last."),
  filters: SearchFilters.default({ status: "open" }).describe("Existing native search filters, combined with the connector view; defaults to open reminders."),
}).strict();

export type ReminderCollectionInputData = z.infer<typeof ReminderCollectionInput>;
export type CollectedReminder = Omit<Reminder, "raw">;

export interface ReminderSearchCollectionPage {
  records: CollectedReminder[];
  scannedRecords: number;
  complete: boolean;
  paginationComplete: boolean;
  continuation: string | null;
}

export interface ReminderSearchCollectionResponse {
  generation: number;
  result: ReminderSearchCollectionPage;
}

export interface ReminderSearchCollectionRequest {
  expectedGeneration?: number;
  filters: ReminderSearchFilters;
  continuation: string | null;
  remainingReminders: number;
}

export interface ReminderCollectionBounds {
  maxPages?: number;
  maxReminders?: number;
  maxBytes?: number;
  maxDurationMs?: number;
  maxExportBytes?: number;
}

export interface CollectReminderOptions extends ReminderCollectionBounds {
  input: z.input<typeof ReminderCollectionInput>;
  searchPage: (request: ReminderSearchCollectionRequest) => Promise<ReminderSearchCollectionResponse>;
}

export interface ReminderCollection {
  generation: number;
  pagesRead: number;
  records: CollectedReminder[];
  complete: true;
}

export class ReminderCollectionError extends Error {
  constructor(message: string) { super(message); this.name = "ReminderCollectionError"; }
}

const DEFAULT_BOUNDS = { maxPages: 100, maxReminders: 5_000, maxBytes: 4 * 1024 * 1024, maxDurationMs: 30_000, maxExportBytes: 4 * 1024 * 1024 } as const;
const encoder = new TextEncoder();

function localDateParts(date: Date, timeZone: string): { year: number; month: number; day: number; date: string } {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  const year = Number(values.year), month = Number(values.month), day = Number(values.day);
  return { year, month, day, date: `${values.year!.padStart(4, "0")}-${values.month}-${values.day}` };
}

function addCalendarDays(date: string, days: number): string {
  const next = new Date(`${date}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + days);
  return `${next.getUTCFullYear().toString().padStart(4, "0")}-${(next.getUTCMonth() + 1).toString().padStart(2, "0")}-${next.getUTCDate().toString().padStart(2, "0")}`;
}

function belongsToView(reminder: CollectedReminder, input: ReminderCollectionInputData, refMs: number, today: string): boolean {
  if (input.view === "all") return true;
  // Search hydrates native tag presence and applies hasTags=false. A missing
  // normalized ID field alone must not override that verified selection.
  if (input.view === "untagged") return true;
  if (reminder.dueDate === null) return false;
  const dueMs = Date.parse(reminder.dueDate);
  if (!Number.isFinite(dueMs)) throw new ReminderCollectionError("A due date cannot be interpreted; no partial result is available.");
  // All-day dates retain Apple's calendar components. Timed reminders use the
  // requested local date; comparing dates also handles skipped/repeated midnights.
  const dueDay = reminder.allDay === true ? reminder.dueDate.slice(0, 10) : localDateParts(new Date(dueMs), input.timeZone).date;
  if (input.view === "overdue") return reminder.allDay === true ? dueDay < today : dueMs < refMs;
  if (input.view === "today") return dueDay === today;
  return dueDay > today && dueDay < addCalendarDays(today, input.upcomingDays + 1);
}

function compareNullable(a: string | number | null, b: string | number | null): number {
  if (a === null) return b === null ? 0 : 1;
  if (b === null) return -1;
  if (typeof a === "string" && typeof b === "string") return a < b ? -1 : a > b ? 1 : 0;
  return Number(a) - Number(b);
}

function sortReminders(records: CollectedReminder[], sortBy: ReminderCollectionInputData["sortBy"]): void {
  const compareDate = (a: string | null, b: string | null) => {
    if (a === null || b === null) return compareNullable(a, b);
    const left = Date.parse(a), right = Date.parse(b);
    if (Number.isFinite(left) && Number.isFinite(right)) return left - right;
    return compareNullable(a, b);
  };
  const priorityRank = (priority: number | null) => priority === 1 ? 0 : priority === 5 ? 1 : priority === 9 ? 2 : priority === 0 ? 3 : 4;
  const compare = (a: CollectedReminder, b: CollectedReminder) => {
    if (sortBy === "priority") return priorityRank(a.priority) - priorityRank(b.priority);
    if (sortBy === "title") return compareNullable(a.title?.toLowerCase() ?? null, b.title?.toLowerCase() ?? null);
    if (sortBy === "created") return compareDate(a.created, b.created);
    return compareDate(a.dueDate, b.dueDate);
  };
  records.sort((a, b) => compare(a, b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export async function collectReminders(options: CollectReminderOptions): Promise<ReminderCollection> {
  const input = ReminderCollectionInput.parse(options.input);
  const bounds = {
    maxPages: options.maxPages ?? DEFAULT_BOUNDS.maxPages,
    maxReminders: options.maxReminders ?? DEFAULT_BOUNDS.maxReminders,
    maxBytes: options.maxBytes ?? DEFAULT_BOUNDS.maxBytes,
    maxDurationMs: options.maxDurationMs ?? DEFAULT_BOUNDS.maxDurationMs,
    maxExportBytes: options.maxExportBytes ?? DEFAULT_BOUNDS.maxExportBytes,
  };
  for (const [name, value] of Object.entries(bounds)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new ReminderCollectionError(`${name} must be a positive safe integer.`);
  }
  const refMs = Date.parse(input.referenceInstant);
  const today = localDateParts(new Date(refMs), input.timeZone).date;
  let filters = input.filters;
  if (input.view === "untagged") {
    if (filters.hasTags === true || filters.tags !== undefined) throw new ReminderCollectionError("The untagged view cannot be combined with tags or hasTags=true.");
    filters = SearchFilters.parse({ ...filters, hasTags: false });
  }
  const startedAt = Date.now();
  const ids = new Set<string>(), cursors = new Set<string>();
  const records: CollectedReminder[] = [];
  let continuation: string | null = null, generation: number | undefined, pagesRead = 0, bytesRead = 0, scannedRecords = 0;
  while (true) {
    if (Date.now() - startedAt > bounds.maxDurationMs) throw new ReminderCollectionError("Collection exceeded its time bound; no partial result is available.");
    if (pagesRead >= bounds.maxPages) throw new ReminderCollectionError("Collection exceeded its page bound; no partial result is available.");
    if (scannedRecords >= bounds.maxReminders) throw new ReminderCollectionError("Collection exceeded its scanned reminder bound; no partial result is available.");
    const remainingMs = bounds.maxDurationMs - (Date.now() - startedAt);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const response: ReminderSearchCollectionResponse = await Promise.race<ReminderSearchCollectionResponse>([
      options.searchPage({ expectedGeneration: generation, filters, continuation, remainingReminders: bounds.maxReminders - scannedRecords }),
      new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new ReminderCollectionError("Collection exceeded its time bound; no partial result is available.")), Math.max(1, remainingMs)); }),
    ]).finally(() => { if (timeout !== undefined) clearTimeout(timeout); });
    if (Date.now() - startedAt > bounds.maxDurationMs) throw new ReminderCollectionError("Collection exceeded its time bound; no partial result is available.");
    pagesRead++;
    if (generation === undefined) generation = response.generation;
    else if (response.generation !== generation) throw new ReminderCollectionError("Apple session generation changed during collection; no partial result is available.");
    const page: ReminderSearchCollectionPage = response.result;
    if (!page || typeof page.complete !== "boolean" || typeof page.paginationComplete !== "boolean" || !(page.continuation === null || typeof page.continuation === "string"))
      throw new ReminderCollectionError("Search page pagination metadata was malformed; no partial result is available.");
    if (!page.complete) throw new ReminderCollectionError("A search page was incomplete; no partial result is available.");
    if (!Array.isArray(page.records)) throw new ReminderCollectionError("Search page records were malformed; no partial result is available.");
    if (!Number.isSafeInteger(page.scannedRecords) || page.scannedRecords < page.records.length) throw new ReminderCollectionError("Search page scan counts were malformed; no partial result is available.");
    scannedRecords += page.scannedRecords;
    if (scannedRecords > bounds.maxReminders) throw new ReminderCollectionError("Collection exceeded its scanned reminder bound; no partial result is available.");
    for (const reminder of page.records) {
      if (!reminder || typeof reminder.id !== "string" || reminder.id.length === 0) throw new ReminderCollectionError("A reminder ID was malformed; no partial result is available.");
      if (ids.has(reminder.id)) throw new ReminderCollectionError("Search returned a duplicate reminder ID; no partial result is available.");
      ids.add(reminder.id);
      const normalized = Object.fromEntries(Object.entries(reminder).filter(([key]) => key !== "raw")) as CollectedReminder;
      const size = encoder.encode(JSON.stringify(normalized)).byteLength;
      bytesRead += size;
      if (ids.size > bounds.maxReminders || bytesRead > bounds.maxBytes) throw new ReminderCollectionError("Collection exceeded its reminder or byte bound; no partial result is available.");
      if (belongsToView(normalized, input, refMs, today)) records.push(normalized);
    }
    if (page.paginationComplete) {
      if (page.continuation !== null) throw new ReminderCollectionError("Terminal search page included a continuation; no partial result is available.");
      break;
    }
    if (typeof page.continuation !== "string" || page.continuation.length === 0) throw new ReminderCollectionError("Nonterminal search page omitted its continuation; no partial result is available.");
    if (cursors.has(page.continuation)) throw new ReminderCollectionError("Search repeated a continuation; no partial result is available.");
    cursors.add(page.continuation);
    continuation = page.continuation;
  }
  sortReminders(records, input.sortBy);
  return { generation: generation!, pagesRead, records, complete: true };
}

export const ReminderCollectionExportInput = z.object({ format: z.enum(["json", "csv"]), maxBytes: z.number().int().min(1).max(16 * 1024 * 1024).default(DEFAULT_BOUNDS.maxExportBytes) }).strict();

function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
  if (/^[\t\r\n]|^\s*[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export function exportReminderCollection(collection: ReminderCollection, options: z.input<typeof ReminderCollectionExportInput>): string {
  const parsed = ReminderCollectionExportInput.parse(options);
  const fields: (keyof CollectedReminder)[] = ["id", "listId", "title", "notes", "completed", "completedDate", "dueDate", "startDate", "priority", "flagged", "allDay", "deleted", "timeZone", "parentReminderId", "alarmIds", "attachmentIds", "hashtagIds", "recurrenceRuleIds", "created", "modified", "recordChangeTag"];
  const content = parsed.format === "json"
    ? JSON.stringify(collection.records)
    : [fields.map(csvCell).join(","), ...collection.records.map(reminder => fields.map(field => csvCell(reminder[field])).join(","))].join("\r\n");
  if (encoder.encode(content).byteLength > parsed.maxBytes) throw new ReminderCollectionError("Export exceeded its byte bound; no truncated output is available.");
  return content;
}
