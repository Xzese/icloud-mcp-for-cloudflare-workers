import { AppError } from "../errors.ts";
import { QUEUE_CONSUMER_AVAILABLE, type RuntimeEnv } from "../platform/sites.ts";

export function jobExecutionMode(env: RuntimeEnv): "request-driven" | "queue" {
  if (!env.REMINDER_JOB_EXECUTION_MODE) return "request-driven";
  if (env.REMINDER_JOB_EXECUTION_MODE !== "queue-v1" || !env[QUEUE_CONSUMER_AVAILABLE] || !env.REMINDER_JOB_QUEUE ||
    !/^[a-z0-9][a-z0-9-]{0,62}$/.test(env.REMINDER_JOB_QUEUE_NAME ?? "")) {
    throw new AppError("CONFIGURATION_REQUIRED", "Autonomous jobs require the standalone consumer, queue binding and exact queue name. Sites must use request-driven mode.", 503);
  }
  return "queue";
}
