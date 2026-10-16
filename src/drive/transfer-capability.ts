import { DRIVE_RELAY_ACTION, DRIVE_RELAY_PROTOCOL } from "./relay-state.ts";
import { z } from "zod";
import { AppError } from "../errors.ts";
import { b64, unb64, utf8 } from "../crypto/bytes.ts";
import { configuredEnvelopes } from "../persistence/apple-sessions.ts";
import type { DriveScope } from "../persistence/drive-operations.ts";
import type { RuntimeEnv } from "../platform/sites.ts";
import { DRIVE_TRANSFER_TIMEOUT_MS, DRIVE_RELAY_TIMEOUT_MS, DRIVE_STREAM_PROTOCOL, DRIVE_STREAM_LEGACY_PROTOCOL, DRIVE_UPLOAD_PART_BYTES } from "./limits.ts";

const number = z.number().int().nonnegative().safe();
const Scope = z.object({ account: z.string().min(1).max(256), generation: number, permissionRevision: number, expiresAt: number }).strict();
const Claim = z.object({ version: z.literal(1), owner: z.string().min(1).max(256), origin: z.string().url(),
  kind: z.enum(["upload", "download", "staged-upload"]), id: z.string().uuid(), transferId: z.string().uuid(), inputHash: z.string().regex(/^[a-f0-9]{64}$/),
  issuedAt: number, scope: Scope,
}).strict();
const Envelope = z.object({ version: z.literal(1), keyId: z.string().min(1).max(64), iv: z.string().max(24), ciphertext: z.string().max(4096) }).strict();
export type TransferClaim = z.infer<typeof Claim>;
export const DriveTransferPlan = z.object({
  url: z.string().url(), method: z.enum(["GET", "WEBSOCKET", "POST"]), headers: z.record(z.string()), expiresAt: number,
  completionUrl: z.string().url().optional(),
  protocol: z.enum([DRIVE_STREAM_PROTOCOL, DRIVE_STREAM_LEGACY_PROTOCOL, DRIVE_RELAY_PROTOCOL, "icloud-drive-upload-parts-v1"]).optional(), size: number.nullable(), sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(), partBytes: number.optional(),
}).strict();
const RelayCredentials = z.object({ capability: z.string().min(1).max(6000), checkpoint: z.string().min(1).max(8192) }).strict();
// Keep both bearer secrets in the standard redacted Authorization header. A
// custom request header would expose the internal checkpoint in platform logs.
export function relayAuthorization(capability: string, checkpoint: string) {
  const value = RelayCredentials.parse({ capability: capability.slice(7), checkpoint });
  const header = `Bearer ${b64(utf8(JSON.stringify(value)))}`;
  if (!capability.startsWith("Bearer ") || header.length > 8192) throw denied();
  return header;
}
export function relayCredentials(header: string | null) {
  if (!header?.startsWith("Bearer ") || header.length > 8192) throw denied();
  try { return RelayCredentials.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(unb64(header.slice(7), 6144)))); }
  catch { throw denied(); }
}
const denied = () => new AppError("FORBIDDEN", "This transfer capability is invalid, expired, or belongs to another transfer.", 403);
const context = (owner: string) => ({ ownerId: owner, accountId: "drive-transfer-capability", generation: 0, recordId: "drive-transfer-capability/v1", schemaVersion: 1 as const });

export function driveTransferRoute(path: string) {
  const match = /^\/api\/drive\/transfers\/(upload|download|staged-upload)\/([a-f0-9-]{36})$/.exec(path);
  if (!match || !z.string().uuid().safeParse(match[2]).success) return null;
  return { kind: match[1] as TransferClaim["kind"], id: match[2] };
}

// Gateway credentials pass the hosting platform's private-Site gate only. They
// supply no owner identity. The independent capability below authorizes exactly
// one application transfer; it is never accepted by /mcp or ordinary API routes.
export function transferGatewayHeaders(env: RuntimeEnv): Record<string, string> {
  if (!env.DRIVE_TRANSFER_SITES_GATEWAY_TOKEN) return {};
  const token = env.DRIVE_TRANSFER_SITES_GATEWAY_TOKEN;
  if (token.length > 4096 || !/^[\x21-\x7e]+$/.test(token)) throw new AppError("CONFIGURATION_REQUIRED", "The transfer gateway credential is invalid.", 503);
  return { "OAI-Sites-Authorization": `Bearer ${token}` };
}

export async function issueDriveTransfer(env: RuntimeEnv, owner: string, kind: TransferClaim["kind"], id: string, inputHash: string, scope: DriveScope, file: { size: number | null; sha256?: string; protocol?: typeof DRIVE_STREAM_PROTOCOL | typeof DRIVE_RELAY_PROTOCOL }) {
  if (!env.APP_ORIGIN || !owner || owner !== env.REMINDERS_OWNER_ID) throw new AppError("CONFIGURATION_REQUIRED", "Configure the transfer origin and owner.", 503);
  const origin = new URL(env.APP_ORIGIN);
  if (origin.origin !== env.APP_ORIGIN || origin.protocol !== "https:" && !["127.0.0.1", "localhost"].includes(origin.hostname)) throw new AppError("CONFIGURATION_REQUIRED", "Configure a secure transfer origin.", 503);
  const now = Date.now(), expiresAt = Math.min(scope.expiresAt, now + (kind === "download" ? 10 * 60_000 : kind === "upload" && file.protocol === DRIVE_RELAY_PROTOCOL ? DRIVE_RELAY_TIMEOUT_MS : DRIVE_TRANSFER_TIMEOUT_MS));
  const claim = Claim.parse({ version: 1, owner, origin: origin.origin, kind, id, transferId: crypto.randomUUID(), inputHash, issuedAt: now, scope: { ...scope, expiresAt } });
  if (expiresAt <= now) throw denied();
  const envelope = await configuredEnvelopes(env).encrypt(claim, context(owner));
  const token = b64(utf8(JSON.stringify(envelope)));
  const url = new URL(`/api/drive/transfers/${kind}/${claim.transferId}`, origin);
  if (kind === "upload") url.protocol = origin.protocol === "https:" ? "wss:" : "ws:";
  return DriveTransferPlan.parse({ url: url.href, method: kind === "upload" ? "WEBSOCKET" : kind === "staged-upload" ? "POST" : "GET",
    headers: { ...transferGatewayHeaders(env), Authorization: `Bearer ${token}` }, expiresAt, ...file,
    ...(kind === "upload" ? { protocol: file.protocol ?? DRIVE_STREAM_PROTOCOL } : {}),
    ...(kind === "staged-upload" ? { protocol: "icloud-drive-upload-parts-v1", partBytes: DRIVE_UPLOAD_PART_BYTES,
      completionUrl: url.href.replace(/^https:/, "wss:").replace(/^http:/, "ws:") } : {}),
  });
}

export async function authorizeDriveTransfer(request: Request, env: RuntimeEnv, route: NonNullable<ReturnType<typeof driveTransferRoute>>): Promise<TransferClaim> {
  const url = new URL(request.url);
  if (!env.REMINDERS_OWNER_ID || !env.APP_ORIGIN || url.origin !== env.APP_ORIGIN || url.search || !(route.kind === "staged-upload" || route.kind === "upload" && request.headers.get("x-drive-transfer-action") === DRIVE_RELAY_ACTION ? ["GET", "POST"] : ["GET"]).includes(request.method)
    || request.headers.has("origin") && request.headers.get("origin") !== env.APP_ORIGIN || request.headers.get("sec-fetch-site") === "cross-site") throw denied();
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ") || header.length > 8192) throw denied();
  try {
    const token = route.kind === "upload" && request.headers.get("x-drive-transfer-action") === DRIVE_RELAY_ACTION ? relayCredentials(header).capability : header.slice(7);
    const envelope = Envelope.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(unb64(token, 6000))));
    const claim = Claim.parse(await configuredEnvelopes(env).decrypt(envelope, context(env.REMINDERS_OWNER_ID)));
    const now = Date.now();
    if (claim.owner !== env.REMINDERS_OWNER_ID || claim.origin !== env.APP_ORIGIN || claim.kind !== route.kind || claim.transferId !== route.id
      || claim.issuedAt > now || claim.scope.expiresAt <= now || claim.scope.expiresAt - claim.issuedAt > (claim.kind === "upload" ? DRIVE_RELAY_TIMEOUT_MS : claim.kind === "download" ? 10 * 60_000 : DRIVE_TRANSFER_TIMEOUT_MS)) throw denied();
    return claim;
  } catch { throw denied(); }
}
