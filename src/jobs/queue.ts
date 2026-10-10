import { z } from "zod";
import { AppError } from "../errors.ts";
import type { RuntimeEnv } from "../platform/sites.ts";
import { ReminderJobService } from "./service.ts";
import { jobExecutionMode } from "./execution.ts";
import { runJobSlice } from "./runner.ts";

export const JOB_CRON = "* * * * *";
export const QueueJob = z.object({ jobId: z.string().uuid().toLowerCase(), revision: z.number().int().nonnegative().safe() }).strict();
function queueService(env: RuntimeEnv) {
  if (jobExecutionMode(env) !== "queue" || !env.REMINDERS_OWNER_ID) throw new AppError("CONFIGURATION_REQUIRED", "The standalone job queue and deployment owner must be configured.", 503);
  return new ReminderJobService(env, env.REMINDERS_OWNER_ID);
}
const delaySeconds = (at: number) => Math.min(43_200, Math.max(1, Math.ceil((at - Date.now()) / 1000)));

export async function pumpJobOutbox(env: RuntimeEnv) {
  const service = queueService(env), repo = service.repository;
  await repo.expireUndispatched();
  const rows = await repo.dueDeliveries();
  for (const row of rows) {
    // Failed or lost send acknowledgements leave the durable request eligible.
    await env.REMINDER_JOB_QUEUE!.send({ jobId: row.job_id, revision: row.revision });
    await repo.deferDelivery(row.job_id, row.revision, Date.now() + 120_000);
  }
  console.info({ event: "reminder-job-outbox-pump", delivered: rows.length });
}

export async function consumeJobQueue(batch: MessageBatch<unknown>, env: RuntimeEnv) {
  const service = queueService(env), repo = service.repository;
  if (batch.queue !== env.REMINDER_JOB_QUEUE_NAME || batch.messages.length > 1) throw new AppError("CONFIGURATION_REQUIRED", "The job consumer requires its exact queue and a one-message batch.", 503);
  for (const message of batch.messages) {
    const parsed = QueueJob.safeParse(message.body);
    if (!parsed.success) {
      console.error({ event: "reminder-job-queue-rejected", code: "VALIDATION_ERROR" });
      message.ack();
      continue;
    }
    try {
      const job = await repo.get(parsed.data.jobId);
      if (parsed.data.revision > job.revision) {
        console.error({ event: "reminder-job-queue-rejected", code: "INVALID_REVISION" });
        message.ack();
        continue;
      }
      if (!["queued", "running", "waiting_retry"].includes(job.state)) {
        await repo.syncOutbox(job);
        message.ack();
        continue;
      }
      const nextAt = await repo.deliveryNotBefore(job);
      if (nextAt > Date.now()) {
        message.retry({ delaySeconds: delaySeconds(nextAt) });
        continue;
      }
      await runJobSlice(service, job);
      const fresh = await repo.get(job.job_id);
      await repo.syncOutbox(fresh);
      if (["queued", "running", "waiting_retry"].includes(fresh.state)) {
        const at = await repo.deliveryNotBefore(fresh);
        // Acknowledge only after progress and its next durable delivery are saved.
        await env.REMINDER_JOB_QUEUE!.send({ jobId: fresh.job_id, revision: fresh.revision }, { delaySeconds: delaySeconds(at) });
        await repo.deferDelivery(fresh.job_id, fresh.revision, Math.max(Date.now(), at) + 120_000);
      }
      message.ack();
    } catch (error) {
      const code = error instanceof AppError ? error.code : "UPSTREAM_UNAVAILABLE";
      console.error({ event: "reminder-job-queue-paused", code });
      // Unknown owner-scoped identifiers are poison messages, never owner authority.
      if (error instanceof AppError && error.code === "FORBIDDEN") message.ack();
      else message.retry({ delaySeconds: 120 });
    }
  }
}
