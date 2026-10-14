import { jsonBytes } from "../lib/canonical.ts";

export const MAX_LIST_MEMBERSHIP_CHARACTERS = 131_072;
export const MAX_LIST_MEMBERS = 2_000;
const DEFAULT_REQUEST_BYTES = 65_536;
const MEMBERSHIP_REQUEST_BYTES = 262_144;

/** Larger native ordering must not grant extra capacity to reminder content. */
export function withinCloudKitRequestBudget(payload: Record<string, unknown>): boolean {
  const total = jsonBytes(payload);
  if (total > MEMBERSHIP_REQUEST_BYTES) return false;
  let membershipBytes = 0;
  for (const operation of Array.isArray(payload.operations) ? payload.operations : []) {
    const record = operation?.record;
    const field = record?.fields?.ReminderIDs;
    if (record?.recordType === "List" && field?.type === "STRING" && typeof field.value === "string" &&
      field.value.length <= MAX_LIST_MEMBERSHIP_CHARACTERS) {
      // Discount only the encoded value; its wrapper and all other fields still
      // consume the existing 64 KiB request budget. Two bytes retain empty quotes.
      membershipBytes += jsonBytes(field.value) - 2;
    }
  }
  return total - membershipBytes <= DEFAULT_REQUEST_BYTES;
}
