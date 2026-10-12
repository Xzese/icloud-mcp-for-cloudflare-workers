export function requestDrivenConfig(config) {
  const variables = config.vars ?? {};
  const hasQueueVariables = ["REMINDER_JOB_EXECUTION_MODE", "REMINDER_JOB_QUEUE_NAME"]
    .some(name => Object.hasOwn(variables, name));
  const hasQueueBindings = config.queues !== undefined && Object.keys(config.queues ?? {}).length > 0;
  const hasCron = config.triggers !== undefined && Object.hasOwn(config.triggers, "crons");
  if (hasQueueVariables || hasQueueBindings || hasCron) {
    throw new Error("This standalone Worker runs reminder jobs through authenticated continue requests; remove Queue and cron settings from the deployment config.");
  }
  return {};
}
