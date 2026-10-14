import { z } from "zod";
import { AppError } from "../errors.ts";
import { b64, unb64, utf8 } from "../crypto/bytes.ts";
import { canonicalJSON } from "../lib/canonical.ts";
import type { CloudKitRecord } from "../icloud/cloudkit.ts";

// This is an API inspection limit, not a claim about Apple's UI maximum.
export const MAX_RECURRENCE_INTERVAL = 999;
const FREQUENCY_CODES = { daily: 0, weekly: 1, monthly: 2, yearly: 3, hourly: 4 } as const;
const FREQUENCY_NAMES = { 0: "daily", 1: "weekly", 2: "monthly", 3: "yearly", 4: "hourly" } as const;
const weekday = z.number().int().min(1).max(7).describe("ISO weekday: Monday=1 through Sunday=7.");
const ordinal = z.union([z.literal(-1), z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]);
const unique = (values: number[]) => new Set(values).size === values.length;
const weekdays = z.array(weekday).min(1).max(7).refine(unique, "Weekdays must be unique.");
const monthDays = z.array(z.number().int().min(1).max(31)).min(1).max(31).refine(unique, "Month days must be unique.");
const months = z.array(z.number().int().min(1).max(12)).min(1).max(12).refine(unique, "Months must be unique.");
const ordinalWeekday = z.object({ weekday, ordinal }).strict();
const endDate = z.string().max(64).datetime({ offset: true }).refine(value => {
  const date = new Date(value); return Number.isSafeInteger(date.getTime()) && date.getUTCFullYear() >= 1 && date.getUTCFullYear() <= 9999;
}, "End date must be a valid explicit-offset instant in years 1-9999.");
const recurrenceFields = {
  frequency: z.enum(["daily", "weekly", "monthly", "yearly", "hourly"]), interval: z.number().int().min(1).max(MAX_RECURRENCE_INTERVAL),
  weekdays: weekdays.nullable().optional(), monthDays: monthDays.nullable().optional(), ordinalWeekday: ordinalWeekday.nullable().optional(),
  months: months.nullable().optional(),
  endDate: endDate.nullable().optional().describe("Explicit-offset recurrence end instant; null removes it, omission preserves it. No implicit date-only end or anchor shift."),
};
export const RecurrenceChanges = z.object(recurrenceFields).strict().superRefine((input, context) => {
  const active = [input.weekdays, input.monthDays, input.ordinalWeekday, input.months].filter(value => value !== undefined && value !== null);
  if (active.length > 1) context.addIssue({ code: z.ZodIssueCode.custom, message: "Choose one recurrence day pattern." });
  if (input.months !== undefined && input.frequency !== "yearly") context.addIssue({ code: z.ZodIssueCode.custom, path: ["months"], message: "Months require yearly frequency." });
  if (input.weekdays !== undefined && input.frequency !== "weekly") context.addIssue({ code: z.ZodIssueCode.custom, path: ["weekdays"], message: "Weekdays require weekly frequency." });
  if ((input.monthDays !== undefined || input.ordinalWeekday !== undefined) && input.frequency !== "monthly") context.addIssue({ code: z.ZodIssueCode.custom, message: "Month days and ordinal weekdays require monthly frequency." });
});
export const RecurrenceSummary = z.object({ ...recurrenceFields, endDate: endDate.nullable(),
  setPositions: z.tuple([z.literal(-1)]).optional().describe("Read-only native final selection from monthDays; preserved during date moves, never inferred or accepted as an edit."),
}).strict();
export type RecurrenceInput = z.infer<typeof RecurrenceChanges>;
export type RecurrenceState = z.infer<typeof RecurrenceSummary>;
const WeekEntries = z.array(z.object({ dayOfTheWeek: z.number().int().min(1).max(7), weekNumber: z.number().int().min(-1).max(5) }).strict()).min(1).max(7);
export const RECURRENCE_PATTERN_FIELDS = ["DaysOfTheWeek", "DaysOfTheMonth", "MonthsOfTheYear"] as const;
function field(record: CloudKitRecord, key: string, type: string): unknown {
  const field = record.fields[key];
  if (!field || typeof field !== "object" || !("type" in field) || !("value" in field) || field.type !== type) throw new AppError("UNSUPPORTED_FEATURE", `Unsupported recurrence field ${key}.`);
  return field.value;
}
function present(record: CloudKitRecord, key: string) {
  const wrapper = record.fields[key];
  return Object.hasOwn(record.fields, key) && (!wrapper || typeof wrapper !== "object" || !("value" in wrapper) || wrapper.value !== null);
}
export function decodeRecurrencePattern(value: unknown, key: "DaysOfTheWeek" | "DaysOfTheMonth" | "MonthsOfTheYear") {
  if (typeof value !== "string") throw new AppError("UNSUPPORTED_FEATURE", "Recurrence patterns must be bounded base64 UTF-8 JSON.");
  let decoded: unknown;
  try { decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(unb64(value, 8192))); }
  catch { throw new AppError("UNSUPPORTED_FEATURE", "Recurrence patterns must be bounded base64 UTF-8 JSON."); }
  const parsed = key === "DaysOfTheWeek" ? WeekEntries.safeParse(decoded) : key === "DaysOfTheMonth" ? monthDays.safeParse(decoded) : months.safeParse(decoded);
  if (!parsed.success) throw new AppError("UNSUPPORTED_FEATURE", "The recurrence day pattern is unsupported.");
  return parsed.data;
}
export function readRecurrence(record: CloudKitRecord): RecurrenceState {
  const allowed = ["Reminder", "Frequency", "Interval", "OccurrenceCount", "FirstDayOfTheWeek", "Imported", "Deleted", "EndDate", ...RECURRENCE_PATTERN_FIELDS];
  if (record.recordType !== "RecurrenceRule" || Object.keys(record.fields).some(key => !allowed.includes(key)) ||
    field(record, "OccurrenceCount", "INT64") !== 0 || field(record, "FirstDayOfTheWeek", "INT64") !== 0 ||
    field(record, "Imported", "INT64") !== 0 || field(record, "Deleted", "INT64") !== 0) throw new AppError("UNSUPPORTED_FEATURE", "The recurrence uses unsupported count, calendar, import, state or pattern fields.");
  const frequency = field(record, "Frequency", "INT64"), interval = field(record, "Interval", "INT64");
  if (typeof frequency !== "number" || ![0, 1, 2, 3, 4].includes(frequency) || typeof interval !== "number" || !Number.isSafeInteger(interval) || interval < 1 || interval > MAX_RECURRENCE_INTERVAL) throw new AppError("UNSUPPORTED_FEATURE", "The recurrence frequency or interval is unsupported.");
  const result: RecurrenceState = { frequency: FREQUENCY_NAMES[frequency as keyof typeof FREQUENCY_NAMES], interval, endDate: null };
  for (const key of RECURRENCE_PATTERN_FIELDS) if (Object.hasOwn(record.fields, key)) field(record, key, "BYTES");
  if (present(record, "MonthsOfTheYear")) {
    if (frequency !== 3 || present(record, "DaysOfTheWeek") || present(record, "DaysOfTheMonth")) throw new AppError("UNSUPPORTED_FEATURE", "Year-month patterns require yearly frequency without another day pattern.");
    result.months = decodeRecurrencePattern(field(record, "MonthsOfTheYear", "BYTES"), "MonthsOfTheYear") as number[];
  }
  if (present(record, "DaysOfTheMonth")) {
    if (frequency !== 2 || present(record, "DaysOfTheWeek")) throw new AppError("UNSUPPORTED_FEATURE", "Month-day patterns require a monthly recurrence without another day pattern.");
    result.monthDays = decodeRecurrencePattern(field(record, "DaysOfTheMonth", "BYTES"), "DaysOfTheMonth") as number[];
  }
  if (present(record, "DaysOfTheWeek")) {
    const days = decodeRecurrencePattern(field(record, "DaysOfTheWeek", "BYTES"), "DaysOfTheWeek") as z.infer<typeof WeekEntries>;
    const iso = (native: number) => (native + 5) % 7 + 1;
    if (frequency === 1 && days.every(day => day.weekNumber === 0) && new Set(days.map(day => day.dayOfTheWeek)).size === days.length) result.weekdays = days.map(day => iso(day.dayOfTheWeek));
    else if (frequency === 2 && days.length === 1 && ordinal.safeParse(days[0].weekNumber).success) result.ordinalWeekday = { weekday: iso(days[0].dayOfTheWeek), ordinal: days[0].weekNumber as -1 | 1 | 2 | 3 | 4 | 5 };
    else throw new AppError("UNSUPPORTED_FEATURE", "The recurrence uses an unsupported weekday/ordinal combination.");
  }
  if (Object.hasOwn(record.fields, "EndDate")) {
    const value = field(record, "EndDate", "TIMESTAMP");
    if (value !== null) {
      if (typeof value !== "number" || !Number.isSafeInteger(value) || !Number.isFinite(new Date(value).getTime())) throw new AppError("UNSUPPORTED_FEATURE", "The recurrence end instant is invalid.");
      const parsed = endDate.safeParse(new Date(value).toISOString());
      if (!parsed.success) throw new AppError("UNSUPPORTED_FEATURE", "The recurrence end instant is outside the supported range.");
      result.endDate = parsed.data;
    }
  }
  return result;
}

/** Date moves preserve this observed native monthly rule; recurrence edits remain strict. */
export function readPreservedRecurrence(record: CloudKitRecord): RecurrenceState {
  if (!Object.hasOwn(record.fields, "SetPositions")) return readRecurrence(record);
  const base = { ...record, fields: Object.fromEntries(Object.entries(record.fields).filter(([key]) => key !== "SetPositions")) };
  const recurrence = readRecurrence(base);
  if (recurrence.frequency !== "monthly" || recurrence.interval !== 1 || recurrence.endDate !== null ||
    !Array.isArray(recurrence.monthDays) || canonicalJSON(recurrence.monthDays) !== "[28,29]") {
    throw new AppError("UNSUPPORTED_FEATURE", "The recurrence SetPositions shape is outside the observed monthly date-preservation recipe.");
  }
  const encoded = field(record, "SetPositions", "BYTES");
  if (typeof encoded !== "string") throw new AppError("UNSUPPORTED_FEATURE", "The recurrence SetPositions must be bounded base64 UTF-8 JSON.");
  let positions: unknown;
  try { positions = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(unb64(encoded, 8192))); }
  catch { throw new AppError("UNSUPPORTED_FEATURE", "The recurrence SetPositions must be bounded base64 UTF-8 JSON."); }
  if (!Array.isArray(positions) || positions.length !== 1 || positions[0] !== -1) throw new AppError("UNSUPPORTED_FEATURE", "The recurrence SetPositions value is outside the observed final-selection recipe.");
  return { ...recurrence, setPositions: [-1] };
}

/** Separate completion recipe: never relax the ordinary recurrence-edit reader. */
export function readCompletionRecurrence(record: CloudKitRecord): { kind: "weekly" | "last-day-monthly" | "monthly-29" | "monthly" | "daily"; endDate: number | null } {
  const positions = record.fields.SetPositions;
  const base = { ...record, fields: Object.fromEntries(Object.entries(record.fields).filter(([key]) => key !== "SetPositions")) };
  const recurrence = readRecurrence(base);
  if (recurrence.interval !== 1 || recurrence.weekdays || recurrence.ordinalWeekday || recurrence.months) {
    throw new AppError("UNSUPPORTED_FEATURE", "This recurring completion pattern needs another native recipe.");
  }
  const endDate = recurrence.endDate === null ? null : Date.parse(recurrence.endDate);
  if (recurrence.frequency === "weekly" && !recurrence.monthDays && positions === undefined) return { kind: "weekly", endDate };
  if (recurrence.frequency === "daily" && !recurrence.monthDays && positions === undefined) return { kind: "daily", endDate };
  // Ordinary Monthly has no explicit day selection: the current due date is
  // its calendar anchor, including after a native date edit.
  if (recurrence.frequency === "monthly" && endDate === null && !recurrence.monthDays && positions === undefined) return { kind: "monthly", endDate };
  if (recurrence.frequency === "monthly" && endDate === null && ["[28,29]", "[28,29,30,31]"].includes(canonicalJSON(recurrence.monthDays)) &&
    positions && typeof positions === "object" && "type" in positions && positions.type === "BYTES" && "value" in positions && typeof positions.value === "string") {
    try {
      if (canonicalJSON(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(unb64(positions.value, 8192)))) === "[-1]")
        return { kind: canonicalJSON(recurrence.monthDays) === "[28,29]" ? "monthly-29" : "last-day-monthly", endDate };
    } catch { /* reject an unknown pattern below */ }
  }
  throw new AppError("UNSUPPORTED_FEATURE", "Supported completion patterns are interval-one weekly, all-day daily, non-ended timed daily or ordinary monthly with one absolute alarm, and the observed last-day monthly rule.");
}
export function recurrenceEdit(record: CloudKitRecord, input: RecurrenceInput) {
  const before = readRecurrence(record), parsed = RecurrenceChanges.parse(input);
  const fields: Record<string, { type: string; value: unknown }> = {};
  const frequency = FREQUENCY_CODES[parsed.frequency];
  if (parsed.frequency !== before.frequency) fields.Frequency = { type: "INT64", value: frequency };
  if (parsed.interval !== before.interval) fields.Interval = { type: "INT64", value: parsed.interval };
  const setPattern = (key: "DaysOfTheWeek" | "DaysOfTheMonth" | "MonthsOfTheYear", value: unknown) => {
    const encoded = value === null ? null : b64(utf8(JSON.stringify(value)));
    if (value === null ? present(record, key) : canonicalJSON(fieldOrNull(record, key)) !== canonicalJSON(encoded)) fields[key] = { type: "BYTES", value: encoded };
  };
  if (parsed.frequency !== before.frequency) for (const key of RECURRENCE_PATTERN_FIELDS) setPattern(key, null);
  if (parsed.weekdays !== undefined) setPattern("DaysOfTheWeek", parsed.weekdays === null ? null : parsed.weekdays.map(day => ({ dayOfTheWeek: day % 7 + 1, weekNumber: 0 })));
  if (parsed.monthDays !== undefined) {
    setPattern("DaysOfTheMonth", parsed.monthDays);
    if (parsed.monthDays !== null) setPattern("DaysOfTheWeek", null);
  }
  if (parsed.ordinalWeekday !== undefined) {
    setPattern("DaysOfTheWeek", parsed.ordinalWeekday === null ? null : [{ dayOfTheWeek: parsed.ordinalWeekday.weekday % 7 + 1, weekNumber: parsed.ordinalWeekday.ordinal }]);
    if (parsed.ordinalWeekday !== null) setPattern("DaysOfTheMonth", null);
  }
  if (parsed.months !== undefined) setPattern("MonthsOfTheYear", parsed.months);
  if (parsed.endDate !== undefined) {
    const value = parsed.endDate === null ? null : Date.parse(parsed.endDate);
    if (value !== (before.endDate === null ? null : Date.parse(before.endDate))) fields.EndDate = { type: "TIMESTAMP", value };
  }
  const after = readRecurrence({ ...record, fields: { ...record.fields, ...fields } });
  return { fields, after };
}
function fieldOrNull(record: CloudKitRecord, key: string) {
  return Object.hasOwn(record.fields, key) ? field(record, key, "BYTES") : null;
}
export function validRecurrenceMutation(fields: Record<string, { type: string; value: unknown }>) {
  const keys = Object.keys(fields);
  if (!keys.length || keys.length > 6) return false;
  return keys.every(key => {
    const wrapper = fields[key];
    if (key === "Frequency") return wrapper.type === "INT64" && typeof wrapper.value === "number" && [0, 1, 2, 3, 4].includes(wrapper.value);
    if (key === "Interval") return wrapper.type === "INT64" && typeof wrapper.value === "number" && Number.isSafeInteger(wrapper.value) && wrapper.value >= 1 && wrapper.value <= MAX_RECURRENCE_INTERVAL;
    if (key === "EndDate") return wrapper.type === "TIMESTAMP" && (wrapper.value === null || typeof wrapper.value === "number" && Number.isSafeInteger(wrapper.value) && Number.isFinite(new Date(wrapper.value).getTime()));
    if (key === "DaysOfTheWeek" || key === "DaysOfTheMonth" || key === "MonthsOfTheYear") {
      if (wrapper.type !== "BYTES") return false;
      if (wrapper.value === null) return true;
      try { decodeRecurrencePattern(wrapper.value, key); return true; } catch { return false; }
    }
    return false;
  });
}

export function recurrenceCreation(reminderId: string, input: RecurrenceInput) {
  const fields: Record<string, { type: string; value: unknown }> = {
    Reminder: { type: "REFERENCE", value: { recordName: reminderId, action: "VALIDATE" } },
    Frequency: { type: "INT64", value: 0 }, Interval: { type: "INT64", value: 1 }, OccurrenceCount: { type: "INT64", value: 0 },
    FirstDayOfTheWeek: { type: "INT64", value: 0 }, Imported: { type: "INT64", value: 0 }, Deleted: { type: "INT64", value: 0 },
  };
  const base: CloudKitRecord = { recordName: "RecurrenceRule/new", recordType: "RecurrenceRule", fields, raw: {} };
  return { ...fields, ...recurrenceEdit(base, input).fields };
}
export function validRecurrenceCreation(fields: Record<string, { type: string; value: unknown }>) {
  try { readRecurrence({ recordName: "RecurrenceRule/new", recordType: "RecurrenceRule", fields, raw: {} }); return true; }
  catch { return false; }
}
