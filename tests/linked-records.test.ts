import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadSchedulingGraph } from "../src/reminders/linked-records.ts";
import { planReminderUpdate } from "../src/reminders/mutation-plan.ts";
import { AppError } from "../src/errors.ts";
import { CloudKitRemindersClient, type CloudKitRecord, type CloudKitLookupResult } from "../src/icloud/cloudkit.ts";
import { AppleHTTP } from "../src/transport/apple-http.ts";
import { CookieJar } from "../src/transport/cookie-jar.ts";
import { buildCreateReminder, buildUpdateReminder, CreateReminderInput, type CloudKitWriteRecord } from "../src/reminders/writes.ts";
import { createPreparation, checkPreparation, preparationContext } from "../src/reminders/preparation.ts";
import { b64 } from "../src/crypto/bytes.ts";
import { SchedulePolicy } from "../src/reminders/schedule-policy.ts";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/linked-records.json", import.meta.url), "utf8"));
const records: CloudKitRecord[] = fixture.records.map((record: Omit<CloudKitRecord, "raw">) => ({ ...record, raw: {} }));
const owner = fixture.zoneOwner as string;
const found = (values: CloudKitRecord[]): CloudKitLookupResult => ({ records: values, requestedRecordNames: values.map(record => record.recordName), recordErrors: [], unresolvedRecordNames: [], complete: true });
const hasCode = (code: string) => (error: unknown) => error instanceof AppError && error.code === code;

test("unverified recurrence stays blocked, graph versions are fingerprinted, and unknown scheduling fields are never rewritten", async () => {
  const graph = await loadSchedulingGraph(records[0], owner, async () => found([records[1]]));
  assert.equal(graph.complete, true, "Explicit dependency resolution does not imply a supported write recipe.");
  const input = { listId: "List/SYNTHETIC", reminderId: records[0].recordName, recordChangeTag: records[0].recordChangeTag!, changes: fixture.requestedChange };
  const plan = planReminderUpdate(graph, input, owner, 1_800_000_000_000);
  assert.equal(plan.supported, false); assert.equal(plan.operationCount, 0); assert.equal(plan.write, null);
  const changed = await loadSchedulingGraph(records[0], owner, async () => found([{ ...records[1], recordChangeTag: "changed-version" }]));
  assert.notEqual(graph.fingerprint, changed.fingerprint);
  assert.deepEqual(records[1].fields, fixture.records[1].fields);
  assert.equal(SchedulePolicy.safeParse({ recurrenceAnchor: "reanchor" }).success, false);
});

test("missing, duplicate, foreign, unversioned and unexpected graph records fail closed", async () => {
  await assert.rejects(loadSchedulingGraph(records[0], owner, async () => ({ ...found([]), complete: false, unresolvedRecordNames: [records[1].recordName] })), hasCode("UNSUPPORTED_FEATURE"));
  for (const record of [
    { ...records[1], zoneID: { zoneName: "Reminders", ownerRecordName: "foreign-owner" } },
    { ...records[1], zoneID: { zoneName: "Other", ownerRecordName: owner } },
    { ...records[1], recordChangeTag: undefined },
    { ...records[1], recordType: "Alarm" },
    { ...records[1], deleted: true },
    { ...records[1], recordName: "RecurrenceRule/UNREQUESTED" },
  ]) await assert.rejects(loadSchedulingGraph(records[0], owner, async () => found([record])), hasCode("PROTOCOL_CHANGED"));
  const duplicated = { ...records[0], fields: { ...records[0].fields, RecurrenceRuleIDs: { type: "STRING_LIST", value: [records[1].recordName, records[1].recordName] } } };
  await assert.rejects(loadSchedulingGraph(duplicated, owner, async () => found([records[1]])), hasCode("UNSUPPORTED_FEATURE"));
});

test("completed recurring history is never redirected to an active successor", async () => {
  const history = { ...records[0], recordName: fixture.completedHistoryCase.historicalId, fields: { ...records[0].fields, Completed: { type: "INT64", value: 1 } } };
  const graph = await loadSchedulingGraph(history, owner, async () => found([records[1]]));
  assert.throws(() => planReminderUpdate(graph, { listId: "List/SYNTHETIC", reminderId: history.recordName, recordChangeTag: history.recordChangeTag!, changes: { dueDate: fixture.completedHistoryCase.requestedNextDate } }, owner, 1_800_000_000_000), hasCode("CONFLICT"));
  assert.equal(history.fields.Completed.value, 1);
});

test("preparation tokens bind request, graph, owner, account, generation and expiry", async () => {
  const env = { ENCRYPTION_KEY_ID: "synthetic", ENCRYPTION_KEYS_JSON: JSON.stringify({ synthetic: b64(crypto.getRandomValues(new Uint8Array(32))) }) };
  const context = preparationContext("owner", "account", 1, "Reminder/TARGET");
  const hash = "a".repeat(64), graph = "b".repeat(64);
  const token = await createPreparation(env, context, hash, graph, Date.now() + 600_000);
  await checkPreparation(env, context, token, hash, graph);
  await assert.rejects(checkPreparation(env, context, token, "c".repeat(64), graph), hasCode("CONFLICT"));
  await assert.rejects(checkPreparation(env, context, token, hash, "c".repeat(64)), hasCode("CONFLICT"));
  for (const changed of [{ ...context, ownerId: "other" }, { ...context, accountId: "other" }, { ...context, generation: 2 }]) await assert.rejects(checkPreparation(env, changed, token, hash, graph), hasCode("PROTOCOL_CHANGED"));
  const expired = await createPreparation(env, context, hash, graph, Date.now() - 1);
  await assert.rejects(checkPreparation(env, context, expired, hash, graph), hasCode("CONFLICT"));
});

function transport(reply: unknown) {
  let requests = 0;
  const http = new AppleHTTP(new CookieJar(), async (_, init) => {
    requests++;
    const body = JSON.parse(String(init?.body)); assert.equal(body.atomic, true);
    return Response.json(reply);
  });
  const client = new CloudKitRemindersClient(http, { dsid: "123456789", clientId: "synthetic-client", clientBuildNumber: "2534Project66", clientMasteringNumber: "2534B22", cloudKitURL: "https://p01-ckdatabasews.icloud.com/database/1/com.apple.reminders/production/private", remindersZoneOwner: owner });
  return { client, requests: () => requests };
}
const writes = [0, 1].map(() => buildCreateReminder(CreateReminderInput.parse({ listId: "List/SYNTHETIC", idempotencyKey: crypto.randomUUID(), title: "Synthetic" }), 1_800_000_000_000));
const confirmations = writes.map((write, index) => ({ ...write, recordChangeTag: `new-${index}`, zoneID: { zoneName: "Reminders", ownerRecordName: owner } }));

test("bounded atomic executor matches all confirmations independently of response order", async () => {
  const { client, requests } = transport({ records: [...confirmations].reverse() });
  const result = await client.modifyRecords(writes.map(record => ({ operationType: "create" as const, record })));
  assert.deepEqual(result.map(record => record.recordName), writes.map(record => record.recordName));
  assert.equal(requests(), 1);
});

test("missing, duplicate, extra, mistyped and mixed atomic confirmations remain uncertain", async () => {
  for (const values of [
    confirmations.slice(0, 1), [confirmations[0], confirmations[0]], [...confirmations, { ...confirmations[0], recordName: "Reminder/EXTRA" }],
    [confirmations[0], { ...confirmations[1], recordType: "Alarm" }],
    [confirmations[0], { recordName: writes[1].recordName, serverErrorCode: "CONFLICT" }],
  ]) {
    const { client } = transport({ records: values });
    await assert.rejects(client.modifyRecords(writes.map(record => ({ operationType: "create" as const, record }))), hasCode("WRITE_OUTCOME_UNKNOWN"));
  }
  const { client } = transport({ records: writes.map(write => ({ recordName: write.recordName, serverErrorCode: "CONFLICT" })) });
  await assert.rejects(client.modifyRecords(writes.map(record => ({ operationType: "create" as const, record }))), hasCode("CONFLICT"));
});

test("atomic bounds and allowlists reject before dispatch intent or transport", async () => {
  const { client, requests } = transport({});
  let intents = 0;
  const callback = async () => { intents++; };
  await assert.rejects(client.modifyRecords([{ operationType: "create", record: writes[0] }, { operationType: "create", record: writes[0] }], callback), hasCode("VALIDATION_ERROR"));
  const invalid: CloudKitWriteRecord = { ...writes[0], fields: { ...writes[0].fields, AlarmIDs: { type: "STRING_LIST", value: ["Alarm/UNPROVEN"] } } };
  await assert.rejects(client.modifyReminder("create", invalid, callback), hasCode("VALIDATION_ERROR"));
  await assert.rejects(client.modifyReminder("create", { ...writes[0], fields: { TitleDocument: { type: "STRING", value: "x".repeat(65_536) } } }, callback), hasCode("VALIDATION_ERROR"));
  assert.equal(requests(), 0); assert.equal(intents, 0);
  await assert.rejects(client.lookup(["Alarm/UNREQUESTED"]), hasCode("VALIDATION_ERROR"));
});

const guardTypes = ["Alarm", "AlarmTrigger", "RecurrenceRule"] as const;
const versionGuards: CloudKitRecord[] = guardTypes.map(recordType => ({ recordName: `${recordType}/GUARDED`, recordType,
  recordChangeTag: `${recordType}-before`, zoneID: { zoneName: "Reminders", ownerRecordName: owner }, raw: {},
  fields: { Deleted: { type: "INT64", value: 0 }, UnknownSchedulingData: { type: "STRING", value: "preserve-without-rewriting" } } }));

test("atomic guards reassert only the live marker and match complete confirmations without rewriting unknown fields", async () => {
  const rootWrite = structuredClone(writes[0]);
  const guardCopies = structuredClone(versionGuards);
  let sent: Record<string, unknown> | undefined, requests = 0, intents = 0;
  const http = new AppleHTTP(new CookieJar(), async (_, init) => {
    requests++;
    const payload = JSON.parse(String(init?.body));
    sent = payload;
    assert.equal(payload.atomic, true);
    assert.equal(payload.operations.length, 4);
    const records = payload.operations.map((operation: { record: CloudKitWriteRecord }) => {
      const guard = versionGuards.find(value => value.recordName === operation.record.recordName);
      if (guard) {
        assert.deepEqual(operation.record.fields, { Deleted: { type: "INT64", value: 0 } });
        assert.equal(operation.record.recordChangeTag, guard.recordChangeTag);
        return { ...guard, recordChangeTag: `${guard.recordChangeTag}-after` };
      }
      assert.deepEqual(operation.record, writes[0]);
      return { ...operation.record, recordChangeTag: "new-root", zoneID: { zoneName: "Reminders", ownerRecordName: owner } };
    });
    return Response.json({ records: records.reverse() });
  });
  const client = new CloudKitRemindersClient(http, { dsid: "123", clientId: "synthetic", clientBuildNumber: "synthetic", clientMasteringNumber: "synthetic",
    cloudKitURL: "https://p01-ckdatabasews.icloud.com/database/1/com.apple.reminders/production/private", remindersZoneOwner: owner });
  const result = await client.modifyRecords([{ operationType: "create", record: rootWrite }], async () => {
    intents++;
    rootWrite.fields.Priority.value = 9;
    guardCopies[0].fields.UnknownSchedulingData = { type: "STRING", value: "changed-after-validation" };
  }, guardCopies);
  assert.ok(sent);
  assert.equal(requests, 1); assert.equal(intents, 1);
  assert.deepEqual(result.map(record => record.recordName), [writes[0].recordName, ...versionGuards.map(record => record.recordName)]);
  assert.deepEqual(result.slice(1).map(record => record.fields), versionGuards.map(record => record.fields));
});

test("each linked dependency changing after preparation rejects the complete atomic group at commit", async () => {
  for (const dependency of versionGuards) {
    const root = { ...writes[0], recordChangeTag: "root-before", zoneID: { zoneName: "Reminders", ownerRecordName: owner }, raw: {} };
    const store = new Map([root, ...structuredClone(versionGuards)].map(record => [record.recordName, record]));
    const write = buildUpdateReminder({ listId: "List/SYNTHETIC", reminderId: root.recordName, recordChangeTag: root.recordChangeTag, changes: { priority: 9 } }, root, owner);
    let requests = 0;
    const http = new AppleHTTP(new CookieJar(), async (_, init) => {
      requests++;
      const payload = JSON.parse(String(init?.body));
      assert.equal(payload.atomic, true);
      const stale = payload.operations.find((operation: { record: CloudKitWriteRecord }) => store.get(operation.record.recordName)!.recordChangeTag !== operation.record.recordChangeTag);
      assert.equal(stale.record.recordName, dependency.recordName);
      return Response.json({ records: payload.operations.map((operation: { record: CloudKitWriteRecord }) => ({ recordName: operation.record.recordName,
        serverErrorCode: operation.record.recordName === dependency.recordName ? "SERVER_RECORD_CHANGED" : "ATOMIC_ERROR" })) });
    });
    const client = new CloudKitRemindersClient(http, { dsid: "123", clientId: "synthetic", clientBuildNumber: "synthetic", clientMasteringNumber: "synthetic",
      cloudKitURL: "https://p01-ckdatabasews.icloud.com/database/1/com.apple.reminders/production/private", remindersZoneOwner: owner });
    await assert.rejects(client.modifyRecords([{ operationType: "update", record: write }], async () => {
      const record = store.get(dependency.recordName)!;
      store.set(dependency.recordName, { ...record, recordChangeTag: "concurrent-version", fields: { ...record.fields, UnknownSchedulingData: { type: "STRING", value: "concurrent-value" } } });
    }, versionGuards), hasCode("CONFLICT"));
    assert.equal(requests, 1);
    assert.deepEqual(store.get(root.recordName), root);
    assert.equal(store.get(dependency.recordName)!.recordChangeTag, "concurrent-version");
    for (const guard of versionGuards.filter(record => record.recordName !== dependency.recordName)) assert.deepEqual(store.get(guard.recordName), guard);
  }
});

test("guard shapes, duplicate targets and combined record/byte limits reject before dispatch", async () => {
  const { client, requests } = transport({});
  let intents = 0;
  const callback = async () => { intents++; };
  for (const guard of [
    { ...versionGuards[0], recordType: "Reminder" },
    { ...versionGuards[0], recordChangeTag: undefined },
    { ...versionGuards[0], deleted: true },
    { ...versionGuards[0], zoneID: { zoneName: "Reminders", ownerRecordName: "foreign-owner" } },
    { ...versionGuards[0], fields: { Deleted: { type: "INT64", value: 1 } } },
    { ...versionGuards[0], fields: { Deleted: { type: "STRING", value: "0" } } },
  ]) await assert.rejects(client.modifyRecords([{ operationType: "create", record: writes[0] }], callback, [guard]), hasCode("VALIDATION_ERROR"));
  await assert.rejects(client.modifyRecords([{ operationType: "create", record: writes[0] }], callback, [versionGuards[0], versionGuards[0]]), hasCode("VALIDATION_ERROR"));
  const many = Array.from({ length: 32 }, (_, index) => ({ ...versionGuards[0], recordName: `Alarm/${index}` }));
  await assert.rejects(client.modifyRecords([{ operationType: "create", record: writes[0] }], callback, many), hasCode("VALIDATION_ERROR"));
  const large = { ...writes[0], fields: { TitleDocument: { type: "STRING", value: "x".repeat(65_000) } } };
  const guards = Array.from({ length: 4 }, (_, index) => ({ ...versionGuards[0], recordName: `Alarm/${index}-${"x".repeat(200)}` }));
  await assert.rejects(client.modifyRecords([{ operationType: "create", record: large }], callback, guards), hasCode("VALIDATION_ERROR"));
  assert.equal(requests(), 0); assert.equal(intents, 0);
});

test("the exact 32-record limit includes both the mutation and all dependency guards", async () => {
  const guards = Array.from({ length: 31 }, (_, index) => ({ ...versionGuards[0], recordName: `Alarm/BOUNDARY-${index}` }));
  const { client, requests } = transport({ records: [confirmations[0], ...guards.map(guard => ({ ...guard, recordChangeTag: "advanced" }))] });
  const confirmed = await client.modifyRecords([{ operationType: "create", record: writes[0] }], undefined, guards);
  assert.equal(confirmed.length, 32);
  assert.equal(requests(), 1);
});

test("guard changes, missing confirmations and inconsistent atomic failures never confirm a protected write", async () => {
  const root = confirmations[0], guard = { ...versionGuards[0], recordChangeTag: "guard-after" };
  for (const values of [
    [root], [root, versionGuards[0]], [root, { ...guard, fields: { ...guard.fields, UnknownSchedulingData: { type: "STRING", value: "changed" } } }],
    [root, { recordName: guard.recordName, serverErrorCode: "CONFLICT" }],
    [{ recordName: root.recordName, serverErrorCode: "CONFLICT" }, { recordName: root.recordName, serverErrorCode: "CONFLICT" }],
    [{ recordName: root.recordName, serverErrorCode: "BATCH_REQUEST_FAILED" }, { recordName: guard.recordName, serverErrorCode: "BATCH_REQUEST_FAILED" }],
    [{ recordName: root.recordName, serverErrorCode: "ATOMIC_ERROR" }, { recordName: guard.recordName, serverErrorCode: "ATOMIC_ERROR" }],
    [{ recordName: root.recordName, serverErrorCode: "THROTTLED" }, { recordName: guard.recordName, serverErrorCode: "CONFLICT" }],
  ]) {
    const { client, requests } = transport({ records: values });
    await assert.rejects(client.modifyRecords([{ operationType: "create", record: writes[0] }], undefined, [versionGuards[0]]), hasCode("WRITE_OUTCOME_UNKNOWN"));
    assert.equal(requests(), 1);
  }
});

test("live-observed one-conflict/three-atomic-error rejection remains a definite conflict for each exact guarded type", async () => {
  const observation = JSON.parse(readFileSync(new URL("./fixtures/linked-atomic-protection-observation.json", import.meta.url), "utf8"));
  assert.equal(observation.source, "authorized-synthetic-apple-api-experiment");
  assert.equal(observation.writableRecipeApproved, false);
  assert.equal(observation.unreferencedChildRaceProtectionProven, false);
  assert.equal(observation.oldAlarmRetirementProven, false);
  for (const scenario of observation.scenarios) {
    assert.equal(scenario.validGuardAccepted, true);
    assert.equal(scenario.staleGuardRejected, true);
    assert.equal(scenario.groupFieldsAndVersionsUnchangedAfterRejection, true);
    assert.deepEqual(scenario.errorCounts, { CONFLICT: 1, ATOMIC_ERROR: 3 });
    const errors = [{ recordName: writes[0].recordName, serverErrorCode: "ATOMIC_ERROR" },
      ...versionGuards.map(guard => ({ recordName: guard.recordName, serverErrorCode: guard.recordType === scenario.dependencyType ? "CONFLICT" : "ATOMIC_ERROR" }))];
    const { client, requests } = transport({ records: errors.reverse() });
    await assert.rejects(client.modifyRecords([{ operationType: "create", record: writes[0] }], undefined, versionGuards), hasCode("CONFLICT"));
    assert.equal(requests(), 1);
  }
});
