import { z } from "zod";
import { AppError } from "../errors.ts";
import { b64, unb64, utf8 } from "../crypto/bytes.ts";
import { configuredEnvelopes } from "../persistence/apple-sessions.ts";
import type { DriveScope } from "../persistence/drive-operations.ts";
import type { RuntimeEnv } from "../platform/sites.ts";
import { HashCheckpoint, CheckpointSHA256 } from "./hash-checkpoint.ts";
import { DRIVE_FILE_BYTES } from "./limits.ts";

export const DRIVE_RELAY_CHUNK_BYTES = 16 * 1024 ** 2;
export const DRIVE_RELAY_PROTOCOL = "icloud-drive-upload-v3";
export const DRIVE_RELAY_ACTION = "verify-relay-chunk";
export const DRIVE_RELAY_STATE_HEADER = "x-drive-relay-state";
export interface RelayAuthority {
  owner: string; operationId: string; inputHash: string; scope: DriveScope;
  leaseId: string; leaseUntil: number; size: number; sha256: string;
}
const integer = z.number().int().nonnegative().safe();
const State = z.object({
  version: z.literal(1), nonce: z.string().uuid(), size: integer.min(1).max(DRIVE_FILE_BYTES),
  sha256: z.string().regex(/^[a-f0-9]{64}$/), leaseId: z.string().uuid(), expiresAt: integer,
  offset: integer.max(DRIVE_FILE_BYTES), sessionVersion: integer,
  hash: HashCheckpoint.nullable(), complete: z.boolean(),
}).strict();
export type RelayState = z.infer<typeof State>;
const Envelope = z.object({ version: z.literal(1), keyId: z.string().max(64), iv: z.string().max(24), ciphertext: z.string().max(4096) }).strict();
const invalid = () => new AppError("FORBIDDEN", "The internal relay checkpoint is invalid, expired, or belongs to another upload.", 403);
const context = (a: Pick<RelayAuthority, "owner" | "operationId" | "inputHash" | "scope">) => ({
  ownerId: a.owner, accountId: a.scope.account, generation: a.scope.generation,
  recordId: `drive-relay-checkpoint/v1/${a.operationId}/${a.inputHash}/${a.scope.permissionRevision}`, schemaVersion: 1 as const,
});
function validate(state: RelayState) {
  if (state.expiresAt <= Date.now() || state.offset > state.size
    || state.complete !== (state.offset === state.size)
    || (state.complete ? state.hash !== null : !state.hash || state.hash.bytes !== state.offset || state.offset % DRIVE_RELAY_CHUNK_BYTES !== 0)) throw invalid();
  return state;
}
export function initialRelayState(a: RelayAuthority, sessionVersion: number): RelayState {
  return validate(State.parse({ version: 1, nonce: crypto.randomUUID(), size: a.size, sha256: a.sha256,
    leaseId: a.leaseId, expiresAt: Math.min(a.scope.expiresAt, a.leaseUntil - 10_000), offset: 0,
    sessionVersion, hash: new CheckpointSHA256().checkpoint(), complete: false }));
}
export async function sealRelayState(env: RuntimeEnv, a: Pick<RelayAuthority, "owner" | "operationId" | "inputHash" | "scope">, value: RelayState) {
  const state = validate(State.parse(value));
  return b64(utf8(JSON.stringify(await configuredEnvelopes(env).encrypt(state, context(a)))));
}
export async function openRelayState(env: RuntimeEnv, a: Pick<RelayAuthority, "owner" | "operationId" | "inputHash" | "scope">, token: string | null) {
  if (!token || token.length > 8192) throw invalid();
  try {
    const envelope = Envelope.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(unb64(token, 6144))));
    const state = validate(State.parse(await configuredEnvelopes(env).decrypt(envelope, context(a))));
    if (state.expiresAt > a.scope.expiresAt) throw invalid();
    return state;
  } catch { throw invalid(); }
}
