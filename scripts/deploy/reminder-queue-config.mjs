export function reminderQueueConfig(config) {
  const mode = config.vars?.REMINDER_JOB_EXECUTION_MODE;
  if (!mode) {
    if (config.queues?.producers?.length || config.queues?.consumers?.length) throw new Error("Queue bindings require explicit REMINDER_JOB_EXECUTION_MODE=queue-v1.");
    return {};
  }
  const name = config.vars?.REMINDER_JOB_QUEUE_NAME;
  const producers = config.queues?.producers ?? [], consumers = config.queues?.consumers ?? [];
  if (mode !== "queue-v1" || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(name ?? "") || producers.length !== 1 ||
    producers[0].binding !== "REMINDER_JOB_QUEUE" || producers[0].queue !== name || consumers.length !== 1 || consumers[0].queue !== name ||
    consumers[0].max_batch_size !== 1 || consumers[0].max_batch_timeout !== 1 || consumers[0].max_concurrency !== 1 ||
    consumers[0].max_retries !== 5 || Object.keys(producers[0]).some(key => !["binding", "queue"].includes(key)) ||
    Object.keys(consumers[0]).some(key => !["queue", "max_batch_size", "max_batch_timeout", "max_concurrency", "max_retries", "dead_letter_queue"].includes(key))) {
    throw new Error("Configure one exact job producer/consumer, one-message batches, max_concurrency=1 and max_retries=5 before enabling Queue jobs.");
  }
  if (config.triggers?.crons?.length !== 1 || config.triggers.crons[0] !== "* * * * *") throw new Error("Queue jobs require only the dedicated one-minute outbox recovery schedule.");
  return { queues: config.queues, triggers: { crons: ["* * * * *"] } };
}
