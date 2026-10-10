import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { AppError } from "../src/errors.ts";
import { b64, utf8 } from "../src/crypto/bytes.ts";
import { CloudKitRemindersClient, type CloudKitLookupResult, type CloudKitRecord } from "../src/icloud/cloudkit.ts";
import { AppleHTTP } from "../src/transport/apple-http.ts";
import { CookieJar } from "../src/transport/cookie-jar.ts";
import { canonicalJSON } from "../src/lib/canonical.ts";
import { buildCreateReminder, CreateReminderInput } from "../src/reminders/writes.ts";
import { loadSchedulingGraph } from "../src/reminders/linked-records.ts";
import { planReminderUpdate } from "../src/reminders/mutation-plan.ts";
import { dateComponents, decodeDateComponents, dueDateNonce, verifyLinkedDateWrite } from "../src/reminders/linked-date.ts";

const owner = "synthetic-owner", listId = "List/LINKED-DATE", now = 1_800_000_000_000;
const zoneID = { zoneName: "Reminders", ownerRecordName: owner };
const alarmId = "Alarm/00000000-0000-4000-8000-000000000002", triggerId = "AlarmTrigger/00000000-0000-4000-8000-000000000003";
const ruleId = "RecurrenceRule/00000000-0000-4000-8000-000000000004";
const hasCode = (code: string) => (error: unknown) => error instanceof AppError && error.code === code;
function records(): CloudKitRecord[] {
  const write = buildCreateReminder(CreateReminderInput.parse({ listId, idempotencyKey: "00000000-0000-4000-8000-000000000001",
    title: "Synthetic recurring date", notes: "Preserve notes", dueDate: "2027-01-10T09:00:00Z", timeZone: "Europe/London" }), now);
  const reference = (recordName: string) => ({ type: "REFERENCE", value: { recordName, action: "VALIDATE", zoneID } });
  const root = { ...write, zoneID, raw: {}, recordChangeTag: "root-before",
    fields: { ...write.fields, AlarmIDs: { type: "STRING_LIST", value: [alarmId.slice(6)] },
      RecurrenceRuleIDs: { type: "STRING_LIST", value: [ruleId.slice(15)] }, FutureContent: { type: "STRING", value: "preserve" } } };
  return [root,
    { recordName: alarmId, recordType: "Alarm", recordChangeTag: "alarm-before", zoneID, raw: {}, fields: {
      AlarmUID: { type: "STRING", value: alarmId.slice(6) }, TriggerID: { type: "STRING", value: triggerId.slice(13) },
      DueDateResolutionTokenAsNonce: { type: "DOUBLE", value: dueDateNonce(write.fields.ResolutionTokenMap.value) },
      Reminder: reference(root.recordName), Imported: { type: "INT64", value: 0 }, Deleted: { type: "INT64", value: 0 },
    } },
    { recordName: triggerId, recordType: "AlarmTrigger", recordChangeTag: "trigger-before", zoneID, raw: {}, fields: {
      Alarm: reference(alarmId), Type: { type: "STRING", value: "Date" }, Imported: { type: "INT64", value: 0 }, Deleted: { type: "INT64", value: 0 },
      DateComponentsData: { type: "BYTES", value: b64(utf8(JSON.stringify(dateComponents("2027-01-10T09:00:00Z", "Europe/London")))) },
    } },
    { recordName: ruleId, recordType: "RecurrenceRule", recordChangeTag: "rule-before", zoneID, raw: {}, fields: {
      Reminder: reference(root.recordName), Frequency: { type: "INT64", value: 1 }, Interval: { type: "INT64", value: 1 },
      OccurrenceCount: { type: "INT64", value: 0 }, FirstDayOfTheWeek: { type: "INT64", value: 0 }, Deleted: { type: "INT64", value: 0 },
    } },
  ];
}
const lookup = (values: CloudKitRecord[]) => async (ids: string[]): Promise<CloudKitLookupResult> => ({
  requestedRecordNames: ids, records: values.filter(record => ids.includes(record.recordName)), recordErrors: [],
  unresolvedRecordNames: ids.filter(id => !values.some(record => record.recordName === id)), complete: ids.every(id => values.some(record => record.recordName === id)),
});
const request = (root: CloudKitRecord) => ({ listId, reminderId: root.recordName, recordChangeTag: root.recordChangeTag!,
  changes: { dueDate: "2027-07-11T09:00:00+01:00" } });

test("timed recurring date plan updates exact existing identities and protects every unchanged recurrence", async () => {
  const values = records(), before = structuredClone(values);
  const graph = await loadSchedulingGraph(values[0], owner, lookup(values));
  assert.equal(graph.complete, true); assert.equal(graph.records.length, 4);
  assert.ok(graph.edges.some(edge => edge.from === alarmId && edge.to === triggerId));
  const plan = planReminderUpdate(graph, request(values[0]), owner, now + 1000);
  assert.equal(plan.supported, true);
  if (!plan.supported) return;
  assert.equal(plan.classification, "linked-date"); assert.equal(plan.operationCount, 4);
  assert.ok(plan.requestBytes > 0 && plan.requestBytes <= 65_536);
  assert.equal(plan.after.dueDate, "2027-07-11T08:00:00.000Z");
  assert.deepEqual(plan.dependencies.map(record => record.recordName), [alarmId, triggerId]);
  assert.deepEqual(plan.guards.map(record => record.recordName), [ruleId]);
  assert.deepEqual(Object.keys(plan.write.fields).sort(), ["DueDate", "LastModifiedDate", "ResolutionTokenMap"]);
  assert.equal(plan.dependencies[0].fields.DueDateResolutionTokenAsNonce.value, dueDateNonce(plan.write.fields.ResolutionTokenMap.value));
  assert.deepEqual(decodeDateComponents(plan.dependencies[1].fields.DateComponentsData.value), {
    era: 1, year: 2027, month: 7, day: 11, hour: 9, minute: 0, second: 0, timeZone: { identifier: "Europe/London" },
  });
  assert.deepEqual(values, before);
});

test("date component construction handles daylight offsets, midnight, leap day, non-hour offsets and invalid precision", () => {
  assert.equal(dateComponents("2027-07-11T08:00:00Z", "Europe/London").hour, 9);
  assert.equal(dateComponents("2027-01-10T09:00:00Z", "Europe/London").hour, 9);
  assert.equal(dateComponents("2027-01-10T00:00:00Z", "UTC").hour, 0);
  assert.deepEqual(dateComponents("2028-02-29T00:00:00Z", "Asia/Kathmandu"), {
    era: 1, year: 2028, month: 2, day: 29, hour: 5, minute: 45, second: 0, timeZone: { identifier: "Asia/Kathmandu" },
  });
  assert.throws(() => dateComponents("2027-01-10T09:00:00.001Z", "Europe/London"), hasCode("VALIDATION_ERROR"));
  assert.throws(() => dateComponents("2027-01-10T09:00:00Z", "bad-zone"), hasCode("VALIDATION_ERROR"));
  assert.throws(() => dateComponents("2026-10-25T01:30:00+01:00", "Europe/London"), hasCode("UNSUPPORTED_FEATURE"));
  assert.throws(() => dateComponents("2026-10-25T01:30:00+00:00", "Europe/London"), hasCode("UNSUPPORTED_FEATURE"));
  assert.throws(() => dateComponents("2027-04-04T01:45:00+11:00", "Australia/Lord_Howe"), hasCode("UNSUPPORTED_FEATURE"));
  assert.throws(() => dateComponents("1892-07-04T12:00:00Z", "Pacific/Apia"), hasCode("UNSUPPORTED_FEATURE"));
  assert.equal(dateComponents("0001-01-01T00:00:00Z", "UTC").year, 1);
  assert.equal(dateComponents("9999-12-31T23:59:59Z", "UTC").year, 9999);
  assert.throws(() => dateComponents("0001-01-01T00:00:00Z", "America/New_York"), hasCode("VALIDATION_ERROR"));
  assert.throws(() => dateComponents("9999-12-31T23:59:59Z", "Asia/Tokyo"), hasCode("VALIDATION_ERROR"));
  assert.throws(() => decodeDateComponents(b64(utf8(JSON.stringify({ ...dateComponents("2028-02-29T00:00:00Z", "UTC"), year: 2027 })))), hasCode("UNSUPPORTED_FEATURE"));
  assert.throws(() => decodeDateComponents(b64(utf8(JSON.stringify({ ...dateComponents("2027-01-10T09:00:00Z", "Europe/London"), unknownCalendar: true })))), hasCode("UNSUPPORTED_FEATURE"));
});

test("zone-only and nonrecurring absolute-alarm plans preserve the instant, existing token and all identities", async () => {
  for (const recurring of [false, true]) {
    const values = records();
    if (!recurring) { delete values[0].fields.RecurrenceRuleIDs; values.pop(); }
    const graph = await loadSchedulingGraph(values[0], owner, lookup(values));
    const plan = planReminderUpdate(graph, { ...request(values[0]), changes: { timeZone: "America/New_York" } }, owner, now + 1000);
    assert.ok(plan.supported); assert.equal(plan.operationCount, recurring ? 4 : 3);
    assert.deepEqual(Object.keys(plan.write.fields).sort(), ["LastModifiedDate", "ResolutionTokenMap", "TimeZone"]);
    assert.equal(plan.after.dueDate, "2027-01-10T09:00:00.000Z");
    const oldMap = values[0].fields.ResolutionTokenMap, oldNonce = values[1].fields.DueDateResolutionTokenAsNonce;
    assert.ok(oldMap && typeof oldMap === "object" && "value" in oldMap);
    assert.ok(oldNonce && typeof oldNonce === "object" && "value" in oldNonce);
    assert.deepEqual(JSON.parse(String(plan.write.fields.ResolutionTokenMap.value)).map.dueDate,
      JSON.parse(String(oldMap.value)).map.dueDate);
    assert.equal(plan.dependencies[0].fields.DueDateResolutionTokenAsNonce.value, oldNonce.value);
    assert.equal(decodeDateComponents(plan.dependencies[1].fields.DateComponentsData.value).hour, 4);
  }
});

test("live in-place projection agrees with the precise token/nonce/components recipe without claiming app delivery", async () => {
  const observation = JSON.parse(await readFile(new URL("./fixtures/linked-inplace-date-observation.json", import.meta.url), "utf8"));
  assert.equal(observation.source, "authorized-synthetic-connector-apple-api-observation");
  for (const phase of ["before", "moved", "restored"]) {
    const current = observation[phase];
    const encoded = JSON.stringify({ map: { dueDate: { ...current.dueDateToken, replicaID: "00000000-0000-4000-8000-000000000001" } } });
    assert.equal(dueDateNonce(encoded), current.nonce);
    assert.deepEqual(dateComponents(current.dueDate, current.components.timeZone.identifier), current.components);
  }
  assert.equal(observation.before.dueDateToken.counter, 5);
  assert.equal(observation.moved.dueDateToken.counter, 1);
  assert.equal(observation.restored.dueDate, observation.before.dueDate);
  assert.equal(observation.operationCount, 4);
  assert.equal(observation.appleAppDisplayVerified, false); assert.equal(observation.alarmDeliveryVerified, false);
});

test("unknown/relative graphs, stale tags, clearing and incompatible date conversions cannot dispatch partial writes", async () => {
  for (const mutate of [
    (values: CloudKitRecord[]) => { values[2].fields.Type = { type: "STRING", value: "Location" }; },
    (values: CloudKitRecord[]) => { values[1].fields.Offset = { type: "INT64", value: -900 }; },
    (values: CloudKitRecord[]) => { values[2].fields.DateComponentsData = { type: "BYTES", value: b64(utf8("{}")) }; },
    (values: CloudKitRecord[]) => { values[0].fields.AllDay = { type: "INT64", value: 1 }; },
    (values: CloudKitRecord[]) => { values[1].fields.Reminder = { type: "REFERENCE", value: { recordName: "Reminder/OTHER", action: "VALIDATE" } }; },
  ]) {
    const values = records(); mutate(values);
    const graph = await loadSchedulingGraph(values[0], owner, lookup(values));
    const plan = planReminderUpdate(graph, request(values[0]), owner, now + 1000);
    assert.equal(plan.supported, false); assert.equal(plan.operationCount, 0); assert.equal(plan.write, null);
  }
  const values = records(), graph = await loadSchedulingGraph(values[0], owner, lookup(values));
  for (const changes of [{ dueDate: null }, { timeZone: null }, { allDay: true, dueDate: "2027-07-11T09:00:00+01:00" }]) {
    assert.equal(planReminderUpdate(graph, { ...request(values[0]), changes }, owner, now).supported, false);
  }
  assert.throws(() => planReminderUpdate(graph, { ...request(values[0]), recordChangeTag: "stale" }, owner, now), hasCode("CONFLICT"));
});

test("bounded trigger traversal refuses missing, shared, foreign or mismatched trigger records", async () => {
  const values = records();
  await assert.rejects(loadSchedulingGraph(values[0], owner, lookup(values.filter(record => record.recordName !== triggerId))), hasCode("UNSUPPORTED_FEATURE"));
  await assert.rejects(loadSchedulingGraph(values[0], owner, lookup(values.map(record => record.recordName === triggerId ?
    { ...record, zoneID: { ...zoneID, ownerRecordName: "foreign" } } : record))), hasCode("PROTOCOL_CHANGED"));
  const scoped = values.map(record => ({ ...record, zoneID: undefined }));
  assert.equal((await loadSchedulingGraph(values[0], owner, lookup(scoped))).records.length, 4);
});

test("atomic linked executor rejects any stale participant and preserves all fields on success", async () => {
  for (const racedId of [null, records()[0].recordName, alarmId, triggerId, ruleId]) {
    const values = records(), graph = await loadSchedulingGraph(values[0], owner, lookup(values));
    const plan = planReminderUpdate(graph, request(values[0]), owner, now + 1000);
    assert.ok(plan.supported);
    const store = new Map(values.map(record => [record.recordName, structuredClone(record)]));
    let calls = 0;
    const client = new CloudKitRemindersClient(new AppleHTTP(new CookieJar(), async (_, init) => {
      calls++;
      const payload = JSON.parse(String(init?.body));
      assert.equal(payload.atomic, true); assert.equal(payload.operations.length, 4);
      assert.equal(new TextEncoder().encode(String(init?.body)).length, plan.requestBytes);
      const stale = payload.operations.find((op: { record: CloudKitRecord }) => op.record.recordChangeTag !== store.get(op.record.recordName)!.recordChangeTag);
      if (stale) return Response.json({ records: payload.operations.map((op: { record: CloudKitRecord }) => ({
        recordName: op.record.recordName, serverErrorCode: op === stale ? "CONFLICT" : "ATOMIC_ERROR",
      })) });
      const confirmed = payload.operations.map((op: { record: CloudKitRecord }) => {
        const before = store.get(op.record.recordName)!;
        const next = { ...before, recordChangeTag: `${before.recordChangeTag}-next`, fields: { ...before.fields, ...op.record.fields } };
        store.set(next.recordName, next); return next;
      });
      return Response.json({ records: confirmed.reverse() });
    }), { dsid: "123", clientId: "synthetic", clientBuildNumber: "synthetic", clientMasteringNumber: "synthetic",
      cloudKitURL: "https://p01-ckdatabasews.icloud.com/database/1/com.apple.reminders/production/private", remindersZoneOwner: owner });
    const dispatch = async () => {
      if (racedId) { const record = store.get(racedId)!; store.set(racedId, { ...record, recordChangeTag: "concurrent" }); }
    };
    if (racedId) {
      await assert.rejects(client.modifyLinkedDate(plan.write, plan.dependencies, dispatch, plan.guards), hasCode("CONFLICT"));
      for (const before of values) assert.equal(canonicalJSON(store.get(before.recordName)!.fields), canonicalJSON(before.fields));
    } else {
      const confirmed = await client.modifyLinkedDate(plan.write, plan.dependencies, dispatch, plan.guards);
      for (const dependency of plan.dependencies) {
        const before = values.find(record => record.recordName === dependency.recordName)!;
        const current = confirmed.find(record => record.recordName === dependency.recordName)!;
        verifyLinkedDateWrite(dependency, before, current);
        assert.throws(() => verifyLinkedDateWrite(dependency, before, { ...current, fields: { ...current.fields, Foreign: true } }), hasCode("WRITE_OUTCOME_UNKNOWN"));
      }
      assert.deepEqual(store.get(ruleId)!.fields, values[3].fields);
    }
    assert.equal(calls, 1);
  }
});
