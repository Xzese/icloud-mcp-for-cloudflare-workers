// Synthetic create/edit acceptance journeys against the production Worker bundle.
// Every outbound request is intercepted here; no Apple account or network is used.
import assert from "node:assert/strict";
import { Miniflare } from "miniflare";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv-provider.js";
import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Envelopes } from "../../src/crypto/envelopes.ts";
import { loginAssurance } from "../../src/auth/apple/policy.ts";
import { encodeDocument } from "../../src/reminders/crdt.ts";
import { runControlledWriteChecks, runControlledLifecycleChecks } from "../../scripts/dev/validate-local-reminder-writes.mjs";
import { JOB_TOOLS } from "../../src/jobs/schemas.ts";
import { dateComponents, dueDateNonce } from "../../src/reminders/linked-date.ts";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const listId = "List/WRITE-ACCEPTANCE";
const zoneOwner = "synthetic-private-owner";
const reminderId = "Reminder/WRITE-EXISTING";
const opaqueMetadata = "synthetic-private-apple-field";

const jsonResponse = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), {
  status,
  headers: { "content-type": "application/json", ...headers },
});

function field(type, value) { return { type, value }; }

function listRecord() {
  return {
    recordName: listId, recordType: "List", recordChangeTag: "list-tag-1",
    zoneID: { zoneName: "Reminders", zoneType: "REGULAR_CUSTOM_ZONE", ownerRecordName: zoneOwner },
    fields: { Name: field("STRING", "Synthetic acceptance list"), Deleted: field("INT64", 0), IsGroup: field("INT64", 0) },
  };
}

function reminderRecord(id, { recurrence = false, alarm = false } = {}) {
  const fields = {
    TitleDocument: field("STRING", encodeDocument(`Existing ${id}`)),
    NotesDocument: field("STRING", encodeDocument("Preserve these notes 📝")),
    List: field("REFERENCE", { recordName: listId, action: "VALIDATE", zoneID: { zoneName: "Reminders", ownerRecordName: zoneOwner } }),
    Completed: field("INT64", 0), CompletionDate: field("TIMESTAMP", null), Deleted: field("INT64", 0),
    Flagged: field("INT64", 1), Priority: field("INT64", 5), AllDay: field("INT64", 0),
    DueDate: field("TIMESTAMP", Date.parse("2030-03-04T09:15:00.000Z")),
    TimeZone: field("STRING", "Europe/London"),
    CreationDate: field("TIMESTAMP", Date.parse("2029-01-01T00:00:00.000Z")),
    LastModifiedDate: field("TIMESTAMP", Date.parse("2029-01-02T00:00:00.000Z")),
    ResolutionTokenMap: field("STRING", JSON.stringify({ map: {} })),
    ApplePrivateMetadata: field("STRING", opaqueMetadata),
  };
  if (recurrence) fields.RecurrenceRuleIDs = field("STRING_LIST", ["RecurrenceRule/WRITE-RECURRING"]);
  if (alarm) fields.AlarmIDs = field("STRING_LIST", ["Alarm/WRITE-ALARMED"]);
  return {
    recordName: id, recordType: "Reminder", recordChangeTag: `tag-${id}`,
    zoneID: { zoneName: "Reminders", zoneType: "REGULAR_CUSTOM_ZONE", ownerRecordName: zoneOwner }, fields,
  };
}

function sessionFixture(expired = false) {
  const now = Date.now();
  return {
    login: loginAssurance(expired ? now - 2_592_000_001 : now),
    auth: {
      clientId: "synthetic-client",
      headers: { "X-Apple-Session-Token": "synthetic-apple-token" },
      cookies: [{ name: "synthetic-session", value: "restore-me", domain: "icloud.com", hostOnly: false, path: "/", secure: true, expiresAt: null }],
    },
    connection: {
      dsid: "123456789", clientId: "synthetic-client", clientBuildNumber: "2534Project66",
      clientMasteringNumber: "2534B22",
      cloudKitURL: "https://p01-ckdatabasews.icloud.com/database/1/com.apple.reminders/production/private",
      remindersZoneOwner: zoneOwner,
    },
    pcs: { consentRequested: true, pcsAttempts: 1, consentChecks: 1, expiresAt: now + 300_000, nextAttemptAt: 0 },
  };
}

function requestHeaders(user, requestOrigin, method) {
  const headers = { ...(user ? { "oai-authenticated-user-id": user, "oai-authenticated-user-email": "synthetic@example.invalid" } : {}) };
  if (method === "POST") Object.assign(headers, { "content-type": "application/json", origin: requestOrigin, accept: "application/json, text/event-stream" });
  return headers;
}

export async function verifyReminderWrites(options) {
  assert.ok(Array.isArray(options.modules) && options.modules.length > 0, "Pass the exact built Worker modules from worker.mjs.");
  assert.ok(options.d1Persist, "Pass the disposable D1 persistence directory from worker.mjs.");
  const owner = options.bindings.REMINDERS_OWNER_ID;
  const origin = options.bindings.APP_ORIGIN;
  assert.ok(owner && origin, "Pass the authenticated owner and private Site origin from worker.mjs.");
  const schema = await readFile(join(root, "schema.sql"), "utf8");
  const secret = options.bindings.ENCRYPTION_KEYS_JSON;
  const keyRing = JSON.parse(secret);
  const keyId = options.bindings.ENCRYPTION_KEY_ID;

  const makeWorker = async ({ login = true, localEvidence = false } = {}) => {
    const state = {
      records: new Map([[listId, listRecord()], [reminderId, reminderRecord(reminderId)],
        ["Reminder/WRITE-RECURRING", reminderRecord("Reminder/WRITE-RECURRING", { recurrence: true })],
        ["Reminder/WRITE-ALARMED", reminderRecord("Reminder/WRITE-ALARMED", { alarm: true })]]),
      requests: [], modifies: [], nextModify: null, holdLookup: null, holdModify: null,
    };
    const bindings = {
      ...options.bindings,
      LIVE_APPLE_CONNECTION_APPROVED: login ? "controlled-device-v2" : "",
      APPLE_CRYPTO_REVIEW_APPROVED: "device-proof-v2",
      ...(localEvidence ? { APP_ORIGIN: "http://127.0.0.1:5173", LOCAL_REMINDER_EVIDENCE_ENABLED: "synthetic-v1" } : {}),
    };
    const outboundService = async request => {
      const url = new URL(request.url);
      state.requests.push({ method: request.method, path: url.pathname });
      const body = request.method === "POST" ? await request.clone().json() : undefined;
      if (url.pathname.endsWith("/records/query")) {
        if (body.query.recordType === "Lists") return jsonResponse({ records: [state.records.get(listId)] });
        assert.equal(body.query.recordType, "reminderList");
        assert.equal(body.query.filterBy.find(filter => filter.fieldName === "List").fieldValue.value.recordName, listId);
        const includeCompleted = body.query.filterBy.find(filter => filter.fieldName === "includeCompleted").fieldValue.value === 1;
        return jsonResponse({ records: [...state.records.values()].filter(record => record.recordType === "Reminder" && record.fields.List.value.recordName === listId && record.fields.Deleted.value === 0 && (includeCompleted || record.fields.Completed.value === 0)) });
      }
      if (url.pathname.endsWith("/records/lookup")) {
        if (state.holdLookup) {
          const held = state.holdLookup;
          state.holdLookup = null;
          held.reached();
          await held.releasePromise;
        }
        const records = body.records.map(({ recordName }) => {
          const record = state.records.get(recordName);
          return record ? localEvidence ? { ...record, zoneID: undefined } : record : { recordName, serverErrorCode: "NOT_FOUND" };
        });
        return jsonResponse({ records });
      }
      if (url.pathname.endsWith("/records/modify")) {
        const operation = body.operations[0];
        if (body.operations.length > 1) {
          assert.equal(body.atomic, true);
          if (body.operations.some(candidate => candidate.record.recordType === "Alarm" && Object.hasOwn(candidate.record.fields, "DueDateResolutionTokenAsNonce"))) {
            assert.equal(body.operations.length, 4);
            state.modifies.push({ atomicDateGroup: true, operationCount: body.operations.length });
            const action = state.nextModify; state.nextModify = null;
            if (action === "date-dependency-race") {
              const current = state.records.get(body.operations[1].record.recordName);
              state.records.set(current.recordName, { ...current, recordChangeTag: "concurrent-date-dependency" });
            }
            const stale = body.operations.find(candidate => candidate.record.recordChangeTag !== state.records.get(candidate.record.recordName)?.recordChangeTag);
            if (stale) return jsonResponse({ records: body.operations.map(candidate => ({
              recordName: candidate.record.recordName, serverErrorCode: candidate === stale ? "CONFLICT" : "ATOMIC_ERROR",
            })) });
            const records = body.operations.map((candidate, index) => {
              if (index === 1) assert.deepEqual(Object.keys(candidate.record.fields), ["DueDateResolutionTokenAsNonce"]);
              if (index === 2) assert.deepEqual(Object.keys(candidate.record.fields), ["DateComponentsData"]);
              if (index === 3) assert.deepEqual(candidate.record.fields, { Deleted: field("INT64", 0) });
              const current = state.records.get(candidate.record.recordName);
              const next = { ...current, recordChangeTag: `date-updated-${state.modifies.length}-${current.recordName}`,
                fields: { ...current.fields, ...candidate.record.fields } };
              state.records.set(next.recordName, next); return next;
            });
            if (action === "committed-500") return jsonResponse({ serverErrorCode: "SERVICE_UNAVAILABLE" }, 500);
            if (action === "date-missing-confirmation") return jsonResponse({ records: records.slice(0, -1) });
            if (action === "date-changed-confirmation") return jsonResponse({ records: records.map(record => record.recordType === "Alarm" ?
              { ...record, fields: { ...record.fields, Foreign: field("STRING", "unexpected") } } : record) });
            return jsonResponse({ records: records.reverse() });
          }
          if (Object.hasOwn(operation.record.fields, "ParentReminder")) {
            assert.ok(body.operations.length === 2 || body.operations.length === 3);
            state.modifies.push({ atomicSubtaskGroup: true, operationCount: body.operations.length });
            const action = state.nextModify;
            state.nextModify = null;
            if (action === "parent-race") {
              const parent = state.records.get(body.operations[1].record.recordName);
              state.records.set(parent.recordName, { ...parent, recordChangeTag: `concurrent-${parent.recordChangeTag}` });
            }
            const stale = body.operations.find(candidate => candidate.operationType === "create" ? state.records.has(candidate.record.recordName) :
              candidate.record.recordChangeTag !== state.records.get(candidate.record.recordName)?.recordChangeTag);
            if (stale) return jsonResponse({ records: body.operations.map(candidate => ({
              recordName: candidate.record.recordName, serverErrorCode: candidate === stale ? "CONFLICT" : "ATOMIC_ERROR",
            })) });
            const records = body.operations.map((candidate, index) => {
              if (index > 0) {
                assert.equal(candidate.operationType, "update");
                assert.deepEqual(candidate.record.fields, { Deleted: field("INT64", 0) });
              }
              const current = state.records.get(candidate.record.recordName);
              const next = candidate.operationType === "create" ? { ...candidate.record, zoneID: { zoneName: "Reminders", ownerRecordName: zoneOwner } } :
                { ...current, fields: { ...current.fields, ...candidate.record.fields } };
              delete next.parent;
              next.recordChangeTag = `subtask-updated-${state.modifies.length}-${next.recordName}`;
              state.records.set(next.recordName, next);
              return next;
            });
            if (action === "committed-500") return jsonResponse({ serverErrorCode: "SERVICE_UNAVAILABLE" }, 500);
            if (action === "missing-parent-confirmation") return jsonResponse({ records: records.slice(0, 1) });
            return jsonResponse({ records: records.reverse() });
          }
          assert.equal(localEvidence, true);
          assert.ok(body.operations.length === 2 || body.operations.length === 4);
          state.modifies.push({ atomicGuardGroup: true, operationCount: body.operations.length });
          const stale = body.operations.find(candidate => candidate.record.recordChangeTag !== state.records.get(candidate.record.recordName)?.recordChangeTag);
          if (stale) return jsonResponse({ records: body.operations.map(candidate => ({
            recordName: candidate.record.recordName, serverErrorCode: candidate === stale ? "SERVER_RECORD_CHANGED" : "ATOMIC_ERROR",
          })) });
          const records = body.operations.map(candidate => {
            assert.equal(candidate.operationType, "update");
            assert.deepEqual(candidate.record.fields, { Deleted: field("INT64", 0) });
            const current = state.records.get(candidate.record.recordName);
            const next = { ...current, recordChangeTag: `guard-updated-${state.modifies.length}-${current.recordName}` };
            state.records.set(next.recordName, next);
            return next;
          });
          return jsonResponse({ records: records.reverse() });
        }
        assert.equal(body.operations.length, 1, "Each controlled action sends one exact reminder write.");
        assert.equal(operation.record.recordType, "Reminder");
        state.modifies.push({ operationType: operation.operationType, recordName: operation.record.recordName, recordChangeTag: operation.record.recordChangeTag, fields: Object.keys(operation.record.fields).sort() });
        const action = state.nextModify;
        state.nextModify = null;
        if (action === "redirect-307") return new Response(null, { status: 307, headers: { location: request.url } });
        if (action === "record-conflict") return jsonResponse({ records: [{ recordName: operation.record.recordName, serverErrorCode: "CONFLICT" }] });

        const current = state.records.get(operation.record.recordName);
        if (operation.operationType === "update" && operation.record.recordChangeTag !== current.recordChangeTag) return jsonResponse({ records: [{ recordName: operation.record.recordName, serverErrorCode: "CONFLICT" }] });
        const next = operation.operationType === "create"
          ? { ...operation.record, zoneID: { zoneName: "Reminders", zoneType: "REGULAR_CUSTOM_ZONE", ownerRecordName: zoneOwner }, recordChangeTag: `tag-created-${state.modifies.length}` }
          : { ...current, fields: { ...current.fields, ...operation.record.fields }, recordChangeTag: `tag-updated-${state.modifies.length}` };
        delete next.parent;
        state.records.set(next.recordName, next);
        if (state.holdModify) {
          const held = state.holdModify;
          state.holdModify = null;
          held.reached();
          await held.releasePromise;
        }
        if (action === "committed-500") return jsonResponse({ serverErrorCode: "SERVICE_UNAVAILABLE" }, 500);
        if (action === "committed-network-drop") throw new Error("Synthetic response lost after commit.");
        if (action === "changed-resolution-tokens") return jsonResponse({ records: [{ ...next, fields: { ...next.fields, ResolutionTokenMap: field("STRING", JSON.stringify({ map: {} })) } }] });
        return jsonResponse({ records: [next] });
      }
      return jsonResponse({ serverErrorCode: "UNEXPECTED_SYNTHETIC_REQUEST" }, 500);
    };
    const worker = new Miniflare({
      ...options,
      name: `reminder-write-acceptance-${randomUUID()}`,
      d1Databases: { ...options.d1Databases, DB: `reminder-write-acceptance-${randomUUID()}` },
      bindings,
      outboundService,
    });
    const db = await worker.getD1Database("DB");
    await db.prepare(schema).run();
    const request = async (path, { user = owner, method = "GET", body, requestOrigin = bindings.APP_ORIGIN, host = bindings.APP_ORIGIN } = {}) => {
      const headers = requestHeaders(user, requestOrigin, method);
      return worker.dispatchFetch(host + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    };
    const seedReady = async (expired = false) => {
      await db.prepare("INSERT OR IGNORE INTO apple_session_state (owner_id, account_id) VALUES (?, ?)").bind(owner, "apple-reminders").run();
      const statusResponse = await request("/api/connection");
      assert.equal(statusResponse.status, 200);
      const { generation } = await statusResponse.json();
      const envelope = await new Envelopes(keyId, keyRing).encrypt(sessionFixture(expired), {
        ownerId: owner, accountId: "apple-reminders", generation, recordId: "apple-session", schemaVersion: 1,
      });
      await db.prepare("UPDATE apple_session_state SET state = 'READY', envelope = ?, action = NULL, next_attempt_at = 0, transaction_id = NULL, transaction_expires_at = NULL, resume_id = NULL, resume_expires_at = NULL, version = version + 1 WHERE owner_id = ?")
        .bind(JSON.stringify(envelope), owner).run();
      return generation;
    };
    const outputValidators = new Map();
    const jsonSchemaValidator = new AjvJsonSchemaValidator();
    const mcp = async (method, params) => {
      const response = await request("/mcp", { method: "POST", body: { jsonrpc: "2.0", id: randomUUID(), method, params } });
      const value = await response.json();
      assert.equal(response.status, 200, JSON.stringify(value));
      if (method === "tools/list") for (const tool of value.result.tools) {
        assert.equal(tool.outputSchema.type, "object");
        assert.equal(tool.outputSchema.additionalProperties, false);
        outputValidators.set(tool.name, jsonSchemaValidator.getValidator(tool.outputSchema));
      }
      if (method === "tools/call" && value.result?.structuredContent) assert.deepEqual(JSON.parse(value.result.content[0].text), value.result.structuredContent);
      if (method === "tools/call" && !value.result?.isError && outputValidators.has(params.name)) {
        const validated = outputValidators.get(params.name)(value.result.structuredContent);
        assert.equal(validated.valid, true, validated.errorMessage);
      }
      return value;
    };
    return { worker, db, state, request, seedReady, mcp };
  };

  let workerHarness;
  try {
    // Login availability, owner and origin checks stop before session or Apple state changes.
    workerHarness = await makeWorker({ login: false });
    const gateDB = workerHarness.db;
    const gateBefore = await gateDB.prepare("SELECT * FROM apple_session_state").all();
    const gated = await workerHarness.request("/api/mutations", { method: "POST", body: { action: "create" } });
    assert.equal(gated.status, 422);
    assert.equal((await gated.json()).error.code, "UNSUPPORTED_AUTH");
    assert.equal((await workerHarness.request("/api/mutations", { user: "different-owner", method: "POST", body: {} })).status, 403);
    assert.equal((await workerHarness.request("/api/mutations", { method: "POST", requestOrigin: "https://evil.example", body: {} })).status, 403);
    assert.equal((await workerHarness.request("/mcp", { user: "different-owner", method: "POST", body: { jsonrpc: "2.0", id: 1, method: "tools/list" } })).status, 403);
    assert.deepEqual(workerHarness.state.requests, []);
    assert.deepEqual((await gateDB.prepare("SELECT * FROM apple_session_state").all()).results, gateBefore.results);
    await workerHarness.worker.dispose(); workerHarness = undefined;

    // Every mutation requires a ready Apple session, without a separate write flag.
    workerHarness = await makeWorker();
    const { request, state, mcp } = workerHarness;
    const disconnectedStatus = await (await request("/api/connection")).json();
    assert.equal(disconnectedStatus.writeEnabled, false);
    assert.equal(disconnectedStatus.capabilities.subtasks, false);
    assert.equal(disconnectedStatus.capabilities.bulkCreate, false);
    for (const action of ["complete", "reopen", "delete"]) {
      const denied = await mcp("tools/call", { name: `${action}_reminder`, arguments: { listId, reminderId, recordChangeTag: `tag-${reminderId}`, expectedGeneration: disconnectedStatus.generation } });
      assert.equal(denied.result.structuredContent.error.code, "NOT_CONNECTED");
    }
    for (const [name, args] of [
      ["create_subtask", { listId, idempotencyKey: randomUUID(), title: "Child", parentReminder: { reminderId, recordChangeTag: `tag-${reminderId}` } }],
      ["set_reminder_parent", { listId, reminderId, recordChangeTag: `tag-${reminderId}`, parentReminder: null }],
    ]) {
      const denied = await mcp("tools/call", { name, arguments: { ...args, expectedGeneration: disconnectedStatus.generation } });
      assert.equal(denied.result.structuredContent.error.code, "NOT_CONNECTED");
    }
    assert.deepEqual(state.requests, []);
    let generation = await workerHarness.seedReady();
    const readyStatus = await (await request("/api/connection")).json();
    assert.equal(readyStatus.phase, "read-write"); assert.equal(readyStatus.writeEnabled, true);
    for (const action of ["create", "update", "complete", "reopen", "delete", "subtasks", "bulkCreate"]) assert.equal(readyStatus.capabilities[action], true);

    const toolsReply = await mcp("tools/list", {});
    const tools = toolsReply.result.tools;
    assert.deepEqual(tools.map(tool => tool.name).sort(), ["complete_reminder", "connection_status", "create_reminder", "create_subtask", "set_reminder_parent", "delete_reminder", "get_all_open_reminders", "get_reminder", "get_reminder_lists", "get_reminders", "reopen_reminder", "update_reminder", "prepare_reminder_update", ...JOB_TOOLS].sort());
    const createTool = tools.find(tool => tool.name === "create_reminder");
    const updateTool = tools.find(tool => tool.name === "update_reminder");
    assert.deepEqual({ readOnly: createTool.annotations.readOnlyHint, destructive: createTool.annotations.destructiveHint, idempotent: createTool.annotations.idempotentHint }, { readOnly: false, destructive: false, idempotent: true });
    assert.deepEqual({ readOnly: updateTool.annotations.readOnlyHint, destructive: updateTool.annotations.destructiveHint, idempotent: updateTool.annotations.idempotentHint }, { readOnly: false, destructive: true, idempotent: true });
    for (const name of ["complete_reminder", "reopen_reminder", "delete_reminder"]) {
      const annotations = tools.find(tool => tool.name === name).annotations;
      assert.deepEqual([annotations.readOnlyHint, annotations.destructiveHint, annotations.idempotentHint], [false, true, true]);
    }
    for (const tool of tools) for (const parameter of Object.values(tool.inputSchema.properties ?? {})) {
      assert.ok(parameter.description?.length > 0, `${tool.name} must describe each parameter in tools/list.`);
    }
    for (const parameter of Object.values(updateTool.inputSchema.properties.changes.properties)) assert.ok(parameter.description?.length > 0);
    const status = await mcp("tools/call", { name: "connection_status", arguments: {} });
    assert.equal(status.result.structuredContent.generation, generation);
    state.records.get(listId).fields.Name.value = "S".repeat(257);
    const currentLists = await mcp("tools/call", { name: "get_reminder_lists", arguments: { expectedGeneration: generation } });
    assert.equal(currentLists.result.isError, undefined, JSON.stringify(currentLists.result));
    assert.equal(currentLists.result.structuredContent.records[0].title, "S".repeat(257), "Live titles must not inherit the saved display snapshot title limit.");
    assert.equal(currentLists.result.structuredContent.source, "direct-cloudkit-query");
    assert.equal(currentLists.result.structuredContent.freshness.mode, "live");
    assert.deepEqual(currentLists.result.structuredContent.records.map(list => list.id), [listId]);
    assert.ok(state.requests.every(request => !request.path.endsWith("/changes/zone")), "The mutation journey discovers lists without history scanning.");

    const createKey = "46cf8eef-6cab-4aa2-a725-219769337d8b";
    const createArgs = { listId, idempotencyKey: createKey, title: "Café 🧭 — 東京", notes: "Keep this note 🌿", priority: 1, flagged: true };
    const created = await mcp("tools/call", { name: "create_reminder", arguments: createArgs });
    assert.equal(created.result.isError, undefined, JSON.stringify(created.result.structuredContent));
    assert.equal(created.result.structuredContent.operation, "create");
    assert.equal(created.result.structuredContent.record.title, createArgs.title);
    assert.equal(created.result.structuredContent.record.notes, createArgs.notes);
    assert.equal(created.result.structuredContent.replayed, false);
    assert.equal(state.modifies.length, 1);
    assert.equal(state.modifies[0].recordName, `Reminder/${createKey.toUpperCase()}`);
    assert.ok(!JSON.stringify(created).includes(opaqueMetadata));
    assert.ok(!JSON.stringify(created).includes("synthetic-private-owner"));
    const validateCreate = new AjvJsonSchemaValidator().getValidator(createTool.outputSchema);
    const exposedRaw = structuredClone(created.result.structuredContent);
    exposedRaw.record.raw = { private: opaqueMetadata };
    assert.equal(validateCreate(exposedRaw).valid, false, "The public contract must reject raw Apple metadata.");
    const missingTag = structuredClone(created.result.structuredContent);
    delete missingTag.record.recordChangeTag;
    assert.equal(validateCreate(missingTag).valid, false, "The mutation contract must declare its returned version token.");

    const replay = await mcp("tools/call", { name: "create_reminder", arguments: createArgs });
    assert.equal(replay.result.structuredContent.replayed, true);
    assert.equal(state.modifies.length, 1, "An identical create replay must reconcile from lookup without another modify.");
    const changedReplay = await mcp("tools/call", { name: "create_reminder", arguments: { ...createArgs, title: "A different item" } });
    assert.equal(changedReplay.result.isError, true);
    assert.equal(changedReplay.result.structuredContent.error.code, "CONFLICT");
    assert.equal(state.modifies.length, 1, "Reusing a create key for changed content must never modify Apple.");

    // API writes require a pinned generation. A title-only edit keeps notes and Apple-owned fields.
    const beforeEdit = state.records.get(reminderId);
    const oldTag = beforeEdit.recordChangeTag;
    const editBody = { action: "update", listId, reminderId, recordChangeTag: oldTag, changes: { title: "Edited through API ✨" }, expectedGeneration: generation };
    const editedResponse = await request("/api/mutations", { method: "POST", body: editBody });
    const edited = await editedResponse.json();
    assert.equal(editedResponse.status, 200, JSON.stringify(edited));
    assert.equal(edited.operation, "update");
    assert.equal(edited.record.title, editBody.changes.title);
    assert.equal(edited.record.notes, "Preserve these notes 📝");
    assert.equal(edited.record.flagged, true);
    assert.equal(edited.record.priority, 5);
    assert.equal(edited.record.dueDate, "2030-03-04T09:15:00.000Z");
    assert.equal(edited.record.timeZone, "Europe/London");
    assert.notEqual(edited.record.recordChangeTag, oldTag);
    assert.deepEqual(state.modifies[1].fields, ["LastModifiedDate", "ResolutionTokenMap", "TitleDocument"]);
    assert.equal(state.records.get(reminderId).fields.NotesDocument.value, beforeEdit.fields.NotesDocument.value);
    assert.equal(state.records.get(reminderId).fields.ApplePrivateMetadata.value, opaqueMetadata);
    assert.ok(!JSON.stringify(edited).includes(opaqueMetadata));

    const modifyCountAfterEdit = state.modifies.length;
    const staleResponse = await request("/api/mutations", { method: "POST", body: { ...editBody, changes: { title: "Stale update" } } });
    assert.equal(staleResponse.status, 409);
    assert.equal((await staleResponse.json()).error.code, "CONFLICT");
    assert.equal(state.modifies.length, modifyCountAfterEdit, "A stale change tag must fail before modify.");
    const identicalEditArgs = { listId, reminderId, recordChangeTag: oldTag, changes: editBody.changes, expectedGeneration: generation };
    const identicalEdit = await mcp("tools/call", { name: "update_reminder", arguments: identicalEditArgs });
    assert.equal(identicalEdit.result.structuredContent.error.code, "CONFLICT");
    assert.equal(state.modifies.length, modifyCountAfterEdit, "Identical MCP edit replay must not send another modify.");
    const unpinnedResponse = await request("/api/mutations", { method: "POST", body: { action: "update", listId, reminderId, recordChangeTag: edited.record.recordChangeTag, changes: { title: "Missing generation" } } });
    assert.equal(unpinnedResponse.status, 400);
    assert.equal(state.modifies.length, modifyCountAfterEdit);

    // Apple-side per-record conflicts are surfaced once; the client never force-writes or retries.
    state.nextModify = "record-conflict";
    const conflictBody = { ...editBody, recordChangeTag: edited.record.recordChangeTag, changes: { title: "Conflict stays a conflict" } };
    const conflictResponse = await request("/api/mutations", { method: "POST", body: conflictBody });
    assert.equal(conflictResponse.status, 409);
    assert.equal((await conflictResponse.json()).error.code, "CONFLICT");
    assert.equal(state.modifies.length, modifyCountAfterEdit + 1);

    // Status changes use their separate tools; linked mutations remain unsupported.
    const beforeUnsupported = state.modifies.length;
    const completionResponse = await request("/api/mutations", { method: "POST", body: { ...editBody, changes: { completed: true } } });
    assert.equal(completionResponse.status, 400);
    for (const [id, tag] of [["Reminder/WRITE-RECURRING", "tag-Reminder/WRITE-RECURRING"], ["Reminder/WRITE-ALARMED", "tag-Reminder/WRITE-ALARMED"]]) {
      const unsupported = await request("/api/mutations", { method: "POST", body: { action: "update", listId, reminderId: id, recordChangeTag: tag, changes: { dueDate: "2030-04-01T09:00:00.000Z" }, expectedGeneration: generation } });
      assert.equal(unsupported.status, 422);
      assert.equal((await unsupported.json()).error.code, "UNSUPPORTED_FEATURE");
    }
    assert.equal(state.modifies.length, beforeUnsupported);

    // Complete/reopen preserve content; deletion works on a completed record.
    const lifecycleId = created.result.structuredContent.record.id;
    const lifecycleTarget = () => ({ listId, reminderId: lifecycleId, recordChangeTag: state.records.get(lifecycleId).recordChangeTag, expectedGeneration: generation });
    const originalLifecycle = structuredClone(state.records.get(lifecycleId));
    const firstTarget = lifecycleTarget();
    const completeReply = await mcp("tools/call", { name: "complete_reminder", arguments: firstTarget });
    assert.equal(completeReply.result.structuredContent.record.completed, true);
    const repeatLifecycle = async (name, args) => {
      const before = structuredClone(state.records.get(args.reminderId));
      const count = state.modifies.length;
      const repeat = await mcp("tools/call", { name, arguments: args });
      assert.equal(repeat.result.isError, true);
      assert.equal(repeat.result.structuredContent.error.code, "CONFLICT");
      assert.equal(state.modifies.length, count, `Identical ${name} replay must not submit another write.`);
      assert.deepEqual(state.records.get(args.reminderId), before);
    };
    await repeatLifecycle("complete_reminder", firstTarget);
    const completedLookup = await mcp("tools/call", { name: "get_reminder", arguments: { listId, reminderId: lifecycleId } });
    assert.equal(completedLookup.result.structuredContent.record.completed, true);
    assert.ok(!JSON.stringify(completedLookup).includes(opaqueMetadata));
    assert.ok(Number.isFinite(Date.parse(completeReply.result.structuredContent.record.completedDate)));
    assert.deepEqual(state.modifies.at(-1).fields, ["Completed", "CompletionDate", "LastModifiedDate", "ResolutionTokenMap"]);
    assert.equal(state.records.get(lifecycleId).fields.TitleDocument.value, originalLifecycle.fields.TitleDocument.value);
    assert.equal(state.records.get(lifecycleId).fields.NotesDocument.value, originalLifecycle.fields.NotesDocument.value);
    const staleDelete = await mcp("tools/call", { name: "delete_reminder", arguments: firstTarget });
    assert.equal(staleDelete.result.structuredContent.error.code, "CONFLICT");
    const reopenTarget = lifecycleTarget();
    const reopenReply = await mcp("tools/call", { name: "reopen_reminder", arguments: reopenTarget });
    assert.equal(reopenReply.result.structuredContent.record.completed, false);
    assert.equal(reopenReply.result.structuredContent.record.completedDate, null);
    await repeatLifecycle("reopen_reminder", reopenTarget);
    await mcp("tools/call", { name: "complete_reminder", arguments: lifecycleTarget() });
    const deleteTarget = lifecycleTarget();
    const deleteReply = await mcp("tools/call", { name: "delete_reminder", arguments: deleteTarget });
    assert.equal(deleteReply.result.structuredContent.record.deleted, true);
    assert.equal(deleteReply.result.structuredContent.record.completed, true);
    await repeatLifecycle("delete_reminder", deleteTarget);
    const deletedLookup = await mcp("tools/call", { name: "get_reminder", arguments: { listId, reminderId: lifecycleId } });
    assert.equal(deletedLookup.result.structuredContent.record.deleted, true);
    const missingLookup = await mcp("tools/call", { name: "get_reminder", arguments: { listId, reminderId: "Reminder/READ-MISSING" } });
    assert.deepEqual(missingLookup.result.structuredContent, { generation, record: null, missing: true });
    state.records.set("List/READ-OTHER", { ...listRecord(), recordName: "List/READ-OTHER" });
    const wrongList = await mcp("tools/call", { name: "get_reminder", arguments: { listId: "List/READ-OTHER", reminderId: lifecycleId } });
    assert.equal(wrongList.result.structuredContent.error.code, "FORBIDDEN");
    state.records.delete("List/READ-OTHER");
    assert.deepEqual(state.modifies.at(-1).fields, ["Deleted", "LastModifiedDate", "ResolutionTokenMap"]);
    assert.equal(state.modifies.at(-1).operationType, "update");
    const beforeLifecycleRefusal = state.modifies.length;
    for (const id of ["Reminder/WRITE-RECURRING", "Reminder/WRITE-ALARMED"]) {
      const refused = await mcp("tools/call", { name: "complete_reminder", arguments: { listId, reminderId: id, recordChangeTag: state.records.get(id).recordChangeTag } });
      assert.equal(refused.result.structuredContent.error.code, "UNSUPPORTED_FEATURE");
    }
    const child = reminderRecord("Reminder/WRITE-SUBTASK");
    child.fields.ParentReminder = field("REFERENCE", { recordName: reminderId, action: "VALIDATE" });
    state.records.set(child.recordName, child);
    const nestedRefused = await mcp("tools/call", { name: "delete_reminder", arguments: { listId, reminderId: child.recordName, recordChangeTag: child.recordChangeTag } });
    assert.equal(nestedRefused.result.structuredContent.error.code, "UNSUPPORTED_FEATURE");
    state.records.delete(child.recordName);
    assert.equal(state.modifies.length, beforeLifecycleRefusal);

    // Exact IDs survive uncertain 5xx and network failures; retry safely reconciles the committed record.
    for (const [key, mode] of [["9de431a5-27a6-4b40-a23b-7a76a1dcae7d", "committed-500"], ["bb3d717e-1712-4ea2-baa5-8f5728b34f96", "committed-network-drop"]]) {
      const args = { action: "create", listId, idempotencyKey: key, title: `Uncertain ${mode}`, expectedGeneration: generation };
      const before = state.modifies.length;
      state.nextModify = mode;
      const uncertainResponse = await request("/api/mutations", { method: "POST", body: args });
      const uncertain = await uncertainResponse.json();
      assert.equal(uncertainResponse.status, 503, JSON.stringify(uncertain));
      assert.equal(uncertain.error.code, "WRITE_OUTCOME_UNKNOWN");
      assert.equal(uncertain.error.retryable, false);
      assert.equal(uncertain.error.reminderId, `Reminder/${key.toUpperCase()}`);
      assert.equal(uncertain.error.idempotencyKey, key);
      assert.equal(state.modifies.length, before + 1);
      const reconciledResponse = await request("/api/mutations", { method: "POST", body: args });
      const reconciled = await reconciledResponse.json();
      assert.equal(reconciledResponse.status, 200, JSON.stringify(reconciled));
      assert.equal(reconciled.replayed, true);
      assert.equal(state.modifies.length, before + 1);
    }

    // A 307 response is never followed or replayed for a POST modify.
    const redirectKey = "d92b886c-0f7a-4b48-b497-4fc88a97a2e4";
    state.nextModify = "redirect-307";
    const beforeRedirect = state.modifies.length;
    const redirectResponse = await request("/api/mutations", { method: "POST", body: { action: "create", listId, idempotencyKey: redirectKey, title: "No redirect replay", expectedGeneration: generation } });
    const redirectResult = await redirectResponse.json();
    assert.equal(redirectResponse.status, 503);
    assert.equal(redirectResult.error.code, "WRITE_OUTCOME_UNKNOWN");
    assert.equal(state.modifies.length, beforeRedirect + 1);
    assert.equal(state.requests.filter(request => request.path.endsWith("/records/modify")).length, beforeRedirect + 1);

    // Disconnect during preflight invalidates the lease before the write is dispatched.
    const preflightKey = "1cdf7593-e38e-4b34-a01d-7962fc67d237";
    let lookupReached;
    let releaseLookup;
    const lookupReady = new Promise(resolve => { lookupReached = resolve; });
    const lookupRelease = new Promise(resolve => { releaseLookup = resolve; });
    state.holdLookup = { reached: lookupReached, releasePromise: lookupRelease };
    const beforePreflightDisconnect = state.modifies.length;
    const preflightRequest = request("/api/mutations", { method: "POST", body: { action: "create", listId, idempotencyKey: preflightKey, title: "Disconnect in preflight", expectedGeneration: generation } });
    await lookupReady;
    const disconnectDuringLookup = await request("/api/auth/disconnect", { method: "POST", body: {} });
    assert.equal(disconnectDuringLookup.status, 200);
    releaseLookup();
    const preflightResponse = await preflightRequest;
    assert.equal(preflightResponse.status, 409);
    assert.equal(state.modifies.length, beforePreflightDisconnect);

    // Restore the same synthetic session at the new generation, then disconnect after modify dispatch.
    generation = await workerHarness.seedReady();
    const duringModifyKey = "08b44b21-e311-4ef1-bb51-17fa343d0b6f";
    let modifyReached;
    let releaseModify;
    const modifyReady = new Promise(resolve => { modifyReached = resolve; });
    const modifyRelease = new Promise(resolve => { releaseModify = resolve; });
    state.holdModify = { reached: modifyReached, releasePromise: modifyRelease };
    const beforeModifyDisconnect = state.modifies.length;
    const modifyRequest = request("/api/mutations", { method: "POST", body: { action: "create", listId, idempotencyKey: duringModifyKey, title: "Disconnect during Apple modify", expectedGeneration: generation } });
    await modifyReady;
    const disconnectDuringModify = await request("/api/auth/disconnect", { method: "POST", body: {} });
    assert.equal(disconnectDuringModify.status, 200);
    releaseModify();
    const modifyResponse = await modifyRequest;
    const modifyResult = await modifyResponse.json();
    assert.equal(modifyResponse.status, 503, JSON.stringify(modifyResult));
    assert.equal(modifyResult.error.code, "WRITE_OUTCOME_UNKNOWN");
    assert.equal(modifyResult.error.idempotencyKey, duringModifyKey);
    assert.equal(state.modifies.length, beforeModifyDisconnect + 1);

    // Exercise the operator's one-item live-test procedure through the real MCP boundary.
    generation = await workerHarness.seedReady();
    const invoke = async (name, args) => {
      const reply = await mcp("tools/call", { name, arguments: args });
      if (reply.result.isError) throw Object.assign(new Error("Synthetic MCP tool rejected the operation."), { code: reply.result.structuredContent.error.code });
      return reply.result.structuredContent;
    };
    const testKey = randomUUID();
    const beforeControlledTest = state.modifies.length;
    const controlled = await runControlledWriteChecks(invoke, { listId, generation, idempotencyKey: testKey });
    assert.equal(controlled.reminderId, `Reminder/${testKey.toUpperCase()}`);
    assert.equal(state.modifies.length, beforeControlledTest + 2, "Replay and stale-tag checks must not produce extra modifications.");
    assert.equal(state.records.get(controlled.reminderId).fields.Priority.value, 5);
    assert.equal(state.records.get(controlled.reminderId).fields.Flagged.value, 1);
    const lifecycle = await runControlledLifecycleChecks(invoke, { listId, generation, idempotencyKey: testKey });
    assert.equal(lifecycle.deleted, true);
    assert.equal(state.modifies.length, beforeControlledTest + 5);
    assert.equal(state.records.get(controlled.reminderId).fields.Deleted.value, 1);

    // An uncertain completion must stop the operator procedure before reopen/delete.
    const lifecycleUncertainKey = randomUUID();
    await runControlledWriteChecks(invoke, { listId, generation, idempotencyKey: lifecycleUncertainKey });
    state.nextModify = "committed-network-drop";
    const beforeUncertainCompletion = state.modifies.length;
    await assert.rejects(runControlledLifecycleChecks(invoke, { listId, generation, idempotencyKey: lifecycleUncertainKey }), error => error.code === "WRITE_OUTCOME_UNKNOWN");
    assert.equal(state.modifies.length, beforeUncertainCompletion + 1);
    const uncertainId = `Reminder/${lifecycleUncertainKey.toUpperCase()}`;
    const submittedCompletion = state.modifies.at(-1);
    const uncertainRepeat = await mcp("tools/call", { name: "complete_reminder", arguments: { listId, reminderId: uncertainId, recordChangeTag: submittedCompletion.recordChangeTag, expectedGeneration: generation } });
    assert.equal(uncertainRepeat.result.structuredContent.error.code, "CONFLICT");
    assert.equal(state.modifies.length, beforeUncertainCompletion + 1, "A committed but unconfirmed completion cannot be submitted twice.");

    const uncertainKey = randomUUID();
    state.nextModify = "committed-network-drop";
    const beforeUncertainTest = state.modifies.length;
    await assert.rejects(runControlledWriteChecks(invoke, { listId, generation, idempotencyKey: uncertainKey }), error => error.code === "WRITE_OUTCOME_UNKNOWN");
    assert.equal(state.modifies.length, beforeUncertainTest + 1, "An uncertain creation must stop before replay or edit.");

    // Prepared updates bind the entire request and graph, without weakening linked guards.
    const prepareArgs = { listId, reminderId, recordChangeTag: state.records.get(reminderId).recordChangeTag, expectedGeneration: generation, changes: { title: "Prepared synthetic edit" } };
    const beforePreparation = state.modifies.length;
    const prepared = await invoke("prepare_reminder_update", prepareArgs);
    assert.equal(prepared.supported, true);
    assert.ok(prepared.preparationToken);
    assert.equal(state.modifies.length, beforePreparation);
    const forgedPreparation = await mcp("tools/call", { name: "update_reminder", arguments: { ...prepareArgs, changes: { title: "Different request" }, preparationToken: prepared.preparationToken } });
    assert.equal(forgedPreparation.result.structuredContent.error.code, "CONFLICT");
    assert.equal(state.modifies.length, beforePreparation);
    await invoke("update_reminder", { ...prepareArgs, preparationToken: prepared.preparationToken });
    assert.equal(state.modifies.length, beforePreparation + 1);
    state.records.set("RecurrenceRule/WRITE-RECURRING", { recordName: "RecurrenceRule/WRITE-RECURRING", recordType: "RecurrenceRule", recordChangeTag: "rule-1", zoneID: { zoneName: "Reminders", ownerRecordName: zoneOwner }, fields: {} });
    const linkedPreview = await invoke("prepare_reminder_update", { listId, reminderId: "Reminder/WRITE-RECURRING", recordChangeTag: "tag-Reminder/WRITE-RECURRING", expectedGeneration: generation, changes: { dueDate: "2030-04-01T09:00:00Z" } });
    assert.equal(linkedPreview.supported, false); assert.equal(linkedPreview.preparationToken, null);
    assert.equal(state.modifies.length, beforePreparation + 1);
    state.nextModify = "changed-resolution-tokens";
    const tokenMismatch = await mcp("tools/call", { name: "update_reminder", arguments: { listId, reminderId, recordChangeTag: state.records.get(reminderId).recordChangeTag, changes: { title: "Unconfirmed token change" }, expectedGeneration: generation } });
    assert.equal(tokenMismatch.result.structuredContent.error.code, "WRITE_OUTCOME_UNKNOWN");

    // Native D1 ledger and real MCP schemas exercise simple request-driven jobs.
    const jobKey = randomUUID();
    const job = await invoke("create_reminder_job", { kind: "bulk_create", idempotencyKey: jobKey, expectedGeneration: generation });
    assert.equal(job.jobId, jobKey);
    assert.equal((await invoke("create_reminder_job", { kind: "bulk_create", idempotencyKey: jobKey, expectedGeneration: generation })).jobId, job.jobId);
    const jobItems = [0, 1, 2, 3].map(index => ({ kind: "bulk_create", clientItemKey: `ordered-${index}`, input: { listId, idempotencyKey: randomUUID(), title: "Equal titles are distinct", notes: `Synthetic job ${index}` } }));
    const appendArgs = { jobId: job.jobId, chunkKey: randomUUID(), expectedRevision: job.revision, items: jobItems };
    const appended = await invoke("append_reminder_job_items", appendArgs);
    assert.equal((await invoke("append_reminder_job_items", appendArgs)).revision, appended.revision);
    const beforeJob = state.modifies.length;
    const preview = await invoke("preview_reminder_job", { jobId: job.jobId, expectedRevision: appended.revision });
    assert.equal(preview.counts.total, 4);
    const started = await invoke("start_reminder_job", { jobId: job.jobId, previewToken: preview.previewToken });
    assert.equal(started.executionMode, "request-driven"); assert.equal(started.state, "queued");
    assert.equal(state.modifies.length, beforeJob);
    const readOnlyStatus = await request(`/api/reminder-jobs/${job.jobId}?limit=2`);
    assert.equal(readOnlyStatus.status, 200);
    assert.equal((await readOnlyStatus.json()).results.length, 2);
    assert.equal(state.modifies.length, beforeJob);
    assert.equal((await request(`/api/reminder-jobs/${job.jobId}`, { user: "different-owner" })).status, 403);
    assert.equal((await request(`/api/reminder-jobs/${job.jobId}/continue`, { method: "POST", body: {}, requestOrigin: "https://evil.example" })).status, 403);
    const firstSlice = await invoke("continue_reminder_job", { jobId: job.jobId });
    assert.equal(firstSlice.counts.succeeded, 3); assert.equal(firstSlice.counts.pending, 1);
    const secondSlice = await invoke("continue_reminder_job", { jobId: job.jobId });
    assert.equal(secondSlice.state, "completed");
    assert.deepEqual(secondSlice.results.map(item => item.clientItemKey), ["ordered-0", "ordered-1", "ordered-2", "ordered-3"]);
    await invoke("continue_reminder_job", { jobId: job.jobId });
    assert.equal(state.modifies.length, beforeJob + 4);
    const ledger = await workerHarness.db.prepare("SELECT input_envelope, mutation_envelope, result_envelope FROM reminder_job_items WHERE job_id = ?").bind(job.jobId).all();
    assert.ok(!JSON.stringify(ledger.results).includes("Synthetic job"));
    assert.ok(!JSON.stringify(ledger.results).includes(listId));

    const uncertainJob = await invoke("create_reminder_job", { kind: "bulk_create", idempotencyKey: randomUUID(), expectedGeneration: generation });
    const uncertainAppend = await invoke("append_reminder_job_items", { jobId: uncertainJob.jobId, chunkKey: randomUUID(), expectedRevision: 0, items: [{ ...jobItems[0], input: { ...jobItems[0].input, idempotencyKey: randomUUID() } }] });
    const uncertainPreview = await invoke("preview_reminder_job", { jobId: uncertainJob.jobId, expectedRevision: uncertainAppend.revision });
    await invoke("start_reminder_job", { jobId: uncertainJob.jobId, previewToken: uncertainPreview.previewToken });
    state.nextModify = "committed-500";
    const beforeUnknownJob = state.modifies.length;
    assert.equal((await invoke("continue_reminder_job", { jobId: uncertainJob.jobId })).counts.unknown, 1);
    const observedJob = await invoke("continue_reminder_job", { jobId: uncertainJob.jobId });
    assert.equal(observedJob.counts.unknown, 1);
    assert.equal(observedJob.results[0].result.desiredStateObserved, true);
    assert.equal(observedJob.results[0].result.operationConfirmed, false);
    assert.equal(state.modifies.length, beforeUnknownJob + 1);
    const cancelledJob = await invoke("create_reminder_job", { kind: "bulk_create", idempotencyKey: randomUUID(), expectedGeneration: generation });
    const cancelled = await invoke("cancel_reminder_job", { jobId: cancelledJob.jobId });
    assert.equal(cancelled.state, "cancelled");

    // Expired device assurance is rejected before any Apple request, even when row state says READY.
    generation = await workerHarness.seedReady(true);
    const beforeExpired = state.requests.length;
    const expiredResponse = await request("/api/mutations", { method: "POST", body: { action: "create", listId, idempotencyKey: "6734def8-8505-47ab-8145-0f41020d77e4", title: "Expired session", expectedGeneration: generation } });
    assert.equal(expiredResponse.status, 409);
    assert.equal((await expiredResponse.json()).error.code, "AUTH_EXPIRED");
    assert.equal(state.requests.length, beforeExpired);

    const hostedAtomic = await request("/api/reminder-evidence/atomic-protection", { method: "POST", body: {} });
    assert.equal(hostedAtomic.status, 403);
    assert.equal(state.requests.length, beforeExpired);
    const atomicHarness = await makeWorker({ localEvidence: true });
    try {
      const atomicGeneration = await atomicHarness.seedReady();
      const caseId = "6efe966a-e90a-4126-b0e3-c0e43902d7cd", id = `Reminder/${caseId.toUpperCase()}`;
      const triggerUuid = "3E33D4CB-5E6A-432E-8F80-96B0A8F4E2E7";
      const alarmId = "Alarm/ATOMIC", ruleId = "RecurrenceRule/ATOMIC", triggerId = `AlarmTrigger/${triggerUuid}`;
      const atomicRoot = reminderRecord(id);
      atomicRoot.fields.TitleDocument = field("STRING", encodeDocument(`MCP protocol ${caseId}`));
      atomicRoot.fields.AlarmIDs = field("STRING_LIST", [alarmId]);
      atomicRoot.fields.RecurrenceRuleIDs = field("STRING_LIST", [ruleId]);
      const child = (recordName, recordType, fields) => ({
        recordName, recordType, recordChangeTag: `initial-${recordType}`, zoneID: atomicRoot.zoneID,
        fields: { Deleted: field("INT64", 0), UnknownSchedulingData: field("STRING", "keep"), ...fields },
      });
      const atomicRecords = [atomicRoot,
        child(alarmId, "Alarm", { Reminder: field("REFERENCE", { recordName: id }), TriggerID: field("STRING", triggerUuid) }),
        child(triggerId, "AlarmTrigger", { Alarm: field("REFERENCE", { recordName: alarmId }), Type: field("STRING", "Date") }),
        child(ruleId, "RecurrenceRule", { Reminder: field("REFERENCE", { recordName: id }), Frequency: field("INT64", 1) }),
      ];
      for (const record of atomicRecords) atomicHarness.state.records.set(record.recordName, record);
      const input = { caseId, listId, reminderId: id, expectedGeneration: atomicGeneration, dependencyType: "Alarm", confirmVersionGuardWrites: true };
      const requestAtomic = body => atomicHarness.request("/api/reminder-evidence/atomic-protection", { method: "POST", body });
      const unconfirmed = { ...input };
      delete unconfirmed.confirmVersionGuardWrites;
      assert.equal((await requestAtomic(unconfirmed)).status, 400);
      assert.equal((await atomicHarness.request("/api/reminder-evidence/atomic-protection", { method: "POST", body: input, user: "another-owner" })).status, 403);
      assert.equal((await atomicHarness.request("/api/reminder-evidence/atomic-protection", { method: "POST", body: input, requestOrigin: "https://evil.example" })).status, 403);
      assert.equal(atomicHarness.state.requests.length, 0);
      const beforeStatus = await (await atomicHarness.request("/api/connection")).json();
      for (const dependencyType of ["Alarm", "AlarmTrigger", "RecurrenceRule"]) {
        const response = await requestAtomic({ ...input, dependencyType });
        const report = await response.json();
        assert.equal(response.status, 200, JSON.stringify(report));
        assert.equal(report.validGuardAccepted, true);
        assert.equal(report.staleGuardRejected, true);
        assert.equal(report.groupFieldsAndVersionsUnchangedAfterRejection, true);
        assert.equal(report.schedulingFieldsRewritten, false);
        assert.equal(report.writableRecipeApproved, false);
        assert.equal(report.linkedSchedulingEnabled, true);
        for (const record of atomicRecords) assert.deepEqual(atomicHarness.state.records.get(record.recordName).fields, record.fields);
      }
      assert.equal(atomicHarness.state.modifies.length, 6);
      const afterStatus = await (await atomicHarness.request("/api/connection")).json();
      assert.equal(afterStatus.generation, beforeStatus.generation);
      assert.equal(afterStatus.expiresAt, beforeStatus.expiresAt);
      assert.equal(afterStatus.capabilities.linkedScheduling, true);
    } finally { await atomicHarness.worker.dispose(); }

    const subtaskHarness = await makeWorker();
    try {
      const subtaskGeneration = await subtaskHarness.seedReady(), state = subtaskHarness.state;
      const invokeSubtask = async (name, args) => {
        const reply = await subtaskHarness.mcp("tools/call", { name, arguments: { expectedGeneration: subtaskGeneration, ...args } });
        assert.equal(reply.result.isError, undefined, JSON.stringify(reply.result));
        return reply.result.structuredContent;
      };
      await subtaskHarness.mcp("tools/list", {});
      const beforeStatus = await (await subtaskHarness.request("/api/connection")).json();
      assert.equal(beforeStatus.capabilities.subtasks, true);
      const firstParent = "Reminder/SUBTASK-PARENT", secondParent = "Reminder/SUBTASK-OTHER";
      for (const id of [firstParent, secondParent]) {
        const root = reminderRecord(id);
        root.fields.DueDate = field("TIMESTAMP", null); root.fields.TimeZone = field("STRING", null);
        state.records.set(id, root);
      }
      const parentTarget = id => ({ reminderId: id, recordChangeTag: state.records.get(id).recordChangeTag });
      const input = { listId, idempotencyKey: randomUUID(), title: "Synthetic subtask", notes: "Child notes", parentReminder: parentTarget(firstParent) };
      const parentFields = structuredClone(state.records.get(firstParent).fields);
      const created = await invokeSubtask("create_subtask", input), childId = created.record.id;
      assert.equal(created.record.parentReminderId, firstParent); assert.equal(created.record.listId, listId);
      assert.equal(state.modifies.length, 1); assert.equal(state.modifies[0].operationCount, 2);
      assert.deepEqual(state.records.get(firstParent).fields, parentFields);
      assert.equal((await invokeSubtask("create_subtask", input)).replayed, true);
      assert.equal(state.modifies.length, 1);
      const conflictingReplay = await subtaskHarness.mcp("tools/call", { name: "create_subtask", arguments: { ...input, parentReminder: parentTarget(secondParent) } });
      assert.equal(conflictingReplay.result.structuredContent.error.code, "CONFLICT");
      const staleParent = await subtaskHarness.mcp("tools/call", { name: "create_subtask", arguments: { ...input, idempotencyKey: randomUUID() } });
      assert.equal(staleParent.result.structuredContent.error.code, "CONFLICT");
      assert.equal(state.modifies.length, 1);
      for (const action of ["complete", "reopen", "delete"]) {
        const before = state.modifies.length;
        const reply = await subtaskHarness.mcp("tools/call", { name: `${action}_reminder`, arguments: { listId, ...parentTarget(firstParent) } });
        assert.ok(["UNSUPPORTED_FEATURE", "CONFLICT"].includes(reply.result.structuredContent.error.code));
        assert.equal(state.modifies.length, before);
      }
      const beforeMove = structuredClone(state.records.get(childId).fields);
      const move = { listId, ...parentTarget(childId), parentReminder: parentTarget(secondParent) };
      const moved = await invokeSubtask("set_reminder_parent", move);
      assert.equal(moved.record.parentReminderId, secondParent);
      assert.equal(state.modifies.at(-1).operationCount, 3);
      for (const [key, value] of Object.entries(beforeMove)) if (!["ParentReminder", "ResolutionTokenMap", "LastModifiedDate"].includes(key)) {
        assert.deepEqual(state.records.get(childId).fields[key], value);
      }
      const replayMove = await subtaskHarness.mcp("tools/call", { name: "set_reminder_parent", arguments: move });
      assert.equal(replayMove.result.structuredContent.error.code, "CONFLICT");
      const detached = await invokeSubtask("set_reminder_parent", { listId, ...parentTarget(childId), parentReminder: null });
      assert.equal(detached.record.parentReminderId, null);
      assert.equal(state.modifies.at(-1).operationCount, 2);
      state.nextModify = "parent-race";
      const beforeRace = structuredClone(state.records.get(childId));
      const raced = await subtaskHarness.mcp("tools/call", { name: "set_reminder_parent", arguments: { listId, ...parentTarget(childId), parentReminder: parentTarget(firstParent) } });
      assert.equal(raced.result.structuredContent.error.code, "CONFLICT");
      assert.deepEqual(state.records.get(childId), beforeRace);
      for (const failure of ["committed-500", "missing-parent-confirmation"]) {
        state.nextModify = failure;
        const unknownInput = { ...input, idempotencyKey: randomUUID(), parentReminder: parentTarget(firstParent) };
        const count = state.modifies.length;
        const unknown = await subtaskHarness.mcp("tools/call", { name: "create_subtask", arguments: unknownInput });
        assert.equal(unknown.result.structuredContent.error.code, "WRITE_OUTCOME_UNKNOWN");
        assert.equal(state.modifies.length, count + 1, "Uncertain relationship writes must not automatically retry.");
        assert.equal((await invokeSubtask("create_subtask", unknownInput)).replayed, true);
        assert.equal(state.modifies.length, count + 1);
      }
      const apiReply = await subtaskHarness.request("/api/mutations", { method: "POST", body: { action: "set_parent", listId, ...parentTarget(childId),
        parentReminder: parentTarget(secondParent), expectedGeneration: subtaskGeneration } });
      assert.equal(apiReply.status, 200, await apiReply.clone().text());
      assert.equal((await apiReply.json()).record.parentReminderId, secondParent);
      const afterStatus = await (await subtaskHarness.request("/api/connection")).json();
      assert.equal(afterStatus.generation, beforeStatus.generation); assert.equal(afterStatus.expiresAt, beforeStatus.expiresAt);
      assert.equal(afterStatus.capabilities.bulkDelete, true); assert.equal(afterStatus.capabilities.linkedScheduling, true);
    } finally { await subtaskHarness.worker.dispose(); }

    const dateHarness = await makeWorker();
    try {
      const dateGeneration = await dateHarness.seedReady(), state = dateHarness.state;
      await dateHarness.mcp("tools/list", {});
      const rootId = "Reminder/LINKED-DATE";
      const alarmId = "Alarm/00000000-0000-4000-8000-000000000002";
      const triggerId = "AlarmTrigger/00000000-0000-4000-8000-000000000003", ruleId = "RecurrenceRule/LINKED-DATE";
      const root = reminderRecord(rootId);
      root.fields.AlarmIDs = field("STRING_LIST", [alarmId.slice(6)]);
      root.fields.RecurrenceRuleIDs = field("STRING_LIST", [ruleId.slice(15)]);
      root.fields.ResolutionTokenMap = field("STRING", JSON.stringify({ map: {
        dueDate: { counter: 5, modificationTime: 1_000_000_000, replicaID: "00000000-0000-4000-8000-000000000001" },
      } }));
      const linkedRecord = (recordName, recordType, fields) => ({ recordName, recordType, recordChangeTag: `initial-${recordType}`,
        zoneID: root.zoneID, fields: { Deleted: field("INT64", 0), ...fields } });
      const reference = recordName => field("REFERENCE", { recordName, action: "VALIDATE" });
      const alarm = linkedRecord(alarmId, "Alarm", { AlarmUID: field("STRING", alarmId.slice(6)),
        TriggerID: field("STRING", triggerId.slice(13)), Reminder: reference(rootId),
        DueDateResolutionTokenAsNonce: field("DOUBLE", dueDateNonce(root.fields.ResolutionTokenMap.value)) });
      const trigger = linkedRecord(triggerId, "AlarmTrigger", { Alarm: reference(alarmId), Type: field("STRING", "Date"),
        DateComponentsData: field("BYTES", Buffer.from(JSON.stringify(dateComponents("2030-03-04T09:15:00Z", "Europe/London"))).toString("base64")) });
      const rule = linkedRecord(ruleId, "RecurrenceRule", { Reminder: reference(rootId), Frequency: field("INT64", 1), Interval: field("INT64", 1),
        OccurrenceCount: field("INT64", 0), FirstDayOfTheWeek: field("INT64", 0), Imported: field("INT64", 0) });
      for (const record of [root, alarm, trigger, rule]) state.records.set(record.recordName, record);
      const history = reminderRecord("Reminder/LINKED-HISTORY"); history.fields.Completed = field("INT64", 1);
      state.records.set(history.recordName, history);
      const invokeDate = async (name, args) => {
        const reply = await dateHarness.mcp("tools/call", { name, arguments: { expectedGeneration: dateGeneration, ...args } });
        assert.equal(reply.result.isError, undefined, JSON.stringify(reply.result));
        return reply.result.structuredContent;
      };
      const request = { listId, reminderId: rootId, recordChangeTag: root.recordChangeTag, changes: { dueDate: "2030-07-04T09:15:00+01:00" } };
      let preview = await invokeDate("prepare_reminder_update", request);
      assert.equal(preview.supported, true); assert.equal(preview.classification, "linked-date");
      assert.equal(preview.operationCount, 4); assert.equal(preview.linkedFeatures.graphComplete, true);
      assert.equal(state.modifies.length, 0);
      state.records.get(ruleId).recordChangeTag = "recurrence-changed-after-preview";
      const changedGraph = await dateHarness.mcp("tools/call", { name: "update_reminder", arguments: { ...request, preparationToken: preview.preparationToken } });
      assert.equal(changedGraph.result.structuredContent.error.code, "CONFLICT"); assert.equal(state.modifies.length, 0);
      preview = await invokeDate("prepare_reminder_update", request);
      const changedRequest = await dateHarness.mcp("tools/call", { name: "update_reminder", arguments: { ...request,
        changes: { dueDate: "2030-07-05T09:15:00+01:00" }, preparationToken: preview.preparationToken } });
      assert.equal(changedRequest.result.structuredContent.error.code, "CONFLICT"); assert.equal(state.modifies.length, 0);
      const result = await invokeDate("update_reminder", { ...request, preparationToken: preview.preparationToken });
      assert.equal(result.record.dueDate, "2030-07-04T08:15:00.000Z"); assert.equal(state.modifies.length, 1);
      assert.deepEqual(result.record.alarmIds, [alarmId]);
      assert.deepEqual(state.records.get(ruleId).fields, rule.fields);
      assert.deepEqual(state.records.get(history.recordName), history);
      const stale = await dateHarness.mcp("tools/call", { name: "update_reminder", arguments: request });
      assert.equal(stale.result.structuredContent.error.code, "CONFLICT"); assert.equal(state.modifies.length, 1);
      state.nextModify = "date-dependency-race";
      const beforeRace = structuredClone(state.records.get(rootId));
      const raced = await dateHarness.mcp("tools/call", { name: "update_reminder", arguments: { ...request, recordChangeTag: beforeRace.recordChangeTag,
        changes: { dueDate: "2030-07-06T09:15:00+01:00" } } });
      assert.equal(raced.result.structuredContent.error.code, "CONFLICT"); assert.deepEqual(state.records.get(rootId), beforeRace);
      state.nextModify = "committed-500";
      const beforeUnknown = state.modifies.length;
      const unknown = await dateHarness.mcp("tools/call", { name: "update_reminder", arguments: { ...request, recordChangeTag: beforeRace.recordChangeTag,
        changes: { dueDate: "2030-07-07T09:15:00+01:00" } } });
      assert.equal(unknown.result.structuredContent.error.code, "WRITE_OUTCOME_UNKNOWN"); assert.equal(state.modifies.length, beforeUnknown + 1);
      let after = await invokeDate("get_reminder", { listId, reminderId: rootId });
      assert.equal(after.record.dueDate, "2030-07-07T08:15:00.000Z");
      assert.deepEqual(state.records.get(history.recordName), history);
      for (const [action, day] of [["date-missing-confirmation", 8], ["date-changed-confirmation", 9]]) {
        state.nextModify = action;
        const beforeCalls = state.modifies.length;
        const refused = await dateHarness.mcp("tools/call", { name: "update_reminder", arguments: { ...request,
          recordChangeTag: after.record.recordChangeTag, changes: { dueDate: `2030-07-${String(day).padStart(2, "0")}T09:15:00+01:00` } } });
        assert.equal(refused.result.structuredContent.error.code, "WRITE_OUTCOME_UNKNOWN"); assert.equal(state.modifies.length, beforeCalls + 1);
        after = await invokeDate("get_reminder", { listId, reminderId: rootId });
        assert.equal(after.record.dueDate, `2030-07-${String(day).padStart(2, "0")}T08:15:00.000Z`);
        assert.deepEqual(state.records.get(history.recordName), history);
      }
      const dueToken = JSON.parse(state.records.get(rootId).fields.ResolutionTokenMap.value).map.dueDate;
      const zoneChange = await dateHarness.request("/api/mutations", { method: "POST", body: { action: "update", expectedGeneration: dateGeneration,
        listId, reminderId: rootId, recordChangeTag: after.record.recordChangeTag, changes: { timeZone: "America/New_York" } } });
      assert.equal(zoneChange.status, 200);
      const zoneResult = await zoneChange.json();
      assert.equal(zoneResult.record.dueDate, after.record.dueDate); assert.equal(zoneResult.record.timeZone, "America/New_York");
      assert.deepEqual(JSON.parse(state.records.get(rootId).fields.ResolutionTokenMap.value).map.dueDate, dueToken);
      assert.equal(JSON.parse(Buffer.from(state.records.get(triggerId).fields.DateComponentsData.value, "base64")).hour, 4);
      assert.deepEqual(state.records.get(history.recordName), history);
      state.records.get(alarmId).fields.TriggerID = field("STRING", "opaque-unsupported-identity");
      const beforeText = state.modifies.length;
      const textEdit = await invokeDate("update_reminder", { listId, reminderId: rootId, recordChangeTag: zoneResult.record.recordChangeTag,
        changes: { title: "Date unchanged while editing text", dueDate: zoneResult.record.dueDate, timeZone: zoneResult.record.timeZone } });
      assert.equal(textEdit.record.title, "Date unchanged while editing text"); assert.equal(state.modifies.length, beforeText + 1);
      assert.ok(state.modifies.at(-1).fields.every(key => !["DueDate", "TimeZone", "AllDay"].includes(key)));
    } finally { await dateHarness.worker.dispose(); }

    return { checks: [
      "login-owner-origin-denial-before-state-or-Apple-access",
      "MCP-discovery-annotations-Unicode-create-and-idempotent-reconciliation",
      "API-title-edit-preserves-notes-and-opaque-Apple-fields",
      "stale-generation-tag-and-Apple-conflict-have-no-force-retry",
      "complete-reopen-and-version-checked-soft-delete-preserve-content",
      "all-mutations-require-READY-with-no-separate-write-flag",
      "advertised-output-contracts-parameter-guidance-and-JSON-status-fallback",
      "identical-versioned-mutation-replays-have-no-additional-effect",
      "recurrence-alarms-and-nested-state-writes-refused",
      "committed-5xx-and-network-drop-return-unknown-and-reconcile",
      "307-modify-response-never-follows-or-replays",
      "disconnect-fences-preflight-and-modify-confirmation",
      "one-item-local-acceptance-procedure-and-uncertain-outcome-stop",
      "prepared-update-request-and-graph-binding-retains-linked-guard",
      "native-D1-job-ledger-encrypted-input-mutation-and-receipts",
      "bounded-request-driven-job-order-and-read-only-status",
      "lost-job-ack-observation-is-not-an-operation-receipt",
      "job-API-owner-and-origin-denial",
      "expired-session-rejected-before-Apple-access",
      "local-only-explicitly-confirmed-atomic-guard-experiment",
      "Alarm-AlarmTrigger-RecurrenceRule-stale-guards-reject-complete-group",
      "atomic-guard-fields-session-deadline-and-ready-linked-capability-preserved",
      "permanent-subtask-create-replay-reparent-detach-and-API-output-contracts",
      "subtask-parent-version-race-and-unknown-confirmations-never-retried",
      "observed-parents-refuse-noncascading-lifecycle-writes",
      "permanent-linked-date-preview-atomic-update-stale-dependency-and-unknown-no-retry",
      "API-linked-zone-change-preserves-instant-and-token-and-unrelated-text-edits",
    ] };
  } finally {
    if (workerHarness) await workerHarness.worker.dispose();
  }
}
