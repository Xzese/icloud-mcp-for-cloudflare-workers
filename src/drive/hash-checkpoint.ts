import { _SHA256 } from "@noble/hashes/sha2.js";
import { z } from "zod";
import { AppError } from "../errors.ts";
import { DRIVE_FILE_BYTES } from "./limits.ts";

// Server-owned state, sealed inside the operation envelope. Only SHA-256 block
// boundaries can be checkpointed; file bytes and client-supplied state are never
// accepted here. The pinned noble implementation supplies the compression and
// padding, including the 64-bit length needed above 4 GiB.
export const HashCheckpoint = z.object({
  version: z.literal(1), bytes: z.number().int().min(0).max(DRIVE_FILE_BYTES).refine(n => n % 64 === 0),
  words: z.tuple([z.number().int(), z.number().int(), z.number().int(), z.number().int(), z.number().int(), z.number().int(), z.number().int(), z.number().int()])
    .refine(words => words.every(word => word >= -0x80000000 && word <= 0x7fffffff)),
}).strict();

export class CheckpointSHA256 extends _SHA256 {
  constructor(state?: z.infer<typeof HashCheckpoint>) {
    super();
    if (state) {
      const checked = HashCheckpoint.parse(state);
      this.set(...checked.words); this.length = checked.bytes;
    }
  }
  checkpoint(): z.infer<typeof HashCheckpoint> {
    if (this.pos || this.finished || this.destroyed) throw new AppError("CONFLICT", "Only an unfinished aligned hash can be checkpointed.", 409);
    return HashCheckpoint.parse({ version: 1, bytes: this.length, words: this.get() });
  }
}
