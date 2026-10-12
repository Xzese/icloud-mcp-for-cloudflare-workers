import { z } from "zod";
import { AppError } from "../errors.ts";
import { b64, unb64, utf8 } from "../crypto/bytes.ts";
import type { CloudKitRecord } from "../icloud/cloudkit.ts";

export const EARLY_UNITS = ["minutes", "hours", "days", "weeks", "months"] as const;
export const EarlyReminder = z.object({ unit: z.enum(EARLY_UNITS), count: z.number().int().min(1).max(10_080) }).strict();
type EarlyUnitCode = 0 | 1 | 2 | 3 | 4;
const UUID = z.string().uuid();
const Payload = z.object({
  reminderIdentifier: UUID, accountIdentifier: UUID, minimumSupportedVersion: z.literal(20230430),
  dueDateDeltaAlerts: z.array(z.object({ creationDate: z.number().finite(), identifier: UUID, dueDateDeltaUnit: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
    dueDateDeltaCount: z.number().int().min(-10_080).max(-1), minimumSupportedAppVersion: z.literal(0) }).strict()).length(1),
}).strict();
function earlyUnitCode(unit: z.infer<typeof EarlyReminder>["unit"]): EarlyUnitCode {
  return EARLY_UNITS.indexOf(unit) as EarlyUnitCode;
}
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
export function createEarlyReminder(
  target: CloudKitRecord, source: CloudKitRecord, input: z.infer<typeof EarlyReminder>, now: number,
) {
  const parsedInput = EarlyReminder.parse(input);
  const sourcePayload = earlyReminderPayload(source);
  const targetId = target.recordName.startsWith("Reminder/") ? target.recordName.slice("Reminder/".length) : "";
  if (target.recordType !== "Reminder" || source.recordType !== "Reminder" || source.recordName === target.recordName || !UUID.safeParse(targetId).success) {
    throw new AppError("UNSUPPORTED_FEATURE", "Early reminder creation requires exact UUID reminder identities from the verified private zone.");
  }
  if (!Number.isSafeInteger(now) || now < 0) throw new AppError("PROTOCOL_CHANGED", "The early reminder creation time is invalid.");
  const payload = {
    reminderIdentifier: targetId,
    accountIdentifier: sourcePayload.accountIdentifier,
    minimumSupportedVersion: 20230430 as const,
    dueDateDeltaAlerts: [{
      creationDate: now / 1000 - 978_307_200,
      identifier: crypto.randomUUID().toUpperCase(),
      dueDateDeltaUnit: earlyUnitCode(parsedInput.unit),
      dueDateDeltaCount: -parsedInput.count,
      minimumSupportedAppVersion: 0 as const,
    }],
  };
  const validated = Payload.parse(payload);
  return { type: "ENCRYPTED_BYTES", value: b64(utf8(JSON.stringify(validated))) };
}
export function editEarlyReminder(record: CloudKitRecord, input: z.infer<typeof EarlyReminder>) {
  const payload = earlyReminderPayload(record);
  const unit = earlyUnitCode(input.unit);
  if (payload.dueDateDeltaAlerts[0].dueDateDeltaCount === -input.count && payload.dueDateDeltaAlerts[0].dueDateDeltaUnit === unit) throw new AppError("VALIDATION_ERROR", "The early reminder is unchanged.", 400);
  payload.dueDateDeltaAlerts[0].dueDateDeltaCount = -input.count;
  payload.dueDateDeltaAlerts[0].dueDateDeltaUnit = unit;
  return { type: "ENCRYPTED_BYTES", value: b64(utf8(JSON.stringify(payload))) };
}
