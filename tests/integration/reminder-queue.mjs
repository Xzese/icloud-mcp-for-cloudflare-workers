import { Miniflare } from "miniflare";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Envelopes } from "../../src/crypto/envelopes.ts";
import { loginAssurance } from "../../src/auth/apple/policy.ts";

export async function verifyReminderQueue(options, authHeaders) {
  const owner = options.bindings.REMINDERS_OWNER_ID, origin = options.bindings.APP_ORIGIN;
  const listId = "List/QUEUE-ACCEPTANCE", zoneOwner = "synthetic-queue-zone";
  const records = new Map([[listId, { recordName: listId, recordType: "List", recordChangeTag: "list-1",
    zoneID: { zoneName: "Reminders", ownerRecordName: zoneOwner }, fields: { Deleted: { type: "INT64", value: 0 }, IsGroup: { type: "INT64", value: 0 } } }]]);
  let modifies = 0;
  const worker = new Miniflare({
    ...options, name: "standalone-queue-acceptance", unsafeTriggerHandlers: true,
    bindings: { ...options.bindings, LIVE_APPLE_CONNECTION_APPROVED: "controlled-device-v2", APPLE_CRYPTO_REVIEW_APPROVED: "device-proof-v2",
      REMINDER_JOB_EXECUTION_MODE: "queue-v1", REMINDER_JOB_QUEUE_NAME: "synthetic-jobs" },
    d1Databases: { DB: "standalone-queue-acceptance" },
    queueProducers: { REMINDER_JOB_QUEUE: { queueName: "synthetic-jobs", deliveryDelay: 30 } },
    queueConsumers: { "synthetic-jobs": { maxBatchSize: 1, maxBatchTimeout: 1, maxRetries: 5 } },
    outboundService: async request => {
      const url = new URL(request.url);
      if (url.hostname === "synthetic-team.cloudflareaccess.com") return options.outboundService(request);
      assert.equal(url.hostname, "p01-ckdatabasews.icloud.com");
      const body = await request.json();
      if (url.pathname.endsWith("/records/lookup")) return Response.json({ records: body.records.map(({ recordName }) => records.get(recordName) ?? { recordName, serverErrorCode: "NOT_FOUND" }) });
      assert.ok(url.pathname.endsWith("/records/modify")); assert.equal(body.atomic, true); assert.equal(body.operations.length, 1);
      const operation = body.operations[0];
      assert.equal(operation.operationType, "create");
      modifies++;
      const record = { ...operation.record, recordChangeTag: `confirmed-${modifies}`, zoneID: { zoneName: "Reminders", ownerRecordName: zoneOwner } };
      records.set(record.recordName, record);
      return Response.json({ records: [record] });
    },
  });
  try {
    const db = await worker.getD1Database("DB");
    await db.prepare(await readFile(new URL("../../schema.sql", import.meta.url), "utf8")).run();
    const session = { login: loginAssurance(), auth: { clientId: "synthetic-client", headers: {}, cookies: [] },
      connection: { dsid: "123456789", clientId: "synthetic-client", clientBuildNumber: "2534Project66", clientMasteringNumber: "2534B22",
        cloudKitURL: "https://p01-ckdatabasews.icloud.com/database/1/com.apple.reminders/production/private", remindersZoneOwner: zoneOwner },
      pcs: { consentRequested: true, pcsAttempts: 1, consentChecks: 1, expiresAt: Date.now() + 300_000, nextAttemptAt: 0 } };
    const envelope = await new Envelopes(options.bindings.ENCRYPTION_KEY_ID, JSON.parse(options.bindings.ENCRYPTION_KEYS_JSON)).encrypt(session,
      { ownerId: owner, accountId: "apple-reminders", generation: 0, recordId: "apple-session", schemaVersion: 1 });
    await db.prepare("INSERT INTO apple_session_state (owner_id, account_id, generation, state, envelope) VALUES (?, 'apple-reminders', 0, 'READY', ?)")
      .bind(owner, JSON.stringify(envelope)).run();
    const request = async (path, body) => {
      const response = await worker.dispatchFetch(origin + path, { headers: { ...authHeaders, ...(body ? { origin, "content-type": "application/json" } : {}) },
        ...(body ? { method: "POST", body: JSON.stringify(body) } : {}) });
      const result = await response.json();
      assert.equal(response.status, 200, JSON.stringify(result));
      return result;
    };
    const initialStatus = await request("/api/connection");
    assert.equal(initialStatus.capabilities.autonomousJobs, true);
    assert.equal(initialStatus.capabilities.jobExecutionMode, "queue");
    const draft = await request("/api/reminder-jobs", { kind: "bulk_create", expectedGeneration: 0, idempotencyKey: randomUUID() });
    const appended = await request(`/api/reminder-jobs/${draft.jobId}/append`, { expectedRevision: draft.revision, chunkKey: randomUUID(),
      items: Array.from({ length: 4 }, (_, index) => ({ kind: "bulk_create", clientItemKey: `item-${index}`, input: { listId, idempotencyKey: randomUUID(), title: `Synthetic queue item ${index}` } })) });
    const preview = await request(`/api/reminder-jobs/${draft.jobId}/preview`, { expectedRevision: appended.revision });
    const started = await request(`/api/reminder-jobs/${draft.jobId}/start`, { previewToken: preview.previewToken });
    assert.equal(started.executionMode, "queue"); assert.equal(modifies, 0);
    const entrypoint = await worker.getWorker();
    const scheduled = await entrypoint.scheduled({ cron: "* * * * *" });
    assert.equal(scheduled.outcome, "ok");
    assert.ok((await db.prepare("SELECT next_eligible_at FROM reminder_job_outbox WHERE job_id = ?").bind(draft.jobId).first()).next_eligible_at > Date.now());
    const body = { jobId: draft.jobId, revision: started.revision };
    const deliver = async value => {
      const result = await entrypoint.queue("synthetic-jobs", [{ id: randomUUID(), timestamp: new Date(), attempts: 1, body: value }]);
      assert.equal(result.outcome, "ok"); assert.equal(result.retryMessages.length, 0);
    };
    await deliver(body);
    assert.equal(modifies, 3);
    await deliver(body);
    assert.equal(modifies, 4);
    await deliver(body);
    await deliver({ ...body, owner: "forged" });
    assert.equal(modifies, 4);
    const completed = await request(`/api/reminder-jobs/${draft.jobId}`);
    assert.equal(completed.state, "completed"); assert.equal(completed.counts.succeeded, 4);
    assert.deepEqual(completed.results.map(result => result.clientItemKey), ["item-0", "item-1", "item-2", "item-3"]);
    const finalStatus = await request("/api/connection");
    assert.equal(finalStatus.generation, initialStatus.generation); assert.equal(finalStatus.expiresAt, initialStatus.expiresAt);
    const rejectedEvidence = await worker.dispatchFetch(origin + "/api/reminder-evidence/capture", { method: "POST", headers: { ...authHeaders, origin, "content-type": "application/json" }, body: "{}" });
    assert.equal(rejectedEvidence.status, 403);
    console.log(JSON.stringify({ result: "passed", standaloneQueue: true, checks: ["built-scheduled-outbox", "real-producer-consumer-bindings", "bounded-3-plus-1", "duplicate-delivery-no-replay", "owner-authority-denial", "session-fence-preservation"] }));
  } finally { await worker.dispose(); }
}
