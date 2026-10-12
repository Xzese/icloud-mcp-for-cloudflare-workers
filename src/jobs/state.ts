import type { ItemStateData, JobStateData } from "./schemas.ts";

export const TERMINAL_JOBS = ["completed", "completed_with_errors", "cancelled", "expired"] as const;
export const isTerminalJob = (state: string) => TERMINAL_JOBS.some(value => value === state);
export type Counts = Record<ItemStateData, number> & { total: number };
export function aggregateState(counts: Counts, cancelled: boolean): JobStateData {
  if (counts.unknown || counts.dispatching || counts.verifying) return "needs_attention";
  if (counts.pending || counts.preparing) return cancelled ? "cancelled" : "queued";
  if (cancelled || counts.cancelled) return "cancelled";
  return counts.failed || counts.conflict ? "completed_with_errors" : "completed";
}
export function retryAt(attempts: number, now: number, retryAfterSeconds: number | null = null, random = Math.random): number {
  const backoff = Math.min(3_600_000, 5000 * 2 ** Math.max(0, attempts - 1));
  const jitter = Math.floor(backoff * (0.75 + random() * 0.5));
  return now + Math.max(jitter, retryAfterSeconds !== null && Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0 ? Math.min(retryAfterSeconds * 1000, 86_400_000) : 0);
}
