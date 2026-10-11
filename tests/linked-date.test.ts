import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { AppError } from "../src/errors.ts";
import { b64, utf8 } from "../src/crypto/bytes.ts";
import { CloudKitRemindersClient, type CloudKitLookupResult, type CloudKitRecord } from "../src/icloud/cloudkit.ts";
import { AppleHTTP } from "../src/transport/apple-http.ts";
import { CookieJar } from "../src/transport/cookie-jar.ts";
import { canonicalJSON } from "../src/lib/canonical.ts";
import { buildCreateReminder, CreateReminderInput, UpdateReminderInput } from "../src/reminders/writes.ts";
import { loadSchedulingGraph } from "../src/reminders/linked-records.ts";
import { planReminderUpdate } from "../src/reminders/mutation-plan.ts";
import { dateComponents, decodeDateComponents, dueDateNonce } from "../src/reminders/linked-date.ts";

import { RecurrenceChanges, readRecurrence } from "../src/reminders/recurrence.ts";
import { verifySchedulingWrite } from "../src/reminders/scheduling-plan.ts";

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
      Imported: { type: "INT64", value: 0 }, OccurrenceCount: { type: "INT64", value: 0 }, FirstDayOfTheWeek: { type: "INT64", value: 0 }, Deleted: { type: "INT64", value: 0 },
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
  const values = records();
  const nativeTokens = JSON.parse(String((values[0].fields.ResolutionTokenMap as { value: string }).value));
  nativeTokens.map.dueDate.counter = 5;
  values[0].fields.ResolutionTokenMap = { type: "STRING", value: JSON.stringify(nativeTokens) };
  values[1].fields.DueDateResolutionTokenAsNonce = { type: "DOUBLE", value: dueDateNonce(JSON.stringify(nativeTokens)) };
  values[2].fields.DateComponentsData = { type: "BYTES", value: b64(utf8(JSON.stringify({ ...dateComponents("2027-01-10T09:00:00Z", "Europe/London"), nanosecond: 0 }))) };
  const before = structuredClone(values);
  const graph = await loadSchedulingGraph(values[0], owner, lookup(values));
  assert.equal(graph.complete, true); assert.equal(graph.records.length, 4);
  assert.ok(graph.edges.some(edge => edge.from === alarmId && edge.to === triggerId));
  const plan = planReminderUpdate(graph, request(values[0]), owner, now + 1000);
  assert.equal(plan.supported, true);
  if (!plan.supported) return;
  const updatedTokens = JSON.parse(String(plan.write.fields.ResolutionTokenMap.value));
  assert.equal(updatedTokens.map.dueDate.counter, 6);
  assert.equal(updatedTokens.map.dueDate.replicaID, nativeTokens.map.dueDate.replicaID);
  assert.equal(plan.classification, "linked-date"); assert.equal(plan.operationCount, 4);
  assert.ok(plan.requestBytes > 0 && plan.requestBytes <= 65_536);
  assert.equal(plan.after.dueDate, "2027-07-11T08:00:00.000Z");
  assert.deepEqual(plan.dependencies.map(record => record.recordName), [alarmId, triggerId]);
  assert.deepEqual(plan.guards.map(record => record.recordName), [ruleId]);
  assert.deepEqual(Object.keys(plan.write.fields).sort(), ["DueDate", "LastModifiedDate", "ResolutionTokenMap"]);
  assert.equal(plan.dependencies[0].fields.DueDateResolutionTokenAsNonce.value, dueDateNonce(plan.write.fields.ResolutionTokenMap.value));
  assert.deepEqual(decodeDateComponents(plan.dependencies[1].fields.DateComponentsData.value), {
    era: 1, year: 2027, month: 7, day: 11, hour: 9, minute: 0, second: 0, timeZone: { identifier: "Europe/London" }, nanosecond: 0,
  });
  assert.deepEqual(values, before);
});

test("date component construction handles daylight offsets, midnight, leap day, non-hour offsets and invalid precision", () => {
  assert.equal(dateComponents("2027-07-11T08:00:00Z", "Europe/London").hour, 9);
  assert.equal(decodeDateComponents(b64(utf8(JSON.stringify({ ...dateComponents("2027-01-10T09:00:00Z", "Europe/London"), nanosecond: 0 })))).nanosecond, 0);
  assert.throws(() => decodeDateComponents(b64(utf8(JSON.stringify({ ...dateComponents("2027-01-10T09:00:00Z", "Europe/London"), nanosecond: 1 })))), hasCode("UNSUPPORTED_FEATURE"));
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
  for (const changes of [{ timeZone: null }]) {
    assert.equal(planReminderUpdate(graph, { ...request(values[0]), changes }, owner, now).supported, false);
  }
  assert.throws(() => planReminderUpdate(graph, { ...request(values[0]), changes: { allDay: true, dueDate: "2027-07-11T09:00:00+01:00" } }, owner, now), hasCode("VALIDATION_ERROR"));
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
    const values = records();
    values[3].fields.DaysOfTheWeek = { type: "BYTES", value: b64(utf8(JSON.stringify([{ dayOfTheWeek: 2, weekNumber: 0 }, { dayOfTheWeek: 4, weekNumber: 0 }]))) };
    values[3].fields.Interval = { type: "INT64", value: 3 };
    const graph = await loadSchedulingGraph(values[0], owner, lookup(values));
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
      await assert.rejects(client.modifyScheduling(plan.write, plan.dependencies, dispatch, plan.guards), hasCode("CONFLICT"));
      for (const before of values) assert.equal(canonicalJSON(store.get(before.recordName)!.fields), canonicalJSON(before.fields));
    } else {
      const confirmed = await client.modifyScheduling(plan.write, plan.dependencies, dispatch, plan.guards);
      for (const dependency of plan.dependencies) {
        const before = values.find(record => record.recordName === dependency.recordName)!;
        const current = confirmed.find(record => record.recordName === dependency.recordName)!;
        assert.ok("recordType" in current);
        verifySchedulingWrite(dependency, before, current);
        assert.throws(() => verifySchedulingWrite(dependency, before, { ...current, fields: { ...current.fields, Foreign: true } }), hasCode("WRITE_OUTCOME_UNKNOWN"));
      }
      assert.deepEqual(store.get(ruleId)!.fields, values[3].fields);
    }
    assert.equal(calls, 1);
  }
});


test("clearing recurring dates retires the complete known graph while preserving calendar metadata", async () => {
  const values = records(), graph = await loadSchedulingGraph(values[0], owner, lookup(values));
  const plan = planReminderUpdate(graph, { ...request(values[0]), changes: { dueDate: null } }, owner, now + 1000);
  assert.ok(plan.supported); assert.equal(plan.operationCount, 4);
  assert.equal(plan.write.fields.DueDate.value, null);
  assert.equal(plan.write.fields.TimeZone, undefined); assert.equal(plan.write.fields.AllDay, undefined);
  assert.deepEqual(plan.write.fields.AlarmIDs, { type: "UNKNOWN_LIST", value: [] });
  assert.deepEqual(plan.write.fields.RecurrenceRuleIDs, { type: "UNKNOWN_LIST", value: [] });
  assert.deepEqual(plan.dependencies.map(record => [record.recordType, record.operationType ?? "update"]), [["AlarmTrigger", "delete"], ["Alarm", "delete"], ["RecurrenceRule", "update"]]);
  assert.ok(plan.dependencies.every(record => record.recordChangeTag));
  assert.deepEqual(plan.dependencies.find(record => record.recordType === "RecurrenceRule")!.fields.Reminder, { type: "REFERENCE", value: null });
});

test("explicit calendar conversion retires date participants and creates a fresh exact bidirectional timed graph", async () => {
  const values = records(), graph = await loadSchedulingGraph(values[0], owner, lookup(values));
  const allDay = planReminderUpdate(graph, { ...request(values[0]), changes: { allDay: true, dueDate: "2027-07-11T00:00:00Z" } }, owner, now + 1000);
  assert.ok(allDay.supported); assert.equal(allDay.operationCount, 4);
  assert.equal(allDay.write.fields.TimeZone.value, null); assert.deepEqual(allDay.guards.map(record => record.recordName), [ruleId]);
  assert.deepEqual(allDay.dependencies.map(record => [record.recordType, record.operationType]), [["AlarmTrigger", "delete"], ["Alarm", "delete"]]);
  const root = { ...values[0], recordChangeTag: "all-day", fields: { ...values[0].fields, ...allDay.write.fields } };
  delete root.fields.TimeZone;
  const nextGraph = await loadSchedulingGraph(root, owner, lookup([root, values[3]]));
  const movedAllDay = planReminderUpdate(nextGraph, { listId, reminderId: root.recordName, recordChangeTag: root.recordChangeTag,
    changes: { dueDate: "2027-08-12T00:00:00Z" } }, owner, now + 1500);
  assert.ok(movedAllDay.supported); assert.equal(movedAllDay.after.dueDate, "2027-08-12T00:00:00.000Z");
  assert.equal(movedAllDay.after.allDay, true); assert.equal(movedAllDay.after.timeZone, null);
  assert.equal(movedAllDay.dependencies.length, 0); assert.deepEqual(movedAllDay.guards.map(record => record.recordName), [ruleId]);
  assert.equal(movedAllDay.write.fields.TimeZone, undefined); assert.equal(movedAllDay.write.fields.AllDay, undefined);
  const timed = planReminderUpdate(nextGraph, { listId, reminderId: root.recordName, recordChangeTag: root.recordChangeTag,
    changes: { allDay: false, dueDate: "2027-07-11T09:00:00+01:00", timeZone: "Europe/London" } }, owner, now + 2000);
  assert.ok(timed.supported); assert.equal(timed.operationCount, 4);
  assert.ok(timed.dependencies.every(record => record.operationType === "create" && !record.recordChangeTag));
  const alarm = timed.dependencies.find(record => record.recordType === "Alarm")!, trigger = timed.dependencies.find(record => record.recordType === "AlarmTrigger")!;
  assert.equal(alarm.fields.TriggerID.value, trigger.recordName.slice(13));
  assert.deepEqual(trigger.fields.Alarm.value, { recordName: alarm.recordName, action: "VALIDATE" });
  assert.equal(alarm.fields.DueDateResolutionTokenAsNonce.value, dueDateNonce(timed.write.fields.ResolutionTokenMap.value));
});

test("weekly interval edits preserve every unrelated participant and refuse unknown recurrence semantics", async () => {
  const values = records(), graph = await loadSchedulingGraph(values[0], owner, lookup(values));
  const plan = planReminderUpdate(graph, { ...request(values[0]), changes: { recurrence: { frequency: "weekly", interval: 2 } } }, owner, now + 1000);
  assert.ok(plan.supported); assert.equal(plan.operationCount, 4);
  assert.deepEqual(plan.dependencies, [{ recordName: ruleId, recordType: "RecurrenceRule", recordChangeTag: "rule-before", fields: { Interval: { type: "INT64", value: 2 } } }]);
  assert.deepEqual(plan.guards.map(record => record.recordName).sort(), [alarmId, triggerId].sort());
  assert.deepEqual(Object.keys(plan.write.fields).sort(), ["LastModifiedDate", "ResolutionTokenMap"]);
  values[3].fields.ByMonth = { type: "INT64", value: 3 };
  const unknown = await loadSchedulingGraph(values[0], owner, lookup(values));
  assert.equal(planReminderUpdate(unknown, { ...request(values[0]), changes: { recurrence: { frequency: "weekly", interval: 2 } } }, owner, now).supported, false);
});

test("frequency edits and existing early offsets preserve private metadata and version-guard the full date graph", async () => {
  const values = records();
  const privatePayload = { reminderIdentifier: values[0].recordName.slice(9), accountIdentifier: "synthetic-private-account", minimumSupportedVersion: 20230430,
    dueDateDeltaAlerts: [{ identifier: "00000000-0000-4000-8000-000000000009", creationDate: 800_000_000, dueDateDeltaUnit: 0, dueDateDeltaCount: -30, minimumSupportedAppVersion: 0 }] };
  values[0].fields.DueDateDeltaAlertsData = { type: "ENCRYPTED_BYTES", value: b64(utf8(JSON.stringify(privatePayload))) };
  const graph = await loadSchedulingGraph(values[0], owner, lookup(values));
  const plan = planReminderUpdate(graph, { ...request(values[0]), changes: { earlyReminder: { unit: "hours", count: 1 }, recurrence: { frequency: "yearly", interval: 1 } } }, owner, now + 1000);
  assert.ok(plan.supported); assert.equal(plan.operationCount, 4);
  assert.deepEqual(plan.dependencies[0].fields, { Frequency: { type: "INT64", value: 3 } });
  const payload = JSON.parse(Buffer.from(String(plan.write.fields.DueDateDeltaAlertsData.value), "base64").toString());
  assert.equal(payload.accountIdentifier, privatePayload.accountIdentifier); assert.equal(payload.reminderIdentifier, privatePayload.reminderIdentifier);
  assert.equal(payload.dueDateDeltaAlerts[0].identifier, privatePayload.dueDateDeltaAlerts[0].identifier);
  assert.equal(payload.dueDateDeltaAlerts[0].creationDate, privatePayload.dueDateDeltaAlerts[0].creationDate);
  assert.equal(payload.dueDateDeltaAlerts[0].dueDateDeltaUnit, 1); assert.equal(payload.dueDateDeltaAlerts[0].dueDateDeltaCount, -1);
  assert.equal(planReminderUpdate(graph, { ...request(values[0]), changes: { dueDate: null } }, owner, now).supported, false);
  const removed = planReminderUpdate(graph, { ...request(values[0]), changes: { earlyReminder: null } }, owner, now + 2000);
  assert.ok(removed.supported); assert.equal(removed.after.earlyReminder, null);
  assert.deepEqual(removed.write.fields.DueDateDeltaAlertsData, { type: "ENCRYPTED_BYTES", value: null });
  assert.equal(removed.operationCount, 4); assert.equal(removed.dependencies.length, 0);
  delete values[0].fields.DueDateDeltaAlertsData;
  assert.equal(planReminderUpdate(await loadSchedulingGraph(values[0], owner, lookup(values)), { ...request(values[0]), changes: { earlyReminder: { unit: "minutes", count: 15 } } }, owner, now).supported, false);
});

test("child date scheduling protects the exact same-list open parent and rejects cross-list or unavailable parents", async () => {
  const values = records();
  const parent = { ...structuredClone(values[0]), recordName: "Reminder/00000000-0000-4000-8000-000000000005", recordChangeTag: "parent-before" };
  delete parent.fields.AlarmIDs; delete parent.fields.RecurrenceRuleIDs;
  values[0].fields.ParentReminder = { type: "REFERENCE", value: { recordName: parent.recordName, action: "VALIDATE", zoneID } };
  const graph = await loadSchedulingGraph(values[0], owner, lookup([...values, parent]));
  const plan = planReminderUpdate(graph, request(values[0]), owner, now + 1000);
  assert.ok(plan.supported); assert.equal(plan.operationCount, 5);
  assert.deepEqual(plan.guards.map(record => record.recordName).sort(), [parent.recordName, ruleId].sort());
  assert.equal(plan.write.fields.ParentReminder, undefined);
  parent.fields.Completed = { type: "INT64", value: 1 };
  await assert.rejects(loadSchedulingGraph(values[0], owner, lookup([...values, parent])), hasCode("UNSUPPORTED_FEATURE"));
  parent.fields.Completed = { type: "INT64", value: 0 };
  parent.fields.List = { type: "REFERENCE", value: { recordName: "List/OTHER", action: "VALIDATE", zoneID } };
  await assert.rejects(loadSchedulingGraph(values[0], owner, lookup([...values, parent])), hasCode("UNSUPPORTED_FEATURE"));
  await assert.rejects(loadSchedulingGraph(values[0], owner, lookup(values)), hasCode("CONFLICT"));
});


test("timed conversion verifies expanded references against the authenticated owner when record zones are omitted", async () => {
  const values = records(), root = values[0];
  root.fields.AllDay = { type: "INT64", value: 1 }; root.fields.AlarmIDs = { type: "UNKNOWN_LIST", value: [] };
  root.fields.DueDate = { type: "TIMESTAMP", value: Date.parse("2027-01-10T00:00:00Z") }; delete root.fields.TimeZone;
  const graph = await loadSchedulingGraph(root, owner, lookup([root, values[3]]));
  const plan = planReminderUpdate(graph, { ...request(root), changes: { allDay: false, dueDate: "2027-07-11T09:00:00+01:00", timeZone: "Europe/London" } }, owner, now + 1000);
  assert.ok(plan.supported);
  let calls = 0;
  const client = new CloudKitRemindersClient(new AppleHTTP(new CookieJar(), async (_, init) => {
    calls++;
    const body = JSON.parse(String(init?.body)); assert.equal(body.atomic, true); assert.equal(body.operations.length, 4);
    assert.deepEqual(body.operations.map((op: { operationType: string }) => op.operationType), ["update", "create", "create", "update"]);
    assert.equal(new TextEncoder().encode(String(init?.body)).length, plan.requestBytes);
    return Response.json({ records: body.operations.map((op: { record: CloudKitRecord }) => {
      const before = values.find(record => record.recordName === op.record.recordName);
      const fields = { ...before?.fields, ...op.record.fields };
      for (const [key, field] of Object.entries(fields)) if (field && typeof field === "object" && "type" in field && field.type === "REFERENCE" && "value" in field && field.value && typeof field.value === "object") fields[key] = { type: "REFERENCE", value: { ...field.value, zoneID } };
      return { ...op.record, fields, recordChangeTag: "confirmed" };
    }) });
  }), { dsid: "123", clientId: "synthetic", clientBuildNumber: "synthetic", clientMasteringNumber: "synthetic",
    cloudKitURL: "https://p01-ckdatabasews.icloud.com/database/1/com.apple.reminders/production/private", remindersZoneOwner: owner });
  const confirmed = await client.modifyScheduling(plan.write, plan.dependencies, undefined, plan.guards);
  for (const dependency of plan.dependencies) {
    const record = confirmed.find(record => record.recordName === dependency.recordName)!;
    assert.equal(record.zoneID, undefined);
    verifySchedulingWrite(dependency, undefined, record, owner);
    if ("recordType" in record) {
      const key = record.recordType === "Alarm" ? "Reminder" : "Alarm";
      const reference = record.fields[key] as { type: string; value: Record<string, unknown> };
      assert.throws(() => verifySchedulingWrite(dependency, undefined, { ...record, fields: { ...record.fields, [key]: { ...reference, value: { ...reference.value, zoneID: { ...zoneID, ownerRecordName: "foreign" } } } } }, owner), hasCode("PROTOCOL_CHANGED"));
    }
  }
  assert.equal(calls, 1);
});

function withLocation(): CloudKitRecord[] {
  const values = records(), root = values[0];
  const locationAlarm = "Alarm/00000000-0000-4000-8000-000000000006", locationTrigger = "AlarmTrigger/00000000-0000-4000-8000-000000000007";
  root.fields.AlarmIDs = { type: "STRING_LIST", value: [alarmId.slice(6), locationAlarm.slice(6)] };
  values.push({ recordName: locationAlarm, recordType: "Alarm", recordChangeTag: "location-alarm-before", zoneID, raw: {}, fields: {
    AlarmUID: { type: "STRING", value: locationAlarm.slice(6) }, TriggerID: { type: "STRING", value: locationTrigger.slice(13) },
    DueDateResolutionTokenAsNonce: { type: "DOUBLE", value: 0 }, Reminder: { type: "REFERENCE", value: { recordName: root.recordName, action: "VALIDATE", zoneID } },
    Imported: { type: "INT64", value: 0 }, Deleted: { type: "INT64", value: 0 },
  } }, { recordName: locationTrigger, recordType: "AlarmTrigger", recordChangeTag: "location-trigger-before", zoneID, raw: {}, fields: {
    ReferenceFrameString: { type: "STRING", value: "1", isEncrypted: true }, Radius: { type: "DOUBLE", value: 250 }, Type: { type: "STRING", value: "Location" },
    Proximity: { type: "INT64", value: 1 }, Address: { type: "STRING", value: "Synthetic address", isEncrypted: true }, Title: { type: "STRING", value: "Synthetic station", isEncrypted: true },
    Latitude: { type: "DOUBLE", value: 51.5, isEncrypted: true }, Longitude: { type: "DOUBLE", value: -0.1, isEncrypted: true }, LocationUID: { type: "STRING", value: "00000000-0000-4000-8000-000000000008" },
    Alarm: { type: "REFERENCE", value: { recordName: locationAlarm, action: "VALIDATE", zoneID } }, Imported: { type: "INT64", value: 0 }, Deleted: { type: "INT64", value: 0 },
  } });
  return values;
}

test("date moves and location proximity edits protect the complete mixed graph without replacing place metadata", async () => {
  const values = withLocation(), before = structuredClone(values);
  const graph = await loadSchedulingGraph(values[0], owner, lookup(values));
  const move = planReminderUpdate(graph, request(values[0]), owner, now + 1000);
  assert.ok(move.supported); assert.equal(move.operationCount, 6);
  assert.deepEqual(move.dependencies.map(record => record.recordName), [alarmId, triggerId]);
  assert.ok(move.guards.some(record => record.recordName === values[4].recordName)); assert.ok(move.guards.some(record => record.recordName === values[5].recordName));
  assert.equal(move.after.locationAlarm?.proximity, "arriving");
  assert.equal(move.after.locationAlarm?.radiusMeters, 250);
  const edit = planReminderUpdate(graph, { ...request(values[0]), changes: { dueDate: "2027-07-11T09:00:00+01:00", locationAlarm: { proximity: "leaving" } } }, owner, now + 1000);
  assert.ok(edit.supported); assert.equal(edit.operationCount, 6);
  const dependency = edit.dependencies.find(record => record.recordName === values[5].recordName)!;
  assert.deepEqual(dependency.fields, { Proximity: { type: "INT64", value: 2 } }); assert.equal(dependency.recordChangeTag, "location-trigger-before");
  assert.equal(edit.before.locationAlarm?.proximity, "arriving"); assert.equal(edit.after.locationAlarm?.proximity, "leaving");
  assert.deepEqual(edit.before.locationAlarm?.place, edit.after.locationAlarm?.place);
  verifySchedulingWrite(dependency, values[5], { ...values[5], recordChangeTag: "location-trigger-after", fields: { ...values[5].fields, ...dependency.fields } });
  assert.deepEqual(values, before);
  assert.equal(planReminderUpdate(graph, { ...request(values[0]), changes: { dueDate: null } }, owner, now).supported, false);
  assert.equal(planReminderUpdate(graph, { ...request(values[0]), changes: { allDay: true, dueDate: "2027-07-11T00:00:00Z" } }, owner, now).supported, false);
  values[5].fields.UnobservedLocationData = { type: "BYTES", value: "AA==" };
  assert.equal(planReminderUpdate(await loadSchedulingGraph(values[0], owner, lookup(values)), request(values[0]), owner, now).supported, false);
});

test("location create, radius/place edit and soft removal preserve a mixed date graph and reject stale atomic versions", async () => {
  const place = { title: "Synthetic station", address: "Synthetic address", latitude: 51.5, longitude: -0.1 };
  const initial = records(), store = new Map(initial.map(record => [record.recordName, structuredClone(record)]));
  let calls = 0;
  const client = new CloudKitRemindersClient(new AppleHTTP(new CookieJar(), async (_, init) => {
    calls++; const body = JSON.parse(String(init?.body));
    assert.equal(body.atomic, true);
    assert.ok(body.operations.every((op: { record: Record<string, unknown> }) => !("locationRetirement" in op.record)));
    for (const op of body.operations) for (const [key, field] of Object.entries(op.record.fields) as [string, { isEncrypted?: boolean }][]) if (["ReferenceFrameString", "Address", "Title", "Latitude", "Longitude"].includes(key)) assert.equal(field.isEncrypted, true);
    const stale = body.operations.find((op: { operationType: string; record: CloudKitRecord }) => op.operationType !== "create" && op.record.recordChangeTag !== store.get(op.record.recordName)?.recordChangeTag);
    if (stale) return Response.json({ records: body.operations.map((op: { record: CloudKitRecord }) => ({ recordName: op.record.recordName, serverErrorCode: op === stale ? "CONFLICT" : "ATOMIC_ERROR" })) });
    return Response.json({ records: body.operations.map((op: { operationType: string; record: CloudKitRecord }) => {
      assert.notEqual(op.operationType, "delete");
      const before = store.get(op.record.recordName);
      const fields = { ...before?.fields, ...op.record.fields };
      for (const [key, field] of Object.entries(fields)) {
        const wrapper = field as { type: string; value: unknown };
        if (wrapper.value === null) delete fields[key];
        else if (op.operationType === "create" && wrapper.type === "REFERENCE") fields[key] = { ...wrapper, value: { ...(wrapper.value as object), zoneID } };
      }
      const after = { ...op.record, recordChangeTag: `${before?.recordChangeTag ?? "new"}-next`, fields, zoneID, raw: {} };
      store.set(after.recordName, after);
      // Native create responses omit their top-level zone and expand reference zones.
      return { ...after, zoneID: undefined };
    }).reverse() });
  }), { dsid: "123", clientId: "synthetic", clientBuildNumber: "synthetic", clientMasteringNumber: "synthetic",
    cloudKitURL: "https://p01-ckdatabasews.icloud.com/database/1/com.apple.reminders/production/private", remindersZoneOwner: owner });
  const planCurrent = async (changes: Parameters<typeof planReminderUpdate>[1]["changes"]) => {
    const current = [...store.values()].filter(record => (record.fields.Deleted as { value: number }).value === 0);
    const root = current.find(record => record.recordType === "Reminder")!;
    return planReminderUpdate(await loadSchedulingGraph(root, owner, lookup(current)), { ...request(root), changes }, owner, now + calls * 1000);
  };
  const create = await planCurrent({ dueDate: "2027-07-11T09:00:00+01:00", locationAlarm: { proximity: "arriving", radiusMeters: 250, place } });
  assert.ok(create.supported); assert.equal(create.operationCount, 6); assert.equal(create.after.locationAlarm?.radiusMeters, 250);
  const newAlarm = create.dependencies.find(record => record.operationType === "create" && record.recordType === "Alarm")!;
  const newTrigger = create.dependencies.find(record => record.operationType === "create" && record.recordType === "AlarmTrigger")!;
  assert.deepEqual(create.write.fields.AlarmIDs.value, [alarmId.slice(6), newAlarm.recordName.slice(6)]);
  assert.equal(newAlarm.fields.DueDateResolutionTokenAsNonce.value, 0);
  const locationUid = newTrigger.fields.LocationUID.value;
  assert.notEqual(locationUid, newAlarm.recordName.slice(6));
  const unflaggedCreate = structuredClone(create.dependencies);
  const unflaggedTrigger = unflaggedCreate.find(record => record.recordName === newTrigger.recordName)!;
  delete unflaggedTrigger.fields.ReferenceFrameString.isEncrypted;
  await assert.rejects(client.modifyScheduling(create.write, unflaggedCreate, undefined, create.guards), hasCode("VALIDATION_ERROR"));
  assert.equal(calls, 0);
  const confirmedCreate = await client.modifyScheduling(create.write, create.dependencies, undefined, create.guards);
  for (const dep of create.dependencies) verifySchedulingWrite(dep, initial.find(record => record.recordName === dep.recordName), confirmedCreate.find(record => record.recordName === dep.recordName)!, owner);
  const createdConfirmation = confirmedCreate.find(record => record.recordName === newTrigger.recordName)!;
  assert.ok("fields" in createdConfirmation);
  const unexpectedFlags = structuredClone(createdConfirmation);
  delete (unexpectedFlags.fields.Title as { isEncrypted?: true }).isEncrypted;
  assert.throws(() => verifySchedulingWrite(newTrigger, undefined, unexpectedFlags, owner), hasCode("WRITE_OUTCOME_UNKNOWN"));
  assert.deepEqual(store.get(ruleId)!.fields, initial[3].fields);
  const changedPlace = { ...place, title: "Synthetic edited station", longitude: -0.2 };
  const edit = await planCurrent({ locationAlarm: { proximity: "leaving", radiusMeters: 500, place: changedPlace } });
  assert.ok(edit.supported); assert.deepEqual(edit.after.locationAlarm, { proximity: "leaving", radiusMeters: 500, place: changedPlace });
  assert.equal(edit.dependencies.length, 1); assert.equal(edit.dependencies[0].recordName, newTrigger.recordName);
  const unflaggedEdit = structuredClone(edit.dependencies);
  delete unflaggedEdit[0].fields.Latitude.isEncrypted;
  await assert.rejects(client.modifyScheduling(edit.write, unflaggedEdit, undefined, edit.guards), hasCode("VALIDATION_ERROR"));
  assert.equal(calls, 1);
  const beforeEdit = structuredClone(store.get(newTrigger.recordName)!);
  const dateBeforeEdit = [structuredClone(store.get(alarmId)!), structuredClone(store.get(triggerId)!)];
  const confirmedEdit = await client.modifyScheduling(edit.write, edit.dependencies, undefined, edit.guards);
  verifySchedulingWrite(edit.dependencies[0], beforeEdit, confirmedEdit.find(record => record.recordName === newTrigger.recordName)!, owner);
  assert.equal((store.get(newTrigger.recordName)!.fields.LocationUID as { value: unknown }).value, locationUid);
  for (const record of dateBeforeEdit) assert.deepEqual(store.get(record.recordName)!.fields, record.fields);
  const remove = await planCurrent({ locationAlarm: null });
  assert.ok(remove.supported); assert.equal(remove.after.locationAlarm, null); assert.equal(remove.operationCount, 6);
  assert.deepEqual(remove.write.fields.AlarmIDs.value, [alarmId.slice(6)]);
  assert.deepEqual(remove.dependencies.map(record => record.recordName), [newAlarm.recordName, newTrigger.recordName]);
  assert.ok(remove.dependencies.every(record => !record.operationType && record.fields.Deleted.value === 1));
  const beforeRemove = [...store.values()].map(record => structuredClone(record));
  const dateTag = store.get(triggerId)!.recordChangeTag!;
  await assert.rejects(client.modifyScheduling(remove.write, remove.dependencies, async () => { store.get(triggerId)!.recordChangeTag = "raced-date"; }, remove.guards), hasCode("CONFLICT"));
  for (const record of beforeRemove) assert.deepEqual(store.get(record.recordName)!.fields, record.fields);
  store.get(triggerId)!.recordChangeTag = dateTag;
  const confirmedRemove = await client.modifyScheduling(remove.write, remove.dependencies, undefined, remove.guards);
  for (const dep of remove.dependencies) verifySchedulingWrite(dep, beforeRemove.find(record => record.recordName === dep.recordName), confirmedRemove.find(record => record.recordName === dep.recordName)!, owner);
  assert.equal(store.get(newAlarm.recordName)!.fields.Reminder, undefined);
  assert.deepEqual(store.get(newTrigger.recordName)!.fields.Alarm, beforeRemove.find(record => record.recordName === newTrigger.recordName)!.fields.Alarm);
  for (const record of dateBeforeEdit) assert.deepEqual(store.get(record.recordName)!.fields, record.fields);
  assert.equal(calls, 4);
  await assert.rejects(client.modifyScheduling(remove.write, [remove.dependencies[0]], undefined, remove.guards), hasCode("VALIDATION_ERROR"));
  await assert.rejects(client.modifyScheduling({ ...remove.write, fields: { ...remove.write.fields, AlarmIDs: { type: "STRING_LIST", value: [alarmId.slice(6), newAlarm.recordName.slice(6)] } } }, remove.dependencies, undefined, remove.guards), hasCode("VALIDATION_ERROR"));
  assert.equal(calls, 4);
  for (const locationAlarm of [{ radiusMeters: 0 }, { place: { ...place, latitude: 91 } }, { place: { ...place, extra: true } }, { radiusMeters: Infinity }, {}]) assert.equal(UpdateReminderInput.safeParse({ ...request(initial[0]), changes: { locationAlarm } }).success, false);
  const initialGraph = await loadSchedulingGraph(initial[0], owner, lookup(initial));
  assert.throws(() => planReminderUpdate(initialGraph, { ...request(initial[0]), changes: { locationAlarm: { radiusMeters: 250 } } }, owner, now), hasCode("VALIDATION_ERROR"));
});

test("new scheduling reference verification rejects missing or contradictory actions", () => {
  const id = "Alarm/00000000-0000-4000-8000-000000000006";
  const write = { operationType: "create" as const, recordName: id, recordType: "Alarm" as const, fields: { Reminder: { type: "REFERENCE", value: { recordName: records()[0].recordName, action: "VALIDATE" } } } };
  const confirmed = { ...write, recordChangeTag: "confirmed", zoneID, raw: {} };
  verifySchedulingWrite(write, undefined, confirmed);
  assert.throws(() => verifySchedulingWrite(write, undefined, { ...confirmed, fields: { Reminder: { type: "REFERENCE", value: { recordName: records()[0].recordName, zoneID } } } }), hasCode("WRITE_OUTCOME_UNKNOWN"));
  assert.throws(() => verifySchedulingWrite(write, undefined, { ...confirmed, fields: { Reminder: { type: "REFERENCE", value: { recordName: records()[0].recordName, action: "DELETE_SELF", zoneID } } } }), hasCode("PROTOCOL_CHANGED"));
});

test("date retirement deletes the exact trigger before its alarm and rejects every stale atomic participant", async () => {
  for (const racedId of [null, records()[0].recordName, triggerId, alarmId, ruleId]) {
    const values = records(), graph = await loadSchedulingGraph(values[0], owner, lookup(values));
    const plan = planReminderUpdate(graph, { ...request(values[0]), changes: { dueDate: null } }, owner, now + 1000);
    assert.ok(plan.supported);
    const store = new Map(values.map(record => [record.recordName, structuredClone(record)]));
    let calls = 0;
    const client = new CloudKitRemindersClient(new AppleHTTP(new CookieJar(), async (_, init) => {
      calls++;
      const body = JSON.parse(String(init?.body));
      assert.equal(body.atomic, true); assert.equal(body.operations.length, 4);
      assert.equal(new TextEncoder().encode(String(init?.body)).length, plan.requestBytes);
      const deletes = body.operations.filter((op: { operationType: string }) => op.operationType === "delete");
      assert.deepEqual(deletes.map((op: { record: CloudKitRecord }) => op.record.recordName), [triggerId, alarmId]);
      assert.ok(deletes.every((op: { record: CloudKitRecord }) => Object.keys(op.record).sort().join() === "recordChangeTag,recordName,recordType"));
      const stale = body.operations.find((op: { record: CloudKitRecord }) => op.record.recordChangeTag !== store.get(op.record.recordName)!.recordChangeTag);
      if (stale) return Response.json({ records: body.operations.map((op: { record: CloudKitRecord }) => ({ recordName: op.record.recordName, serverErrorCode: op === stale ? "CONFLICT" : "ATOMIC_ERROR" })) });
      return Response.json({ records: body.operations.map((op: { operationType: string; record: CloudKitRecord }) => {
        if (op.operationType === "delete") { store.delete(op.record.recordName); return { recordName: op.record.recordName, deleted: true }; }
        const before = store.get(op.record.recordName)!;
        const after = { ...before, recordChangeTag: `${before.recordChangeTag}-after`, fields: { ...before.fields, ...op.record.fields } };
        store.set(after.recordName, after); return after;
      }).reverse() });
    }), { dsid: "123", clientId: "synthetic", clientBuildNumber: "synthetic", clientMasteringNumber: "synthetic",
      cloudKitURL: "https://p01-ckdatabasews.icloud.com/database/1/com.apple.reminders/production/private", remindersZoneOwner: owner });
    const dispatch = async () => { if (racedId) store.get(racedId)!.recordChangeTag = "raced"; };
    if (racedId) {
      await assert.rejects(client.modifyScheduling(plan.write, plan.dependencies, dispatch, plan.guards), hasCode("CONFLICT"));
      for (const before of values) assert.deepEqual(store.get(before.recordName)!.fields, before.fields);
    } else {
      const confirmed = await client.modifyScheduling(plan.write, plan.dependencies, dispatch, plan.guards);
      for (const dependency of plan.dependencies) verifySchedulingWrite(dependency, values.find(record => record.recordName === dependency.recordName), confirmed.find(record => record.recordName === dependency.recordName)!);
      assert.equal(store.has(triggerId), false); assert.equal(store.has(alarmId), false);
      assert.deepEqual(store.get(values[0].recordName)!.fields.AlarmIDs, { type: "UNKNOWN_LIST", value: [] });
      const tombstone = confirmed.find(record => record.recordName === triggerId)!;
      assert.throws(() => verifySchedulingWrite(plan.dependencies[0], values[2], { ...tombstone, raw: { recordName: triggerId, deleted: true, fields: {} } }), hasCode("WRITE_OUTCOME_UNKNOWN"));
      await assert.rejects(client.modifyScheduling(plan.write, [...plan.dependencies].reverse(), undefined, plan.guards), hasCode("VALIDATION_ERROR"));
    }
    assert.equal(calls, 1);
  }
});

test("unexpected deletion confirmation metadata remains uncertain without an automatic replay", async () => {
  const values = records(), graph = await loadSchedulingGraph(values[0], owner, lookup(values));
  const plan = planReminderUpdate(graph, { ...request(values[0]), changes: { allDay: true, dueDate: "2027-07-11T00:00:00Z" } }, owner, now + 1000);
  assert.ok(plan.supported); let calls = 0;
  const client = new CloudKitRemindersClient(new AppleHTTP(new CookieJar(), async (_, init) => {
    calls++; const body = JSON.parse(String(init?.body));
    return Response.json({ records: body.operations.map((op: { operationType: string; record: CloudKitRecord }) => op.operationType === "delete" ?
      { recordName: op.record.recordName, deleted: true, fields: {} } : { ...values.find(record => record.recordName === op.record.recordName)!, recordChangeTag: "advanced", fields: { ...values.find(record => record.recordName === op.record.recordName)!.fields, ...op.record.fields } }) });
  }), { dsid: "123", clientId: "synthetic", clientBuildNumber: "synthetic", clientMasteringNumber: "synthetic",
    cloudKitURL: "https://p01-ckdatabasews.icloud.com/database/1/com.apple.reminders/production/private", remindersZoneOwner: owner });
  await assert.rejects(client.modifyScheduling(plan.write, plan.dependencies, undefined, plan.guards), hasCode("WRITE_OUTCOME_UNKNOWN"));
  assert.equal(calls, 1);
});


test("custom recurrence edits through calendar conversion preserve end instants and remove incompatible patterns", async () => {
  const values = records();
  values[3].fields.Interval = { type: "INT64", value: 3 };
  values[3].fields.DaysOfTheWeek = { type: "BYTES", value: b64(utf8(JSON.stringify([{ dayOfTheWeek: 2, weekNumber: 0 }, { dayOfTheWeek: 4, weekNumber: 0 }]))) };
  values[3].fields.EndDate = { type: "TIMESTAMP", value: Date.parse("2027-09-01T09:00:00+01:00") };
  const graph = await loadSchedulingGraph(values[0], owner, lookup(values));
  const plan = planReminderUpdate(graph, { ...request(values[0]), changes: { allDay: true, dueDate: "2027-07-11T00:00:00Z", recurrence: { frequency: "monthly", interval: 2, monthDays: [17, 31] } } }, owner, now + 1000);
  assert.ok(plan.supported); assert.equal(plan.operationCount, 4);
  assert.deepEqual(plan.before.recurrence, { frequency: "weekly", interval: 3, weekdays: [1, 3], endDate: "2027-09-01T08:00:00.000Z" });
  assert.deepEqual(plan.after.recurrence, { frequency: "monthly", interval: 2, monthDays: [17, 31], endDate: "2027-09-01T08:00:00.000Z" });
  const ruleWrite = plan.dependencies.find(record => record.recordType === "RecurrenceRule")!;
  assert.deepEqual(ruleWrite.fields.DaysOfTheWeek, { type: "BYTES", value: null });
  assert.equal(ruleWrite.fields.EndDate, undefined);
  assert.deepEqual(JSON.parse(Buffer.from(String(ruleWrite.fields.DaysOfTheMonth.value), "base64").toString()), [17, 31]);
  let modifyCalls = 0;
  const client = new CloudKitRemindersClient(new AppleHTTP(new CookieJar(), async (_, init) => {
    modifyCalls++;
    const body = JSON.parse(String(init?.body)); assert.equal(body.atomic, true); assert.equal(body.operations.length, 4);
    const recurrence = body.operations.find((op: { record: CloudKitRecord }) => op.record.recordType === "RecurrenceRule").record;
    assert.deepEqual(recurrence.fields.DaysOfTheWeek, { type: "BYTES", value: null });
    return Response.json({ records: body.operations.map((op: { operationType: string; record: CloudKitRecord }) => {
      if (op.operationType === "delete") return { recordName: op.record.recordName, deleted: true };
      const original = values.find(record => record.recordName === op.record.recordName)!;
      const fields = { ...original.fields, ...op.record.fields };
      for (const [key, wrapper] of Object.entries(fields)) if (wrapper && typeof wrapper === "object" && "value" in wrapper && wrapper.value === null) delete fields[key];
      return { ...original, fields, recordChangeTag: "custom-confirmed" };
    }) });
  }), { dsid: "123", clientId: "synthetic", clientBuildNumber: "synthetic", clientMasteringNumber: "synthetic",
    cloudKitURL: "https://p01-ckdatabasews.icloud.com/database/1/com.apple.reminders/production/private", remindersZoneOwner: owner });
  const confirmed = await client.modifyScheduling(plan.write, plan.dependencies, undefined, plan.guards);
  for (const dependency of plan.dependencies) verifySchedulingWrite(dependency, values.find(record => record.recordName === dependency.recordName), confirmed.find(record => record.recordName === dependency.recordName)!, owner);
  assert.equal(modifyCalls, 1);
  const root = { ...values[0], recordChangeTag: "all-day-custom", fields: { ...values[0].fields, ...plan.write.fields } };
  delete root.fields.TimeZone;
  const rule = { ...values[3], recordChangeTag: "monthly-custom", fields: { ...values[3].fields, ...ruleWrite.fields } };
  delete rule.fields.DaysOfTheWeek;
  verifySchedulingWrite(ruleWrite, values[3], rule);
  const allDayGraph = await loadSchedulingGraph(root, owner, lookup([root, rule]));
  const ordinal = planReminderUpdate(allDayGraph, { listId, reminderId: root.recordName, recordChangeTag: root.recordChangeTag,
    changes: { recurrence: { frequency: "monthly", interval: 2, ordinalWeekday: { weekday: 2, ordinal: -1 }, endDate: null } } }, owner, now + 2000);
  assert.ok(ordinal.supported); assert.deepEqual(ordinal.after.recurrence, { frequency: "monthly", interval: 2, ordinalWeekday: { weekday: 2, ordinal: -1 }, endDate: null });
  assert.deepEqual(ordinal.dependencies[0].fields.DaysOfTheMonth, { type: "BYTES", value: null });
  assert.deepEqual(JSON.parse(Buffer.from(String(ordinal.dependencies[0].fields.DaysOfTheWeek.value), "base64").toString()), [{ dayOfTheWeek: 3, weekNumber: -1 }]);
  const year = planReminderUpdate(allDayGraph, { listId, reminderId: root.recordName, recordChangeTag: root.recordChangeTag,
    changes: { recurrence: { frequency: "yearly", interval: 2, months: [1, 7] } } }, owner, now + 2000);
  assert.ok(year.supported); assert.deepEqual(year.after.recurrence, { frequency: "yearly", interval: 2, months: [1, 7], endDate: "2027-09-01T08:00:00.000Z" });
  assert.deepEqual(year.dependencies[0].fields.DaysOfTheMonth, { type: "BYTES", value: null });
});

test("custom recurrence input and current-rule inspection reject incompatible, duplicated and unknown calendar patterns", async () => {
  for (const input of [
    { frequency: "weekly", interval: 3, weekdays: [1, 1] },
    { frequency: "monthly", interval: 2, weekdays: [2] },
    { frequency: "monthly", interval: 2, monthDays: [17, 31], ordinalWeekday: { weekday: 2, ordinal: -1 } },
    { frequency: "monthly", interval: 2, monthDays: [0, 32] },
    { frequency: "yearly", interval: 2, months: [1, 1] },
    { frequency: "daily", interval: 1000 },
    { frequency: "weekly", interval: 3, endDate: "2027-09-01" },
  ]) assert.equal(RecurrenceChanges.safeParse(input).success, false);
  const values = records();
  values[3].fields.DaysOfTheWeek = { type: "BYTES", value: b64(utf8(JSON.stringify([{ dayOfTheWeek: 3, weekNumber: -1, calendar: "unobserved" }]))) };
  assert.throws(() => readRecurrence(values[3]), hasCode("UNSUPPORTED_FEATURE"));
  const graph = await loadSchedulingGraph(values[0], owner, lookup(values));
  assert.equal(planReminderUpdate(graph, request(values[0]), owner, now + 1000).supported, false);
  assert.equal(planReminderUpdate(graph, { ...request(values[0]), changes: { dueDate: null } }, owner, now + 1000).supported, false);
});
