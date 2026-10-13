import { Miniflare } from "miniflare";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Envelopes } from "../../src/crypto/envelopes.ts";
import { loginAssurance } from "../../src/auth/apple/policy.ts";

export async function verifyRequestDrivenJobs(options, authHeaders) {
  const owner = options.bindings.REMINDERS_OWNER_ID, origin = options.bindings.APP_ORIGIN;
  const listId = "List/REQUEST-DRIVEN-ACCEPTANCE", zoneOwner = "synthetic-request-driven-zone";
  const records = new Map([[listId, { recordName: listId, recordType: "List", recordChangeTag: "list-1",
    zoneID: { zoneName: "Reminders", ownerRecordName: zoneOwner }, fields: {
      Name: { type: "STRING", value: "Synthetic request-driven list" }, Deleted: { type: "INT64", value: 0 }, IsGroup: { type: "INT64", value: 0 },
      ReminderIDs: { type: "STRING", value: JSON.stringify(["REQUEST-DRIVEN-EXISTING"]) },
      ResolutionTokenMap: { type: "STRING", value: JSON.stringify({ map: {
        reminderIDsMergeableOrdering: { counter: 2, modificationTime: 757_382_400, replicaID: "3e6cb834-5b1c-4ce6-8c39-00e752121111" },
        syntheticUnrelatedField: { counter: 4, modificationTime: 757_382_399, replicaID: "4e6cb834-5b1c-4ce6-8c39-00e752121111" },
      } }) },
      SyntheticFutureListField: { type: "STRING", value: "preserve-this-list-field" },
    } }]]);
  let modifies = 0;
  const worker = new Miniflare({
    ...options, name: "standalone-request-driven-acceptance",
    bindings: { ...options.bindings, LIVE_APPLE_CONNECTION_APPROVED: "controlled-device-v2", APPLE_CRYPTO_REVIEW_APPROVED: "device-proof-v2" },
    d1Databases: { DB: "standalone-request-driven-acceptance" },
    outboundService: async request => {
      const url = new URL(request.url);
      if (url.hostname === "synthetic-team.cloudflareaccess.com") return options.outboundService(request);
      assert.equal(url.hostname, "p01-ckdatabasews.icloud.com");
      const body = await request.json();
      if (url.pathname.endsWith("/records/lookup")) return Response.json({ records: body.records.map(({ recordName }) => records.get(recordName) ?? { recordName, serverErrorCode: "NOT_FOUND" }) });
      if (url.pathname.endsWith("/records/query")) {
        assert.equal(body.query.recordType, "reminderList");
        assert.equal(body.query.filterBy.find(filter => filter.fieldName === "List").fieldValue.value.recordName, listId);
        assert.equal(body.query.filterBy.find(filter => filter.fieldName === "includeCompleted").fieldValue.value, 1);
        return Response.json({ records: [...records.values()].filter(record => record.recordType === "Reminder" && record.fields.List?.value?.recordName === listId) });
      }
      assert.ok(url.pathname.endsWith("/records/modify")); assert.equal(body.atomic, true); assert.equal(body.operations.length, 2);
      assert.equal(body.operations.filter(candidate => candidate.record.recordType === "Reminder").length, 1);
      const operation = body.operations.find(candidate => candidate.operationType === "create" && candidate.record.recordType === "Reminder") ??
        body.operations.find(candidate => candidate.record.recordType === "Reminder");
      assert.ok(operation, "Each accepted job mutation updates exactly one Reminder record.");
      const creation = operation.operationType === "create";
      if (creation) {
        assert.equal(body.operations.length, 2);
        const guard = body.operations[0];
        assert.equal(guard.operationType, "update"); assert.equal(guard.record.recordName, listId);
        assert.equal(guard.record.recordChangeTag, records.get(listId).recordChangeTag);
        assert.deepEqual(Object.keys(guard.record.fields).sort(), ["ReminderIDs", "ResolutionTokenMap"]);
        assert.equal(operation, body.operations[1]);
        assert.equal(operation.operationType, "create");
        assert.equal(operation.record.recordType, "Reminder");
        assert.equal(operation.record.parent?.recordName, listId);
        const currentList = records.get(listId);
        const beforeMembers = JSON.parse(currentList.fields.ReminderIDs.value);
        const afterMembers = JSON.parse(guard.record.fields.ReminderIDs.value);
        assert.deepEqual(afterMembers, [...beforeMembers, operation.record.recordName.slice("Reminder/".length)], "Creation preserves native List ordering.");
        const beforeTokens = JSON.parse(currentList.fields.ResolutionTokenMap.value).map;
        const afterTokens = JSON.parse(guard.record.fields.ResolutionTokenMap.value).map;
        assert.deepEqual(Object.keys(afterTokens).sort(), Object.keys(beforeTokens).sort());
        assert.equal(afterTokens.reminderIDsMergeableOrdering.counter, beforeTokens.reminderIDsMergeableOrdering.counter + 1);
        assert.deepEqual(afterTokens.syntheticUnrelatedField, beforeTokens.syntheticUnrelatedField);
      } else {
        assert.equal(operation.operationType, "update");
        assert.equal(operation.record.recordChangeTag, records.get(operation.record.recordName).recordChangeTag);
        for (const guard of body.operations.filter(candidate => candidate.record.recordType === "List")) {
          assert.equal(guard.operationType, "update"); assert.equal(guard.record.recordName, listId);
          assert.equal(guard.record.recordChangeTag, records.get(listId).recordChangeTag);
          assert.deepEqual(Object.keys(guard.record.fields), ["Deleted"]);
          assert.equal(guard.record.fields.Deleted.value, 0);
        }
      }
      modifies++;
      const confirmations = body.operations.map(candidate => {
        const previous = records.get(candidate.record.recordName);
        if (candidate.operationType === "update") assert.equal(candidate.record.recordChangeTag, previous?.recordChangeTag);
        const next = { ...previous, ...candidate.record, fields: { ...(previous?.fields ?? {}), ...candidate.record.fields },
          recordChangeTag: `confirmed-${modifies}-${candidate.record.recordName}`, zoneID: { zoneName: "Reminders", ownerRecordName: zoneOwner } };
        records.set(next.recordName, next);
        return next;
      });
      return Response.json({ records: confirmations });
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
    const connection = await request("/api/connection");
    assert.equal(connection.capabilities.jobExecutionMode, "request-driven");
    assert.equal(connection.capabilities.autonomousJobs, false);
    const writeCount = modifies;
    const jobKey = randomUUID();
    const draft = await request("/api/reminder-jobs", { kind: "bulk_create", expectedGeneration: 0, idempotencyKey: jobKey });
    assert.equal((await request("/api/reminder-jobs", { kind: "bulk_create", expectedGeneration: 0, idempotencyKey: jobKey })).jobId, draft.jobId);
    const items = Array.from({ length: 4 }, (_, index) => ({ kind: "bulk_create", clientItemKey: `item-${index}`, input: {
      listId, idempotencyKey: randomUUID(), title: `Synthetic request-driven item ${index}` } }));
    const chunk = { expectedRevision: draft.revision, chunkKey: randomUUID(), items };
    const appended = await request(`/api/reminder-jobs/${draft.jobId}/append`, chunk);
    assert.equal((await request(`/api/reminder-jobs/${draft.jobId}/append`, chunk)).revision, appended.revision);
    const preview = await request(`/api/reminder-jobs/${draft.jobId}/preview`, { expectedRevision: appended.revision });
    assert.equal(preview.counts.total, 4);
    assert.equal(modifies, writeCount);
    const beforeStartStatus = await request(`/api/reminder-jobs/${draft.jobId}`);
    assert.equal(beforeStartStatus.state, "ready");
    assert.equal(beforeStartStatus.executionMode, "request-driven");
    const started = await request(`/api/reminder-jobs/${draft.jobId}/start`, { previewToken: preview.previewToken });
    assert.equal(started.executionMode, "request-driven"); assert.equal(started.state, "queued");
    assert.equal(modifies, writeCount);
    assert.equal((await request(`/api/reminder-jobs/${draft.jobId}`)).state, "queued");
    assert.equal(modifies, writeCount);
    const firstSlice = await request(`/api/reminder-jobs/${draft.jobId}/continue`, {});
    assert.equal(firstSlice.counts.succeeded, 3, JSON.stringify(firstSlice.results)); assert.equal(firstSlice.counts.pending, 1);
    assert.equal(modifies, writeCount + 3);
    const secondSlice = await request(`/api/reminder-jobs/${draft.jobId}/continue`, {});
    assert.equal(secondSlice.state, "completed"); assert.equal(secondSlice.counts.succeeded, 4);
    assert.deepEqual(secondSlice.results.map(result => result.clientItemKey), ["item-0", "item-1", "item-2", "item-3"]);
    assert.equal(modifies, writeCount + 4);
    assert.deepEqual(JSON.parse(records.get(listId).fields.ReminderIDs.value), ["REQUEST-DRIVEN-EXISTING", ...items.map(item => item.input.idempotencyKey.toUpperCase())]);
    assert.equal(records.get(listId).fields.SyntheticFutureListField.value, "preserve-this-list-field");
    const replay = await request(`/api/reminder-jobs/${draft.jobId}/continue`, {});
    assert.equal(replay.state, "completed"); assert.equal(modifies, writeCount + 4);

    const updateId = `Reminder/${items[0].input.idempotencyKey.toUpperCase()}`;
    const beforeTitle = records.get(updateId).fields.TitleDocument.value;
    const updateDraft = await request("/api/reminder-jobs", { kind: "bulk_update", expectedGeneration: 0, idempotencyKey: randomUUID() });
    const updateChunk = await request(`/api/reminder-jobs/${updateDraft.jobId}/append`, { expectedRevision: updateDraft.revision, chunkKey: randomUUID(), items: [{
      kind: "bulk_update", clientItemKey: "update-first", input: { listId, reminderId: updateId,
        recordChangeTag: records.get(updateId).recordChangeTag, changes: { title: "Synthetic updated title" } },
    }] });
    const updatePreview = await request(`/api/reminder-jobs/${updateDraft.jobId}/preview`, { expectedRevision: updateChunk.revision });
    await request(`/api/reminder-jobs/${updateDraft.jobId}/start`, { previewToken: updatePreview.previewToken });
    const updated = await request(`/api/reminder-jobs/${updateDraft.jobId}/continue`, {});
    assert.equal(updated.state, "completed", JSON.stringify(updated.results)); assert.equal(updated.counts.succeeded, 1);
    assert.notEqual(records.get(updateId).fields.TitleDocument.value, beforeTitle);
    assert.equal(modifies, writeCount + 5);

    const completeId = `Reminder/${items[1].input.idempotencyKey.toUpperCase()}`;
    const completeDraft = await request("/api/reminder-jobs", { kind: "bulk_complete", expectedGeneration: 0, idempotencyKey: randomUUID() });
    const completeChunk = await request(`/api/reminder-jobs/${completeDraft.jobId}/append`, { expectedRevision: completeDraft.revision, chunkKey: randomUUID(), items: [{
      kind: "bulk_complete", clientItemKey: "complete-second", input: { listId, reminderId: completeId, recordChangeTag: records.get(completeId).recordChangeTag },
    }] });
    const completePreview = await request(`/api/reminder-jobs/${completeDraft.jobId}/preview`, { expectedRevision: completeChunk.revision });
    await request(`/api/reminder-jobs/${completeDraft.jobId}/start`, { previewToken: completePreview.previewToken });
    const completed = await request(`/api/reminder-jobs/${completeDraft.jobId}/continue`, {});
    assert.equal(completed.state, "completed", JSON.stringify(completed.results)); assert.equal(completed.counts.succeeded, 1);
    assert.equal(records.get(completeId).fields.Completed.value, 1);
    assert.equal(modifies, writeCount + 6);

    const cancelledDraft = await request("/api/reminder-jobs", { kind: "bulk_create", expectedGeneration: 0, idempotencyKey: randomUUID() });
    const cancelledChunk = await request(`/api/reminder-jobs/${cancelledDraft.jobId}/append`, { expectedRevision: cancelledDraft.revision,
      chunkKey: randomUUID(), items: [{ kind: "bulk_create", clientItemKey: "cancelled", input: { listId, idempotencyKey: randomUUID(), title: "Synthetic cancelled item" } }] });
    const cancelledPreview = await request(`/api/reminder-jobs/${cancelledDraft.jobId}/preview`, { expectedRevision: cancelledChunk.revision });
    await request(`/api/reminder-jobs/${cancelledDraft.jobId}/start`, { previewToken: cancelledPreview.previewToken });
    const cancelled = await request(`/api/reminder-jobs/${cancelledDraft.jobId}/cancel`, {});
    assert.equal(cancelled.state, "cancelled");
    assert.equal((await request(`/api/reminder-jobs/${cancelledDraft.jobId}/continue`, {})).counts.cancelled, 1);
    assert.equal(modifies, writeCount + 6);
    const finalConnection = await request("/api/connection");
    assert.equal(finalConnection.generation, connection.generation); assert.equal(finalConnection.expiresAt, connection.expiresAt);
    const rejectedEvidence = await worker.dispatchFetch(origin + "/api/reminder-evidence/capture", { method: "POST", headers: { ...authHeaders, origin, "content-type": "application/json" }, body: "{}" });
    assert.equal(rejectedEvidence.status, 403);
    console.log(JSON.stringify({ result: "passed", requestDrivenJobs: true, checks: ["create-and-append-replay", "read-only-status-and-start", "bounded-3-plus-1", "bulk-update", "bulk-complete", "replayed-continuation-no-mutation", "pre-dispatch-cancellation", "session-fence-preservation"] }));
  } finally { await worker.dispose(); }
}
