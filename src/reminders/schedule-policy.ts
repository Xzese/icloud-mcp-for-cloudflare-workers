import { z } from "zod";

// Timed absolute-date changes preserve existing recurrence and alarm identities.
export const SchedulePolicy = z.object({}).strict();
export const scheduleSummary = (reminder: { dueDate: string | null; timeZone: string | null; allDay: boolean | null }) => ({
  dueDate: reminder.dueDate, timeZone: reminder.timeZone, allDay: reminder.allDay,
});
