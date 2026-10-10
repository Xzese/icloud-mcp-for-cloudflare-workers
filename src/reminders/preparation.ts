import { z } from "zod";
import { b64, unb64, utf8 } from "../crypto/bytes.ts";
import type { EnvelopeContext } from "../crypto/envelopes.ts";
import { AppError } from "../errors.ts";
import { configuredEnvelopes } from "../persistence/apple-sessions.ts";
import type { RuntimeEnv } from "../platform/sites.ts";
import { UpdateReminderInput } from "./writes.ts";
import { SchedulePolicy } from "./schedule-policy.ts";

const EnvelopeSchema = z.object({ version: z.literal(1), keyId: z.string().min(1).max(64), iv: z.string().max(32), ciphertext: z.string().max(8192) }).strict();
const Token = z.object({ requestHash: z.string().regex(/^[a-f0-9]{64}$/), graphFingerprint: z.string().regex(/^[a-f0-9]{64}$/), expiresAt: z.number().int().safe().positive() }).strict();
export const PreparationToken = z.string().min(1).max(12_288).describe("Expiring owner/account/session-bound preparation token; not user authorization.");
export const PreparedUpdateInput = UpdateReminderInput.extend({ preparationToken: PreparationToken.optional() }).strict();
export const PrepareUpdateInput = UpdateReminderInput.extend({ expectedGeneration: z.number().int().nonnegative().safe().describe("Required Apple session generation from connection_status."), policy: SchedulePolicy.optional().describe("Only an empty object or omission is accepted. Supported timed absolute-date edits preserve alarm/trigger identities and recurrence; no recurrence anchor, relative alarm or wall-clock reinterpretation is requested.") }).strict();
export function preparationContext(owner: string, account: string, generation: number, recordId: string): EnvelopeContext {
  return { ownerId: owner, accountId: account, generation, recordId: `reminder-preparation-v1/${recordId}`, schemaVersion: 1 };
}
export async function createPreparation(env: RuntimeEnv, context: EnvelopeContext, requestHash: string, graphFingerprint: string, expiresAt: number) {
  return b64(utf8(JSON.stringify(await configuredEnvelopes(env).encrypt({ requestHash, graphFingerprint, expiresAt }, context))));
}
export async function checkPreparation(env: RuntimeEnv, context: EnvelopeContext, token: string, requestHash: string, graphFingerprint: string) {
  let raw: unknown;
  try { raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(unb64(token, 9216))); }
  catch { throw new AppError("VALIDATION_ERROR", "The preparation token is malformed.", 400); }
  const envelope = EnvelopeSchema.safeParse(raw);
  if (!envelope.success) throw new AppError("VALIDATION_ERROR", "The preparation token is malformed.", 400);
  const saved = Token.parse(await configuredEnvelopes(env).decrypt(envelope.data, context));
  if (saved.expiresAt <= Date.now() || saved.requestHash !== requestHash || saved.graphFingerprint !== graphFingerprint) throw new AppError("CONFLICT", "The preparation expired or its request or graph changed. Prepare and review again.", 409);
}
