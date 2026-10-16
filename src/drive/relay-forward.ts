import { relayFrameSize, type RelayFrame } from "./relay-upload.ts";
import { AppError } from "../errors.ts";
import type { RuntimeEnv } from "../platform/sites.ts";
import { issueDriveTransfer, relayAuthorization } from "./transfer-capability.ts";
import { DRIVE_RELAY_ACTION, DRIVE_RELAY_CHUNK_BYTES, DRIVE_RELAY_PROTOCOL, DRIVE_RELAY_STATE_HEADER, initialRelayState, openRelayState, sealRelayState, type RelayAuthority } from "./relay-state.ts";

export async function relayForwarder(env: RuntimeEnv, authority: RelayAuthority, sessionVersion: number, signal?: AbortSignal, send: typeof fetch = fetch) {
  let state = initialRelayState(authority, sessionVersion);
  let checkpoint = await sealRelayState(env, authority, state);
  const plan = await issueDriveTransfer(env, authority.owner, "upload", authority.operationId, authority.inputHash,
    { ...authority.scope, expiresAt: state.expiresAt }, { size: authority.size, sha256: authority.sha256, protocol: DRIVE_RELAY_PROTOCOL });
  const url = new URL(plan.url); url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  return async (bytes: RelayFrame) => {
    const length = relayFrameSize(bytes);
    if (state.complete || signal?.aborted || Date.now() >= state.expiresAt || length !== Math.min(DRIVE_RELAY_CHUNK_BYTES, state.size - state.offset)) throw new AppError("CONFLICT", "The relay checkpoint is no longer usable.", 409);
    let response: Response | undefined;
    try {
      response = await send(url, { method: "POST", redirect: "manual", signal,
        headers: { ...plan.headers, "accept-encoding": "identity", "content-type": "application/octet-stream", "content-length": String(length),
          "x-drive-transfer-action": DRIVE_RELAY_ACTION, Authorization: relayAuthorization(plan.headers.Authorization, checkpoint) }, body: bytes as BodyInit });
      if (response.status !== 200) throw new AppError("UPSTREAM_UNAVAILABLE", `The protected chunk verifier rejected the request (HTTP ${response.status}). Inspect the original operation.`, 502);
      if (!response.body || response.headers.get("content-type") !== "application/octet-stream" || response.headers.get("content-length") !== String(length)
        || response.headers.has("content-encoding") && response.headers.get("content-encoding") !== "identity") throw new AppError("PROTOCOL_CHANGED", "The protected chunk verifier returned invalid framing.", 502);
      const nextToken = response.headers.get(DRIVE_RELAY_STATE_HEADER);
      const next = await openRelayState(env, authority, nextToken);
      if (next.nonce !== state.nonce || next.size !== state.size || next.sha256 !== state.sha256 || next.leaseId !== state.leaseId
        || next.expiresAt !== state.expiresAt || next.sessionVersion < state.sessionVersion || next.offset !== state.offset + length) throw new AppError("PROTOCOL_CHANGED", "The protected chunk verifier returned an unrelated checkpoint.", 502);
      checkpoint = nextToken!; state = next;
      return { body: response.body, complete: next.complete };
    } catch (error) { await response?.body?.cancel(error).catch(() => {}); throw error; }
  };
}
