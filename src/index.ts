import sitesWorker from "./worker";
import { cloudflareAccessFetch, type CloudflareAccessEnv } from "./platform/cloudflare-access.ts";
import { QUEUE_CONSUMER_AVAILABLE } from "./platform/sites.ts";
import { consumeJobQueue, pumpJobOutbox, JOB_CRON } from "./jobs/queue.ts";
import { jobExecutionMode } from "./jobs/execution.ts";
import { AppError } from "./errors.ts";

const worker = {
  fetch(request: Request, env: Cloudflare.Env & CloudflareAccessEnv, ctx: Parameters<typeof sitesWorker.fetch>[2]) {
    return cloudflareAccessFetch(request, env, (authenticatedRequest) => sitesWorker.fetch(authenticatedRequest, { ...env, [QUEUE_CONSUMER_AVAILABLE]: true }, ctx));
  },
  async queue(batch: MessageBatch<unknown>, env: Cloudflare.Env & CloudflareAccessEnv) {
    await consumeJobQueue(batch, { ...env, [QUEUE_CONSUMER_AVAILABLE]: true });
  },
  async scheduled(controller: ScheduledController, env: Cloudflare.Env & CloudflareAccessEnv) {
    const runtime = { ...env, [QUEUE_CONSUMER_AVAILABLE]: true as const };
    if (jobExecutionMode(runtime) !== "queue") return;
    if (controller.cron !== JOB_CRON) throw new AppError("CONFIGURATION_REQUIRED", "Only the dedicated reminder-job outbox schedule is supported.", 503);
    await pumpJobOutbox(runtime);
  },
};
export default worker;
