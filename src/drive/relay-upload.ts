import { AppError } from "../errors.ts";
import { DRIVE_FILE_BYTES } from "./limits.ts";
import { DRIVE_RELAY_CHUNK_BYTES } from "./relay-state.ts";

export type RelayFrame = Uint8Array | Blob;
export const relayFrameSize = (frame: RelayFrame) => frame instanceof Blob ? frame.size : frame.byteLength;

type Authorization = { size: number; expiresAt: number; signal?: AbortSignal;
  forward: (bytes: RelayFrame) => Promise<{ body: ReadableStream<Uint8Array>; complete: boolean }> };
type Proof = { size: number; bytes: () => number; complete: () => boolean; failure: () => unknown; drained: Promise<void>; cancel: (reason?: unknown) => Promise<void> };
const sources = new WeakMap<ReadableStream<Uint8Array>, { bind: (authorization: Authorization) => void; proof: Proof }>();

// Each short verifier request hashes exactly one frame and returns those same
// bytes over authenticated HTTPS. Only its native response stream reaches the
// Apple socket. The coordinator never hashes or stores the multi-gigabyte file.
export function createRelayUpload(size: number) {
  if (!Number.isSafeInteger(size) || size < 1 || size > DRIVE_FILE_BYTES || typeof FixedLengthStream !== "function") throw new AppError("CONFIGURATION_REQUIRED", "The relay requires a bounded nonempty file and native Worker streams.", 503);
  const output = new FixedLengthStream(size), abort = new AbortController();
  let authorization: Authorization | undefined, delivered = 0, busy = false, verified = false, complete = false, failure: unknown;
  let resolve!: () => void, reject!: (reason: unknown) => void;
  const drained = new Promise<void>((yes, no) => { resolve = yes; reject = no; }); void drained.catch(() => {});
  const active = () => {
    if (!authorization) throw new AppError("CONFLICT", "The relay has not been authorized.", 409);
    if (abort.signal.aborted) throw abort.signal.reason;
    if (authorization.signal?.aborted) throw authorization.signal.reason;
    if (Date.now() >= authorization.expiresAt) throw new AppError("AUTH_EXPIRED", "The relay authorization expired.", 409);
  };
  const cancel = async (reason: unknown = new AppError("CONFLICT", "The relay stopped; inspect its original operation.", 409)) => {
    if (complete) return;
    failure ??= reason; abort.abort(reason); reject(reason);
    authorization?.signal?.removeEventListener("abort", onAbort);
    await Promise.all([output.readable.cancel(reason).catch(() => {}), output.writable.abort(reason).catch(() => {})]);
  };
  const onAbort = () => { void cancel(authorization?.signal?.reason); };
  const proof: Proof = { size, bytes: () => delivered, complete: () => complete, failure: () => failure, drained, cancel };
  sources.set(output.readable, { proof, bind(value) {
    if (authorization || value.size !== size || !Number.isFinite(value.expiresAt)) throw new AppError("CONFLICT", "The relay does not match its retained intent.", 409);
    authorization = value; value.signal?.addEventListener("abort", onAbort, { once: true });
    if (value.signal?.aborted) onAbort();
    console.info({ event: "drive-verified-relay", size, frameBytes: DRIVE_RELAY_CHUNK_BYTES });
  } });
  return {
    stream: output.readable,
    async write(bytes: RelayFrame, verifiedFrame?: () => void) {
      let body: ReadableStream<Uint8Array> | undefined;
      const length = relayFrameSize(bytes);
      try {
        active();
        if (busy || complete || verified || length !== Math.min(DRIVE_RELAY_CHUNK_BYTES, size - delivered)) throw new AppError("VALIDATION_ERROR", "Send exactly one credited relay frame.", 400);
        busy = true;
        const checked = await authorization!.forward(bytes); body = checked.body;
        active();
        if (checked.complete !== (delivered + length === size)) throw new AppError("PROTOCOL_CHANGED", "The relay verifier returned an inconsistent final proof.", 502);
        // At most one next client frame may be prefetched while these verified
        // bytes drain to Apple. Hash checkpoint advancement remains serialized.
        verifiedFrame?.();
        // HTTPS enforces the verifier's exact Content-Length; the native output
        // additionally enforces the full file length. Workerd cannot pipe one
        // FixedLengthStream into another, so keep this network stream native.
        await body.pipeTo(output.writable, { preventClose: true, signal: abort.signal });
        delivered += length; verified = checked.complete;
        if (delivered % (256 * 1024 ** 2) === 0 || verified) console.info({ event: "drive-verified-relay-progress", bytes: delivered, size });
      } catch (error) { await body?.cancel(error).catch(() => {}); await cancel(error); throw error; }
      finally { busy = false; }
    },
    async close() {
      try {
        active();
        if (busy || !verified || delivered !== size) throw new AppError("VALIDATION_ERROR", "The relay ended before complete verified content.", 400);
        complete = true; await output.writable.close(); resolve();
      } catch (error) { complete = false; await cancel(error); throw error; }
      finally { authorization?.signal?.removeEventListener("abort", onAbort); }
    },
    cancel,
  };
}
export function bindRelayUpload(body: ReadableStream<Uint8Array>, authorization: Authorization) {
  const source = sources.get(body); if (!source) return null;
  source.bind(authorization); return { stream: body, verified: source.proof.complete, cancel: source.proof.cancel };
}
export function relayUploadProof(body: ReadableStream<Uint8Array>) { return sources.get(body)?.proof; }
