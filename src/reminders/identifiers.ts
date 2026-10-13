import { z } from "zod";

// CloudKit can parse record names up to 512 characters, but its List mutation
// path applies the stricter 255-character bound before dispatch. Keep the
// shared input schema within the existing verified printable-ASCII mutation
// contract; sharing schemas must not silently broaden writable identities.
export const ListId = z.string().min(6).max(255)
  .regex(/^List\/[\x21-\x2e\x30-\x7e]+$/, "Expected an exact canonical List/<ASCII suffix> record name.")
  .describe("Exact List record ID returned by a Reminders list read; do not use a title or invent an ID.");
