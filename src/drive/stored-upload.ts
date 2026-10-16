import { AppError } from "../errors.ts";
import type { UploadStagingData } from "./staging.ts";

// Only server-verified, sealed, ETag-pinned R2 objects enter this path. The full
// SHA-256 was computed over these exact ordered multipart bytes across earlier
// requests. Keep the final delivery native: no repeated hash or JS byte copies.
const RANGE_BYTES = 32 * 1024 * 1024;
type StoredProof = { size: number; bytes: () => number; complete: () => boolean; failure: () => unknown; drained: Promise<void>; cancel: (reason?: unknown) => Promise<void> };
const proofs = new WeakMap<ReadableStream<Uint8Array>, StoredProof>();
export const storedUploadProof = (body: ReadableStream<Uint8Array>) => proofs.get(body);

export function storedUpload(bucket: R2Bucket, staging: UploadStagingData, size: number, sha256: string, guard: () => Promise<unknown>, signal?: AbortSignal) {
  if (!staging.objectEtag || staging.cancelled || staging.verification?.sha256 !== sha256 || size <= 0 || typeof FixedLengthStream !== "function") throw new AppError("CONFIGURATION_REQUIRED", "Verified stored transfer requires native Worker streams and a sealed file.", 503);
  const output = new FixedLengthStream(size), abort = new AbortController();
  let complete = false, failure: unknown, delivered = 0;
  const cancel = async (reason?: unknown) => { abort.abort(reason); };
  const stopped = () => { if (abort.signal.aborted) throw abort.signal.reason; };
  const onAbort = () => { void cancel(signal?.reason); };
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  const drained = (async () => {
    try {
      for (let offset = 0; offset < size;) {
        stopped(); await guard(); stopped();
        // Leave the final byte behind a separate authorization and storage read.
        // Receipt validation still requires the complete fixed-length stream.
        const length = offset === size - 1 ? 1 : Math.min(RANGE_BYTES, size - 1 - offset);
        const object = await bucket.get(staging.key, { onlyIf: { etagMatches: staging.objectEtag! }, range: { offset, length } });
        if (!object || !("body" in object) || object.etag !== staging.objectEtag || object.size !== size || !object.range || !("offset" in object.range) || object.range.offset !== offset || object.range.length !== length) {
          if (object && "body" in object) await object.body.cancel();
          throw new AppError("CONFLICT", "The verified stored file changed or expired during delivery.", 409);
        }
        await object.body.pipeTo(output.writable, { preventClose: true, signal: abort.signal });
        offset += length;
        delivered = offset;
        if (offset % (256 * 1024 ** 2) === 0 || offset === size) console.info({ event: "drive-stored-delivery", bytes: offset, size });
      }
      // Every pinned range has drained. Mark this before closing: a native
      // fixed-length consumer may observe EOF before close()'s promise settles.
      // Both HTTP and socket consumers still await the framing pump/drained
      // promise; a close failure invalidates this flag and rejects the receipt.
      complete = true;
      const writer = output.writable.getWriter();
      try { await writer.close(); } finally { writer.releaseLock(); }
    } catch (error) {
      complete = false;
      failure = error;
      const writer = output.writable.getWriter();
      try { await writer.abort(error).catch(() => {}); } finally { writer.releaseLock(); }
      throw error;
    } finally { signal?.removeEventListener("abort", onAbort); }
  })();
  void drained.catch(() => {});
  const proof: StoredProof = { size, bytes: () => delivered, complete: () => complete, failure: () => failure, drained, cancel };
  proofs.set(output.readable, proof);
  return { stream: output.readable, verified: proof.complete, cancel };
}
