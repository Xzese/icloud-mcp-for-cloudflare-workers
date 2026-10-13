import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

/** Hash a file stream without holding the complete file in browser memory. */
export async function sha256Stream(source: ReadableStream<Uint8Array>): Promise<string> {
  const reader = source.getReader();
  const hash = sha256.create();
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) return bytesToHex(hash.digest());
      hash.update(next.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
    hash.destroy();
  }
}
