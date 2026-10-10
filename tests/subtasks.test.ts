import test from "node:test";
import assert from "node:assert/strict";
import { AppError } from "../src/errors.ts";
import { CloudKitRemindersClient, type CloudKitRecord, type CloudKitPage, type CloudKitLookupResult } from "../src/icloud/cloudkit.ts";
import { AppleHTTP } from "../src/transport/apple-http.ts";
import { CookieJar } from "../src/transport/cookie-jar.ts";
import { readFileSync } from "node:fs";
import { omitField } from "../src/lib/omit-field.ts";
import { CreateReminderInput, buildCreateReminder, matchesCreatedReminder } from "../src/reminders/writes.ts";
import { CreateSubtaskInput, SetReminderParentInput, buildCreateSubtask, buildSetReminderParent, requireNoChildren, subtaskParents } from "../src/reminders/subtasks.ts";

const listId = "List/SUBTASKS", owner = "synthetic-owner", now = 1_800_000_000_000;
const hasCode = (code: string) => (error: unknown) => error instanceof AppError && error.code === code;
const zoneID = { zoneName: "Reminders", ownerRecordName: owner };
function fieldValue(record: CloudKitRecord, name: string) {
  const field = record.fields[name];
  assert.ok(field && typeof field === "object" && "value" in field);
  return field.value;
}
function record(id: string, parentId: string | null = null): CloudKitRecord {
  const write = buildCreateReminder(CreateReminderInput.parse({ listId, idempotencyKey: "00000000-0000-4000-8000-000000000001", title: "Synthetic", notes: "Preserve me" }), now);
  return { recordName: id, recordType: "Reminder", recordChangeTag: `version-${id}`, zoneID, raw: {}, fields: {
    ...write.fields, UnknownFutureField: { type: "STRING", value: "preserve" },
    ...(parentId ? { ParentReminder: { type: "REFERENCE", value: { recordName: parentId, action: "VALIDATE" } } } : {}),
  } };
}
function page(records: CloudKitRecord[], continuation: string | null = null): CloudKitPage {
  return { records, recordErrors: [], complete: continuation === null, paginationComplete: continuation === null, continuation, pendingReason: continuation ? "continuation" : null };
}
function clientFor(records: CloudKitRecord[], pages: CloudKitPage[] = [page(records)]) {
  let queries = 0;
  return {
    queries: () => queries,
    lookup: async (ids: string[]): Promise<CloudKitLookupResult> => ({
      requestedRecordNames: ids, records: ids.flatMap(id => records.filter(value => value.recordName === id)),
      recordErrors: [], unresolvedRecordNames: [], complete: true,
    }),
    queryRemindersPage: async (options: { includeCompleted: boolean }) => {
      assert.equal(options.includeCompleted, true);
      return pages[Math.min(queries++, pages.length - 1)];
    },
  };
}
const parent = record("Reminder/PARENT"), other = record("Reminder/OTHER"), child = record("Reminder/CHILD", parent.recordName);
const parentInput = { reminderId: parent.recordName, recordChangeTag: parent.recordChangeTag! };
const createInput = CreateSubtaskInput.parse({ listId, idempotencyKey: "00000000-0000-4000-8000-000000000002", title: "Child", parentReminder: parentInput });
const target = { listId, reminderId: child.recordName, recordChangeTag: child.recordChangeTag! };

test("subtask creation keeps List ownership distinct from ParentReminder and binds replay to the parent", () => {
  const observation = JSON.parse(readFileSync(new URL("./fixtures/subtask-observation.json", import.meta.url), "utf8"));
  assert.equal(observation.source, "authorized-synthetic-apple-api-experiment");
  assert.equal(observation.unreferencedNewChildRaceSafetyProven, false);
  assert.equal(observation.nativePostPreparationParentRaceProven, false);
  assert.equal(observation.bulkDeleteEnabled, false);
  assert.deepEqual(observation.appleAppRelationshipObservation.childParentField, {
    type: "REFERENCE", value: { recordName: "Reminder/SYNTHETIC-PARENT", action: "VALIDATE" },
  });
  const write = buildCreateSubtask(createInput, now);
  assert.deepEqual(write.parent, { recordName: listId });
  assert.deepEqual(write.fields.ParentReminder, { type: "REFERENCE", value: { recordName: parent.recordName, action: "VALIDATE" } });
  const confirmed = { ...write, recordChangeTag: "created", zoneID, raw: {} };
  const simpleInput = omitField(createInput, "parentReminder");
  assert.equal(matchesCreatedReminder(simpleInput, confirmed, owner, parent.recordName), true);
  assert.equal(matchesCreatedReminder(simpleInput, confirmed, owner), false);
  assert.equal(matchesCreatedReminder(simpleInput, { ...confirmed, fields: { ...confirmed.fields, ParentReminder: { type: "REFERENCE", value: { recordName: other.recordName, action: "VALIDATE" } } } }, owner, parent.recordName), false);
  assert.equal(CreateReminderInput.safeParse(createInput).success, false, "Simple bulk create must not accept a subtask manifest.");
  assert.throws(() => buildCreateSubtask({ ...createInput, dueDate: "2027-01-01T09:00:00Z" }), hasCode("UNSUPPORTED_FEATURE"));
  assert.throws(() => buildCreateSubtask({ ...createInput, parentReminder: { ...parentInput, reminderId: write.recordName } }), hasCode("VALIDATION_ERROR"));
});

test("attachment, reparenting and detachment emit only the relationship and preserve unrelated resolution tokens", () => {
  for (const destination of [parentInput, { reminderId: other.recordName, recordChangeTag: other.recordChangeTag! }, null]) {
    const current = destination?.reminderId === parent.recordName ? record(child.recordName) : child;
    const write = buildSetReminderParent({ ...target, parentReminder: destination }, current, owner, now + 1000);
    assert.deepEqual(Object.keys(write.fields).sort(), ["LastModifiedDate", "ParentReminder", "ResolutionTokenMap"]);
    assert.equal(write.parent, undefined);
    assert.equal(write.fields.ParentReminder.type, "REFERENCE");
    assert.deepEqual(write.fields.ParentReminder.value, destination ? { recordName: destination.reminderId, action: "VALIDATE" } : null);
    const before = JSON.parse(String(fieldValue(current, "ResolutionTokenMap"))).map;
    const after = JSON.parse(String(write.fields.ResolutionTokenMap.value)).map;
    assert.deepEqual(Object.keys(before).sort(), Object.keys(after).sort());
    for (const field of Object.keys(before)) {
      if (field === "parentReminder" || field === "lastModifiedDate") assert.notDeepEqual(after[field], before[field]);
      else assert.deepEqual(after[field], before[field]);
    }
    assert.equal(fieldValue(current, "UnknownFutureField"), "preserve");
  }
});

test("parent changes reject stale child tags, self-parenting, no-ops, unsupported schedules, foreign owners and unknown inputs", () => {
  assert.throws(() => buildSetReminderParent({ ...target, recordChangeTag: "stale", parentReminder: null }, child, owner), hasCode("CONFLICT"));
  assert.throws(() => buildSetReminderParent({ ...target, parentReminder: { reminderId: child.recordName, recordChangeTag: child.recordChangeTag! } }, child, owner), hasCode("VALIDATION_ERROR"));
  assert.throws(() => buildSetReminderParent({ ...target, parentReminder: parentInput }, child, owner), hasCode("VALIDATION_ERROR"));
  for (const fields of [
    { DueDate: { type: "TIMESTAMP", value: now } },
    { AlarmIDs: { type: "STRING_LIST", value: ["Alarm/ONE"] } },
    { RecurrenceRuleIDs: { type: "STRING_LIST", value: ["RecurrenceRule/ONE"] } },
    { UnknownChildren: { type: "STRING_LIST", value: [] } },
  ]) assert.throws(() => buildSetReminderParent({ ...target, parentReminder: null }, { ...child, fields: { ...child.fields, ...fields } }, owner), hasCode("UNSUPPORTED_FEATURE"));
  assert.throws(() => buildSetReminderParent({ ...target, parentReminder: null }, { ...child, zoneID: { ...zoneID, ownerRecordName: "foreign" } }, owner), hasCode("FORBIDDEN"));
  assert.throws(() => buildSetReminderParent({ ...target, parentReminder: null }, { ...child, fields: { ...child.fields, Completed: { type: "INT64", value: 1 } } }, owner), hasCode("CONFLICT"));
  assert.equal(SetReminderParentInput.safeParse({ ...target, parentReminder: null, changes: {} }).success, false);
});

test("reparent inspection guards both roots, refuses cycles/deeper nesting and requires the caller's destination tag", async () => {
  const client = clientFor([parent, other, child]);
  assert.deepEqual((await subtaskParents(client, owner, listId, child, { reminderId: other.recordName, recordChangeTag: other.recordChangeTag! })).map(value => value.recordName).sort(), [parent.recordName, other.recordName].sort());
  assert.deepEqual((await subtaskParents(client, owner, listId, child, null)).map(value => value.recordName), [parent.recordName]);
  await assert.rejects(subtaskParents(client, owner, listId, null, { ...parentInput, recordChangeTag: "stale" }), hasCode("CONFLICT"));
  await assert.rejects(subtaskParents(client, owner, listId, parent, { reminderId: other.recordName, recordChangeTag: other.recordChangeTag! }), hasCode("UNSUPPORTED_FEATURE"));
  await assert.rejects(subtaskParents(client, owner, listId, child, { reminderId: child.recordName, recordChangeTag: child.recordChangeTag! }), hasCode("VALIDATION_ERROR"));
  const nested = record(other.recordName, parent.recordName);
  await assert.rejects(subtaskParents(clientFor([parent, child, nested]), owner, listId, child, { reminderId: nested.recordName, recordChangeTag: nested.recordChangeTag! }), hasCode("UNSUPPORTED_FEATURE"));
  const foreign = { ...other, fields: { ...other.fields, List: { type: "REFERENCE", value: { recordName: "List/OTHER", action: "VALIDATE" } } } };
  await assert.rejects(subtaskParents(clientFor([parent, child, foreign]), owner, listId, child, { reminderId: other.recordName, recordChangeTag: other.recordChangeTag! }), hasCode("FORBIDDEN"));
  await assert.rejects(subtaskParents(clientFor([]), owner, listId, null, parentInput), hasCode("CONFLICT"));
});

test("child inspection covers completed descendants and refuses incomplete, cycling, erroneous and oversized pages", async () => {
  const completeChild = { ...child, fields: { ...child.fields, Completed: { type: "INT64", value: 1 } } };
  await assert.rejects(requireNoChildren(clientFor([], [page([parent], "next"), page([completeChild])]), owner, listId, parent.recordName), hasCode("UNSUPPORTED_FEATURE"));
  await requireNoChildren(clientFor([], [page([parent], "next"), page([child])]), owner, listId, child.recordName);
  for (const pages of [
    [page([], "same")],
    [{ ...page([]), complete: false }],
    [{ ...page([]), recordErrors: [{ recordName: null, serverErrorCode: "UNKNOWN_ERROR", reason: null, raw: {} }] }],
    [page([{ ...parent, fields: { ...parent.fields, Huge: { type: "STRING", value: "x".repeat(262_145) } } }])],
  ]) await assert.rejects(requireNoChildren(clientFor([], pages), owner, listId, parent.recordName), error => error instanceof AppError && ["UNSUPPORTED_FEATURE", "PROTOCOL_CHANGED"].includes(error.code));
  for (const [serverErrorCode, code] of [["AUTHENTICATION_REQUIRED", "REAUTH_REQUIRED"], ["ACCESS_DENIED", "FORBIDDEN"], ["THROTTLED", "RATE_LIMITED"]]) {
    await assert.rejects(requireNoChildren(clientFor([], [{ ...page([]), recordErrors: [{ recordName: null, serverErrorCode, reason: null, raw: {} }] }]), owner, listId, parent.recordName), hasCode(code));
  }
});

function atomicClient(reply: unknown, capture: (payload: { operations: { record: CloudKitRecord }[] }) => void = () => {}) {
  return new CloudKitRemindersClient(new AppleHTTP(new CookieJar(), async (_, init) => {
    capture(JSON.parse(String(init?.body)));
    return Response.json(reply);
  }), { dsid: "123", clientId: "synthetic", clientBuildNumber: "synthetic", clientMasteringNumber: "synthetic",
    cloudKitURL: "https://p01-ckdatabasews.icloud.com/database/1/com.apple.reminders/production/private", remindersZoneOwner: owner });
}

test("Reminder parent guards are exact marker-only operations; stale guards reject every relationship write", async () => {
  const write = buildSetReminderParent({ ...target, parentReminder: null }, child, owner, now + 1000);
  let calls = 0;
  const confirmed = { ...child, recordChangeTag: "child-next", fields: { ...child.fields, ...write.fields } };
  const client = atomicClient({ records: [{ ...parent, recordChangeTag: "parent-next" }, confirmed] }, payload => {
    calls++;
    assert.equal(payload.operations.length, 2);
    assert.deepEqual(payload.operations[1].record.fields, { Deleted: { type: "INT64", value: 0 } });
    assert.equal(payload.operations[1].record.recordChangeTag, parent.recordChangeTag);
  });
  assert.equal((await client.modifyRecords([{ operationType: "update", record: write }], undefined, [parent]))[0].recordName, child.recordName);
  assert.equal(calls, 1);
  for (const stale of [child, parent]) {
    const rejected = atomicClient({ records: [child, parent].map(value => ({ recordName: value.recordName, serverErrorCode: value === stale ? "CONFLICT" : "ATOMIC_ERROR" })) });
    await assert.rejects(rejected.modifyRecords([{ operationType: "update", record: write }], undefined, [parent]), hasCode("CONFLICT"));
  }
  const drift = atomicClient({ records: [confirmed, { ...parent, recordChangeTag: "parent-next", fields: { ...parent.fields, UnknownFutureField: { type: "STRING", value: "changed" } } }] });
  await assert.rejects(drift.modifyRecords([{ operationType: "update", record: write }], undefined, [parent]), hasCode("WRITE_OUTCOME_UNKNOWN"));
});

test("relationship transport refuses malformed references before any dispatch", async () => {
  let calls = 0;
  const client = atomicClient({}, () => { calls++; });
  const write = buildSetReminderParent({ ...target, parentReminder: null }, child, owner);
  for (const value of [
    { recordName: child.recordName, action: "VALIDATE" },
    { recordName: parent.recordName, action: "DELETE_SELF" },
    { recordName: "List/OTHER", action: "VALIDATE" },
    { recordName: parent.recordName, action: "VALIDATE", zoneID: { ownerRecordName: "foreign" } },
    "Reminder/PARENT",
  ]) await assert.rejects(client.modifyReminder("update", { ...write, fields: { ...write.fields, ParentReminder: { type: "REFERENCE", value } } }), hasCode("VALIDATION_ERROR"));
  const create = buildCreateSubtask(createInput);
  await assert.rejects(client.modifyReminder("create", { ...create, fields: { ...create.fields, ParentReminder: { type: "REFERENCE", value: null } } }), hasCode("VALIDATION_ERROR"));
  assert.equal(calls, 0);
});
