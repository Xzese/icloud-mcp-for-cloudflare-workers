import { z } from "zod";
import { AppError } from "../errors.ts";
import { b64, unb64, utf8 } from "../crypto/bytes.ts";
import type { CloudKitRecord } from "../icloud/cloudkit.ts";

export const EarlyReminder = z.object({ unit: z.enum(["minutes", "hours"]), count: z.number().int().min(1).max(10_080) }).strict();
const Payload = z.object({
  reminderIdentifier: z.string().uuid(), accountIdentifier: z.string().min(1).max(512), minimumSupportedVersion: z.literal(20230430),
  dueDateDeltaAlerts: z.array(z.object({ creationDate: z.number().finite(), identifier: z.string().uuid(), dueDateDeltaUnit: z.union([z.literal(0), z.literal(1)]),
    dueDateDeltaCount: z.number().int().min(-10_080).max(-1), minimumSupportedAppVersion: z.literal(0) }).strict()).length(1),
}).strict();
export function earlyReminderPayload(record: CloudKitRecord) {
  const field = record.fields.DueDateDeltaAlertsData;
  if (!field || typeof field !== "object" || !("type" in field) || !("value" in field) || field.type !== "ENCRYPTED_BYTES" || typeof field.value !== "string") {
    throw new AppError("UNSUPPORTED_FEATURE", "Early reminder edits require an existing reviewed payload; account metadata is never inferred.");
  }
  let decoded: unknown;
  try { decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(unb64(field.value, 8192))); }
  catch { throw new AppError("UNSUPPORTED_FEATURE", "The early reminder payload is not bounded UTF-8 JSON."); }
  const parsed = Payload.safeParse(decoded);
  if (!parsed.success || parsed.data.reminderIdentifier.toUpperCase() !== record.recordName.slice(9).toUpperCase()) {
    throw new AppError("UNSUPPORTED_FEATURE", "The early reminder payload has unsupported shape, identity or units.");
  }
  return parsed.data;
}
export function editEarlyReminder(record: CloudKitRecord, input: z.infer<typeof EarlyReminder>) {
  const payload = earlyReminderPayload(record);
  if (payload.dueDateDeltaAlerts[0].dueDateDeltaCount === -input.count && payload.dueDateDeltaAlerts[0].dueDateDeltaUnit === (input.unit === "minutes" ? 0 : 1)) throw new AppError("VALIDATION_ERROR", "The early reminder is unchanged.", 400);
  payload.dueDateDeltaAlerts[0].dueDateDeltaCount = -input.count;
  payload.dueDateDeltaAlerts[0].dueDateDeltaUnit = input.unit === "minutes" ? 0 : 1;
  return { type: "ENCRYPTED_BYTES", value: b64(utf8(JSON.stringify(payload))) };
}
