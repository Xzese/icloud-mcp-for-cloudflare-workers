import { z } from "zod";
import { AppError } from "../errors.ts";

export const RecurrenceCalendarTimeZone = z.string().min(1).max(128).regex(/^[A-Za-z][A-Za-z0-9._+-]*(?:\/[A-Za-z0-9._+-]+)*$/).refine(value => {
  try { new Intl.DateTimeFormat("en-US", { timeZone: value }).format(0); return true; }
  catch { return false; }
}, "Use an explicit valid IANA calendar time-zone identifier.").describe("Explicit IANA calendar zone, such as Europe/London, for an ended all-day interval-one daily recurrence. Interprets the raw EndDate instant as a calendar date in this zone, even when the instant is midnight UTC. Omit for the existing midnight-UTC end recipe; omission refuses nonmidnight ends. Does not set the reminder's stored TimeZone and is refused for other lifecycle recipes. Retain the identical zone with original arguments for uncertain-outcome reconciliation.");

/** All-day due dates encode UTC calendar labels, rather than zoned instants. */
export function recurrenceEndCalendarLabel(end: number, recurrenceCalendarTimeZone?: string): number {
  if (recurrenceCalendarTimeZone === undefined) {
    if (end % 86_400_000 !== 0) throw new AppError("UNSUPPORTED_FEATURE", "A nonmidnight recurrence EndDate requires an explicit recurrenceCalendarTimeZone.");
    return end;
  }
  const zone = RecurrenceCalendarTimeZone.parse(recurrenceCalendarTimeZone);
  const parts = new Intl.DateTimeFormat("en-US-u-ca-gregory-nu-latn", { timeZone: zone, era: "short", year: "numeric", month: "numeric", day: "numeric" }).formatToParts(new Date(end));
  const part = (type: string) => Number(parts.find(part => part.type === type)?.value);
  const year = part("year");
  if (parts.find(part => part.type === "era")?.value !== "AD" || year < 1 || year > 9999) throw new AppError("UNSUPPORTED_FEATURE", "The recurrence end calendar label is outside years 1–9999.");
  const label = new Date(0); label.setUTCFullYear(year, part("month") - 1, part("day")); label.setUTCHours(0, 0, 0, 0);
  return label.getTime();
}
