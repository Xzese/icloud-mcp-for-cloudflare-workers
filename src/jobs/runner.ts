import { AppleConnectionService } from "../auth/service.ts";
import { CloudKitRateLimitedError } from "../icloud/cloudkit.ts";
import { AppError, publicError, WriteOutcomeUnknownError } from "../errors.ts";
import type { JobRow, ItemRow } from "../persistence/reminder-jobs.ts";
import type { ReminderJobService } from "./service.ts";
import { JOB_LIMITS, type JobItemData, type JobResultData } from "./schemas.ts";
import { isTerminalJob, retryAt } from "./state.ts";

const targetId = (value: JobItemData) => value.kind === "bulk_create" ? `Reminder/${value.input.idempotencyKey.toUpperCase()}` : value.input.reminderId;
const authCodes = ["REAUTH_REQUIRED", "AUTH_EXPIRED", "DEVICE_APPROVAL_PENDING", "NOT_CONNECTED", "VERIFICATION_REQUIRED", "TERMS_ACTION_REQUIRED"];
export async function runJobSlice(service: ReminderJobService, job: JobRow) {
  const repo = service.repository;
  if (isTerminalJob(job.state)) return;
  if (["draft", "ready"].includes(job.state)) throw new AppError("CONFLICT", "Start the reviewed job before continuing it.", 409);
  if (job.next_eligible_at > Date.now()) return;
  const lease = await repo.claim(job), deadline = Date.now() + 75_000;
  try {
    try { await service.binding(job); }
    catch (error) {
      if (!(error instanceof AppError) || ![...authCodes, "CONFLICT"].includes(error.code)) throw error;
      await repo.transition(job, lease, "paused_auth");
      return;
    }
    await repo.transition(job, lease, "running");
    const allRows = await repo.items(job);
    // Reconciliation must not repeatedly consume every slot while independent
    // approved items remain undispatched. Dispatch order still follows ordinals.
    const rows = [...allRows.filter(item => ["pending", "preparing"].includes(item.state)),
      ...allRows.filter(item => ["dispatching", "verifying", "unknown"].includes(item.state))];
    let processed = 0;
    for (const item of rows) {
      if (processed >= JOB_LIMITS.sliceItems || Date.now() + 25_000 > deadline) break;
      if (!["pending", "preparing", "dispatching", "verifying", "unknown"].includes(item.state)) continue;
      const current = await repo.get(job.job_id);
      if (item.next_attempt_at > Date.now()) break;
      const value = await repo.input(job, item);
      const base: JobResultData = { status: "unknown", code: null, message: "", targetId: targetId(value), operationConfirmed: false, desiredStateObserved: false };
      processed++;
      // Any durable intent survives process death as potentially submitted.
      if (["dispatching", "verifying", "unknown"].includes(item.state) || item.dispatch_phase === "intent") {
        await reconcile(service, job, lease, item, value, base);
        continue;
      }
      if (current.cancel_requested || current.expires_at <= Date.now()) {
        await repo.setItem(job, lease, item, { ...base, status: "cancelled", code: current.cancel_requested ? "JOB_CANCELLED" : "JOB_EXPIRED", message: "No operation was dispatched; cancellation or expiry stopped this item." }, "not_submitted");
        continue;
      }
      if (item.state === "preparing") await repo.setItem(job, lease, item, { ...base, status: "pending", message: "Recovered undispatched preparation." }, "not_submitted");
      await repo.prepareItem(job, lease, item);
      let submitted = false;
      let operationReturned = false;
      try {
        const result = await new AppleConnectionService(service.env, service.owner).mutate({ action: value.kind === "bulk_create" ? "create" : "delete", expectedGeneration: job.generation, ...value.input }, {
          expectedAccount: job.account_scope,
          beforeDispatch: write => repo.dispatchIntent(job, lease, item, write),
          async assertDispatch() { await repo.assertLease(job, lease, true); submitted = true; },
        });
        operationReturned = true;
        const message = result.replayed ? "Matching stable ID observed; no new mutation was sent." : "Apple confirmed this operation.";
        await repo.setItem(job, lease, item, { ...base, status: "succeeded", operationConfirmed: !result.replayed, desiredStateObserved: true, message }, result.replayed ? "observed" : "confirmed");
        if (value.kind === "bulk_delete") await recheckDeletedParent(service, job, lease, item, value, { ...base, status: "succeeded", operationConfirmed: true, desiredStateObserved: true, message });
      } catch (error) {
        const safe = publicError(error, crypto.randomUUID());
        const persisted = (await repo.items(job, item.ordinal, 1))[0];
        if (persisted.state === "succeeded" && ["confirmed", "observed"].includes(persisted.dispatch_phase)) continue;
        const hasIntent = persisted.dispatch_phase === "intent";
        if (operationReturned || error instanceof WriteOutcomeUnknownError || ((submitted || hasIntent) && !(error instanceof AppError))) {
          await repo.setItem(job, lease, item, { ...base, code: "WRITE_OUTCOME_UNKNOWN", message: "Apple may have committed. Only read-only reconciliation is permitted; this mutation will not be replayed." }, "intent");
        } else if (error instanceof AppError && ["JOB_CANCELLED", "JOB_EXPIRED"].includes(error.code)) {
          await repo.setItem(job, lease, item, { ...base, status: "cancelled", code: error.code, message: error.message }, "not_submitted");
        } else if (error instanceof AppError && authCodes.includes(error.code)) {
          await repo.setItem(job, lease, item, { ...base, status: "pending", code: safe.code, message: safe.message }, submitted ? "rejected" : "not_submitted");
          await repo.transition(job, lease, "paused_auth");
          return;
        } else if (error instanceof AppError && error.retryable && item.attempts < JOB_LIMITS.attempts && (!submitted || ["RATE_LIMITED", "CONFLICT"].includes(error.code))) {
          const next = retryAt(item.attempts, Date.now(), error instanceof CloudKitRateLimitedError ? error.retryAfterSeconds : null);
          await repo.setItem(job, lease, item, { ...base, status: "pending", code: safe.code, message: safe.message }, submitted ? "rejected" : "not_submitted", next);
          await repo.cooldown(job, next);
          await repo.transition(job, lease, "waiting_retry", next);
          return;
        } else if (submitted && !(error instanceof AppError && ["CONFLICT", "FORBIDDEN", "RATE_LIMITED"].includes(error.code)) &&
          !(error instanceof AppError && error.message === "Apple rejected the reminder write fields. No automatic retry was attempted.")) {
          await repo.setItem(job, lease, item, { ...base, code: "WRITE_OUTCOME_UNKNOWN", message: "The dispatched mutation has no reliable receipt. Do not replay it." }, "intent");
        } else {
          await repo.setItem(job, lease, item, { ...base, status: safe.code === "CONFLICT" ? "conflict" : "failed", code: safe.code, message: safe.message }, submitted ? "rejected" : "not_submitted");
        }
      }
    }
    await repo.finish(job, lease);
    const fresh = await repo.get(job.job_id);
    if (fresh.expires_at <= Date.now() && fresh.state !== "needs_attention") await repo.transition(fresh, lease, "expired");
    console.info({ event: "reminder-job-slice", processed, state: fresh.state });
  } finally { await repo.release(job, lease); }
}

async function reconcile(service: ReminderJobService, job: JobRow, lease: string, item: ItemRow, value: JobItemData, base: JobResultData) {
  const repo = service.repository;
  if (value.kind === "bulk_delete") {
    try {
      const observed = await new AppleConnectionService(service.env, service.owner).observeJobDelete(job.generation, job.account_scope, value.input);
      await repo.setItem(job, lease, item, { ...base, desiredStateObserved: observed.deleted, code: "WRITE_OUTCOME_UNKNOWN",
        message: observed.deleted ? `The reminder is deleted, but this operation has no valid receipt and absence does not prove who deleted it. No replay will occur.${orphanNote(observed.remainingChildren)}` :
          "The reminder is still present; the prior dispatch remains unresolved. No replay will occur. Review it, then delete it individually if intended." }, "intent");
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      const safe = publicError(error, crypto.randomUUID());
      await repo.setItem(job, lease, item, { ...base, code: safe.code, message: `Read-only reconciliation paused: ${safe.message}` }, "intent");
    }
    return;
  }
  try {
    const observed = await new AppleConnectionService(service.env, service.owner).observeJobCreate(job.generation, job.account_scope, value.input);
    await repo.setItem(job, lease, item, { ...base, desiredStateObserved: observed.desiredStateObserved, code: "WRITE_OUTCOME_UNKNOWN",
      message: observed.desiredStateObserved ? "Desired state observed at the stable ID, but this operation has no valid receipt. No replay will occur." :
        observed.missing ? "The exact stable ID is currently absent; the prior dispatch remains unresolved. No replay will occur." : "The stable ID does not match the approved creation. Manual review is required." }, "intent");
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    const safe = publicError(error, crypto.randomUUID());
    await repo.setItem(job, lease, item, { ...base, code: safe.code, message: `Read-only reconciliation paused: ${safe.message}` }, "intent");
  }
}

const orphanNote = (count: number) => count ? ` ${count} subtask${count === 1 ? " still references" : "s still reference"} this deleted reminder; review them in Apple Reminders.` : "";

// Exact-version deletion cannot block a subtask attached natively after the
// pre-dispatch scan, so a read-only scan reports any that remain.
async function recheckDeletedParent(service: ReminderJobService, job: JobRow, lease: string, item: ItemRow, value: Extract<JobItemData, { kind: "bulk_delete" }>, result: JobResultData) {
  const repo = service.repository;
  const current = (await repo.items(job, item.ordinal, 1))[0];
  try {
    const observed = await new AppleConnectionService(service.env, service.owner).observeJobDelete(job.generation, job.account_scope, value.input);
    if (observed.remainingChildren) await repo.setItem(job, lease, current, { ...result, code: "SUBTASKS_REMAIN", message: `${result.message}${orphanNote(observed.remainingChildren)}` }, "confirmed");
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    await repo.setItem(job, lease, current, { ...result, code: "SUBTASK_CHECK_INCOMPLETE", message: `${result.message} The read-only post-delete subtask check did not complete: ${publicError(error, crypto.randomUUID()).message}` }, "confirmed");
  }
}
