import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { AppError } from "../src/errors.ts";
import { b64, utf8 } from "../src/crypto/bytes.ts";
import { CloudKitRemindersClient, type CloudKitLookupResult, type CloudKitRecord } from "../src/icloud/cloudkit.ts";
import { AppleHTTP } from "../src/transport/apple-http.ts";
import { CookieJar } from "../src/transport/cookie-jar.ts";
import { canonicalJSON, fingerprint } from "../src/lib/canonical.ts";
import { buildCreateReminder, CreateReminderInput, UpdateReminderInput } from "../src/reminders/writes.ts";
import { loadSchedulingGraph, attachEarlyReminderWitness } from "../src/reminders/linked-records.ts";
import { planReminderUpdate } from "../src/reminders/mutation-plan.ts";
import { absoluteDatePairShape, dateComponents, decodeDateComponents, dueDateNonce } from "../src/reminders/linked-date.ts";

import { RecurrenceChanges, readRecurrence } from "../src/reminders/recurrence.ts";
import { verifySchedulingWrite } from "../src/reminders/scheduling-plan.ts";
import { nextRecurringDue, planRecurringCompletion, recurringIdentities, verifyRecurringExpected } from "../src/reminders/recurring-lifecycle.ts";
import { RecurringIntentSchema } from "../src/persistence/apple-sessions.ts";
import { inspectRecurringRecovery, requireUnchangedRecurringRetry } from "../src/reminders/recurring-recovery.ts";
import { planRecurringDeletion } from "../src/reminders/recurring-deletion.ts";
import { planDateAlarmLifecycle } from "../src/reminders/date-alarm-lifecycle.ts";
import { RecurrenceCalendarTimeZone, recurrenceEndCalendarLabel } from "../src/reminders/recurrence-calendar.ts";
import { earlyReminderPayload } from "../src/reminders/early-reminder.ts";

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

test("repeat intervals advance calendar units across clock changes, leap years and month boundaries", () => {
  const cases = [
    ["2027-03-26T09:00:00Z", "Europe/London", false, "daily", 2, "2027-03-28T08:00:00.000Z"],
    ["2027-10-29T08:00:00Z", "Europe/London", false, "daily", 2, "2027-10-31T09:00:00.000Z"],
    ["2026-10-12T08:00:00Z", "Europe/London", false, "weekly", 3, "2026-11-02T09:00:00.000Z"],
    ["2028-02-28T00:00:00Z", null, true, "daily", 2, "2028-03-01T00:00:00.000Z"],
    ["2027-01-31T09:00:00Z", "Europe/London", false, "monthly", 2, "2027-03-31T08:00:00.000Z"],
    ["2027-12-31T00:00:00Z", null, true, "last-day-monthly", 2, "2028-02-29T00:00:00.000Z"],
    ["2027-01-29T09:00:00Z", "Europe/London", false, "monthly-29", 2, "2027-03-29T08:00:00.000Z"],
    ["2000-01-01T00:00:00Z", null, true, "daily", 999, "2002-09-26T00:00:00.000Z"],
    ["2000-01-31T00:00:00Z", null, true, "last-day-monthly", 999, "2083-04-30T00:00:00.000Z"],
    ["2000-01-10T09:00:00Z", "Europe/London", false, "monthly", 999, "2083-04-10T08:00:00.000Z"],
  ] as const;
  for (const [due, zone, allDay, kind, interval, expected] of cases)
    assert.equal(nextRecurringDue(due, zone, allDay, kind, interval), expected);
  for (const interval of [0, -1, 1.5, 1000, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER])
    assert.throws(() => nextRecurringDue("2027-01-01T00:00:00Z", null, true, "daily", interval), hasCode("UNSUPPORTED_FEATURE"));
  for (const [due, kind, interval] of [
    ["2027-03-26T01:30:00Z", "daily", 2], ["2027-10-29T00:30:00Z", "daily", 2],
    ["2027-12-31T09:00:00Z", "monthly", 2], ["9999-01-10T09:00:00Z", "monthly", 12],
  ] as const) assert.throws(() => nextRecurringDue(due, "Europe/London", false, kind, interval), hasCode("UNSUPPORTED_FEATURE"));
});

test("date parser diagnostics identify rejected protocol fields without exposing private payload values or unknown keys", () => {
  const payload: Record<string, unknown> = { ...dateComponents("2027-01-10T09:00:00Z", "Europe/London"),
    year: "private-field-value", "private-native-key": "private-native-value", calendar: "private-calendar-value" };
  delete payload.second;
  assert.throws(() => decodeDateComponents(b64(utf8(JSON.stringify(payload)))), error => {
    assert.ok(hasCode("UNSUPPORTED_FEATURE")(error));
    const message = (error as Error).message;
    assert.ok(message.includes("year:invalid_type")); assert.ok(message.includes("second:invalid_type"));
    assert.ok(message.includes("calendar:unexpected")); assert.ok(message.includes("unrecognized:unexpected"));
    assert.ok(!message.includes("private-")); assert.ok(!message.includes("Europe/London"));
    return true;
  });
});

test("Gregorian date components accept only an optional false leap-month marker", () => {
  const ordinary = dateComponents("2027-01-10T09:00:00Z", "Europe/London");
  assert.deepEqual(decodeDateComponents(b64(utf8(JSON.stringify({ ...ordinary, isLeapMonth: false })))), { ...ordinary, isLeapMonth: false });
  for (const isLeapMonth of [true, null, 0, "false", {}, []])
    assert.throws(() => decodeDateComponents(b64(utf8(JSON.stringify({ ...ordinary, isLeapMonth })))), hasCode("UNSUPPORTED_FEATURE"));
});

test("multi-interval completion preserves the exact rule, independent history and retained replay identities", async () => {
  for (const [frequency, interval, expected] of [
    [0, 2, "2027-01-12T09:00:00Z"], [1, 3, "2027-01-31T09:00:00Z"], [2, 2, "2027-03-10T09:00:00Z"],
    [0, 999, "2029-10-05T08:00:00Z"],
  ] as const) {
    const values = records(), ids = recurringIdentities();
    values[3].fields.Frequency = { type: "INT64", value: frequency };
    values[3].fields.Interval = { type: "INT64", value: interval };
    values[2].fields.DateComponentsData = { type: "BYTES", value: b64(utf8(JSON.stringify({
      ...dateComponents("2027-01-10T09:00:00Z", "Europe/London", true), isLeapMonth: false,
    }))) };
    const before = structuredClone(values);
    const list: CloudKitRecord = { recordName: listId, recordType: "List", recordChangeTag: "list-before", zoneID, raw: {}, fields: {
      Deleted: { type: "INT64", value: 0 }, IsGroup: { type: "INT64", value: 0 },
      ReminderIDs: { type: "STRING", value: JSON.stringify([values[0].recordName.slice(9)]) }, ResolutionTokenMap: { type: "STRING", value: JSON.stringify({ map: {} }) },
    } };
    const graph = await loadSchedulingGraph(values[0], owner, lookup(values));
    const plan = await planRecurringCompletion(graph, list, owner, ids, Date.parse("2027-01-10T12:00:00Z"));
    assert.equal(plan.active.fields.DueDate.value, Date.parse(expected));
    assert.equal(plan.history!.fields.DueDate.value, Date.parse("2027-01-10T09:00:00Z"));
    assert.equal(plan.history!.fields.Completed.value, 1);
    assert.deepEqual(plan.history!.fields.RecurrenceRuleIDs.value, []);
    assert.deepEqual(plan.guards, [values[3]]);
    assert.ok(!plan.operations.some(op => op.record.recordType === "RecurrenceRule"));
    for (const op of plan.operations.filter(op => op.operationType === "create" && op.record.recordType === "AlarmTrigger")) {
      const components = decodeDateComponents(op.record.fields.DateComponentsData.value);
      assert.equal(components.isLeapMonth, false); assert.equal(components.nanosecond, 0);
    }
    assert.deepEqual((await planRecurringCompletion(graph, list, owner, ids, plan.timestamp)).operations, plan.operations);
    const receipt = plan.operations.filter(op => op.operationType !== "delete").map(op => {
      const source = [...values, list].find(record => record.recordName === op.record.recordName);
      return { ...op.record, raw: { ...source?.raw, ...(op.record.parent ? { parent: op.record.parent } : {}) },
        recordChangeTag: "after", fields: { ...source?.fields, ...op.record.fields } };
    });
    await verifyRecurringExpected(plan.expected, [...receipt, values[3]], owner);
    const wrongRule = structuredClone(values[3]); wrongRule.fields.Interval = { type: "INT64", value: 1 };
    await assert.rejects(verifyRecurringExpected(plan.expected, [...receipt, wrongRule], owner), hasCode("WRITE_OUTCOME_UNKNOWN"));
    const moved = planReminderUpdate(graph, { ...request(values[0]), changes: { dueDate: "2027-01-09T09:00:00Z" } }, owner, plan.timestamp);
    assert.ok(moved.supported); assert.equal(moved.after.recurrence!.interval, interval);
    assert.equal(decodeDateComponents(moved.dependencies.find(record => record.recordType === "AlarmTrigger")!.fields.DateComponentsData.value).isLeapMonth, false);
    for (const scope of ["occurrence", "all_future"] as const)
      await assert.rejects(planRecurringDeletion(graph, list, owner, scope, undefined, plan.timestamp), hasCode("UNSUPPORTED_FEATURE"));
    assert.deepEqual(values, before);
  }
});

test("ended multi-interval rules advance only on their cadence and complete or reopen the exact final occurrence", async () => {
  for (const allDay of [true, false]) {
    const values = records(), due = allDay ? "2027-01-10T00:00:00Z" : "2027-01-10T09:00:00Z";
    const end = allDay ? "2027-01-14T00:00:00Z" : "2027-01-24T09:00:00Z";
    values[0].fields.DueDate = { type: "TIMESTAMP", value: Date.parse(due) };
    values[3].fields.Interval = { type: "INT64", value: 2 };
    values[3].fields.Frequency = { type: "INT64", value: allDay ? 0 : 1 };
    values[3].fields.EndDate = { type: "TIMESTAMP", value: Date.parse(end) };
    if (allDay) {
      values[0].fields.AllDay = { type: "INT64", value: 1 }; delete values[0].fields.TimeZone;
      values[0].fields.AlarmIDs = { type: "UNKNOWN_LIST", value: [] }; values.splice(1, 2);
    }
    const rule = values.at(-1)!;
    const list: CloudKitRecord = { recordName: listId, recordType: "List", recordChangeTag: "list-before", zoneID, raw: {}, fields: {
      Deleted: { type: "INT64", value: 0 }, IsGroup: { type: "INT64", value: 0 },
      ReminderIDs: { type: "STRING", value: JSON.stringify([values[0].recordName.slice(9)]) }, ResolutionTokenMap: { type: "STRING", value: JSON.stringify({ map: {} }) },
    } };
    const graph = await loadSchedulingGraph(values[0], owner, lookup(values));
    const plan = await planRecurringCompletion(graph, list, owner, undefined, Date.parse(due) + 1000);
    assert.equal(plan.mode, "advance");
    assert.equal(plan.active.fields.DueDate.value, Date.parse(allDay ? "2027-01-12T00:00:00Z" : end));
    const bad = structuredClone(values), badRule = bad.at(-1)!;
    badRule.fields.EndDate = { type: "TIMESTAMP", value: Date.parse(allDay ? "2027-01-13T00:00:00Z" : "2027-01-17T09:00:00Z") };
    await assert.rejects(planRecurringCompletion(await loadSchedulingGraph(bad[0], owner, lookup(bad)), list, owner, undefined, plan.timestamp), hasCode("UNSUPPORTED_FEATURE"));
    values[0].fields.DueDate = { type: "TIMESTAMP", value: Date.parse(end) };
    if (!allDay) values[2].fields.DateComponentsData = { type: "BYTES", value: b64(utf8(JSON.stringify(dateComponents(end, "Europe/London")))) };
    const final = await planRecurringCompletion(await loadSchedulingGraph(values[0], owner, lookup(values)), list, owner, undefined, Date.parse(end) + 1000);
    assert.equal(final.mode, "final"); assert.equal(final.history, undefined); assert.equal(final.active.fields.DueDate, undefined);
    assert.equal(final.active.fields.Completed.value, 1); assert.deepEqual(final.guards.find(record => record.recordName === rule.recordName), rule);
    values[0].fields = { ...values[0].fields, ...final.active.fields };
    const reopened = await planRecurringCompletion(await loadSchedulingGraph(values[0], owner, lookup(values)), list, owner, undefined, final.timestamp + 1000, "reopen");
    assert.equal(reopened.mode, "reopen"); assert.equal(reopened.active.fields.Completed.value, 0); assert.equal(reopened.active.fields.DueDate, undefined);
  }
});

test("date-pair diagnostics report bounded shape and equality without native identities or payloads", async () => {
  const values = records(), graph = await loadSchedulingGraph(values[0], owner, lookup(values));
  const identity = crypto.randomUUID();
  graph.records.find(record => record.recordType === "Alarm")!.fields.AlarmUID = { type: "STRING", value: identity };
  graph.records.find(record => record.recordType === "Alarm")!.fields["not a native field"] = { type: "STRING", value: "private synthetic contents" };
  const shape = absoluteDatePairShape(graph, owner)!;
  assert.equal(shape.alarmUIDMatchesRecord, false);
  assert.equal(shape.alarmUIDMatchesIgnoringCase, false);
  assert.equal(shape.reminderBacklinkMatches, true);
  assert.equal(shape.alarmBacklinkMatches, true);
  assert.ok(shape.alarmFields.includes("unrecognized"));
  assert.ok(!JSON.stringify(shape).includes(identity));
  assert.ok(!JSON.stringify(shape).includes("private synthetic contents"));
  assert.ok(!JSON.stringify(shape).includes(values[0].recordName));
});

test("observed timed monthly completion preserves the active early alert and creates independent old-date history", async () => {
  for (const [before, after] of [
    ["2026-10-14T08:00:00Z", "2026-10-29T09:00:00.000Z"],
    ["2027-01-29T09:00:00Z", "2027-02-28T09:00:00.000Z"],
    ["2028-01-29T09:00:00Z", "2028-02-29T09:00:00.000Z"],
    ["2028-02-29T09:00:00Z", "2028-03-29T08:00:00.000Z"],
    ["2027-12-29T09:00:00Z", "2028-01-29T09:00:00.000Z"],
  ]) assert.equal(nextRecurringDue(before, "Europe/London", false, "monthly-29"), after);
  for (const due of ["2026-03-14T01:30:00Z", "9999-12-29T09:00:00Z"])
    assert.throws(() => nextRecurringDue(due, "Europe/London", false, "monthly-29"));
  const values = records(), due = "2026-10-14T08:00:00Z", timestamp = Date.parse("2026-10-14T12:00:00Z");
  values[0].fields.DueDate = { type: "TIMESTAMP", value: Date.parse(due) };
  values[2].fields.DateComponentsData = { type: "BYTES", value: b64(utf8(JSON.stringify(dateComponents(due, "Europe/London", true)))) };
  Object.assign(values[3].fields, { Frequency: { type: "INT64", value: 2 },
    DaysOfTheMonth: { type: "BYTES", value: b64(utf8("[28,29]")) }, SetPositions: { type: "BYTES", value: b64(utf8("[-1]")) } });
  values[0].fields.DueDateDeltaAlertsData = { type: "ENCRYPTED_BYTES", value: b64(utf8(JSON.stringify({
    reminderIdentifier: values[0].recordName.slice(9), accountIdentifier: crypto.randomUUID(), minimumSupportedVersion: 20230430,
    dueDateDeltaAlerts: [{ creationDate: 800000000.12345, identifier: crypto.randomUUID(), dueDateDeltaUnit: 2,
      dueDateDeltaCount: -1, minimumSupportedAppVersion: 0 }],
  }))) };
  const before = structuredClone(values), ids = recurringIdentities();
  const list: CloudKitRecord = { recordName: listId, recordType: "List", recordChangeTag: "list-before", zoneID, raw: {}, fields: {
    Deleted: { type: "INT64", value: 0 }, IsGroup: { type: "INT64", value: 0 },
    ReminderIDs: { type: "STRING", value: JSON.stringify([values[0].recordName.slice(9)]) },
    ResolutionTokenMap: { type: "STRING", value: JSON.stringify({ map: {} }) },
  } };
  const graph = await loadSchedulingGraph(values[0], owner, lookup(values));
  const plan = await planRecurringCompletion(graph, list, owner, ids, timestamp);
  assert.equal(plan.active.fields.DueDate.value, Date.parse("2026-10-29T09:00:00Z"));
  assert.equal(plan.active.fields.DueDateDeltaAlertsData, undefined);
  assert.equal(plan.active.fields.CreationDate, undefined);
  assert.equal(plan.history!.fields.CreationDate.value, timestamp);
  assert.equal(plan.history!.fields.DueDate.value, Date.parse(due));
  assert.equal(plan.history!.fields.Completed.value, 1);
  assert.deepEqual(plan.history!.fields.RecurrenceRuleIDs.value, []);
  const historical = earlyReminderPayload({ ...plan.history!, raw: {} }), original = earlyReminderPayload(values[0]);
  assert.equal(historical.reminderIdentifier, ids.history);
  assert.equal(historical.accountIdentifier, original.accountIdentifier);
  assert.deepEqual(historical.dueDateDeltaAlerts[0], { ...original.dueDateDeltaAlerts[0], identifier: ids.replicas[22] });
  assert.notEqual(historical.dueDateDeltaAlerts[0].identifier, original.dueDateDeltaAlerts[0].identifier);
  assert.equal(JSON.parse(String(plan.history!.fields.ResolutionTokenMap.value)).map.dueDateDeltaAlertsData.replicaID, ids.replicas[13]);
  const replay = await planRecurringCompletion(graph, list, owner, ids, timestamp);
  assert.deepEqual(replay.operations, plan.operations);
  assert.deepEqual(replay.expected, plan.expected);
  assert.deepEqual(values, before);
  const committed = plan.operations.filter(op => op.operationType !== "delete").map(op => {
    const source = [...values, list].find(record => record.recordName === op.record.recordName);
    return { ...op.record, raw: { ...source?.raw, ...(op.record.parent ? { parent: op.record.parent } : {}) },
      recordChangeTag: "after", fields: { ...source?.fields, ...op.record.fields } };
  });
  await verifyRecurringExpected(plan.expected, [...committed, values[3]], owner);
  let dispatched = 0;
  const client = new CloudKitRemindersClient(new AppleHTTP(new CookieJar(), async (_, init) => {
    dispatched++;
    const payload = JSON.parse(String(init?.body));
    assert.equal(payload.atomic, true);
    return Response.json({ records: payload.operations.map((op: { operationType: string; record: CloudKitRecord }) => {
      if (op.operationType === "delete") return { recordName: op.record.recordName, deleted: true };
      const source = [...values, list].find(record => record.recordName === op.record.recordName);
      return { ...op.record, fields: { ...source?.fields, ...op.record.fields }, recordChangeTag: "after", zoneID };
    }) });
  }), { dsid: "123", clientId: "synthetic", clientBuildNumber: "synthetic", clientMasteringNumber: "synthetic",
    cloudKitURL: "https://p01-ckdatabasews.icloud.com/database/1/com.apple.reminders/production/private", remindersZoneOwner: owner });
  await client.modifyRecurringCompletion(plan, async () => {});
  assert.equal(dispatched, 1);
  const forged = structuredClone(plan);
  forged.history!.fields.DueDateDeltaAlertsData = values[0].fields.DueDateDeltaAlertsData as { type: string; value: unknown };
  await assert.rejects(client.modifyRecurringCompletion(forged, async () => {}), hasCode("VALIDATION_ERROR"));
  assert.equal(dispatched, 1);
  const changed = structuredClone(committed);
  changed.find(record => record.recordName === plan.history!.recordName)!.fields.DueDateDeltaAlertsData = values[0].fields.DueDateDeltaAlertsData;
  await assert.rejects(verifyRecurringExpected(plan.expected, [...changed, values[3]], owner), hasCode("WRITE_OUTCOME_UNKNOWN"));
  assert.equal(RecurringIntentSchema.safeParse({ requestFingerprint: "a".repeat(64), sourceFingerprint: plan.sourceFingerprint,
    phase: "prepared", timestamp, ids, expected: plan.expected, retired: plan.retired }).success, true);
  const acknowledged = structuredClone(values), acknowledgedPayload = earlyReminderPayload(acknowledged[0]);
  acknowledgedPayload.dueDateDeltaAlerts[0].acknowledgedDate = 800000100.98765;
  acknowledged[0].fields.DueDateDeltaAlertsData = { type: "ENCRYPTED_BYTES", value: b64(utf8(JSON.stringify(acknowledgedPayload))) };
  const acknowledgedGraph = await loadSchedulingGraph(acknowledged[0], owner, lookup(acknowledged));
  const acknowledgedPlan = await planRecurringCompletion(acknowledgedGraph, list, owner, ids, timestamp);
  assert.equal(acknowledgedPlan.active.fields.DueDateDeltaAlertsData, undefined);
  assert.deepEqual(earlyReminderPayload({ ...acknowledgedPlan.history!, raw: {} }).dueDateDeltaAlerts[0],
    { ...acknowledgedPayload.dueDateDeltaAlerts[0], identifier: ids.replicas[22] });
  assert.deepEqual((await planRecurringCompletion(acknowledgedGraph, list, owner, ids, timestamp)).operations, acknowledgedPlan.operations);
  assert.notEqual(acknowledgedPlan.sourceFingerprint, plan.sourceFingerprint);
  const acknowledgedCommitted = acknowledgedPlan.operations.filter(op => op.operationType !== "delete").map(op => {
    const source = [...acknowledged, list].find(record => record.recordName === op.record.recordName);
    return { ...op.record, raw: { ...source?.raw, ...(op.record.parent ? { parent: op.record.parent } : {}) },
      recordChangeTag: "after", fields: { ...source?.fields, ...op.record.fields } };
  });
  await verifyRecurringExpected(acknowledgedPlan.expected, [...acknowledgedCommitted, acknowledged[3]], owner);
  const acknowledgedAlarm = structuredClone(acknowledged);
  acknowledgedAlarm[1].fields.AcknowledgedDate = { type: "TIMESTAMP", value: timestamp - 1000 };
  acknowledgedAlarm[1].fields.AlarmUID = { type: "STRING", value: crypto.randomUUID().toUpperCase() };
  const acknowledgedAlarmGraph = await loadSchedulingGraph(acknowledgedAlarm[0], owner, lookup(acknowledgedAlarm));
  const acknowledgedAlarmPlan = await planRecurringCompletion(acknowledgedAlarmGraph, list, owner, ids, timestamp);
  assert.deepEqual(acknowledgedAlarmPlan.active.fields, acknowledgedPlan.active.fields);
  assert.deepEqual(acknowledgedAlarmPlan.history!.fields, acknowledgedPlan.history!.fields);
  assert.ok(acknowledgedAlarmPlan.operations.filter(op => op.operationType === "create" && op.record.recordType === "Alarm")
    .every(op => !Object.hasOwn(op.record.fields, "AcknowledgedDate") && op.record.fields.AlarmUID.value === op.record.recordName.slice(6)));
  assert.deepEqual(acknowledgedAlarmPlan.retired, acknowledgedPlan.retired);
  assert.notEqual(acknowledgedAlarmPlan.sourceFingerprint, acknowledgedPlan.sourceFingerprint);
  for (const field of [{ type: "DOUBLE", value: timestamp - 1000 }, { type: "TIMESTAMP", value: timestamp + 1000 },
    { type: "TIMESTAMP", value: "private synthetic value" }, { type: "TIMESTAMP", value: timestamp - 1000, unknown: true }]) {
    const invalid = structuredClone(acknowledgedAlarm);
    invalid[1].fields.AcknowledgedDate = field;
    await assert.rejects(planRecurringCompletion(await loadSchedulingGraph(invalid[0], owner, lookup(invalid)), list, owner, ids, timestamp), hasCode("UNSUPPORTED_FEATURE"));
  }
  const missingAck = structuredClone(acknowledgedAlarm); delete missingAck[1].fields.AcknowledgedDate;
  await assert.rejects(planRecurringCompletion(await loadSchedulingGraph(missingAck[0], owner, lookup(missingAck)), list, owner, ids, timestamp), hasCode("UNSUPPORTED_FEATURE"));
  const nullAck = structuredClone(acknowledgedAlarm); nullAck[1].fields.AcknowledgedDate = { type: "TIMESTAMP", value: null };
  assert.equal((await planRecurringCompletion(await loadSchedulingGraph(nullAck[0], owner, lookup(nullAck)), list, owner, ids, timestamp)).active.fields.DueDate.value,
    acknowledgedPlan.active.fields.DueDate.value);
  for (const variant of ["daily", "no-early", "two-days", "all-day", "ended", "wrong-pattern", "location"]) {
    const altered = structuredClone(values);
    if (variant === "daily") { altered[3].fields.Frequency = { type: "INT64", value: 0 }; delete altered[3].fields.DaysOfTheMonth; delete altered[3].fields.SetPositions; }
    if (variant === "no-early") delete altered[0].fields.DueDateDeltaAlertsData;
    if (variant === "two-days") {
      const payload = earlyReminderPayload(altered[0]);
      payload.dueDateDeltaAlerts[0].dueDateDeltaCount = -2;
      altered[0].fields.DueDateDeltaAlertsData = { type: "ENCRYPTED_BYTES", value: b64(utf8(JSON.stringify(payload))) };
    }
    if (variant === "all-day") altered[0].fields.AllDay = { type: "INT64", value: 1 };
    if (variant === "ended") altered[3].fields.EndDate = { type: "TIMESTAMP", value: Date.parse("2026-11-29T09:00:00Z") };
    if (variant === "wrong-pattern") altered[3].fields.DaysOfTheMonth = { type: "BYTES", value: b64(utf8("[27,28]")) };
    if (variant === "location") altered[2].fields.Type = { type: "STRING", value: "Location" };
    await assert.rejects(planRecurringCompletion(await loadSchedulingGraph(altered[0], owner, lookup(altered)), list, owner, ids, timestamp));
  }
});

test("ordinary monthly completion follows a moved due date, retaining the rule and independent completed history", async () => {
  for (const [before, after] of [
    ["2026-10-14T08:00:00Z", "2026-11-14T09:00:00.000Z"],
    ["2026-11-14T09:00:00Z", "2026-12-14T09:00:00.000Z"],
    ["2026-10-18T08:00:00Z", "2026-11-18T09:00:00.000Z"],
    ["2026-12-18T09:00:00Z", "2027-01-18T09:00:00.000Z"],
    ["2028-02-18T09:00:00Z", "2028-03-18T09:00:00.000Z"],
  ]) assert.equal(nextRecurringDue(before, "Europe/London", false, "monthly"), after);
  for (const due of ["2026-01-31T09:00:00Z", "2027-02-28T01:30:00Z", "2026-09-25T00:30:00Z", "9999-12-18T09:00:00Z"])
    assert.throws(() => nextRecurringDue(due, "Europe/London", false, "monthly"), hasCode("UNSUPPORTED_FEATURE"));
  for (const withEarly of [false, true]) {
    const values = records(), due = "2026-10-13T08:00:00Z", timestamp = Date.parse("2026-10-14T12:00:00Z");
    values[0].fields.DueDate = { type: "TIMESTAMP", value: Date.parse(due) };
    values[2].fields.DateComponentsData = { type: "BYTES", value: b64(utf8(JSON.stringify(dateComponents(due, "Europe/London", true)))) };
    values[3].fields.Frequency = { type: "INT64", value: 2 };
    if (withEarly) values[0].fields.DueDateDeltaAlertsData = { type: "ENCRYPTED_BYTES", value: b64(utf8(JSON.stringify({
      reminderIdentifier: values[0].recordName.slice(9), accountIdentifier: crypto.randomUUID(), minimumSupportedVersion: 20230430,
      dueDateDeltaAlerts: [{ creationDate: 800000000.12345, identifier: crypto.randomUUID(), dueDateDeltaUnit: 2,
        dueDateDeltaCount: -1, minimumSupportedAppVersion: 0 }],
    }))) };
    const original = structuredClone(values), graph = await loadSchedulingGraph(values[0], owner, lookup(values));
    const moved = planReminderUpdate(graph, { ...request(values[0]), changes: { dueDate: "2026-10-18T09:00:00+01:00" } }, owner, timestamp);
    assert.ok(moved.supported);
    assert.deepEqual(moved.after.recurrence, { frequency: "monthly", interval: 1, endDate: null });
    const changed: CloudKitRecord[] = values.map(record => {
      const update = record.recordType === "Reminder" ? moved.write : moved.dependencies.find(write => write.recordName === record.recordName);
      return { ...record, fields: { ...record.fields, ...update?.fields } };
    });
    const list: CloudKitRecord = { recordName: listId, recordType: "List", recordChangeTag: "list-before", zoneID, raw: {}, fields: {
      Deleted: { type: "INT64", value: 0 }, IsGroup: { type: "INT64", value: 0 },
      ReminderIDs: { type: "STRING", value: JSON.stringify([values[0].recordName.slice(9)]) },
      ResolutionTokenMap: { type: "STRING", value: JSON.stringify({ map: {} }) },
    } };
    const changedGraph = await loadSchedulingGraph(changed[0], owner, lookup(changed)), ids = recurringIdentities();
    const plan = await planRecurringCompletion(changedGraph, list, owner, ids, timestamp);
    assert.equal(plan.active.fields.DueDate.value, Date.parse("2026-11-18T09:00:00Z"));
    assert.equal(plan.history!.fields.DueDate.value, Date.parse("2026-10-18T08:00:00Z"));
    assert.equal(plan.history!.fields.Completed.value, 1);
    assert.deepEqual(plan.history!.fields.RecurrenceRuleIDs.value, []);
    assert.ok(plan.guards.some(record => record.recordName === ruleId));
    assert.equal(plan.active.fields.DueDateDeltaAlertsData, undefined);
    if (withEarly) assert.notEqual(earlyReminderPayload({ ...plan.history!, raw: {} }).dueDateDeltaAlerts[0].identifier,
      earlyReminderPayload(changed[0]).dueDateDeltaAlerts[0].identifier);
    assert.deepEqual((await planRecurringCompletion(changedGraph, list, owner, ids, timestamp)).operations, plan.operations);
    assert.deepEqual(values, original);
    const committed = plan.operations.filter(op => op.operationType !== "delete").map(op => {
      const source = [...changed, list].find(record => record.recordName === op.record.recordName);
      return { ...op.record, raw: { ...source?.raw, ...(op.record.parent ? { parent: op.record.parent } : {}) },
        recordChangeTag: "after", fields: { ...source?.fields, ...op.record.fields } };
    });
    await verifyRecurringExpected(plan.expected, [...committed, changed[3]], owner);
    const ended = structuredClone(changed); ended[3].fields.EndDate = { type: "TIMESTAMP", value: Date.parse("2027-01-18T09:00:00Z") };
    await assert.rejects(planRecurringCompletion(await loadSchedulingGraph(ended[0], owner, lookup(ended)), list, owner, ids, timestamp), hasCode("UNSUPPORTED_FEATURE"));
  }
});

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
  const asset = { type: "ASSETID", value: { downloadURL: "https://synthetic.invalid/one", wrappingKey: "synthetic-key", fileChecksum: "synthetic-checksum", referenceChecksum: "reference", size: 10 } };
  const withAsset = { ...values[0], fields: { ...values[0].fields, UrgentPresentationAlarmsAsData: asset } };
  const assetGraph = await loadSchedulingGraph(withAsset, owner, lookup(values));
  const signedGraph = await loadSchedulingGraph({ ...withAsset, fields: { ...withAsset.fields, UrgentPresentationAlarmsAsData: { ...asset, value: { ...asset.value, downloadURL: "https://synthetic.invalid/two" } } } }, owner, lookup(values));
  assert.equal(signedGraph.fingerprint, assetGraph.fingerprint);
  for (const key of ["wrappingKey", "fileChecksum"]) {
    const drift = await loadSchedulingGraph({ ...withAsset, fields: { ...withAsset.fields, UrgentPresentationAlarmsAsData: { ...asset, value: { ...asset.value, [key]: "changed" } } } }, owner, lookup(values));
    assert.notEqual(drift.fingerprint, assetGraph.fingerprint);
  }
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
  const privatePayload = { reminderIdentifier: values[0].recordName.slice(9), accountIdentifier: "00000000-0000-4000-8000-000000000010", minimumSupportedVersion: 20230430,
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
  assert.equal(planReminderUpdate(graph, { ...request(values[0]), changes: { dueDate: null } }, owner, now).supported, true);
  const removed = planReminderUpdate(graph, { ...request(values[0]), changes: { earlyReminder: null } }, owner, now + 2000);
  assert.ok(removed.supported); assert.equal(removed.after.earlyReminder, null);
  assert.deepEqual(removed.write.fields.DueDateDeltaAlertsData, { type: "ENCRYPTED_BYTES", value: null });
  assert.equal(removed.operationCount, 4); assert.equal(removed.dependencies.length, 0);
  delete values[0].fields.DueDateDeltaAlertsData;
  assert.equal(planReminderUpdate(await loadSchedulingGraph(values[0], owner, lookup(values)), { ...request(values[0]), changes: { earlyReminder: { unit: "minutes", count: 15 } } }, owner, now).supported, false);
  const plainGraph = await loadSchedulingGraph(values[0], owner, lookup(values));
  const sourceId = "Reminder/00000000-0000-4000-8000-000000000011";
  const source: CloudKitRecord = { ...structuredClone(values[0]), recordName: sourceId, recordChangeTag: "source-before", fields: { ...values[0].fields,
    DueDateDeltaAlertsData: { type: "ENCRYPTED_BYTES", value: b64(utf8(JSON.stringify({ ...privatePayload, reminderIdentifier: sourceId.slice(9),
      dueDateDeltaAlerts: [{ ...privatePayload.dueDateDeltaAlerts[0], acknowledgedDate: 800_000_100.25 }] }))) } } };
  delete source.fields.AlarmIDs; delete source.fields.RecurrenceRuleIDs;
  const witnessedGraph = await attachEarlyReminderWitness(plainGraph, source);
  assert.notEqual(witnessedGraph.fingerprint, plainGraph.fingerprint);
  const creation = planReminderUpdate(witnessedGraph, { ...request(values[0]), changes: { earlyReminder: { unit: "days", count: 2 } } }, owner, now);
  assert.ok(creation.supported); assert.equal(creation.after.earlyReminder?.unit, "days");
  const createdPayload = JSON.parse(Buffer.from(String(creation.write.fields.DueDateDeltaAlertsData.value), "base64").toString());
  assert.equal(createdPayload.accountIdentifier, privatePayload.accountIdentifier);
  assert.equal(createdPayload.reminderIdentifier, values[0].recordName.slice(9));
  assert.notEqual(createdPayload.dueDateDeltaAlerts[0].identifier, privatePayload.dueDateDeltaAlerts[0].identifier);
  assert.equal(createdPayload.dueDateDeltaAlerts[0].creationDate, now / 1000 - 978_307_200);
  assert.equal(createdPayload.dueDateDeltaAlerts[0].dueDateDeltaUnit, 2); assert.equal(createdPayload.dueDateDeltaAlerts[0].dueDateDeltaCount, -2);
  assert.equal(createdPayload.dueDateDeltaAlerts[0].acknowledgedDate, undefined, "A new alert never inherits its metadata source's acknowledgement.");
  assert.ok(creation.guards.some(record => record.recordName === sourceId && record.recordChangeTag === "source-before"));
  const foreignSource = structuredClone(source); foreignSource.fields.List = { type: "REFERENCE", value: { recordName: "List/OTHER", action: "VALIDATE", zoneID } };
  assert.throws(() => planReminderUpdate({ ...witnessedGraph, earlyReminderWitness: foreignSource }, { ...request(values[0]), changes: { earlyReminder: { unit: "days", count: 2 } } }, owner, now), hasCode("CONFLICT"));
});

test("date moves preserve acknowledged early alerts and the native monthly final-selection rule without enabling offset or recurrence edits", async () => {
  const values = records();
  const alert = { identifier: "00000000-0000-4000-8000-000000000009", creationDate: 800_000_000.125,
    acknowledgedDate: 800_000_100.25, dueDateDeltaUnit: 2, dueDateDeltaCount: -1, minimumSupportedAppVersion: 0 };
  const payload = { reminderIdentifier: values[0].recordName.slice(9), accountIdentifier: "00000000-0000-4000-8000-000000000010",
    minimumSupportedVersion: 20230430, dueDateDeltaAlerts: [alert] };
  const earlyField = { type: "ENCRYPTED_BYTES", value: b64(utf8(JSON.stringify(payload, null, 2))) };
  values[0].fields.DueDateDeltaAlertsData = earlyField;
  Object.assign(values[3].fields, { Frequency: { type: "INT64", value: 2 },
    DaysOfTheMonth: { type: "BYTES", value: b64(utf8("[28,29]")) }, SetPositions: { type: "BYTES", value: b64(utf8("[-1]")) } });
  const before = structuredClone(values), graph = await loadSchedulingGraph(values[0], owner, lookup(values));
  const input = { ...request(values[0]), changes: { dueDate: "2027-10-14T09:00:00+01:00", timeZone: "Europe/London" } };
  const plan = planReminderUpdate(graph, input, owner, now + 1000);
  assert.ok(plan.supported); assert.equal(plan.operationCount, 4);
  assert.equal(plan.after.dueDate, "2027-10-14T08:00:00.000Z");
  assert.deepEqual(plan.before.earlyReminder, { count: 1, unit: "days" });
  assert.deepEqual(plan.after.earlyReminder, plan.before.earlyReminder);
  assert.deepEqual(plan.before.recurrence, { frequency: "monthly", interval: 1, endDate: null, monthDays: [28, 29], setPositions: [-1] });
  assert.deepEqual(plan.after.recurrence, plan.before.recurrence);
  assert.equal(plan.write.fields.DueDateDeltaAlertsData, undefined, "Even JSON formatting and acknowledgement bytes stay untouched.");
  assert.equal(plan.write.fields.Completed, undefined);
  assert.equal(plan.dependencies.some(record => record.recordType === "RecurrenceRule"), false);
  assert.ok(plan.guards.some(record => record.recordName === ruleId && record.recordChangeTag === "rule-before"));
  assert.deepEqual(values, before, "Preview never changes the captured graph.");
  assert.throws(() => readRecurrence(values[3]), hasCode("UNSUPPORTED_FEATURE"));
  for (const changes of [{ recurrence: { frequency: "monthly" as const, interval: 2 } }, { allDay: true, dueDate: "2027-10-14T00:00:00Z" },
    { earlyReminder: { unit: "hours" as const, count: 1 } }]) {
    const refused = planReminderUpdate(graph, { ...input, changes }, owner, now);
    assert.equal(refused.supported, false); assert.equal(refused.operationCount, 0);
  }
  for (const invalid of [
    { ...payload, dueDateDeltaAlerts: [{ ...alert, acknowledgedDate: "yesterday" }] },
    { ...payload, dueDateDeltaAlerts: [{ ...alert, futureField: true }] },
    { ...payload, reminderIdentifier: "00000000-0000-4000-8000-000000000099" },
    { ...payload, dueDateDeltaAlerts: [{ ...alert, dueDateDeltaUnit: 99 }] },
  ]) {
    const altered = structuredClone(values); altered[0].fields.DueDateDeltaAlertsData = { type: "ENCRYPTED_BYTES", value: b64(utf8(JSON.stringify(invalid))) };
    const refused = planReminderUpdate(await loadSchedulingGraph(altered[0], owner, lookup(altered)), input, owner, now);
    assert.equal(refused.supported, false); assert.equal(refused.operationCount, 0);
    assert.match(refused.unsupportedReason!, /acknowledgedDate|unreviewed fields|reminderIdentifier|dueDateDeltaUnit/);
  }
  const altered = structuredClone(values); altered[3].fields.SetPositions = { type: "BYTES", value: b64(utf8("[1]")) };
  assert.equal(planReminderUpdate(await loadSchedulingGraph(altered[0], owner, lookup(altered)), input, owner, now).supported, false);
  for (const malformed of ["missing-days", "non-string-positions", "non-finite-positions"]) {
    const altered = structuredClone(values);
    if (malformed === "missing-days") delete altered[3].fields.DaysOfTheMonth;
    else altered[3].fields.SetPositions = { type: "BYTES", value: malformed === "non-string-positions" ? [b64(utf8("[-1]"))] : b64(utf8("[-1e400]")) };
    const refused = planReminderUpdate(await loadSchedulingGraph(altered[0], owner, lookup(altered)), input, owner, now);
    assert.equal(refused.supported, false); assert.equal(refused.operationCount, 0);
  }
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
  assert.equal(planReminderUpdate(graph, { ...request(values[0]), changes: { dueDate: null } }, owner, now).supported, true);
  assert.equal(planReminderUpdate(graph, { ...request(values[0]), changes: { allDay: true, dueDate: "2027-07-11T00:00:00Z" } }, owner, now).supported, true);
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

test("recurrence lifecycle and mixed calendar conversions preserve location and early metadata until date clearing", async () => {
  const values = withLocation().filter(record => record.recordType !== "RecurrenceRule");
  // Both native UUID and canonical record-name trigger links survive the whole journey.
  values[3].fields.TriggerID = { type: "STRING", value: values[4].recordName };
  delete values[0].fields.RecurrenceRuleIDs;
  const earlyPayload = { reminderIdentifier: values[0].recordName.slice(9), accountIdentifier: "00000000-0000-4000-8000-000000000010", minimumSupportedVersion: 20230430,
    dueDateDeltaAlerts: [{ identifier: "00000000-0000-4000-8000-000000000009", creationDate: 800_000_000, dueDateDeltaUnit: 1, dueDateDeltaCount: -1, minimumSupportedAppVersion: 0 }] };
  const earlyField = { type: "ENCRYPTED_BYTES", value: b64(utf8(JSON.stringify(earlyPayload))) };
  values[0].fields.DueDateDeltaAlertsData = earlyField;
  const store = new Map(values.map(record => [record.recordName, structuredClone(record)]));
  const locationBefore = values.filter(record => record.recordName !== alarmId && record.recordName !== triggerId && record.recordType !== "Reminder");
  let calls = 0;
  const client = new CloudKitRemindersClient(new AppleHTTP(new CookieJar(), async (_, init) => {
    calls++; const body = JSON.parse(String(init?.body)); assert.equal(body.atomic, true);
    const stale = body.operations.find((op: { operationType: string; record: CloudKitRecord }) => op.operationType !== "create" && store.get(op.record.recordName)?.recordChangeTag !== op.record.recordChangeTag);
    if (stale) return Response.json({ records: body.operations.map((op: { record: CloudKitRecord }) => ({ recordName: op.record.recordName, serverErrorCode: op === stale ? "CONFLICT" : "ATOMIC_ERROR" })) });
    return Response.json({ records: body.operations.map((op: { operationType: string; record: CloudKitRecord }) => {
      if (op.operationType === "delete") { store.delete(op.record.recordName); return { recordName: op.record.recordName, deleted: true }; }
      const before = store.get(op.record.recordName), fields = { ...before?.fields, ...op.record.fields };
      for (const [key, unknownField] of Object.entries(fields)) {
        const field = unknownField as { type: string; value: unknown };
        if (field.value === null) delete fields[key];
        else if (op.operationType === "create" && field.type === "REFERENCE") fields[key] = { ...field, value: { ...(field.value as object), zoneID } };
      }
      const after = { ...op.record, fields, recordChangeTag: `${before?.recordChangeTag ?? "new"}-next`, zoneID, raw: {} };
      store.set(after.recordName, after); return { ...after, zoneID: undefined };
    }).reverse() });
  }), { dsid: "123", clientId: "synthetic", clientBuildNumber: "synthetic", clientMasteringNumber: "synthetic",
    cloudKitURL: "https://p01-ckdatabasews.icloud.com/database/1/com.apple.reminders/production/private", remindersZoneOwner: owner });
  const planCurrent = async (changes: Parameters<typeof planReminderUpdate>[1]["changes"]) => {
    const root = store.get(values[0].recordName)!;
    return planReminderUpdate(await loadSchedulingGraph(root, owner, lookup([...store.values()])), { ...request(root), changes }, owner, now + calls * 1000);
  };
  const apply = async (plan: Awaited<ReturnType<typeof planCurrent>>) => {
    assert.ok(plan.supported); const before = structuredClone([...store.values()]);
    const confirmed = await client.modifyScheduling(plan.write, plan.dependencies, undefined, plan.guards);
    for (const dependency of plan.dependencies) verifySchedulingWrite(dependency, before.find(record => record.recordName === dependency.recordName), confirmed.find(record => record.recordName === dependency.recordName)!, owner);
    for (const record of locationBefore) assert.deepEqual(store.get(record.recordName)!.fields, record.fields);
  };
  const create = await planCurrent({ recurrence: { frequency: "weekly", interval: 3, weekdays: [1, 3], endDate: "2027-09-01T08:00:00Z" } });
  assert.ok(create.supported); assert.equal(create.dependencies.length, 1);
  const createdRule = create.dependencies[0]; assert.equal(createdRule.operationType, "create");
  assert.deepEqual(create.after.recurrence, { frequency: "weekly", interval: 3, weekdays: [1, 3], endDate: "2027-09-01T08:00:00.000Z" });
  const badCreate = structuredClone(create.dependencies); badCreate[0].fields.Calendar = { type: "STRING", value: "unknown" };
  await assert.rejects(client.modifyScheduling(create.write, badCreate, undefined, create.guards), hasCode("VALIDATION_ERROR")); assert.equal(calls, 0);
  await apply(create);
  const remove = await planCurrent({ recurrence: null }); assert.ok(remove.supported);
  assert.equal(remove.after.recurrence, null); assert.equal(remove.write.fields.DueDate, undefined);
  await apply(remove);
  assert.deepEqual(store.get(createdRule.recordName)!.fields.Deleted, { type: "INT64", value: 1 });
  assert.equal(store.get(createdRule.recordName)!.fields.Reminder, undefined);
  assert.deepEqual(store.get(values[0].recordName)!.fields.DueDateDeltaAlertsData, earlyField);
  const recreate = await planCurrent({ recurrence: { frequency: "hourly", interval: 2 } }); assert.ok(recreate.supported);
  assert.notEqual(recreate.dependencies[0].recordName, createdRule.recordName);
  assert.equal(Object.keys(recreate.dependencies[0].fields).length, 7); assert.equal(recreate.dependencies[0].fields.Frequency.value, 4); await apply(recreate);
  await assert.rejects(planCurrent({ allDay: true, dueDate: "2027-07-11T00:00:00Z", recurrence: { frequency: "hourly", interval: 3 } }), hasCode("VALIDATION_ERROR"));
  const allDay = await planCurrent({ allDay: true, dueDate: "2027-07-11T00:00:00Z" }); assert.ok(allDay.supported);
  assert.deepEqual(allDay.dependencies.filter(record => record.operationType === "delete").map(record => [record.recordType, record.operationType]), [["AlarmTrigger", "delete"], ["Alarm", "delete"]]);
  assert.equal(allDay.write.fields.DueDateDeltaAlertsData, undefined); assert.equal(allDay.after.earlyReminder?.unit, "hours");
  assert.equal(allDay.after.recurrence, null); assert.deepEqual(allDay.write.fields.RecurrenceRuleIDs.value, []);
  assert.equal(allDay.dependencies.find(record => record.recordType === "RecurrenceRule")!.fields.Deleted.value, 1);
  assert.deepEqual(allDay.write.fields.AlarmIDs.value, [locationBefore[0].recordName.slice(6)]);
  await apply(allDay); assert.equal(store.has(alarmId), false); assert.equal(store.has(triggerId), false);
  assert.deepEqual(store.get(values[0].recordName)!.fields.DueDateDeltaAlertsData, earlyField);
  const allDayClear = await planCurrent({ dueDate: null }); assert.ok(allDayClear.supported);
  assert.equal(allDayClear.write.fields.AllDay, undefined); assert.equal(allDayClear.write.fields.TimeZone, undefined);
  assert.deepEqual(allDayClear.write.fields.DueDateDeltaAlertsData, { type: "ENCRYPTED_BYTES", value: null });
  const timed = await planCurrent({ allDay: false, dueDate: "2027-07-12T09:00:00+01:00", timeZone: "Europe/London", recurrence: { frequency: "daily", interval: 2 } }); assert.ok(timed.supported);
  assert.equal(timed.dependencies.filter(record => record.operationType === "create").length, 3);
  assert.equal(timed.write.fields.DueDateDeltaAlertsData, undefined); await apply(timed);
  assert.deepEqual(store.get(values[0].recordName)!.fields.DueDateDeltaAlertsData, earlyField);
  const clear = await planCurrent({ dueDate: null, recurrence: null, earlyReminder: null }); assert.ok(clear.supported);
  assert.equal(clear.after.recurrence, null); assert.equal(clear.after.earlyReminder, null);
  assert.equal(clear.write.fields.TimeZone, undefined); assert.equal(clear.write.fields.AllDay, undefined);
  assert.equal(clear.dependencies.filter(record => record.operationType === "delete").length, 2);
  assert.deepEqual(clear.write.fields.AlarmIDs.value, [locationBefore[0].recordName.slice(6)]);
  const beforeClear = structuredClone([...store.values()]), raced = store.get(locationBefore[1].recordName)!;
  const exactTag = raced.recordChangeTag; raced.recordChangeTag = "concurrent-location";
  await assert.rejects(client.modifyScheduling(clear.write, clear.dependencies, undefined, clear.guards), hasCode("CONFLICT"));
  for (const record of beforeClear) assert.deepEqual(store.get(record.recordName)?.fields, record.fields);
  raced.recordChangeTag = exactTag;
  const missingLocationGuard = clear.guards.filter(record => record.recordName !== locationBefore[1].recordName);
  await assert.rejects(client.modifyScheduling(clear.write, clear.dependencies, undefined, missingLocationGuard), hasCode("VALIDATION_ERROR"));
  await apply(clear); assert.equal(calls, 7);
  const clearedRoot = store.get(values[0].recordName)!;
  assert.equal(clearedRoot.fields.DueDate, undefined); assert.equal(clearedRoot.fields.DueDateDeltaAlertsData, undefined);
  assert.deepEqual(clearedRoot.fields.TimeZone, { type: "STRING", value: "Europe/London" }); assert.deepEqual(clearedRoot.fields.AllDay, { type: "INT64", value: 0 });
  const invalidGraph = await loadSchedulingGraph(clearedRoot, owner, lookup([...store.values()]));
  assert.equal(planReminderUpdate(invalidGraph, { ...request(clearedRoot), changes: { recurrence: { frequency: "daily", interval: 1 } } }, owner, now).supported, false);
  assert.throws(() => planReminderUpdate(invalidGraph, { ...request(clearedRoot), changes: { recurrence: null } }, owner, now), hasCode("VALIDATION_ERROR"));
  for (const changes of [{ dueDate: null, recurrence: { frequency: "daily" as const, interval: 1 } }, { dueDate: null, earlyReminder: { unit: "hours" as const, count: 1 } }, { allDay: true, dueDate: "2027-08-01T00:00:00Z", locationAlarm: null }]) assert.throws(() => planReminderUpdate(invalidGraph, { ...request(clearedRoot), changes }, owner, now), hasCode("VALIDATION_ERROR"));
  const addDate = await planCurrent({ dueDate: "2027-08-14T03:00:00+01:00", timeZone: "Europe/London", allDay: false });
  assert.ok(addDate.supported); assert.equal(addDate.dependencies.filter(record => record.operationType === "create").length, 2);
  assert.equal(addDate.after.dueDate, "2027-08-14T02:00:00.000Z");
  assert.ok(addDate.guards.some(record => record.recordName === locationBefore[0].recordName));
  await apply(addDate); assert.equal(calls, 8);
  const addedDateTrigger = addDate.dependencies.find(record => record.recordType === "AlarmTrigger")!;
  assert.equal(decodeDateComponents(addedDateTrigger.fields.DateComponentsData.value).hour, 3);
  assert.throws(() => planReminderUpdate(invalidGraph, { ...request(clearedRoot), changes: { dueDate: "2027-08-14T03:00:00+01:00" } }, owner, now), hasCode("VALIDATION_ERROR"));
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

test("ordinary absolute-date lifecycle preserves its pair, guards every version and soft-deletes without new identities", async () => {
  const source = records().slice(0, 3); delete source[0].fields.RecurrenceRuleIDs;
  source[0].raw = { parent: { recordName: listId } }; source[1].raw = { parent: { recordName: source[0].recordName } }; source[2].raw = { parent: { recordName: alarmId } };
  const list: CloudKitRecord = { recordName: listId, recordType: "List", recordChangeTag: "list-before", raw: {}, fields: {
    Name: { type: "STRING", value: "Synthetic lifecycle" }, Deleted: { type: "INT64", value: 0 }, IsGroup: { type: "INT64", value: 0 },
    ReminderIDs: { type: "STRING", value: JSON.stringify(["KEEP", source[0].recordName, "OTHER"]) }, ResolutionTokenMap: { type: "STRING", value: JSON.stringify({ map: {} }) },
  } };
  const store = new Map([list, ...source].map(record => [record.recordName, record]));
  let dispatches = 0, stale: string | undefined;
  const client = new CloudKitRemindersClient(new AppleHTTP(new CookieJar(), async (value, init) => {
    const payload = JSON.parse(String(init?.body));
    if (String(value).includes("/records/lookup")) return Response.json({ records: payload.records.map((item: { recordName: string }) => {
      const record = store.get(item.recordName)!; return { ...record, parent: record.raw.parent, raw: undefined };
    }) });
    dispatches++; assert.equal(payload.atomic, true); assert.equal(payload.operations.length, 4);
    assert.ok(payload.operations.every((operation: { operationType: string }) => operation.operationType === "update"));
    if (stale) return Response.json({ records: payload.operations.map((operation: { record: { recordName: string } }) => ({ recordName: operation.record.recordName,
      serverErrorCode: operation.record.recordName === stale ? "CONFLICT" : "ATOMIC_ERROR" })) });
    const results = payload.operations.map((operation: { record: CloudKitRecord & { parent?: { recordName: string | null } } }) => {
      const before = store.get(operation.record.recordName)!, fields = { ...before.fields, ...operation.record.fields };
      let parent = before.raw.parent;
      if (operation.record.parent?.recordName === null) parent = undefined;
      const wire = { ...operation.record, fields, parent, recordChangeTag: `${before.recordChangeTag}-next`, zoneID };
      store.set(wire.recordName, { ...wire, raw: { parent } });
      return operation.record.parent?.recordName === null ? { ...wire, parent: before.raw.parent } : wire;
    });
    return Response.json({ records: results.reverse() });
  }), { dsid: "123", clientId: "synthetic", clientBuildNumber: "synthetic", clientMasteringNumber: "synthetic", cloudKitURL: "https://p01-ckdatabasews.icloud.com/database/1/com.apple.reminders/production/private", remindersZoneOwner: owner });
  const make = async (action: "complete" | "reopen" | "delete") => {
    const root = store.get(source[0].recordName)!;
    const graph = await loadSchedulingGraph(root, owner, lookup([...store.values()]));
    return planDateAlarmLifecycle(action, { listId, reminderId: root.recordName, recordChangeTag: root.recordChangeTag! }, graph, store.get(listId)!, owner, now + dispatches * 1000);
  };
  const complete = await make("complete");
  for (const id of [alarmId, listId]) { stale = id; await assert.rejects(client.modifyDateAlarmLifecycle(complete, async () => {}), hasCode("CONFLICT")); }
  stale = undefined;
  const pairBefore = source.slice(1).map(record => structuredClone(record));
  await client.modifyDateAlarmLifecycle(complete, async () => {});
  assert.equal(store.get(source[0].recordName)!.fields.Completed && (store.get(source[0].recordName)!.fields.Completed as { value: number }).value, 1);
  for (const before of pairBefore) { assert.deepEqual(store.get(before.recordName)!.fields, before.fields); assert.deepEqual(store.get(before.recordName)!.raw.parent, before.raw.parent); }
  await client.modifyDateAlarmLifecycle(await make("reopen"), async () => {});
  const deletion = await make("delete");
  assert.deepEqual(Object.keys(deletion.operations[1].record.fields), ["Deleted"]); assert.deepEqual(Object.keys(deletion.operations[2].record.fields), ["Deleted"]);
  await client.modifyDateAlarmLifecycle(deletion, async () => {});
  assert.equal(store.size, 4); assert.equal(store.get(source[0].recordName)!.raw.parent, undefined);
  for (const before of pairBefore) assert.deepEqual(store.get(before.recordName)!.fields, { ...before.fields, Deleted: { type: "INT64", value: 1 } });
  assert.deepEqual(JSON.parse(String((store.get(listId)!.fields.ReminderIDs as { value: string }).value)), ["KEEP", "OTHER"]);
  const bad = records().slice(0, 3); delete bad[0].fields.RecurrenceRuleIDs;
  bad[1].fields.DueDateResolutionTokenAsNonce = { type: "DOUBLE", value: 0 };
  const badGraph = await loadSchedulingGraph(bad[0], owner, lookup(bad));
  const badInput = { listId, reminderId: bad[0].recordName, recordChangeTag: bad[0].recordChangeTag! };
  assert.throws(() => planDateAlarmLifecycle("complete", badInput, badGraph, list, owner), hasCode("CONFLICT"));
  bad[1].fields.DueDateResolutionTokenAsNonce = source[1].fields.DueDateResolutionTokenAsNonce;
  bad[0].fields.UnknownParentIDs = { type: "STRING_LIST", value: ["unknown"] };
  assert.throws(() => planDateAlarmLifecycle("complete", badInput, badGraph, list, owner), hasCode("UNSUPPORTED_FEATURE"));
  assert.equal(dispatches, 5);
});

test("unknown recurring completion retries require unchanged source versions and definite absence of every original create ID", async () => {
  const values = records(), root = values[0];
  const list: CloudKitRecord = { recordName: listId, recordType: "List", recordChangeTag: "list-before", zoneID, raw: {}, fields: {
    Deleted: { type: "INT64", value: 0 }, IsGroup: { type: "INT64", value: 0 }, ReminderIDs: { type: "STRING", value: JSON.stringify([root.recordName.slice(9)]) },
    ResolutionTokenMap: { type: "STRING", value: JSON.stringify({ map: {} }) },
  } };
  const graph = await loadSchedulingGraph(root, owner, lookup(values));
  const plan = await planRecurringCompletion(graph, list, owner, recurringIdentities(), Date.parse("2027-01-11T00:00:00Z"));
  const intent = RecurringIntentSchema.parse({ requestFingerprint: "a".repeat(64), sourceFingerprint: plan.sourceFingerprint, timestamp: plan.timestamp,
    ids: plan.ids, expected: plan.expected, retired: plan.retired, phase: "dispatched" });
  const read = async (ids: string[]): Promise<CloudKitLookupResult> => ({ requestedRecordNames: ids,
    records: [...values, list].filter(record => ids.includes(record.recordName)),
    recordErrors: ids.filter(id => ![...values, list].some(record => record.recordName === id)).map(recordName => ({ recordName, serverErrorCode: "NOT_FOUND", reason: null, raw: {} })),
    unresolvedRecordNames: [], complete: ids.every(id => [...values, list].some(record => record.recordName === id)),
  });
  const client = { lookup: read, lookupSchedulingRecords: read };
  await requireUnchangedRecurringRetry(client, intent, plan);
  const diagnostic = await inspectRecurringRecovery(client, intent, root, list, owner);
  assert.equal(diagnostic.sourceUnchanged, true); assert.equal(diagnostic.outcome, "unresolved");
  assert.equal(diagnostic.missingExpectedIds.length, 5); assert.equal(diagnostic.retiredIdsStillPresent.length, 2);
  for (const phase of ["prepared", "confirmed"] as const)
    await assert.rejects(requireUnchangedRecurringRetry(client, { ...intent, phase }, plan), hasCode("CONFLICT"));
  const changed = structuredClone(values); changed[1].recordChangeTag = "alarm-changed";
  const changedPlan = await planRecurringCompletion(await loadSchedulingGraph(changed[0], owner, lookup(changed)), list, owner, intent.ids, intent.timestamp);
  await assert.rejects(requireUnchangedRecurringRetry(client, intent, changedPlan), hasCode("CONFLICT"));
  for (const faulty of [
    async (ids: string[]) => ({ ...(await read(ids)), recordErrors: [], unresolvedRecordNames: ids }),
    async (ids: string[]) => ({ ...(await read(ids)), recordErrors: ids.map(recordName => ({ recordName, serverErrorCode: "ACCESS_DENIED", reason: null, raw: {} })) }),
    async (ids: string[]) => ({ ...(await read(ids)), records: [{ ...root, recordName: ids[0] }] }),
    async (ids: string[]) => ({ ...(await read(ids)), recordErrors: ids.map(() => ({ recordName: ids[0], serverErrorCode: "NOT_FOUND", reason: null, raw: {} })) }),
  ]) await assert.rejects(requireUnchangedRecurringRetry({ lookup: faulty, lookupSchedulingRecords: faulty }, intent, plan), hasCode("CONFLICT"));
  const nextIds = await planRecurringCompletion(graph, list, owner, recurringIdentities(), intent.timestamp);
  await assert.rejects(requireUnchangedRecurringRetry(client, intent, nextIds), hasCode("CONFLICT"));
});

test("recurring completion preserves encoded history, advances calendar dates and replaces only the exact date pair atomically", async () => {
  assert.equal(nextRecurringDue("2026-10-19T08:00:00Z", "Europe/London", false, "weekly"), "2026-10-26T09:00:00.000Z");
  assert.equal(nextRecurringDue("2027-01-31T00:00:00Z", null, true, "last-day-monthly"), "2027-02-28T00:00:00.000Z");
  assert.equal(nextRecurringDue("2027-02-28T00:00:00Z", null, true, "last-day-monthly"), "2027-03-31T00:00:00.000Z");
  assert.equal(nextRecurringDue("2026-10-20T00:00:00Z", null, true, "daily"), "2026-10-21T00:00:00.000Z");
  for (const [before, after, hours] of [["2027-03-27T09:00:00Z", "2027-03-28T08:00:00.000Z", 23], ["2027-10-30T08:00:00Z", "2027-10-31T09:00:00.000Z", 25]] as const) {
    assert.equal(nextRecurringDue(before, "Europe/London", false, "daily"), after);
    assert.equal((Date.parse(after) - Date.parse(before)) / 3_600_000, hours);
  }
  for (const due of ["2027-03-27T01:30:00Z", "2027-10-30T00:30:00Z"])
    assert.throws(() => nextRecurringDue(due, "Europe/London", false, "daily"), hasCode("UNSUPPORTED_FEATURE"));
  const values = records(), root = values[0];
  root.fields.TitleDocument = { ...(root.fields.TitleDocument as object), type: "ENCRYPTED_BYTES" };
  const list: CloudKitRecord = { recordName: listId, recordType: "List", recordChangeTag: "list-before", zoneID, raw: {}, fields: {
    Deleted: { type: "INT64", value: 0 }, IsGroup: { type: "INT64", value: 0 }, ReminderIDs: { type: "STRING", value: JSON.stringify(["KEEP", root.recordName.slice(9), "OTHER"]) },
    ResolutionTokenMap: { type: "STRING", value: JSON.stringify({ map: {} }) }, OpaqueMembership: { type: "STRING", value: "preserve" },
  } };
  const graph = await loadSchedulingGraph(root, owner, lookup(values)), ids = recurringIdentities();
  const plan = await planRecurringCompletion(graph, list, owner, ids, Date.parse("2027-01-11T00:00:00Z"));
  assert.ok(plan.history); assert.ok(plan.membership);
  assert.equal(plan.active.fields.Completed.value, 0);
  assert.equal(plan.history.fields.TitleDocument.type, "STRING");
  assert.equal(plan.history.fields.TitleDocument.value, (root.fields.TitleDocument as { value: string }).value);
  assert.equal(plan.history.fields.CreationDate.value, (root.fields.CreationDate as { value: number }).value);
  assert.deepEqual(plan.history.fields.RecurrenceRuleIDs.value, []);
  assert.deepEqual(JSON.parse(String(plan.membership.fields.ReminderIDs.value)), ["KEEP", ids.history, root.recordName.slice(9), "OTHER"]);
  assert.deepEqual(plan.retired.sort(), [alarmId, triggerId].sort());
  assert.equal(plan.operations.filter(operation => operation.operationType === "create").length, 5);
  assert.equal(plan.operations.filter(operation => operation.operationType === "delete" && operation.record.recordType === "Reminder").length, 0);
  assert.equal((await planRecurringCompletion(graph, list, owner, ids, plan.timestamp)).sourceFingerprint, plan.sourceFingerprint);
  // Intents saved before zone-expansion support must remain reconcilable.
  for (const record of [...plan.operations.filter(operation => operation.operationType === "create" && ["Alarm", "AlarmTrigger"].includes(operation.record.recordType)).map(operation => operation.record), values[3]]) {
    assert.equal(plan.expected.find(entry => entry.id === record.recordName)?.hash,
      await fingerprint({ id: record.recordName, type: record.recordType, fields: record.fields }));
  }
  let dispatches = 0;
  const client = (stale?: string, lose = false, foreignReference?: "Alarm" | "AlarmTrigger") => new CloudKitRemindersClient(new AppleHTTP(new CookieJar(), async (_, init) => {
    dispatches++;
    const payload = JSON.parse(String(init?.body)); assert.equal(payload.atomic, true); assert.equal(payload.operations.length, 10);
    if (stale) return Response.json({ records: payload.operations.map((operation: { record: { recordName: string } }) => ({ recordName: operation.record.recordName, serverErrorCode: operation.record.recordName === stale ? "CONFLICT" : "ATOMIC_ERROR" })) });
    if (lose) return new Response("lost", { status: 503 });
    return Response.json({ records: payload.operations.map((operation: { operationType: string; record: CloudKitRecord }) => {
      if (operation.operationType === "delete") return { recordName: operation.record.recordName, deleted: true };
      const before = [list, ...values].find(record => record.recordName === operation.record.recordName);
      const fields = { ...before?.fields, ...operation.record.fields };
      if (operation.operationType === "create" && ["Alarm", "AlarmTrigger"].includes(operation.record.recordType)) {
        const key = operation.record.recordType === "Alarm" ? "Reminder" : "Alarm", reference = fields[key] as { type: string; value: object };
        fields[key] = { ...reference, value: { ...reference.value, zoneID: { ...zoneID, ownerRecordName: operation.record.recordType === foreignReference ? "synthetic-foreign-owner" : owner } } };
      }
      return { ...operation.record, fields, recordChangeTag: `next-${operation.record.recordName}`, zoneID };
    }).reverse() });
  }), { dsid: "123", clientId: "synthetic", clientBuildNumber: "synthetic", clientMasteringNumber: "synthetic", cloudKitURL: "https://p01-ckdatabasews.icloud.com/database/1/com.apple.reminders/production/private", remindersZoneOwner: owner });
  await client().modifyRecurringCompletion(plan, async () => {});
  for (const stale of [ruleId, listId, alarmId]) await assert.rejects(client(stale).modifyRecurringCompletion(plan, async () => {}), hasCode("CONFLICT"));
  await assert.rejects(client(undefined, true).modifyRecurringCompletion(plan, async () => {}), hasCode("WRITE_OUTCOME_UNKNOWN"));
  for (const type of ["Alarm", "AlarmTrigger"] as const) await assert.rejects(client(undefined, false, type).modifyRecurringCompletion(plan, async () => {}), hasCode("WRITE_OUTCOME_UNKNOWN"));
  assert.equal(dispatches, 7);
  const dailyRecords = (due: string) => {
    const source = records(); source[0].fields.DueDate = { type: "TIMESTAMP", value: Date.parse(due) };
    source[0].fields.Flagged = { type: "INT64", value: 1 }; source[0].fields.Priority = { type: "INT64", value: 5 };
    source[0].fields.TitleDocument = { ...(source[0].fields.TitleDocument as object), type: "ENCRYPTED_BYTES", nativeDocumentMetadata: "preserve" };
    source[0].fields.UrgentPresentationAlarmsAsData = { type: "ASSETID", nativeWrapperMetadata: "preserve", value: {
      downloadURL: "https://synthetic.invalid/first", wrappingKey: "synthetic-wrapping", referenceSignature: "synthetic-reference", fileChecksum: "synthetic-content", size: 64,
    } };
    source[0].fields.UrgentPresentationAlarmsChecksum = { type: "STRING", value: "synthetic-policy-checksum", nativeChecksumMetadata: "preserve" };
    source[2].fields.DateComponentsData = { type: "BYTES", value: b64(utf8(JSON.stringify(dateComponents(due, "Europe/London", true)))) };
    source[3].fields.Frequency = { type: "INT64", value: 0 };
    return source;
  };
  const timedDaily = dailyRecords("2027-03-27T09:00:00Z"), timedDailyBefore = structuredClone(timedDaily), dailyTime = Date.parse("2027-03-27T12:00:00Z");
  const timedDailyGraph = await loadSchedulingGraph(timedDaily[0], owner, lookup(timedDaily));
  const dailyPlan = await planRecurringCompletion(timedDailyGraph, list, owner, ids, dailyTime);
  assert.equal(dailyPlan.active.recordName, timedDaily[0].recordName); assert.equal(dailyPlan.mode, "advance");
  assert.equal(dailyPlan.active.fields.DueDate.value, Date.parse("2027-03-28T08:00:00Z"));
  assert.deepEqual(Object.keys(dailyPlan.active.fields).sort(), ["AlarmIDs", "Completed", "CompletionDate", "DueDate", "LastModifiedDate", "ResolutionTokenMap"]);
  for (const key of ["DueDate", "CreationDate", "Flagged", "Priority", "TimeZone"])
    assert.deepEqual(dailyPlan.history!.fields[key], timedDaily[0].fields[key]);
  assert.equal(dailyPlan.history!.fields.TitleDocument.value, (timedDaily[0].fields.TitleDocument as { value: string }).value);
  assert.equal(dailyPlan.history!.fields.TitleDocument.type, "STRING"); assert.deepEqual(dailyPlan.history!.fields.RecurrenceRuleIDs.value, []);
  assert.deepEqual(dailyPlan.retired.slice().sort(), [alarmId, triggerId].sort()); assert.equal(dailyPlan.operations.length, 9);
  assert.deepEqual(dailyPlan.guards, [timedDaily[3]]); assert.equal(dailyPlan.guards[0].recordChangeTag, "rule-before");
  assert.deepEqual(JSON.parse(String(dailyPlan.membership!.fields.ReminderIDs.value)), ["KEEP", ids.history, timedDaily[0].recordName.slice(9), "OTHER"]);
  const pairs = dailyPlan.operations.filter(operation => operation.operationType === "create" && operation.record.recordType === "AlarmTrigger");
  assert.deepEqual(pairs.map(operation => decodeDateComponents(operation.record.fields.DateComponentsData.value)),
    [dateComponents("2027-03-28T08:00:00Z", "Europe/London", true), dateComponents("2027-03-27T09:00:00Z", "Europe/London", true)]);
  const presentationEntry = dailyPlan.expected.find(entry => entry.id === timedDaily[0].recordName)!;
  assert.match(presentationEntry.presentationHash!, /^[a-f0-9]{64}$/);
  assert.equal(dailyPlan.expected.filter(entry => entry.presentationHash !== undefined).length, 1);
  assert.ok(plan.expected.every(entry => entry.presentationHash === undefined), "Legacy weekly intent projections are unchanged.");
  const intent = { requestFingerprint: await fingerprint({ synthetic: "daily-completion" }), sourceFingerprint: dailyPlan.sourceFingerprint,
    timestamp: dailyTime, phase: "dispatched", ids, expected: dailyPlan.expected, retired: dailyPlan.retired };
  assert.ok(RecurringIntentSchema.safeParse(intent).success);
  const legacyExpected = intent.expected.map(({ id, type, hash }) => ({ id, type, hash }));
  assert.ok(RecurringIntentSchema.safeParse({ ...intent, expected: legacyExpected }).success);
  assert.equal(RecurringIntentSchema.safeParse({ ...intent, expected: intent.expected.map(entry => ({ ...entry, presentationHash: "invalid" })) }).success, false);
  let dailyDispatches = 0;
  const dailyReceipt = (variant?: string): CloudKitRecord[] => [...dailyPlan.operations.filter(operation => operation.operationType !== "delete").map(operation => {
    const before = [...timedDaily, list].find(record => record.recordName === operation.record.recordName);
    const record: CloudKitRecord = { ...operation.record, recordChangeTag: "daily-confirmed", zoneID, raw: { ...before?.raw, ...(operation.record.parent ? { parent: operation.record.parent } : {}) },
      fields: structuredClone({ ...before?.fields, ...operation.record.fields }) };
    if (record.recordName === dailyPlan.active.recordName) {
      const asset = record.fields.UrgentPresentationAlarmsAsData as { value: Record<string, unknown>; nativeWrapperMetadata?: string };
      asset.value.downloadURL = "https://synthetic.invalid/refreshed";
      if (variant === "crypto") asset.value.wrappingKey = "changed";
      if (variant === "reference") asset.value.referenceSignature = "changed";
      if (variant === "content") asset.value.fileChecksum = "changed";
      if (variant === "size") asset.value.size = 65;
      if (variant === "wrapper") asset.nativeWrapperMetadata = "changed";
      if (variant === "checksum") record.fields.UrgentPresentationAlarmsChecksum = { type: "STRING", value: "changed" };
      if (variant === "checksum-wrapper") record.fields.UrgentPresentationAlarmsChecksum = { ...(record.fields.UrgentPresentationAlarmsChecksum as object), nativeChecksumMetadata: "changed" };
      if (variant === "omission") delete record.fields.UrgentPresentationAlarmsAsData;
      if (variant === "checksum-omission") delete record.fields.UrgentPresentationAlarmsChecksum;
    }
    if (record.recordName === dailyPlan.history!.recordName) record.fields.TitleDocument = { ...(record.fields.TitleDocument as object), type: "ENCRYPTED_BYTES", serverMetadata: "normalized-copy" };
    return record;
  }), { ...timedDaily[3], recordChangeTag: "rule-confirmed" }];
  const dailyClient = (variant?: string) => new CloudKitRemindersClient(new AppleHTTP(new CookieJar(), async (_, init) => {
    dailyDispatches++; const payload = JSON.parse(String(init?.body)); assert.equal(payload.atomic, true); assert.equal(payload.operations.length, 10);
    if ([alarmId, ruleId, listId].includes(variant ?? "")) return Response.json({ records: payload.operations.map((operation: { record: CloudKitRecord }) => ({ recordName: operation.record.recordName,
      serverErrorCode: operation.record.recordName === variant ? "CONFLICT" : "ATOMIC_ERROR" })) });
    return Response.json({ records: [...dailyReceipt(variant).map(record => ({ ...record, parent: record.raw.parent })), ...dailyPlan.retired.map(recordName => ({ recordName, deleted: true }))].reverse() });
  }), { dsid: "123", clientId: "synthetic", clientBuildNumber: "synthetic", clientMasteringNumber: "synthetic", cloudKitURL: "https://p01-ckdatabasews.icloud.com/database/1/com.apple.reminders/production/private", remindersZoneOwner: owner });
  await dailyClient().modifyRecurringCompletion(dailyPlan, async () => {});
  for (const stale of [alarmId, ruleId, listId]) await assert.rejects(dailyClient(stale).modifyRecurringCompletion(dailyPlan, async () => {}), hasCode("CONFLICT"));
  await assert.rejects(dailyClient("crypto").modifyRecurringCompletion(dailyPlan, async () => {}), hasCode("WRITE_OUTCOME_UNKNOWN"));
  const confirmedDaily = dailyReceipt(), recoveryReads = await lookup(confirmedDaily)(dailyPlan.expected.map(entry => entry.id));
  // The original dispatched intent is checked using only current records; no
  // regenerated IDs, guessed presentation policy or repeat writes are needed.
  await verifyRecurringExpected(RecurringIntentSchema.parse(intent).expected, recoveryReads.records, owner);
  await assert.rejects(verifyRecurringExpected(intent.expected, [...timedDaily, list], owner), hasCode("WRITE_OUTCOME_UNKNOWN"));
  await assert.rejects(verifyRecurringExpected(intent.expected, confirmedDaily.filter(record => record.recordName !== ruleId), owner), hasCode("WRITE_OUTCOME_UNKNOWN"));
  for (const drift of ["crypto", "reference", "content", "size", "wrapper", "checksum", "checksum-wrapper", "omission", "checksum-omission"])
    await assert.rejects(verifyRecurringExpected(intent.expected, dailyReceipt(drift), owner), hasCode("WRITE_OUTCOME_UNKNOWN"));
  await verifyRecurringExpected(legacyExpected, dailyReceipt("crypto"), owner);
  assert.equal(dailyDispatches, 5, "Recovery verification never dispatches another write.");
  const regenerated = structuredClone(timedDaily); (regenerated[0].fields.UrgentPresentationAlarmsAsData as { value: Record<string, unknown> }).value.downloadURL = "https://synthetic.invalid/new-read";
  const regeneratedPlan = await planRecurringCompletion(await loadSchedulingGraph(regenerated[0], owner, lookup(regenerated)), list, owner, ids, dailyTime);
  assert.equal(regeneratedPlan.sourceFingerprint, dailyPlan.sourceFingerprint); assert.deepEqual(regeneratedPlan.expected, dailyPlan.expected);
  const historyRoot = confirmedDaily.find(record => record.recordName === dailyPlan.history!.recordName)!;
  const historyGraph = await loadSchedulingGraph(historyRoot, owner, lookup(confirmedDaily)); assert.equal(historyGraph.records.length, 3);
  const ordinaryReopen = planDateAlarmLifecycle("reopen", { listId, reminderId: historyRoot.recordName, recordChangeTag: historyRoot.recordChangeTag! }, historyGraph,
    confirmedDaily.find(record => record.recordName === listId)!, owner, dailyTime + 1000);
  assert.equal(ordinaryReopen.write.fields.Completed.value, 0);
  assert.deepEqual(timedDaily, timedDailyBefore, "Planning and recovery preserve the original read-only graph.");
  const fallDaily = dailyRecords("2027-10-30T08:00:00Z");
  assert.equal((await planRecurringCompletion(await loadSchedulingGraph(fallDaily[0], owner, lookup(fallDaily)), list, owner, ids, Date.parse("2027-10-30T12:00:00Z"))).active.fields.DueDate.value, Date.parse("2027-10-31T09:00:00Z"));
  const absentPresentation = structuredClone(timedDaily); delete absentPresentation[0].fields.UrgentPresentationAlarmsAsData; delete absentPresentation[0].fields.UrgentPresentationAlarmsChecksum;
  const absentPlan = await planRecurringCompletion(await loadSchedulingGraph(absentPresentation[0], owner, lookup(absentPresentation)), list, owner, ids, dailyTime);
  const absentReceipt = dailyReceipt(); const absentRoot = absentReceipt.find(record => record.recordName === absentPlan.active.recordName)!;
  delete absentRoot.fields.UrgentPresentationAlarmsAsData; delete absentRoot.fields.UrgentPresentationAlarmsChecksum;
  await verifyRecurringExpected(absentPlan.expected, absentReceipt, owner);
  absentRoot.fields.UrgentPresentationAlarmsChecksum = { type: "STRING", value: "replacement" };
  await assert.rejects(verifyRecurringExpected(absentPlan.expected, absentReceipt, owner), hasCode("WRITE_OUTCOME_UNKNOWN"));
  for (const variant of ["no-alarm", "no-zone", "offset-zone", "all-day", "ended", "interval", "tags", "family", "early", "location", "gap", "fold", "nonce"]) {
    const bad = dailyRecords(variant === "gap" ? "2027-03-27T01:30:00Z" : variant === "fold" ? "2027-10-30T00:30:00Z" : "2027-03-27T09:00:00Z");
    if (variant === "no-alarm") { bad[0].fields.AlarmIDs = { type: "UNKNOWN_LIST", value: [] }; bad.splice(1, 2); }
    if (variant === "no-zone") delete bad[0].fields.TimeZone;
    if (variant === "offset-zone") bad[0].fields.TimeZone = { type: "STRING", value: "+01:00" };
    if (variant === "all-day") bad[0].fields.AllDay = { type: "INT64", value: 1 };
    if (variant === "ended") bad[3].fields.EndDate = { type: "TIMESTAMP", value: Date.parse("2027-03-28T00:00:00Z") };
    if (variant === "interval") bad[3].fields.Interval = { type: "INT64", value: 1000 };
    if (variant === "tags") bad[0].fields.HashtagIDs = { type: "STRING_LIST", value: ["synthetic-tag"] };
    if (variant === "family") bad[0].fields.ChildReminderIDs = { type: "STRING_LIST", value: ["synthetic-child"] };
    if (variant === "early") bad[0].fields.DueDateDeltaAlertsData = { type: "BYTES", value: b64(utf8("[]")) };
    if (variant === "location") bad[2].fields.Type = { type: "STRING", value: "Location" };
    if (variant === "nonce") bad[1].fields.DueDateResolutionTokenAsNonce = { type: "DOUBLE", value: 0 };
    const badGraph = await loadSchedulingGraph(bad[0], owner, lookup(bad));
    await assert.rejects(planRecurringCompletion(badGraph, list, owner, ids, variant === "fold" ? Date.parse("2027-10-30T12:00:00Z") : dailyTime),
      hasCode(variant === "nonce" ? "CONFLICT" : "UNSUPPORTED_FEATURE"));
  }
  await assert.rejects(planRecurringCompletion(timedDailyGraph, list, owner, ids, dailyTime, "complete", "Europe/London"), hasCode("UNSUPPORTED_FEATURE"));
  const completedDaily = structuredClone(timedDaily); completedDaily[0].fields.Completed = { type: "INT64", value: 1 }; completedDaily[0].fields.CompletionDate = { type: "TIMESTAMP", value: dailyTime };
  await assert.rejects(planRecurringCompletion(await loadSchedulingGraph(completedDaily[0], owner, lookup(completedDaily)), list, owner, undefined, dailyTime, "reopen"), hasCode("UNSUPPORTED_FEATURE"));
  for (const scope of ["occurrence", "all_future"] as const) await assert.rejects(planRecurringDeletion(timedDailyGraph, list, owner, scope, undefined, dailyTime), hasCode("UNSUPPORTED_FEATURE"));
  const endedWeekly = records(), weeklyDue = "2026-10-19T08:00:00Z", weeklyEnd = "2026-10-26T09:00:00Z";
  endedWeekly[0].fields.DueDate = { type: "TIMESTAMP", value: Date.parse(weeklyDue) };
  endedWeekly[2].fields.DateComponentsData = { type: "BYTES", value: b64(utf8(JSON.stringify(dateComponents(weeklyDue, "Europe/London")))) };
  endedWeekly[3].fields.EndDate = { type: "TIMESTAMP", value: Date.parse(weeklyEnd) };
  const weeklyTime = Date.parse("2026-10-19T12:00:00Z");
  const endedWeeklyGraph = await loadSchedulingGraph(endedWeekly[0], owner, lookup(endedWeekly));
  const weeklyAdvance = await planRecurringCompletion(endedWeeklyGraph, list, owner, ids, weeklyTime);
  assert.equal(weeklyAdvance.mode, "advance"); assert.equal(weeklyAdvance.active.fields.DueDate.value, Date.parse(weeklyEnd));
  assert.equal(weeklyAdvance.intrinsicParentGuards, undefined, "Advancing hashes and retained identities remain legacy compatible.");
  for (const end of ["2026-10-27T09:00:00Z", "2026-10-26T08:00:00Z", "2026-10-26T09:00:00.001Z"]) {
    const badRule = { ...endedWeekly[3], fields: { ...endedWeekly[3].fields, EndDate: { type: "TIMESTAMP", value: Date.parse(end) } } };
    await assert.rejects(planRecurringCompletion(await loadSchedulingGraph(endedWeekly[0], owner, lookup([...endedWeekly.slice(0, 3), badRule])), list, owner, undefined, weeklyTime), hasCode("UNSUPPORTED_FEATURE"));
  }
  const retained = endedWeekly.map(record => structuredClone(record));
  retained[0].fields.DueDate = { type: "TIMESTAMP", value: Date.parse(weeklyEnd) };
  retained[0].raw.parent = { recordName: listId };
  retained[0].fields.UrgentPresentationAlarmsAsData = { type: "ASSETID", value: { downloadURL: "https://synthetic.invalid/one", wrappingKey: "key", fileChecksum: "checksum", size: 1 } };
  retained[1].raw.parent = { recordName: retained[0].recordName }; retained[2].raw.parent = { recordName: alarmId }; retained[3].raw.parent = { recordName: retained[0].recordName };
  retained[2].fields.DateComponentsData = { type: "BYTES", value: b64(utf8(JSON.stringify(dateComponents(weeklyEnd, "Europe/London")))) };
  const weeklyFinalGraph = await loadSchedulingGraph(retained[0], owner, lookup(retained));
  const weeklyFinal = await planRecurringCompletion(weeklyFinalGraph, list, owner, undefined, weeklyTime + 7 * 86_400_000);
  assert.equal(weeklyFinal.mode, "final"); assert.equal(weeklyFinal.intrinsicParentGuards, true); assert.equal(weeklyFinal.history, undefined);
  assert.equal(weeklyFinal.expected.length, 5); assert.deepEqual(Object.keys(weeklyFinal.ids), ["replicas"]);
  assert.deepEqual(weeklyFinal.guards.map(record => record.recordType), ["Alarm", "AlarmTrigger", "RecurrenceRule", "List"]);
  assert.equal(weeklyFinal.active.fields.DueDate, undefined);
  const completedWeekly = { ...retained[0], fields: { ...retained[0].fields, ...weeklyFinal.active.fields } };
  const weeklyReopen = await planRecurringCompletion(await loadSchedulingGraph(completedWeekly, owner, lookup([completedWeekly, ...retained.slice(1)])), list, owner, undefined, weeklyFinal.timestamp + 1000, "reopen");
  assert.equal(weeklyReopen.mode, "reopen"); assert.equal(weeklyReopen.expected.length, 5); assert.equal(weeklyReopen.active.fields.Completed.value, 0);
  await assert.rejects(planRecurringCompletion(weeklyFinalGraph, list, owner, undefined, weeklyFinal.timestamp, "complete", "Europe/London"), hasCode("UNSUPPORTED_FEATURE"));
  const unalarmedWeekly = { ...retained[0], fields: { ...retained[0].fields, AlarmIDs: { type: "UNKNOWN_LIST", value: [] } } };
  const unalarmedFinal = await planRecurringCompletion(await loadSchedulingGraph(unalarmedWeekly, owner, lookup([unalarmedWeekly, retained[3]])), list, owner, undefined, weeklyFinal.timestamp);
  assert.equal(unalarmedFinal.expected.length, 3); assert.equal(unalarmedFinal.intrinsicParentGuards, true);
  let weeklyPosts = 0;
  const weeklyClient = (drift?: string) => new CloudKitRemindersClient(new AppleHTTP(new CookieJar(), async (_, init) => {
    weeklyPosts++; const payload = JSON.parse(String(init?.body));
    assert.equal(payload.atomic, true); assert.equal(payload.operations.length, 5); assert.ok(payload.operations.every((operation: { operationType: string }) => operation.operationType === "update"));
    if ([alarmId, ruleId, listId].includes(drift ?? "")) return Response.json({ records: payload.operations.map((operation: { record: CloudKitRecord }) => ({ recordName: operation.record.recordName, serverErrorCode: operation.record.recordName === drift ? "CONFLICT" : "ATOMIC_ERROR" })) });
    return Response.json({ records: payload.operations.map((operation: { record: CloudKitRecord }) => {
      const before = [...retained, list].find(record => record.recordName === operation.record.recordName)!;
      const result = { ...operation.record, fields: structuredClone({ ...before.fields, ...operation.record.fields }), parent: before.raw.parent, recordChangeTag: "confirmed", zoneID };
      if (result.parent) result.parent = { ...result.parent as object, zoneID };
      if (before.recordType === "Reminder") {
        const asset = result.fields.UrgentPresentationAlarmsAsData as { value: Record<string, unknown> };
        asset.value.downloadURL = "https://synthetic.invalid/two";
        if (drift === "crypto") asset.value.wrappingKey = "changed";
      }
      if (drift === "parent" && before.recordType === "Alarm") result.parent = { recordName: "Reminder/OTHER" };
      return result;
    }) });
  }), { dsid: "123", clientId: "synthetic", clientBuildNumber: "synthetic", clientMasteringNumber: "synthetic", cloudKitURL: "https://p01-ckdatabasews.icloud.com/database/1/com.apple.reminders/production/private", remindersZoneOwner: owner });
  await weeklyClient().modifyRecurringCompletion(weeklyFinal, async () => {});
  for (const stale of [alarmId, ruleId, listId]) await assert.rejects(weeklyClient(stale).modifyRecurringCompletion(weeklyFinal, async () => {}), hasCode("CONFLICT"));
  for (const drift of ["crypto", "parent"]) await assert.rejects(weeklyClient(drift).modifyRecurringCompletion(weeklyFinal, async () => {}), hasCode("WRITE_OUTCOME_UNKNOWN"));
  assert.equal(weeklyPosts, 6);
  const deleting = records(); deleting[0].raw.parent = { recordName: listId };
  deleting[1].raw.parent = { recordName: deleting[0].recordName }; deleting[2].raw.parent = { recordName: alarmId }; deleting[3].raw.parent = { recordName: deleting[0].recordName };
  deleting[0].fields.UrgentPresentationAlarmsAsData = { type: "ASSETID", value: { downloadURL: "https://synthetic.invalid/one", wrappingKey: "key", fileChecksum: "checksum", size: 1 } };
  const deletionGraph = await loadSchedulingGraph(deleting[0], owner, lookup(deleting));
  const occurrenceDelete = await planRecurringDeletion(deletionGraph, list, owner, "occurrence", undefined, plan.timestamp);
  assert.equal(occurrenceDelete.operations.length, 7); assert.equal(occurrenceDelete.expected.length, 5); assert.equal(occurrenceDelete.ids.history, undefined);
  assert.deepEqual(Object.keys(occurrenceDelete.active.fields).sort(), ["AlarmIDs", "DueDate", "LastModifiedDate", "ResolutionTokenMap"]);
  assert.equal(occurrenceDelete.active.fields.DueDate.value, Date.parse("2027-01-17T09:00:00Z"));
  const oldDeletionTokens = JSON.parse(String((deleting[0].fields.ResolutionTokenMap as { value: string }).value)).map;
  const newDeletionTokens = JSON.parse(String(occurrenceDelete.active.fields.ResolutionTokenMap.value)).map;
  assert.deepEqual(newDeletionTokens.completed, oldDeletionTokens.completed); assert.deepEqual(newDeletionTokens.completionDate, oldDeletionTokens.completionDate);
  assert.equal(newDeletionTokens.dueDate.counter, oldDeletionTokens.dueDate.counter + 1);
  assert.ok(occurrenceDelete.operations.filter(operation => operation.operationType === "create").every(operation => ["Alarm", "AlarmTrigger"].includes(operation.record.recordType)));
  const futureDelete = await planRecurringDeletion(deletionGraph, list, owner, "all_future", undefined, plan.timestamp);
  assert.equal(futureDelete.operations.length, 5); assert.deepEqual(Object.keys(futureDelete.ids), ["replicas"]); assert.deepEqual(futureDelete.retired, []);
  assert.deepEqual(Object.keys(futureDelete.active.fields).sort(), ["Deleted", "LastModifiedDate", "List", "ResolutionTokenMap"]); assert.equal(futureDelete.active.parent, null);
  assert.ok(futureDelete.operations.filter(operation => ["Alarm", "AlarmTrigger", "RecurrenceRule"].includes(operation.record.recordType)).every(operation => Object.keys(operation.record.fields).length === 1 && operation.record.fields.Deleted.value === 1));
  const deletingRuleWithEnd = { ...deleting[3], fields: { ...deleting[3].fields, EndDate: { type: "TIMESTAMP", value: Date.parse("2027-01-17T09:00:00Z") } } };
  const endedWeeklyDeletionGraph = await loadSchedulingGraph(deleting[0], owner, lookup([...deleting.slice(0, 3), deletingRuleWithEnd]));
  const endedWeeklySkip = await planRecurringDeletion(endedWeeklyDeletionGraph, list, owner, "occurrence", undefined, plan.timestamp);
  assert.equal(endedWeeklySkip.recipe, "timed_weekly_ended"); assert.equal(endedWeeklySkip.terminal, undefined); assert.equal(endedWeeklySkip.operations.length, 7);
  assert.equal(endedWeeklySkip.active.fields.DueDate.value, Date.parse("2027-01-17T09:00:00Z"));
  const sameDayRule = { ...deletingRuleWithEnd, fields: { ...deletingRuleWithEnd.fields, EndDate: { type: "TIMESTAMP", value: Date.parse("2027-01-10T05:26:40Z") } } };
  const sameDayGraph = await loadSchedulingGraph(deleting[0], owner, lookup([...deleting.slice(0, 3), sameDayRule]));
  const noMembers = { ...list, fields: { ...list.fields, ReminderIDs: { type: "STRING", value: "[]" } } };
  const endedWeeklyFinal = await planRecurringDeletion(sameDayGraph, noMembers, owner, "occurrence", undefined, plan.timestamp);
  assert.equal(endedWeeklyFinal.terminal, true); assert.equal(endedWeeklyFinal.operations.length, 5); assert.equal(endedWeeklyFinal.expected.length, 5);
  assert.deepEqual(Object.keys(endedWeeklyFinal.ids), ["replicas"]); assert.deepEqual(endedWeeklyFinal.retired, []); assert.equal(endedWeeklyFinal.active.parent, null);
  assert.deepEqual(Object.keys(endedWeeklyFinal.operations.find(operation => operation.record.recordType === "List")!.record.fields), ["ResolutionTokenMap"]);
  const edgeRule = { ...deletingRuleWithEnd, fields: { ...deletingRuleWithEnd.fields, EndDate: { type: "TIMESTAMP", value: Date.parse("2027-01-17T05:26:40Z") } } };
  const edgeGraph = await loadSchedulingGraph(deleting[0], owner, lookup([...deleting.slice(0, 3), edgeRule]));
  await assert.rejects(planRecurringDeletion(edgeGraph, list, owner, "occurrence", undefined, plan.timestamp), error => hasCode("VALIDATION_ERROR")(error) && /all_future/.test((error as Error).message));
  const edgeFuture = await planRecurringDeletion(edgeGraph, list, owner, "all_future", undefined, plan.timestamp);
  assert.equal(edgeFuture.terminal, true); assert.equal(edgeFuture.operations.length, 5);
  await assert.rejects(planRecurringDeletion(endedWeeklyDeletionGraph, list, owner, "occurrence", undefined, plan.timestamp, "Europe/London"), hasCode("UNSUPPORTED_FEATURE"));
  const dstWeekly = structuredClone(deleting); dstWeekly[0].fields.DueDate = { type: "TIMESTAMP", value: Date.parse("2030-10-21T04:00:00Z") };
  dstWeekly[2].fields.DateComponentsData = { type: "BYTES", value: b64(utf8(JSON.stringify(dateComponents("2030-10-21T04:00:00Z", "Europe/London")))) };
  dstWeekly[3].fields.EndDate = { type: "TIMESTAMP", value: Date.parse("2030-10-28T06:26:20Z") };
  const dstWeeklyDelete = await planRecurringDeletion(await loadSchedulingGraph(dstWeekly[0], owner, lookup(dstWeekly)), list, owner, "occurrence", undefined, plan.timestamp);
  assert.equal(dstWeeklyDelete.active.fields.DueDate.value, Date.parse("2030-10-28T05:00:00Z"));
  const pastRule = { ...sameDayRule, fields: { ...sameDayRule.fields, EndDate: { type: "TIMESTAMP", value: Date.parse("2027-01-09T23:59:59Z") } } };
  await assert.rejects(planRecurringDeletion(await loadSchedulingGraph(deleting[0], owner, lookup([...deleting.slice(0, 3), pastRule])), list, owner, "all_future", undefined, plan.timestamp), hasCode("UNSUPPORTED_FEATURE"));
  await assert.rejects(planRecurringDeletion(deletionGraph, list, owner, "all_future", occurrenceDelete.ids, plan.timestamp), hasCode("CONFLICT"));
  let deletionPosts = 0;
  const deletionClient = (recipe: typeof occurrenceDelete, variant?: string) => {
    const state = new Map([...recipe.graph.records, recipe.list].map(record => [record.recordName, structuredClone(record)]));
    return new CloudKitRemindersClient(new AppleHTTP(new CookieJar(), async (url, init) => {
      if (new URL(String(url)).pathname.endsWith("/records/lookup")) return Response.json({ records: [state.get(recipe.active.recordName)] });
      deletionPosts++; const payload = JSON.parse(String(init?.body)); assert.equal(payload.atomic, true); assert.equal(payload.operations.length, recipe.operations.length);
      if ([ruleId, listId, alarmId].includes(variant ?? "")) return Response.json({ records: payload.operations.map((operation: { record: CloudKitRecord }) => ({ recordName: operation.record.recordName, serverErrorCode: operation.record.recordName === variant ? "CONFLICT" : "ATOMIC_ERROR" })) });
      const receipts = payload.operations.map((operation: { operationType: string; record: CloudKitRecord & { parent?: { recordName: string | null } } }) => {
        if (operation.operationType === "delete") { state.delete(operation.record.recordName); return { recordName: operation.record.recordName, deleted: true }; }
        const before = state.get(operation.record.recordName), next = { ...before, ...operation.record, zoneID, raw: { ...before?.raw }, fields: { ...before?.fields, ...operation.record.fields }, recordChangeTag: "delete-confirmed" };
        if (operation.record.parent?.recordName === null) { assert.deepEqual(operation.record.parent, { recordName: null }); delete next.parent; delete next.raw.parent; }
        else if (operation.record.parent) next.raw.parent = next.parent;
        else if (before?.raw.parent) next.parent = before.raw.parent as { recordName: string };
        state.set(next.recordName, next);
        if (variant === "crypto" && next.recordType === "Reminder") ((next.fields.UrgentPresentationAlarmsAsData as { value: Record<string, unknown> }).value).wrappingKey = "changed";
        if (variant === "parent" && operation.operationType === "create" && next.recordType === "Alarm") next.parent = { recordName: "Reminder/OTHER" };
        return operation.record.parent?.recordName === null ? { ...next, parent: before?.raw.parent } : next;
      });
      return Response.json({ records: receipts.reverse() });
    }), { dsid: "123", clientId: "synthetic", clientBuildNumber: "synthetic", clientMasteringNumber: "synthetic", cloudKitURL: "https://p01-ckdatabasews.icloud.com/database/1/com.apple.reminders/production/private", remindersZoneOwner: owner });
  };
  await deletionClient(occurrenceDelete).modifyRecurringDeletion(occurrenceDelete, async () => {});
  await deletionClient(futureDelete).modifyRecurringDeletion(futureDelete, async () => {});
  for (const stale of [ruleId, listId, alarmId]) await assert.rejects(deletionClient(occurrenceDelete, stale).modifyRecurringDeletion(occurrenceDelete, async () => {}), hasCode("CONFLICT"));
  for (const variant of ["crypto", "parent"]) await assert.rejects(deletionClient(occurrenceDelete, variant).modifyRecurringDeletion(occurrenceDelete, async () => {}), hasCode("WRITE_OUTCOME_UNKNOWN"));
  await deletionClient(endedWeeklyFinal).modifyRecurringDeletion(endedWeeklyFinal, async () => {});
  await deletionClient(edgeFuture).modifyRecurringDeletion(edgeFuture, async () => {});
  assert.equal(deletionPosts, 9);
  const dailyDeleteRoot = structuredClone(deleting[0]); dailyDeleteRoot.fields.AlarmIDs = { type: "UNKNOWN_LIST", value: [] }; dailyDeleteRoot.fields.AllDay = { type: "INT64", value: 1 };
  dailyDeleteRoot.fields.DueDate = { type: "TIMESTAMP", value: Date.parse("2027-01-10T00:00:00Z") }; delete dailyDeleteRoot.fields.TimeZone;
  const dailyDeleteRule = { ...deleting[3], fields: { ...deleting[3].fields, Frequency: { type: "INT64", value: 0 } } };
  const dailyDeleteGraph = await loadSchedulingGraph(dailyDeleteRoot, owner, lookup([dailyDeleteRoot, dailyDeleteRule]));
  const absentMembers = { ...list, fields: { ...list.fields, ReminderIDs: { type: "STRING", value: "[]" }, ResolutionTokenMap: { type: "STRING", value: JSON.stringify({ map: {
    reminderIDsMergeableOrdering: { counter: 1, modificationTime: 1_700_000_000, replicaID: crypto.randomUUID() }, otherToken: { counter: 7, modificationTime: 1_700_000_000, replicaID: crypto.randomUUID() },
  } }) } } };
  const dailySkip = await planRecurringDeletion(dailyDeleteGraph, absentMembers, owner, "occurrence", undefined, Date.parse("2027-01-10T12:00:00Z"));
  assert.equal(dailySkip.recipe, "all_day_daily"); assert.equal(dailySkip.operations.length, 3); assert.equal(dailySkip.expected.length, 3); assert.deepEqual(Object.keys(dailySkip.ids), ["replicas"]); assert.deepEqual(dailySkip.retired, []);
  assert.deepEqual(Object.keys(dailySkip.active.fields).sort(), ["DueDate", "LastModifiedDate", "ResolutionTokenMap"]); assert.equal(dailySkip.active.fields.DueDate.value, Date.parse("2027-01-11T00:00:00Z"));
  const dailyRetire = await planRecurringDeletion(dailyDeleteGraph, absentMembers, owner, "all_future", undefined, dailySkip.timestamp);
  assert.equal(dailyRetire.expected.length, 3); assert.deepEqual(Object.keys(dailyRetire.ids), ["replicas"]);
  const dailyListWrite = dailyRetire.operations.find(operation => operation.record.recordType === "List")!;
  assert.deepEqual(Object.keys(dailyListWrite.record.fields), ["ResolutionTokenMap"]);
  const oldOrdering = JSON.parse(String((absentMembers.fields.ResolutionTokenMap as { value: string }).value)).map, newOrdering = JSON.parse(String(dailyListWrite.record.fields.ResolutionTokenMap.value)).map;
  assert.equal(newOrdering.reminderIDsMergeableOrdering.counter, 2); assert.deepEqual(newOrdering.otherToken, oldOrdering.otherToken);
  const weeklyAbsentRetire = await planRecurringDeletion(deletionGraph, absentMembers, owner, "all_future", futureDelete.ids, futureDelete.timestamp);
  assert.equal(Object.hasOwn(weeklyAbsentRetire, "recipe"), false); assert.deepEqual(weeklyAbsentRetire.operations.find(operation => operation.record.recordType === "List")!.record.fields, { Deleted: { type: "INT64", value: 0 } });
  const dailyWithMember = await planRecurringDeletion(dailyDeleteGraph, list, owner, "all_future", undefined, dailySkip.timestamp);
  assert.ok(Object.hasOwn(dailyWithMember.operations.find(operation => operation.record.recordType === "List")!.record.fields, "ReminderIDs"));
  const endedDeleteRule = { ...dailyDeleteRule, fields: { ...dailyDeleteRule.fields, EndDate: { type: "TIMESTAMP", value: Date.parse("2027-01-11T00:00:00Z") } } };
  const endedDeleteGraph = await loadSchedulingGraph(dailyDeleteRoot, owner, lookup([dailyDeleteRoot, endedDeleteRule]));
  const endedSkip = await planRecurringDeletion(endedDeleteGraph, absentMembers, owner, "occurrence", undefined, dailySkip.timestamp);
  assert.equal(endedSkip.recipe, "all_day_daily_ended"); assert.equal(endedSkip.terminal, undefined);
  assert.equal(endedSkip.active.fields.DueDate.value, Date.parse("2027-01-11T00:00:00Z")); assert.equal(endedSkip.expected.length, 3);
  const endedFinalRoot = { ...dailyDeleteRoot, fields: { ...dailyDeleteRoot.fields, ...endedSkip.active.fields } };
  const endedFinalGraph = await loadSchedulingGraph(endedFinalRoot, owner, lookup([endedFinalRoot, endedDeleteRule]));
  const finalDelete = await planRecurringDeletion(endedFinalGraph, absentMembers, owner, "occurrence", undefined, Date.parse("2027-01-11T12:00:00Z"));
  assert.equal(finalDelete.terminal, true); assert.equal(finalDelete.scope, "occurrence"); assert.equal(finalDelete.active.parent, null);
  assert.deepEqual(Object.keys(finalDelete.active.fields).sort(), ["Deleted", "LastModifiedDate", "List", "ResolutionTokenMap"]);
  assert.equal(finalDelete.operations.length, 3); assert.deepEqual(finalDelete.retired, []); assert.deepEqual(Object.keys(finalDelete.ids), ["replicas"]);
  assert.equal((await planRecurringDeletion(endedDeleteGraph, absentMembers, owner, "all_future", undefined, dailySkip.timestamp)).terminal, true);
  await assert.rejects(planRecurringDeletion(endedFinalGraph, absentMembers, owner, "occurrence", undefined, dailySkip.timestamp, "America/Los_Angeles"), hasCode("UNSUPPORTED_FEATURE"));
  const dstDeleteRoot = { ...dailyDeleteRoot, fields: { ...dailyDeleteRoot.fields, DueDate: { type: "TIMESTAMP", value: Date.parse("2030-10-26T00:00:00Z") } } };
  const dstDeleteRule = { ...endedDeleteRule, fields: { ...endedDeleteRule.fields, EndDate: { type: "TIMESTAMP", value: Date.parse("2030-10-26T23:51:29Z") } } };
  const dstDeleteGraph = await loadSchedulingGraph(dstDeleteRoot, owner, lookup([dstDeleteRoot, dstDeleteRule]));
  await assert.rejects(planRecurringDeletion(dstDeleteGraph, absentMembers, owner, "occurrence", undefined, dailySkip.timestamp), hasCode("UNSUPPORTED_FEATURE"));
  const dstDelete = await planRecurringDeletion(dstDeleteGraph, absentMembers, owner, "occurrence", undefined, dailySkip.timestamp, "Europe/London");
  assert.equal(dstDelete.active.fields.DueDate.value, Date.parse("2030-10-27T00:00:00Z")); assert.equal(dstDelete.terminal, undefined);
  assert.equal((await planRecurringDeletion(dstDeleteGraph, absentMembers, owner, "occurrence", undefined, dailySkip.timestamp, "UTC")).terminal, true);
  await assert.rejects(planRecurringDeletion(dailyDeleteGraph, absentMembers, owner, "occurrence", undefined, dailySkip.timestamp, "Europe/London"), hasCode("UNSUPPORTED_FEATURE"));
  const dailyTimedRoot = { ...dailyDeleteRoot, fields: { ...dailyDeleteRoot.fields, DueDate: { type: "TIMESTAMP", value: Date.parse("2027-01-10T01:00:00Z") } } };
  await assert.rejects(planRecurringDeletion(await loadSchedulingGraph(dailyTimedRoot, owner, lookup([dailyTimedRoot, dailyDeleteRule])), absentMembers, owner, "all_future", undefined, dailySkip.timestamp), hasCode("UNSUPPORTED_FEATURE"));
  const monthly = records(); monthly[0].fields.AlarmIDs = { type: "UNKNOWN_LIST", value: [] }; monthly[0].fields.AllDay = { type: "INT64", value: 1 };
  monthly[0].fields.DueDate = { type: "TIMESTAMP", value: Date.parse("2027-01-31T00:00:00Z") }; delete monthly[0].fields.TimeZone;
  monthly[3].fields.Frequency = { type: "INT64", value: 2 }; monthly[3].fields.DaysOfTheMonth = { type: "BYTES", value: b64(utf8("[28,29,30,31]")) };
  monthly[3].fields.SetPositions = { type: "BYTES", value: b64(utf8("[-1]")) };
  const monthlyGraph = await loadSchedulingGraph(monthly[0], owner, lookup(monthly));
  assert.equal((await planRecurringCompletion(monthlyGraph, list, owner, ids, plan.timestamp)).active.fields.DueDate.value, Date.parse("2027-02-28T00:00:00Z"));
  const monthlyDelete = await planRecurringDeletion(monthlyGraph, noMembers, owner, "occurrence", undefined, plan.timestamp);
  assert.equal(monthlyDelete.recipe, "all_day_last_day_monthly"); assert.equal(monthlyDelete.active.fields.DueDate.value, Date.parse("2027-02-28T00:00:00Z"));
  assert.equal(monthlyDelete.operations.length, 3); assert.equal(monthlyDelete.expected.length, 3); assert.deepEqual(monthlyDelete.retired, []); assert.deepEqual(Object.keys(monthlyDelete.ids), ["replicas"]);
  assert.deepEqual(Object.keys(monthlyDelete.active.fields).sort(), ["DueDate", "LastModifiedDate", "ResolutionTokenMap"]);
  const monthlyFuture = await planRecurringDeletion(monthlyGraph, noMembers, owner, "all_future", undefined, plan.timestamp);
  assert.equal(monthlyFuture.active.parent, null); assert.equal(monthlyFuture.terminal, undefined);
  assert.deepEqual(Object.keys(monthlyFuture.operations.find(operation => operation.record.recordType === "List")!.record.fields), ["ResolutionTokenMap"]);
  assert.deepEqual(monthlyFuture.operations.find(operation => operation.record.recordType === "RecurrenceRule")!.record.fields, { Deleted: { type: "INT64", value: 1 } });
  for (const [before, after] of [["2028-01-31", "2028-02-29"], ["2028-02-29", "2028-03-31"], ["2027-12-31", "2028-01-31"]]) {
    const root = { ...monthly[0], fields: { ...monthly[0].fields, DueDate: { type: "TIMESTAMP", value: Date.parse(`${before}T00:00:00Z`) } } };
    const graph = await loadSchedulingGraph(root, owner, lookup([root, monthly[3]]));
    assert.equal((await planRecurringDeletion(graph, noMembers, owner, "occurrence", undefined, plan.timestamp)).active.fields.DueDate.value, Date.parse(`${after}T00:00:00Z`));
  }
  const wrongMonthlyAnchor = { ...monthly[0], fields: { ...monthly[0].fields, DueDate: { type: "TIMESTAMP", value: Date.parse("2027-01-30T00:00:00Z") } } };
  for (const scope of ["occurrence", "all_future"] as const) await assert.rejects(planRecurringDeletion(await loadSchedulingGraph(wrongMonthlyAnchor, owner, lookup([wrongMonthlyAnchor, monthly[3]])), noMembers, owner, scope, undefined, plan.timestamp), hasCode("UNSUPPORTED_FEATURE"));
  await assert.rejects(planRecurringDeletion(monthlyGraph, noMembers, owner, "occurrence", undefined, plan.timestamp, "UTC"), hasCode("UNSUPPORTED_FEATURE"));
  const endedMonthlyRule = { ...monthly[3], fields: { ...monthly[3].fields, EndDate: { type: "TIMESTAMP", value: Date.parse("2027-03-31T00:00:00Z") } } };
  await assert.rejects(planRecurringDeletion(await loadSchedulingGraph(monthly[0], owner, lookup([monthly[0], endedMonthlyRule])), noMembers, owner, "all_future", undefined, plan.timestamp), hasCode("UNSUPPORTED_FEATURE"));

  const daily = records(); daily[0].fields.AlarmIDs = { type: "UNKNOWN_LIST", value: [] }; daily[0].fields.AllDay = { type: "INT64", value: 1 };
  daily[0].fields.DueDate = { type: "TIMESTAMP", value: Date.parse("2027-01-11T00:00:00Z") }; delete daily[0].fields.TimeZone;
  daily[3].fields.Frequency = { type: "INT64", value: 0 }; daily[3].fields.EndDate = { type: "TIMESTAMP", value: Date.parse("2027-01-12T00:00:00Z") };
  const dailyGraph = await loadSchedulingGraph(daily[0], owner, lookup(daily));
  const penultimate = await planRecurringCompletion(dailyGraph, list, owner, ids, plan.timestamp);
  assert.equal(penultimate.mode, "advance"); assert.ok(penultimate.history); assert.ok(penultimate.membership);
  assert.equal(penultimate.active.fields.DueDate.value, Date.parse("2027-01-12T00:00:00Z"));
  const finalRoot = { ...daily[0], recordChangeTag: "final-before", fields: { ...daily[0].fields, ...penultimate.active.fields } };
  const finalList = { ...list, fields: { ...list.fields, ...penultimate.membership.fields }, recordChangeTag: "final-list-before" };
  const finalGraph = await loadSchedulingGraph(finalRoot, owner, lookup([finalRoot, daily[3]]));
  const final = await planRecurringCompletion(finalGraph, finalList, owner, undefined, Date.parse("2027-01-12T12:00:00Z"));
  const omittedZoneList = { ...finalList }; delete omittedZoneList.zoneID;
  const reboundFinal = await planRecurringCompletion(finalGraph, omittedZoneList, owner, final.ids, final.timestamp);
  assert.equal(reboundFinal.sourceFingerprint, final.sourceFingerprint); assert.deepEqual(reboundFinal.expected, final.expected);
  assert.deepEqual(reboundFinal.guards.find(record => record.recordType === "List")?.zoneID, { zoneName: "Reminders", zoneType: "REGULAR_CUSTOM_ZONE", ownerRecordName: owner });
  assert.equal(final.mode, "final"); assert.equal(final.history, undefined); assert.equal(final.membership, undefined);
  assert.deepEqual(Object.keys(final.ids), ["replicas"]); assert.equal(final.expected.length, 3); assert.equal(final.operations.length, 1);
  assert.deepEqual(final.guards.map(record => record.recordType), ["RecurrenceRule", "List"]);
  assert.deepEqual(Object.keys(final.active.fields).sort(), ["Completed", "CompletionDate", "LastModifiedDate", "ResolutionTokenMap"]);
  assert.deepEqual(JSON.parse(String(final.active.fields.ResolutionTokenMap.value)).map.dueDate, JSON.parse(String((finalRoot.fields.ResolutionTokenMap as { value: string }).value)).map.dueDate);
  const reopenedRoot = { ...finalRoot, recordChangeTag: "reopen-before", fields: { ...finalRoot.fields, ...final.active.fields } };
  const reopen = await planRecurringCompletion(await loadSchedulingGraph(reopenedRoot, owner, lookup([reopenedRoot, daily[3]])), finalList, owner, undefined, final.timestamp + 1000, "reopen");
  assert.equal(reopen.mode, "reopen"); assert.equal(reopen.active.fields.Completed.value, 0); assert.equal(reopen.active.fields.CompletionDate.value, null);
  assert.equal(reopen.history, undefined); assert.equal(reopen.operations.length, 1);
  let terminalDispatches = 0;
  const terminalClient = (stale?: string) => new CloudKitRemindersClient(new AppleHTTP(new CookieJar(), async (_, init) => {
    terminalDispatches++;
    const payload = JSON.parse(String(init?.body)); assert.equal(payload.atomic, true); assert.equal(payload.operations.length, 3);
    assert.ok(payload.operations.every((operation: { operationType: string }) => operation.operationType === "update"));
    if (stale) return Response.json({ records: payload.operations.map((operation: { record: { recordName: string } }) => ({ recordName: operation.record.recordName, serverErrorCode: operation.record.recordName === stale ? "CONFLICT" : "ATOMIC_ERROR" })) });
    return Response.json({ records: payload.operations.map((operation: { record: CloudKitRecord }) => {
      const before = [finalRoot, finalList, daily[3]].find(record => record.recordName === operation.record.recordName)!;
      return { ...operation.record, fields: { ...before.fields, ...operation.record.fields }, recordChangeTag: `confirmed-${operation.record.recordName}`, zoneID };
    }) });
  }), { dsid: "123", clientId: "synthetic", clientBuildNumber: "synthetic", clientMasteringNumber: "synthetic", cloudKitURL: "https://p01-ckdatabasews.icloud.com/database/1/com.apple.reminders/production/private", remindersZoneOwner: owner });
  await terminalClient().modifyRecurringCompletion(final, async () => {});
  for (const stale of [ruleId, listId]) await assert.rejects(terminalClient(stale).modifyRecurringCompletion(final, async () => {}), hasCode("CONFLICT"));
  await assert.rejects(terminalClient().modifyRecurringCompletion({ ...final, guards: final.guards.slice(0, 1) }, async () => {}), hasCode("VALIDATION_ERROR"));
  assert.equal(terminalDispatches, 3);
  for (const fields of [{ EndDate: { type: "TIMESTAMP", value: Date.parse("2027-01-12T09:00:00Z") } }, { OccurrenceCount: { type: "INT64", value: 2 } }]) {
    const badRule = { ...daily[3], fields: { ...daily[3].fields, ...fields } };
    const unsupported = await loadSchedulingGraph(finalRoot, owner, lookup([finalRoot, badRule]));
    await assert.rejects(planRecurringCompletion(unsupported, finalList, owner, undefined, final.timestamp), hasCode("UNSUPPORTED_FEATURE"));
  }
  assert.equal(new Date(recurrenceEndCalendarLabel(Date.parse("2026-10-24T23:51:29Z"), "Europe/London")).toISOString(), "2026-10-25T00:00:00.000Z");
  assert.equal(new Date(recurrenceEndCalendarLabel(Date.parse("2026-03-28T23:30:00Z"), "Europe/London")).toISOString(), "2026-03-28T00:00:00.000Z");
  assert.equal(new Date(recurrenceEndCalendarLabel(Date.parse("2026-03-29T23:30:00Z"), "Europe/London")).toISOString(), "2026-03-30T00:00:00.000Z");
  assert.equal(RecurrenceCalendarTimeZone.safeParse("+01:00").success, false); assert.equal(RecurrenceCalendarTimeZone.safeParse("Europe/Unknown").success, false);
  const zonedRoot = { ...daily[0], fields: { ...daily[0].fields, DueDate: { type: "TIMESTAMP", value: Date.parse("2026-10-24T00:00:00Z") }, CreationDate: { type: "TIMESTAMP", value: Date.parse("2026-10-01T00:00:00Z") } } };
  const zonedRule = { ...daily[3], fields: { ...daily[3].fields, EndDate: { type: "TIMESTAMP", value: Date.parse("2026-10-24T23:51:29Z") } } };
  const zonedGraph = await loadSchedulingGraph(zonedRoot, owner, lookup([zonedRoot, zonedRule])), zonedTime = Date.parse("2026-10-24T12:00:00Z");
  await assert.rejects(planRecurringCompletion(zonedGraph, list, owner, undefined, zonedTime), hasCode("UNSUPPORTED_FEATURE"));
  const calendarAdvance = await planRecurringCompletion(zonedGraph, list, owner, undefined, zonedTime, "complete", "Europe/London");
  assert.equal(calendarAdvance.mode, "advance"); assert.equal(calendarAdvance.active.fields.DueDate.value, Date.parse("2026-10-25T00:00:00Z"));
  assert.equal(calendarAdvance.recurrenceCalendarTimeZone, "Europe/London"); assert.equal(calendarAdvance.active.fields.TimeZone, undefined);
  const utcFinal = await planRecurringCompletion(zonedGraph, list, owner, undefined, zonedTime, "complete", "UTC");
  assert.equal(utcFinal.mode, "final");
  const calendarFinalRoot = { ...zonedRoot, fields: { ...zonedRoot.fields, ...calendarAdvance.active.fields } };
  const calendarFinalGraph = await loadSchedulingGraph(calendarFinalRoot, owner, lookup([calendarFinalRoot, zonedRule]));
  const calendarFinal = await planRecurringCompletion(calendarFinalGraph, list, owner, undefined, zonedTime + 86_400_000, "complete", "Europe/London");
  assert.equal(calendarFinal.mode, "final"); assert.equal(calendarFinal.history, undefined);
  await assert.rejects(planRecurringCompletion(calendarFinalGraph, list, owner, undefined, zonedTime, "complete", "UTC"), hasCode("UNSUPPORTED_FEATURE"));
  const calendarCompletedRoot = { ...calendarFinalRoot, fields: { ...calendarFinalRoot.fields, ...calendarFinal.active.fields } };
  const calendarReopenGraph = await loadSchedulingGraph(calendarCompletedRoot, owner, lookup([calendarCompletedRoot, zonedRule]));
  assert.equal((await planRecurringCompletion(calendarReopenGraph, list, owner, undefined, zonedTime + 86_400_000, "reopen", "Europe/London")).mode, "reopen");
  await assert.rejects(planRecurringCompletion(calendarReopenGraph, list, owner, undefined, zonedTime, "reopen", "UTC"), hasCode("UNSUPPORTED_FEATURE"));
  const midnightZonedRule = { ...zonedRule, fields: { ...zonedRule.fields, EndDate: { type: "TIMESTAMP", value: Date.parse("2026-10-25T00:00:00Z") } } };
  const midnightZonedGraph = await loadSchedulingGraph(zonedRoot, owner, lookup([zonedRoot, midnightZonedRule]));
  assert.equal((await planRecurringCompletion(midnightZonedGraph, list, owner, undefined, zonedTime)).mode, "advance");
  assert.equal((await planRecurringCompletion(midnightZonedGraph, list, owner, undefined, zonedTime, "complete", "America/New_York")).mode, "final");
  await assert.rejects(planRecurringCompletion(graph, list, owner, undefined, plan.timestamp, "complete", "Europe/London"), hasCode("UNSUPPORTED_FEATURE"));
});
