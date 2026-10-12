import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JobSQLiteD1 } from "./helpers/sqlite-d1.ts";
import { AppleSessionRepository, type AppleSession } from "../src/persistence/apple-sessions.ts";
import { loginAssurance } from "../src/auth/apple/policy.ts";
import { Envelopes } from "../src/crypto/envelopes.ts";
import { b64 } from "../src/crypto/bytes.ts";
import { ReminderJobService, canonicalItem } from "../src/jobs/service.ts";
import { JobItem, JOB_LIMITS, AppendJob } from "../src/jobs/schemas.ts";
import { aggregateState, retryAt } from "../src/jobs/state.ts";
import { AppError } from "../src/errors.ts";
import { accountScope, fingerprint } from "../src/lib/canonical.ts";
import { jsonBytes } from "../src/lib/canonical.ts";
import { applicationRoute } from "../src/api/router.ts";
import { CreateReminderInput } from "../src/reminders/writes.ts";
import { consumeJobQueue, pumpJobOutbox } from "../src/jobs/queue.ts";
import { QUEUE_CONSUMER_AVAILABLE, type RuntimeEnv } from "../src/platform/sites.ts";

const owner = "synthetic-job-owner", listId = "List/JOB-TEST", zoneOwner = "synthetic-private-owner";
const hasCode = (code: string) => (error: unknown) => error instanceof AppError && error.code === code;
function delivery(body: unknown) {
  const result = { acked: false, retry: 0 };
  const batch: MessageBatch<unknown> = { queue: "synthetic-jobs", metadata: { metrics: { backlogCount: 1, backlogBytes: 0 } }, messages: [{
    id: crypto.randomUUID(), timestamp: new Date(), body, attempts: 1,
    ack() { result.acked = true; }, retry(options) { result.retry = options?.delaySeconds ?? 1; },
  }], ackAll() { result.acked = true; }, retryAll(options) { result.retry = options?.delaySeconds ?? 1; } };
  return { batch, result };
}
function queuedEnv(f: Awaited<ReturnType<typeof fixture>>, failSend = false) {
  const sent: unknown[] = [];
  const metadata = { metrics: { backlogCount: 0, backlogBytes: 0 } };
  const queue: Queue<{ jobId: string; revision: number }> = {
    async metrics() { return metadata.metrics; },
    async send(value) { if (failSend) throw new Error("synthetic queue send failure"); sent.push(value); return { metadata }; },
    async sendBatch(values) { sent.push(...values); return { metadata }; },
  };
  const env: RuntimeEnv = { ...f.env, [QUEUE_CONSUMER_AVAILABLE]: true, REMINDER_JOB_EXECUTION_MODE: "queue-v1", REMINDER_JOB_QUEUE_NAME: "synthetic-jobs", REMINDER_JOB_QUEUE: queue };
  return { env, sent };
}
function item(index: number, key = crypto.randomUUID()) {
  return JobItem.parse({ kind: "bulk_create", clientItemKey: `item-${index}`, input: { listId, idempotencyKey: key, title: "Same title", notes: `Synthetic notes ${index}` } });
}
async function fixture() {
  const db = new JobSQLiteD1(), envelopes = new Envelopes("synthetic", { synthetic: b64(crypto.getRandomValues(new Uint8Array(32))) });
  const env = { ...db.env(), APP_ORIGIN: "https://private.example.test", REMINDERS_OWNER_ID: owner, ENCRYPTION_KEY_ID: envelopes.active, ENCRYPTION_KEYS_JSON: JSON.stringify(envelopes.keys),
    LIVE_APPLE_CONNECTION_APPROVED: "controlled-device-v2", APPLE_CRYPTO_REVIEW_APPROVED: "device-proof-v2" };
  const session: AppleSession = {
    login: loginAssurance(), auth: { clientId: "synthetic-client", headers: {}, cookies: [] },
    connection: { dsid: "123456789", clientId: "synthetic-client", clientBuildNumber: "2534Project66", clientMasteringNumber: "2534B22", cloudKitURL: "https://p01-ckdatabasews.icloud.com/database/1/com.apple.reminders/production/private", remindersZoneOwner: zoneOwner },
    pcs: { consentRequested: true, pcsAttempts: 1, consentChecks: 1, expiresAt: Date.now() + 300_000, nextAttemptAt: 0 },
  };
  const sessions = new AppleSessionRepository(env, owner), setup = await sessions.begin(0);
  await sessions.commit(setup, session, "READY");
  const jobs = new ReminderJobService(env, owner);
  const records = new Map<string, Record<string, unknown>>([[listId, { recordName: listId, recordType: "List", fields: { Deleted: { type: "INT64", value: 0 }, IsGroup: { type: "INT64", value: 0 } }, zoneID: { zoneName: "Reminders", ownerRecordName: zoneOwner }, recordChangeTag: "list-1" }]]);
  const nativeFetch = globalThis.fetch;
  const network = { modifies: 0, reads: 0, queries: 0, loseAck: false, rejectRate: false, cancelAtDispatch: null as string | null, onModify: null as (() => void) | null };
  globalThis.fetch = async (url, options) => {
    const path = new URL(String(url)).pathname;
    const body = JSON.parse(String(options?.body));
    if (path.endsWith("/records/lookup")) {
      network.reads++;
      return Response.json({ records: body.records.map(({ recordName }: { recordName: string }) => records.get(recordName) ?? { recordName, serverErrorCode: "NOT_FOUND" }) });
    }
    if (path.endsWith("/records/query")) {
      network.queries++;
      const list = body.query.filterBy[0].fieldValue.value.recordName;
      return Response.json({ records: [...records.values()].filter(record => record.recordType === "Reminder" &&
        (record.fields as Record<string, { value: { recordName: string } }>).List?.value.recordName === list) });
    }
    assert.ok(path.endsWith("/records/modify"), "Only synthetic exact reads and writes are allowed.");
    network.modifies++;
    if (network.rejectRate) { network.rejectRate = false; return Response.json({}, { status: 429, headers: { "retry-after": "120" } }); }
    const write = body.operations[0].record;
    assert.equal(body.atomic, true); assert.equal(body.operations.length, 1);
    const previous = records.get(write.recordName);
    const next = { ...previous, ...write, fields: { ...(previous?.fields as object | undefined), ...write.fields }, recordChangeTag: `confirmed-${network.modifies}`, zoneID: { zoneName: "Reminders", ownerRecordName: zoneOwner } };
    records.set(write.recordName, next);
    network.onModify?.(); network.onModify = null;
    if (network.cancelAtDispatch) await jobs.cancel({ jobId: network.cancelAtDispatch });
    if (network.loseAck) { network.loseAck = false; return new Response("lost acknowledgement", { status: 503 }); }
    return Response.json({ records: [next] });
  };
  return { db, env, jobs, sessions, session, generation: setup.generation, network, records,
    close() { globalThis.fetch = nativeFetch; db.sqlite.close(); } };
}
async function draft(f: Awaited<ReturnType<typeof fixture>>, items = [item(0)]) {
  const job = await f.jobs.create({ kind: "bulk_create", expectedGeneration: f.generation, idempotencyKey: crypto.randomUUID() });
  return f.jobs.append({ jobId: job.jobId, chunkKey: crypto.randomUUID(), expectedRevision: job.revision, items });
}
async function ready(f: Awaited<ReturnType<typeof fixture>>, items = [item(0)]) {
  const job = await draft(f, items);
  const preview = await f.jobs.preview({ jobId: job.jobId, expectedRevision: job.revision });
  return f.jobs.start({ jobId: preview.jobId, previewToken: preview.previewToken });
}

test("Queue outbox and duplicate delivery execute bounded slices in ledger order", async () => {
  const f = await fixture();
  try {
    const job = await ready(f, [item(0), item(1), item(2), item(3)]), q = queuedEnv(f);
    assert.equal((await new ReminderJobService(q.env, owner).get({ jobId: job.jobId })).executionMode, "queue");
    await pumpJobOutbox(q.env);
    assert.deepEqual(q.sent, [{ jobId: job.jobId, revision: job.revision }]);
    assert.equal(f.network.modifies, 0);
    const first = delivery(q.sent[0]);
    await consumeJobQueue(first.batch, q.env);
    assert.equal(first.result.acked, true); assert.equal(f.network.modifies, 3);
    assert.equal(q.sent.length, 2);
    const duplicate = delivery(q.sent[0]);
    await consumeJobQueue(duplicate.batch, q.env);
    assert.equal(duplicate.result.acked, true); assert.equal(f.network.modifies, 4);
    await consumeJobQueue(delivery(q.sent[1]).batch, q.env);
    assert.equal(f.network.modifies, 4);
    assert.equal((await f.jobs.get({ jobId: job.jobId })).state, "completed");
    assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) AS count FROM reminder_job_outbox").get()?.count, 0);
    assert.equal((await f.sessions.load()).session.login.expiresAt, f.session.login.expiresAt);
  } finally { f.close(); }
});

test("lost queue send acknowledgement leaves recoverable outbox and never replays confirmed writes", async () => {
  const f = await fixture();
  try {
    const job = await ready(f, [item(0), item(1), item(2), item(3)]), q = queuedEnv(f, true);
    await assert.rejects(pumpJobOutbox(q.env), /synthetic queue send failure/);
    assert.equal((await f.jobs.repository.dueDeliveries()).length, 1);
    const first = delivery({ jobId: job.jobId, revision: job.revision });
    await consumeJobQueue(first.batch, q.env);
    assert.equal(first.result.acked, false); assert.equal(first.result.retry, 120);
    assert.equal((await f.jobs.get({ jobId: job.jobId })).counts.succeeded, 3);
    const recovered = delivery({ jobId: job.jobId, revision: job.revision });
    await consumeJobQueue(recovered.batch, q.env);
    assert.equal(recovered.result.acked, true); assert.equal(f.network.modifies, 4);
  } finally { f.close(); }
});

test("Queue uncertainty and cancellation remain visible and stop autonomous mutation", async () => {
  const f = await fixture();
  try {
    const job = await ready(f), q = queuedEnv(f);
    f.network.loseAck = true;
    const first = delivery({ jobId: job.jobId, revision: job.revision });
    await consumeJobQueue(first.batch, q.env);
    assert.equal(first.result.acked, true);
    assert.equal((await f.jobs.get({ jobId: job.jobId })).counts.unknown, 1);
    await consumeJobQueue(delivery({ jobId: job.jobId, revision: job.revision }).batch, q.env);
    assert.equal(f.network.modifies, 1); assert.equal(q.sent.length, 0);
    const cancelled = await ready(f);
    await f.jobs.cancel({ jobId: cancelled.jobId });
    await consumeJobQueue(delivery({ jobId: cancelled.jobId, revision: cancelled.revision }).batch, q.env);
    assert.equal(f.network.modifies, 1);
  } finally { f.close(); }
});

test("Queue messages cannot supply owner authority, future revisions or another queue", async () => {
  const f = await fixture();
  try {
    const job = await ready(f), q = queuedEnv(f), malformed = delivery({ jobId: job.jobId, revision: job.revision, owner: "forged" });
    await consumeJobQueue(malformed.batch, q.env);
    assert.equal(malformed.result.acked, true);
    await consumeJobQueue(delivery({ jobId: crypto.randomUUID(), revision: 0 }).batch, q.env);
    await consumeJobQueue(delivery({ jobId: job.jobId, revision: job.revision + 100 }).batch, q.env);
    const wrong = delivery({ jobId: job.jobId, revision: job.revision });
    await assert.rejects(consumeJobQueue({ ...wrong.batch, queue: "other" }, q.env), hasCode("CONFIGURATION_REQUIRED"));
    assert.equal(f.network.modifies, 0);
  } finally { f.close(); }
});

test("Queue delivery honors account cooldown, live leases and authentication pause", async () => {
  const f = await fixture();
  try {
    const job = await ready(f), q = queuedEnv(f);
    const lease = await f.jobs.repository.claim(await f.jobs.repository.get(job.jobId));
    const contention = delivery({ jobId: job.jobId, revision: job.revision });
    await consumeJobQueue(contention.batch, q.env);
    assert.equal(contention.result.acked, false); assert.ok(contention.result.retry > 0); assert.equal(f.network.modifies, 0);
    await f.jobs.repository.release(await f.jobs.repository.get(job.jobId), lease);
    f.network.rejectRate = true;
    await consumeJobQueue(delivery({ jobId: job.jobId, revision: job.revision }).batch, q.env);
    assert.equal(f.network.modifies, 1);
    const deferred = delivery({ jobId: job.jobId, revision: job.revision });
    await consumeJobQueue(deferred.batch, q.env);
    assert.equal(deferred.result.acked, false); assert.ok(deferred.result.retry > 0); assert.equal(f.network.modifies, 1);
    assert.equal((await f.jobs.repository.dueDeliveries()).length, 0);
    f.db.sqlite.exec("UPDATE reminder_jobs SET next_eligible_at = 0; UPDATE reminder_job_accounts SET cooldown_until = 0; UPDATE reminder_job_items SET next_attempt_at = 0;");
    await f.sessions.disconnect();
    const paused = delivery({ jobId: job.jobId, revision: job.revision });
    await consumeJobQueue(paused.batch, q.env);
    assert.equal(paused.result.acked, true);
    assert.equal((await f.jobs.get({ jobId: job.jobId })).state, "paused_auth");
    assert.equal((await f.jobs.repository.dueDeliveries()).length, 0);
  } finally { f.close(); }
});

test("canonical creation defaults, UUID case and date representations produce deterministic hashes", async () => {
  const key = crypto.randomUUID();
  const a = canonicalItem(JobItem.parse({ kind: "bulk_create", clientItemKey: "a", input: { listId, idempotencyKey: key, title: "Title", dueDate: "2030-03-04T09:00:00+01:00" } }));
  const b = canonicalItem(JobItem.parse({ kind: "bulk_create", clientItemKey: "a", input: { listId, idempotencyKey: key.toUpperCase(), title: "Title", notes: "", priority: 0, flagged: false, allDay: false, timeZone: null, dueDate: "2030-03-04T08:00:00Z" } }));
  assert.equal(await fingerprint(a), await fingerprint(b));
  assert.equal(AppendJob.safeParse({ jobId: crypto.randomUUID(), chunkKey: key, expectedRevision: 0, items: Array(51).fill(a) }).success, false);
  assert.equal(CreateReminderInput.safeParse({ listId, idempotencyKey: key, title: "Title", ownerId: "forged" }).success, false);
});

test("migration is additive and repeated application leaves the existing session envelope and fences intact", async () => {
  const f = await fixture();
  try {
    const before = f.db.sqlite.prepare("SELECT * FROM apple_session_state").get();
    const migration = readFileSync(new URL("../migrations/0001_reminder_jobs.sql", import.meta.url), "utf8");
    f.db.sqlite.exec(migration); f.db.sqlite.exec(migration);
    assert.deepEqual(f.db.sqlite.prepare("SELECT * FROM apple_session_state").get(), before);
    assert.equal((await f.sessions.load()).session.login.expiresAt, f.session.login.expiresAt);
  } finally { f.close(); }
});

test("draft/chunk replay, revision CAS and scoped key reservations prevent conflicting manifests", async () => {
  const f = await fixture();
  try {
    const key = crypto.randomUUID(), request = { kind: "bulk_create", expectedGeneration: f.generation, idempotencyKey: key };
    const initial = await f.jobs.create(request);
    assert.equal((await f.jobs.create(request)).jobId, initial.jobId);
    await assert.rejects(f.jobs.create({ ...request, kind: "bulk_delete" }), hasCode("CONFLICT"));
    const chunk = { jobId: initial.jobId, chunkKey: crypto.randomUUID(), expectedRevision: 0, items: [item(0)] };
    const appended = await f.jobs.append(chunk);
    assert.equal((await f.jobs.append(chunk)).revision, appended.revision);
    await assert.rejects(f.jobs.append({ ...chunk, items: [item(1)] }), hasCode("CONFLICT"));
    await assert.rejects(f.jobs.append({ ...chunk, chunkKey: crypto.randomUUID() }), hasCode("CONFLICT"));
    const second = await f.jobs.create({ ...request, idempotencyKey: crypto.randomUUID() });
    await assert.rejects(f.jobs.append({ ...chunk, jobId: second.jobId, chunkKey: crypto.randomUUID(), expectedRevision: second.revision }), hasCode("CONFLICT"));
    await assert.rejects(f.jobs.append({ ...chunk, chunkKey: crypto.randomUUID(), expectedRevision: appended.revision, items: [item(0)] }), hasCode("CONFLICT"));
    assert.equal((await f.jobs.get({ jobId: initial.jobId })).counts.total, 1);
    assert.equal(f.network.modifies, 0);
    const rows = f.db.sqlite.prepare("SELECT input_envelope, result_envelope FROM reminder_job_items").all();
    assert.ok(!JSON.stringify(rows).includes("Synthetic notes"));
    assert.ok(!JSON.stringify(rows).includes(listId));
  } finally { f.close(); }
});

test("bounded continuation persists order, does not deduplicate titles, and status reads never execute work", async () => {
  const f = await fixture();
  try {
    const job = await ready(f, [item(0), item(1), item(2), item(3)]);
    assert.equal(f.network.modifies, 0);
    const before = f.db.sqlite.prepare("SELECT revision FROM reminder_jobs WHERE job_id = ?").get(job.jobId);
    await f.jobs.get({ jobId: job.jobId });
    assert.deepEqual(f.db.sqlite.prepare("SELECT revision FROM reminder_jobs WHERE job_id = ?").get(job.jobId), before);
    const first = await f.jobs.continue({ jobId: job.jobId });
    assert.equal(first.counts.succeeded, 3); assert.equal(first.counts.pending, 1);
    assert.equal(f.network.modifies, 3);
    const restarted = new ReminderJobService(f.env, owner);
    const final = await restarted.continue({ jobId: job.jobId });
    assert.equal(final.state, "completed"); assert.equal(final.counts.succeeded, 4);
    assert.deepEqual(final.results.map(result => result.clientItemKey), ["item-0", "item-1", "item-2", "item-3"]);
    await restarted.continue({ jobId: job.jobId });
    assert.equal(f.network.modifies, 4);
    const page = await restarted.get({ jobId: job.jobId, offset: 1, limit: 2 });
    assert.deepEqual(page.results.map(result => result.ordinal), [1, 2]); assert.equal(page.nextOffset, 3);
    assert.equal((await f.sessions.load()).session.login.expiresAt, f.session.login.expiresAt);
  } finally { f.close(); }
});

test("lost acknowledgement is unknown, observed state does not become a receipt, and restart never resubmits", async () => {
  const f = await fixture();
  try {
    const job = await ready(f);
    f.network.loseAck = true;
    const first = await f.jobs.continue({ jobId: job.jobId });
    assert.equal(first.state, "needs_attention"); assert.equal(first.counts.unknown, 1);
    const result = await new ReminderJobService(f.env, owner).continue({ jobId: job.jobId });
    assert.equal(result.counts.unknown, 1); assert.equal(result.results[0].result?.desiredStateObserved, true);
    assert.equal(result.results[0].result?.operationConfirmed, false);
    assert.equal(f.network.modifies, 1);
    const ledger = f.db.sqlite.prepare("SELECT mutation_envelope FROM reminder_job_items").get();
    assert.ok(ledger?.mutation_envelope && !String(ledger.mutation_envelope).includes("TitleDocument"));
  } finally { f.close(); }
});

test("a process dying after durable intent but before Apple is reconciled, not replayed", async () => {
  const f = await fixture();
  try {
    const job = await ready(f);
    const repository = f.jobs.repository, row = await repository.get(job.jobId), lease = await repository.claim(row);
    const selected = (await repository.items(row))[0], value = await repository.input(row, selected);
    assert.equal(value.kind, "bulk_create");
    await repository.prepareItem(row, lease, selected);
    if (value.kind !== "bulk_create") throw new Error("Expected creation fixture.");
    const { buildCreateReminder } = await import("../src/reminders/writes.ts");
    await repository.dispatchIntent(row, lease, selected, buildCreateReminder(value.input));
    await repository.release(row, lease);
    const result = await new ReminderJobService(f.env, owner).continue({ jobId: job.jobId });
    assert.equal(result.counts.unknown, 1); assert.equal(result.results[0].result?.desiredStateObserved, false);
    assert.equal(f.network.modifies, 0);
  } finally { f.close(); }
});

test("cancellation before and during dispatch stops remaining items without rolling back success", async () => {
  const f = await fixture();
  try {
    const cancelled = await ready(f);
    await f.jobs.cancel({ jobId: cancelled.jobId });
    assert.equal((await f.jobs.continue({ jobId: cancelled.jobId })).counts.cancelled, 1);
    assert.equal(f.network.modifies, 0);
    const job = await ready(f, [item(0), item(1), item(2)]);
    f.network.cancelAtDispatch = job.jobId;
    const result = await f.jobs.continue({ jobId: job.jobId });
    assert.equal(result.state, "cancelled"); assert.equal(result.counts.succeeded, 1); assert.equal(result.counts.cancelled, 2);
    assert.equal(f.network.modifies, 1);
  } finally { f.close(); }
});

test("rate rejection persists account-wide Retry-After and resume cannot bypass it", async () => {
  const f = await fixture();
  try {
    const job = await ready(f);
    f.network.rejectRate = true;
    const result = await f.jobs.continue({ jobId: job.jobId });
    assert.equal(result.state, "waiting_retry"); assert.ok(result.nextRetryAt! >= Date.now() + 119_000);
    await assert.rejects(f.jobs.resume({ jobId: job.jobId }), hasCode("RATE_LIMITED"));
    await f.jobs.continue({ jobId: job.jobId }); assert.equal(f.network.modifies, 1);
    const other = await f.jobs.create({ kind: "bulk_create", expectedGeneration: f.generation, idempotencyKey: crypto.randomUUID() });
    const row = await f.jobs.repository.get(other.jobId);
    await assert.rejects(f.jobs.repository.claim(row), error => error instanceof AppError && error.retryable);
    assert.ok(retryAt(5, 1000, 120, () => 0) >= 121_000);
  } finally { f.close(); }
});

test("generation changes pause work and forged/cross-owner API access is rejected before database reads", async () => {
  const f = await fixture();
  try {
    const job = await ready(f);
    await f.sessions.disconnect();
    const changed = await f.sessions.begin((await f.sessions.status()).generation);
    await f.sessions.commit(changed, f.session, "READY");
    assert.equal((await f.jobs.continue({ jobId: job.jobId })).state, "paused_auth");
    assert.equal(f.network.modifies, 0);
    await assert.rejects(f.jobs.resume({ jobId: job.jobId }), hasCode("CONFLICT"));
    const headers = { "oai-authenticated-user-id": owner, "content-type": "application/json", origin: "https://evil.example" };
    assert.equal((await applicationRoute(new Request(`${f.env.APP_ORIGIN}/api/reminder-jobs/${job.jobId}/continue`, { method: "POST", headers, body: "{}" }), f.env))?.status, 403);
    headers["oai-authenticated-user-id"] = "another-owner";
    let reads = 0;
    f.db.afterStatement = async () => { reads++; };
    assert.equal((await applicationRoute(new Request(`${f.env.APP_ORIGIN}/api/reminder-jobs/${job.jobId}`, { headers }), f.env))?.status, 403);
    assert.equal(reads, 0);
    await assert.rejects(f.jobs.repository.get(crypto.randomUUID()), hasCode("FORBIDDEN"));
  } finally { f.close(); }
});

async function created(f: Awaited<ReturnType<typeof fixture>>, count: number) {
  const items = Array.from({ length: count }, (_, index) => item(index));
  const job = await ready(f, items);
  while (!["completed", "completed_with_errors", "needs_attention"].includes((await f.jobs.continue({ jobId: job.jobId })).state));
  return items.map(value => {
    const id = `Reminder/${(value.input as { idempotencyKey: string }).idempotencyKey.toUpperCase()}`;
    return { listId, reminderId: id, recordChangeTag: String(f.records.get(id)!.recordChangeTag) };
  });
}
function attachChild(f: Awaited<ReturnType<typeof fixture>>, parentId: string, childId = `Reminder/${crypto.randomUUID().toUpperCase()}`) {
  const template = [...f.records.values()].find(record => record.recordType === "Reminder")!;
  f.records.set(childId, { ...template, recordName: childId, recordChangeTag: "native-child-1",
    fields: { ...(template.fields as object), Deleted: { type: "INT64", value: 0 }, ParentReminder: { type: "REFERENCE", value: { recordName: parentId, action: "VALIDATE" } } } });
}
async function deleteJob(f: Awaited<ReturnType<typeof fixture>>, targets: { listId: string; reminderId: string; recordChangeTag: string }[]) {
  const job = await f.jobs.create({ kind: "bulk_delete", expectedGeneration: f.generation, idempotencyKey: crypto.randomUUID() });
  const appended = await f.jobs.append({ jobId: job.jobId, expectedRevision: job.revision, chunkKey: crypto.randomUUID(),
    items: targets.map((input, index) => ({ kind: "bulk_delete", clientItemKey: `delete-${index}`, input })) });
  return f.jobs.preview({ jobId: job.jobId, expectedRevision: appended.revision });
}
const deletedField = (f: Awaited<ReturnType<typeof fixture>>, id: string) => (f.records.get(id)!.fields as Record<string, { value: number }>).Deleted.value;

test("bulk deletion is permanent and preview refuses stale, missing, duplicate and parent targets before dispatch", async () => {
  const f = await fixture();
  try {
    const [simple, stale, parent] = await created(f, 3);
    attachChild(f, parent.reminderId);
    const modifies = f.network.modifies;
    const preview = await deleteJob(f, [simple, { ...stale, recordChangeTag: "stale-tag" }, parent, { ...simple, recordChangeTag: "other-tag" },
      { listId, reminderId: "Reminder/MISSING-SYNTHETIC", recordChangeTag: "missing" }]);
    assert.deepEqual(preview.results.map(result => result.result?.code ?? null), [null, "CONFLICT", "UNSUPPORTED_FEATURE", "VALIDATION_ERROR", "CONFLICT"]);
    assert.equal(preview.counts.failed, 4); assert.equal(f.network.modifies, modifies);
    assert.ok(preview.warnings.some(warning => warning.includes("soft-deletes")));
    await f.jobs.start({ jobId: preview.jobId, previewToken: preview.previewToken });
    const done = await f.jobs.continue({ jobId: preview.jobId });
    assert.equal(done.state, "completed_with_errors"); assert.equal(done.counts.succeeded, 1);
    assert.equal(f.network.modifies, modifies + 1);
    assert.equal(deletedField(f, simple.reminderId), 1); assert.equal(deletedField(f, parent.reminderId), 0);
    assert.equal(done.results[0].result?.code, null); assert.equal(done.results[0].result?.operationConfirmed, true);
    const status = await new (await import("../src/auth/service.ts")).AppleConnectionService(f.env, owner).status();
    assert.equal(status.capabilities.bulkDelete, true);
  } finally { f.close(); }
});

test("bulk deletion rechecks subtasks before dispatch and reports a native child attached during commit", async () => {
  const f = await fixture();
  try {
    const [early, late] = await created(f, 2);
    const preview = await deleteJob(f, [early, late]);
    assert.equal(preview.counts.failed, 0);
    await f.jobs.start({ jobId: preview.jobId, previewToken: preview.previewToken });
    attachChild(f, early.reminderId);
    const modifies = f.network.modifies;
    f.network.onModify = () => attachChild(f, late.reminderId);
    const done = await f.jobs.continue({ jobId: preview.jobId });
    assert.equal(done.results[0].status, "failed"); assert.equal(done.results[0].result?.code, "UNSUPPORTED_FEATURE");
    assert.equal(deletedField(f, early.reminderId), 0);
    assert.equal(done.results[1].status, "succeeded"); assert.equal(done.results[1].result?.code, "SUBTASKS_REMAIN");
    assert.match(done.results[1].result?.message ?? "", /1 subtask still references/);
    assert.equal(f.network.modifies, modifies + 1); assert.equal(done.state, "completed_with_errors");
  } finally { f.close(); }
});

test("a lost bulk-delete acknowledgement is reconciled read-only and never replayed", async () => {
  const f = await fixture();
  try {
    const [target] = await created(f, 1);
    const preview = await deleteJob(f, [target]);
    await f.jobs.start({ jobId: preview.jobId, previewToken: preview.previewToken });
    const modifies = f.network.modifies;
    f.network.loseAck = true;
    const first = await f.jobs.continue({ jobId: preview.jobId });
    assert.equal(first.results[0].status, "unknown"); assert.equal(first.state, "needs_attention");
    const second = await f.jobs.continue({ jobId: preview.jobId });
    assert.equal(second.results[0].status, "unknown"); assert.equal(second.results[0].result?.desiredStateObserved, true);
    assert.match(second.results[0].result?.message ?? "", /No replay/);
    assert.equal(f.network.modifies, modifies + 1);
  } finally { f.close(); }
});

test("bulk creation needs no rollout flag and active-job and ingestion limits still prevent dispatch", async () => {
  const f = await fixture();
  try {
    const d = await draft(f);
    const preview = await f.jobs.preview({ jobId: d.jobId, expectedRevision: d.revision });
    const started = await f.jobs.start({ jobId: d.jobId, previewToken: preview.previewToken });
    assert.equal(started.state, "queued");
    for (let index = 1; index < JOB_LIMITS.activeJobs; index++) await f.jobs.create({ kind: "bulk_create", expectedGeneration: f.generation, idempotencyKey: crypto.randomUUID() });
    await assert.rejects(f.jobs.create({ kind: "bulk_create", expectedGeneration: f.generation, idempotencyKey: crypto.randomUUID() }), hasCode("CONFLICT"));
    await assert.rejects(f.jobs.append({ jobId: d.jobId, chunkKey: crypto.randomUUID(), expectedRevision: d.revision, items: [item(0)], extra: true }), hasCode("VALIDATION_ERROR"));
    assert.equal(f.network.modifies, 0);
    assert.equal(await accountScope(owner, f.session.connection.dsid), (await f.jobs.repository.get(d.jobId)).account_scope);
  } finally { f.close(); }
});

test("aggregate states cannot conceal failures, conflicts, cancellation or uncertainty", () => {
  const counts = { total: 1, pending: 0, preparing: 0, dispatching: 0, verifying: 0, succeeded: 1, failed: 0, conflict: 0, unknown: 0, cancelled: 0 };
  assert.equal(aggregateState(counts, false), "completed");
  assert.equal(aggregateState({ ...counts, failed: 1 }, false), "completed_with_errors");
  assert.equal(aggregateState({ ...counts, unknown: 1 }, false), "needs_attention");
  assert.equal(aggregateState({ ...counts, cancelled: 1 }, false), "cancelled");
});

test("lost ledger acknowledgements preserve durable intent and a committed receipt", async () => {
  for (const point of ["intent", "receipt"] as const) {
    const f = await fixture();
    try {
      const job = await ready(f);
      f.db.afterStatement = async sql => {
        if ((point === "intent" && sql.includes("state = 'dispatching'")) ||
          (point === "receipt" && sql.includes("result_envelope =") && f.db.sqlite.prepare("SELECT state FROM reminder_job_items WHERE job_id = ?").get(job.jobId)?.state === "succeeded")) {
          f.db.afterStatement = null;
          throw new Error("Synthetic D1 response lost after durable commit.");
        }
      };
      const result = await f.jobs.continue({ jobId: job.jobId });
      assert.equal(result.counts[point === "intent" ? "unknown" : "succeeded"], 1);
      assert.equal(f.network.modifies, point === "intent" ? 0 : 1);
      await new ReminderJobService(f.env, owner).continue({ jobId: job.jobId });
      assert.equal(f.network.modifies, point === "intent" ? 0 : 1);
    } finally { f.close(); }
  }
});

test("Apple success before item receipt commit remains unknown without replay", async () => {
  const f = await fixture();
  try {
    const job = await ready(f), original = f.jobs.repository.setItem.bind(f.jobs.repository);
    let failedOnce = false;
    f.jobs.repository.setItem = async (...args) => {
      if (args[3].status === "succeeded" && !failedOnce) {
        failedOnce = true;
        throw new Error("Synthetic process stopped before receipt commit.");
      }
      return original(...args);
    };
    assert.equal((await f.jobs.continue({ jobId: job.jobId })).counts.unknown, 1);
    const restarted = await new ReminderJobService(f.env, owner).continue({ jobId: job.jobId });
    assert.equal(restarted.counts.unknown, 1); assert.equal(restarted.results[0].result?.desiredStateObserved, true);
    assert.equal(f.network.modifies, 1);
  } finally { f.close(); }
});

test("cancellation after durable intent but before submission prevents the Apple request", async () => {
  const f = await fixture();
  try {
    const job = await ready(f);
    f.db.afterStatement = async sql => {
      if (sql.includes("state = 'dispatching'")) {
        f.db.afterStatement = null;
        await f.jobs.cancel({ jobId: job.jobId });
      }
    };
    const result = await f.jobs.continue({ jobId: job.jobId });
    assert.equal(result.counts.cancelled, 1); assert.equal(f.network.modifies, 0);
  } finally { f.close(); }
});

test("expired authorization cannot dispatch, resolved content expires but unknown content and replay keys remain", async () => {
  const f = await fixture();
  try {
    const expired = await ready(f);
    f.db.sqlite.prepare("UPDATE reminder_jobs SET expires_at = ? WHERE job_id = ?").run(Date.now() - 1, expired.jobId);
    const before = await f.jobs.get({ jobId: expired.jobId });
    assert.equal(before.state, "expired");
    await f.jobs.repository.expireUndispatched();
    assert.equal((await f.jobs.get({ jobId: expired.jobId })).counts.cancelled, 1);
    assert.equal(f.network.modifies, 0);
    const completed = await ready(f);
    await f.jobs.continue({ jobId: completed.jobId });
    const unknown = await ready(f);
    f.network.loseAck = true;
    await f.jobs.continue({ jobId: unknown.jobId });
    f.db.sqlite.prepare("UPDATE reminder_jobs SET updated_at = ?").run(Date.now() - 8 * 86_400_000);
    await f.jobs.repository.purgeResolvedContent();
    await assert.rejects(f.jobs.get({ jobId: completed.jobId }), hasCode("JOB_EXPIRED"));
    assert.equal((await f.jobs.get({ jobId: unknown.jobId })).counts.unknown, 1);
    assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) AS count FROM reminder_job_receipts").get()?.count, 3);
  } finally { f.close(); }
});

test("maximum-sized manifests seal all 1,000 items and reject the 1,001st or oversized ingestion", async () => {
  const f = await fixture();
  try {
    let job = await f.jobs.create({ kind: "bulk_create", expectedGeneration: f.generation, idempotencyKey: crypto.randomUUID() });
    for (let chunk = 0; chunk < 20; chunk++) {
      job = await f.jobs.append({ jobId: job.jobId, expectedRevision: job.revision, chunkKey: crypto.randomUUID(), items: Array.from({ length: 50 }, (_, index) => item(chunk * 50 + index)) });
    }
    await assert.rejects(f.jobs.append({ jobId: job.jobId, expectedRevision: job.revision, chunkKey: crypto.randomUUID(), items: [item(1000)] }), hasCode("VALIDATION_ERROR"));
    const sealed = await f.jobs.preview({ jobId: job.jobId, expectedRevision: job.revision });
    assert.equal(sealed.counts.total, 1000); assert.equal(sealed.results.length, 50); assert.equal(sealed.nextOffset, 50);
    assert.deepEqual((await f.jobs.get({ jobId: job.jobId, offset: 999 })).results.map(result => result.ordinal), [999]);
    const another = await f.jobs.create({ kind: "bulk_create", expectedGeneration: f.generation, idempotencyKey: crypto.randomUUID() });
    const large = Array.from({ length: 50 }, (_, index) => ({ kind: "bulk_create", clientItemKey: `large-${index}`, input: { listId, idempotencyKey: crypto.randomUUID(), title: "x".repeat(2000) } }));
    await assert.rejects(f.jobs.append({ jobId: another.jobId, expectedRevision: 0, chunkKey: crypto.randomUUID(), items: large }), hasCode("VALIDATION_ERROR"));
    assert.equal(f.network.modifies, 0);
  } finally { f.close(); }
});

test("unresolved earlier items do not starve independent pending dispatch", async () => {
  const f = await fixture();
  try {
    const job = await ready(f, Array.from({ length: 4 }, (_, index) => item(index)));
    for (let ordinal = 0; ordinal < 3; ordinal++) f.db.sqlite.prepare("UPDATE reminder_job_items SET state = 'unknown', dispatch_phase = 'intent' WHERE job_id = ? AND ordinal = ?").run(job.jobId, ordinal);
    const result = await f.jobs.continue({ jobId: job.jobId });
    assert.equal(result.counts.succeeded, 1); assert.equal(result.counts.unknown, 3); assert.equal(result.counts.pending, 0);
    assert.equal(f.network.modifies, 1);
  } finally { f.close(); }
});

test("result pages honor byte limits and total input enforces the exact 2 MiB threshold", async () => {
  const f = await fixture();
  try {
    let job = await f.jobs.create({ kind: "bulk_create", expectedGeneration: f.generation, idempotencyKey: crypto.randomUUID() });
    let ordinal = 0, acceptedBytes = 0;
    while (true) {
      const values = Array.from({ length: 3 }, () => canonicalItem(JobItem.parse({ kind: "bulk_create", clientItemKey: `bytes-${ordinal++}`, input: { listId, idempotencyKey: crypto.randomUUID(), title: "Byte budget", notes: "n".repeat(16000) } })));
      const chunkBytes = jsonBytes(values);
      const request = { jobId: job.jobId, expectedRevision: job.revision, chunkKey: crypto.randomUUID(), items: values };
      if (acceptedBytes + chunkBytes > JOB_LIMITS.inputBytes) {
        await assert.rejects(f.jobs.append(request), hasCode("VALIDATION_ERROR"));
        assert.ok(acceptedBytes <= JOB_LIMITS.inputBytes);
        assert.ok(acceptedBytes + chunkBytes > JOB_LIMITS.inputBytes);
        break;
      }
      job = await f.jobs.append(request); acceptedBytes += chunkBytes;
    }
    const page = await f.jobs.get({ jobId: job.jobId, limit: 50 });
    assert.ok(page.results.length > 0 && page.results.length < 50);
    assert.ok(jsonBytes(page.results) < 262_144);
    assert.equal(page.nextOffset, page.results.length);
    assert.equal(f.network.modifies, 0);
  } finally { f.close(); }
});
