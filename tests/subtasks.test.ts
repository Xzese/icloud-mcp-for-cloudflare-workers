import test from "node:test";
import assert from "node:assert/strict";
import { AppError } from "../src/errors.ts";
import { CloudKitRemindersClient, normalizeReminder, type CloudKitRecord, type CloudKitPage, type CloudKitLookupResult } from "../src/icloud/cloudkit.ts";
import { AppleHTTP } from "../src/transport/apple-http.ts";
import { CookieJar } from "../src/transport/cookie-jar.ts";
import { readFileSync } from "node:fs";
import { omitField } from "../src/lib/omit-field.ts";
import { CreateReminderInput, buildCreateReminder, matchesCreatedReminder } from "../src/reminders/writes.ts";
import { CreateSubtaskInput, SetReminderParentInput, buildCreateSubtask, buildSetReminderParent, listChildren, requireNoChildren, subtaskParents } from "../src/reminders/subtasks.ts";
import { inspectLifecycleFamily, planLifecycle } from "../src/reminders/lifecycle.ts";
import { stableNativePresentation } from "../src/lib/native-presentation.ts";
import { loadScheduledFamilyPairs, planScheduledFamilyLifecycle } from "../src/reminders/scheduled-family-lifecycle.ts";
import { dateComponents, dueDateNonce } from "../src/reminders/linked-date.ts";
import { b64, utf8 } from "../src/crypto/bytes.ts";
import { creationMembership } from "../src/reminders/creation.ts";

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
const list: CloudKitRecord = { recordName: listId, recordType: "List", recordChangeTag: "list-version", zoneID, raw: {},
  fields: { Deleted: { type: "INT64", value: 0 }, IsGroup: { type: "INT64", value: 0 },
    ReminderIDs: { type: "STRING", value: JSON.stringify([parent.recordName, child.recordName]) },
    ResolutionTokenMap: { type: "STRING", value: JSON.stringify({ map: {} }) } } };
function completed(record: CloudKitRecord, date = now - 1000): CloudKitRecord {
  return { ...record, fields: { ...record.fields, Completed: { type: "INT64", value: 1 }, CompletionDate: { type: "TIMESTAMP", value: date } } };
}

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
  assert.deepEqual((await subtaskParents(client, owner, listId, child, { reminderId: other.recordName, recordChangeTag: other.recordChangeTag! }, list)).map(value => value.recordName).sort(), [parent.recordName, other.recordName].sort());
  assert.deepEqual((await subtaskParents(client, owner, listId, child, null, list)).map(value => value.recordName), [parent.recordName]);
  await assert.rejects(subtaskParents(client, owner, listId, null, { ...parentInput, recordChangeTag: "stale" }, list), hasCode("CONFLICT"));
  await assert.rejects(subtaskParents(client, owner, listId, parent, { reminderId: other.recordName, recordChangeTag: other.recordChangeTag! }, list), hasCode("UNSUPPORTED_FEATURE"));
  await assert.rejects(subtaskParents(client, owner, listId, child, { reminderId: child.recordName, recordChangeTag: child.recordChangeTag! }, list), hasCode("VALIDATION_ERROR"));
  const nested = record(other.recordName, parent.recordName);
  await assert.rejects(subtaskParents(clientFor([parent, child, nested]), owner, listId, child, { reminderId: nested.recordName, recordChangeTag: nested.recordChangeTag! }, list), hasCode("UNSUPPORTED_FEATURE"));
  const foreign = { ...other, fields: { ...other.fields, List: { type: "REFERENCE", value: { recordName: "List/OTHER", action: "VALIDATE" } } } };
  await assert.rejects(subtaskParents(clientFor([parent, child, foreign]), owner, listId, child, { reminderId: other.recordName, recordChangeTag: other.recordChangeTag! }, list), hasCode("FORBIDDEN"));
  await assert.rejects(subtaskParents(clientFor([]), owner, listId, null, parentInput, list), hasCode("CONFLICT"));
});

test("large native inventories retain complete query and exact-membership child checks", async () => {
  const ids = Array.from({ length: 1822 }, () => `Reminder/${crypto.randomUUID()}`);
  const records = ids.map(id => record(id));
  const root = records[0], hiddenChild = records.at(-1)!;
  hiddenChild.fields.ParentReminder = { type: "REFERENCE", value: { recordName: root.recordName, action: "VALIDATE" } };
  const inventory = { ...list, fields: { ...list.fields, ReminderIDs: { type: "STRING", value: JSON.stringify(ids.map(id => id.slice(9))) } } };
  // The query index omits the committed child. Exact inventory still finds it.
  const queried = records.slice(0, -1);
  const pages = Array.from({ length: Math.ceil(queried.length / 200) }, (_, i) => page(queried.slice(i * 200, (i + 1) * 200),
    (i + 1) * 200 < queried.length ? `page-${i + 1}` : null));
  const client = clientFor(records, pages), originalLookup = client.lookup;
  let batches = 0;
  client.lookup = async names => { assert.ok(names.length <= 200); batches++; return originalLookup(names); };
  await assert.rejects(requireNoChildren(client, owner, inventory, root.recordName), hasCode("UNSUPPORTED_FEATURE"));
  assert.equal(client.queries(), 10); assert.equal(batches, 10);
  await requireNoChildren(clientFor(records, pages), owner, inventory, records[1].recordName);
  const incomplete = clientFor(records.slice(0, -1), pages);
  await assert.rejects(requireNoChildren(incomplete, owner, inventory, root.recordName), hasCode("CONFLICT"));
  const unknown = { ...hiddenChild, fields: { ...hiddenChild.fields, UnknownChildren: { type: "STRING_LIST", value: [] } } };
  await assert.rejects(requireNoChildren(clientFor([...records.slice(0, -1), unknown], pages), owner, inventory, root.recordName), hasCode("UNSUPPORTED_FEATURE"));
});

test("large exact inspection bounds concurrency and drains reads before propagating failure", async () => {
  const ids = Array.from({ length: 1001 }, () => `Reminder/${crypto.randomUUID()}`);
  const inventory = { ...list, fields: { ...list.fields, ReminderIDs: { type: "STRING", value: JSON.stringify(ids) } } };
  let started = 0, settled = false;
  let signalStarted!: () => void, release!: () => void;
  const firstGroup = new Promise<void>(resolve => { signalStarted = resolve; });
  const pending = new Promise<void>(resolve => { release = resolve; });
  const client = {
    ...clientFor([], [page([])]),
    lookupRelationshipRecords: async (names: string[]): Promise<CloudKitLookupResult> => {
      const index = started++;
      if (started === 4) signalStarted();
      if (index === 0) throw new AppError("UPSTREAM_UNAVAILABLE", "Synthetic read failure.");
      await pending;
      if (index === 1) throw new AppError("REAUTH_REQUIRED", "Synthetic authentication failure.");
      return { requestedRecordNames: names, records: [], unresolvedRecordNames: [], complete: false,
        recordErrors: names.map(recordName => ({ recordName, serverErrorCode: "NOT_FOUND", reason: null, raw: {} })) };
    },
  };
  const inspection = requireNoChildren(client, owner, inventory, parent.recordName);
  const completion = inspection.then(() => { settled = true; }, error => { settled = true; throw error; });
  await firstGroup;
  assert.equal(started, 4); assert.equal(settled, false);
  release();
  await assert.rejects(completion, hasCode("REAUTH_REQUIRED"));
  assert.equal(started, 4); assert.equal(settled, true);
});

test("large scans overlap exact native inventory, then resolve query-only children", async () => {
  const ids = Array.from({ length: 1001 }, () => `Reminder/${crypto.randomUUID()}`);
  const root = record(ids[0]), extra = record(`Reminder/${crypto.randomUUID()}`, root.recordName);
  const records = [...ids.map(id => record(id)), extra];
  const inventory = { ...list, fields: { ...list.fields, ReminderIDs: { type: "STRING", value: JSON.stringify(ids) } } };
  let releaseQuery!: () => void;
  const queryGate = new Promise<void>(resolve => { releaseQuery = resolve; });
  const lookedUp = new Set<string>(), base = clientFor(records);
  const client = {
    ...base,
    queryRemindersPage: async () => { await queryGate; return page([root, extra]); },
    lookupRelationshipRecords: async (names: string[]) => {
      names.forEach(id => { assert.equal(lookedUp.has(id), false); lookedUp.add(id); });
      releaseQuery(); // Sequential query-before-lookup would deadlock here.
      return base.lookup(names);
    },
  };
  await assert.rejects(requireNoChildren(client, owner, inventory, root.recordName), hasCode("UNSUPPORTED_FEATURE"));
  assert.equal(lookedUp.size, ids.length + 1);
  assert.ok(lookedUp.has(extra.recordName));
});

test("overlapped scans drain both branches and prioritize authentication failures", async () => {
  for (const failQuery of [false, true]) {
    const ids = Array.from({ length: 1001 }, () => `Reminder/${crypto.randomUUID()}`);
    const inventory = { ...list, fields: { ...list.fields, ReminderIDs: { type: "STRING", value: JSON.stringify(ids) } } };
    let release!: () => void, queryStarted!: () => void, settled = false;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { queryStarted = resolve; });
    const client = {
      ...clientFor([]),
      queryRemindersPage: async () => {
        queryStarted();
        if (!failQuery) await pending;
        throw new AppError(failQuery ? "UPSTREAM_UNAVAILABLE" : "REAUTH_REQUIRED", "Synthetic query failure.");
      },
      lookupRelationshipRecords: async (): Promise<CloudKitLookupResult> => {
        if (failQuery) await pending;
        throw new AppError(failQuery ? "REAUTH_REQUIRED" : "UPSTREAM_UNAVAILABLE", "Synthetic inventory failure.");
      },
    };
    const result = requireNoChildren(client, owner, inventory, parent.recordName)
      .then(() => { settled = true; }, error => { settled = true; throw error; });
    await started; await Promise.resolve();
    assert.equal(settled, false);
    release();
    await assert.rejects(result, hasCode("REAUTH_REQUIRED"));
    assert.equal(settled, true);
  }
});

test("overlapped inventory absence remains a conflict when the fresh query returns that identity", async () => {
  const ids = Array.from({ length: 1001 }, () => `Reminder/${crypto.randomUUID()}`);
  const missing = ids[0], inventory = { ...list, fields: { ...list.fields, ReminderIDs: { type: "STRING", value: JSON.stringify(ids) } } };
  const client = {
    ...clientFor([], [page([record(missing)])]),
    lookupRelationshipRecords: async (names: string[]): Promise<CloudKitLookupResult> => ({
      requestedRecordNames: names, records: [], unresolvedRecordNames: [], complete: false,
      recordErrors: names.map(recordName => ({ recordName, serverErrorCode: "NOT_FOUND", reason: null, raw: {} })),
    }),
  };
  await assert.rejects(requireNoChildren(client, owner, inventory, missing), hasCode("CONFLICT"));
});

test("child inspection covers completed descendants and refuses incomplete, cycling, erroneous and oversized pages", async () => {
  const completeChild = { ...child, fields: { ...child.fields, Completed: { type: "INT64", value: 1 } } };
  await assert.rejects(requireNoChildren(clientFor([parent, completeChild], [page([parent], "next"), page([completeChild])]), owner, list, parent.recordName), hasCode("UNSUPPORTED_FEATURE"));
  await requireNoChildren(clientFor([parent, child], [page([parent], "next"), page([child])]), owner, list, child.recordName);
  for (const pages of [
    [page([], "same")],
    [{ ...page([]), complete: false }],
    [{ ...page([]), recordErrors: [{ recordName: null, serverErrorCode: "UNKNOWN_ERROR", reason: null, raw: {} }] }],
    [page([{ ...parent, fields: { ...parent.fields, Huge: { type: "STRING", value: "x".repeat(262_145) } } }])],
  ]) await assert.rejects(requireNoChildren(clientFor([], pages), owner, list, parent.recordName), error => error instanceof AppError && ["UNSUPPORTED_FEATURE", "PROTOCOL_CHANGED"].includes(error.code));
  for (const [serverErrorCode, code] of [["AUTHENTICATION_REQUIRED", "REAUTH_REQUIRED"], ["ACCESS_DENIED", "FORBIDDEN"], ["THROTTLED", "RATE_LIMITED"]]) {
    await assert.rejects(requireNoChildren(clientFor([], [{ ...page([]), recordErrors: [{ recordName: null, serverErrorCode, reason: null, raw: {} }] }]), owner, list, parent.recordName), hasCode(code));
  }
});

test("compound family scans count known auxiliary records without interpreting or rejecting repeated graphs", async () => {
  const auxiliaries: CloudKitRecord[] = ["Alarm", "AlarmTrigger", "RecurrenceRule", "Attachment", "Hashtag"].map(recordType => ({
    recordName: `${recordType}/AUXILIARY`, recordType, recordChangeTag: "auxiliary-version", zoneID, raw: {},
    fields: { Deleted: { type: "INT64", value: 0 } },
  }));
  const pages = [page([parent, ...auxiliaries], "next"), page([child, ...auxiliaries])];
  assert.deepEqual([...await listChildren(clientFor([], pages), owner, listId)], [[parent.recordName, [child.recordName]]]);
  const input = { listId, reminderId: parent.recordName, recordChangeTag: parent.recordChangeTag! };
  const plan = await planLifecycle(clientFor([parent, child], pages), "complete", input, parent, list, owner, now);
  assert.deepEqual(plan.writes.map(write => write.recordName), [parent.recordName, child.recordName]);
  assert.deepEqual(plan.guards.map(record => record.recordName), [listId]);
  await assert.rejects(listChildren(clientFor([], [page([parent], "next"), page([parent])]), owner, listId), hasCode("PROTOCOL_CHANGED"));
  const foreign = { ...auxiliaries[0], zoneID: { ...zoneID, ownerRecordName: "foreign" } };
  await assert.rejects(listChildren(clientFor([], [page([parent, foreign])]), owner, listId), hasCode("FORBIDDEN"));
  const huge = { ...auxiliaries[0], fields: { Huge: { type: "STRING", value: "x".repeat(262_145) } } };
  await assert.rejects(listChildren(clientFor([], [page([parent, huge])]), owner, listId), hasCode("UNSUPPORTED_FEATURE"));
});

function atomicClient(reply: unknown, capture: (payload: { operations: { record: CloudKitRecord & { parent?: unknown } }[] }) => void = () => {}) {
  return new CloudKitRemindersClient(new AppleHTTP(new CookieJar(), async (url, init) => {
    const payload = JSON.parse(String(init?.body));
    if (new URL(String(url)).pathname.endsWith("/records/lookup")) {
      const records = (reply as { records?: CloudKitRecord[] }).records ?? [];
      return Response.json({ records: records.filter(record => payload.records.some((request: { recordName: string }) => request.recordName === record.recordName)) });
    }
    capture(payload);
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
  const changingInput = structuredClone(write);
  const frozen = atomicClient({ records: [confirmed, { ...parent, recordChangeTag: "parent-next" }] });
  const retained = await frozen.modifyRecords([{ operationType: "update", record: changingInput }], async () => {
    changingInput.recordName = parent.recordName;
    changingInput.recordChangeTag = "changed-before-dispatch";
  }, [parent]);
  assert.equal(retained[0].recordName, child.recordName, "Receipt identity stays bound to the submitted snapshot across the dispatch callback.");
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

test("mixed family lifecycle shares completion time and selectively reopens; child actions preserve root state", async () => {
  const independent = completed(record("Reminder/INDEPENDENT", parent.recordName));
  const records = [parent, child, independent];
  const input = { listId, reminderId: parent.recordName, recordChangeTag: parent.recordChangeTag! };
  const plan = await planLifecycle(clientFor(records), "complete", input, parent, list, owner, now);
  assert.deepEqual(plan.writes.map(write => write.recordName), [parent.recordName, child.recordName]);
  assert.deepEqual(plan.guards.map(record => record.recordName), [independent.recordName, listId]);
  for (const write of plan.writes) assert.equal(write.fields.CompletionDate.value, now);
  const after = records.map(record => {
    const write = plan.writes.find(write => write.recordName === record.recordName);
    return write ? { ...record, fields: { ...record.fields, ...write.fields } } : record;
  });
  const reopen = await planLifecycle(clientFor(after), "reopen", input, after[0], list, owner, now + 1000);
  assert.deepEqual(reopen.writes.map(write => write.recordName), [parent.recordName, child.recordName]);
  for (const write of reopen.writes) assert.equal(write.fields.CompletionDate.value, null);
  assert.equal(fieldValue(reopen.guards[0], "CompletionDate"), now - 1000);
  const childReopen = await planLifecycle(clientFor(after), "reopen", target, after[1], list, owner, now + 2000);
  assert.deepEqual(childReopen.writes.map(write => write.recordName), [child.recordName]);
  assert.deepEqual(childReopen.guards.map(record => record.recordName), [parent.recordName, independent.recordName, listId]);
  assert.equal(fieldValue(childReopen.guards[0], "Completed"), 1);
  const childComplete = await planLifecycle(clientFor([parent, child]), "complete", target, child, list, owner, now);
  assert.deepEqual(childComplete.writes.map(write => write.recordName), [child.recordName]);
  assert.equal(fieldValue(childComplete.guards[0], "Completed"), 0);
  assert.equal(childComplete.writes[0].fields.ParentReminder, undefined);
  const tokens = JSON.parse(String(childComplete.writes[0].fields.ResolutionTokenMap.value)).map;
  const previous = JSON.parse(String(fieldValue(child, "ResolutionTokenMap"))).map;
  assert.deepEqual(tokens.parentReminder, previous.parentReminder);
});

test("native direct child and root deletion use distinct detach and cascade recipes with exact List membership", async () => {
  const independent = completed(record("Reminder/INDEPENDENT", parent.recordName));
  const records = [parent, child, independent];
  const populated = { ...list, fields: { ...list.fields, ReminderIDs: { type: "STRING", value: JSON.stringify(records.map(record => record.recordName)) } } };
  const direct = await planLifecycle(clientFor(records), "delete", target, child, populated, owner, now);
  assert.deepEqual(direct.writes.map(write => write.recordName), [child.recordName, parent.recordName]);
  const detached = direct.writes[0];
  assert.equal(detached.parent, null);
  assert.equal(detached.fields.List.value, null); assert.equal(detached.fields.ParentReminder.value, null);
  assert.deepEqual(Object.keys(direct.writes[1].fields).sort(), ["LastModifiedDate", "ResolutionTokenMap"]);
  const childTokens = JSON.parse(String(detached.fields.ResolutionTokenMap.value)).map;
  const previousTokens = JSON.parse(String(fieldValue(child, "ResolutionTokenMap"))).map;
  for (const name of ["completed", "completionDate", "deleted"]) assert.deepEqual(childTokens[name], previousTokens[name]);
  assert.deepEqual(JSON.parse(String(direct.listWrite!.fields.ReminderIDs.value)), [parent.recordName, independent.recordName]);
  assert.deepEqual(direct.guards.map(record => record.recordName), [independent.recordName]);
  const family = await planLifecycle(clientFor(records), "delete", { listId, reminderId: parent.recordName, recordChangeTag: parent.recordChangeTag! }, parent, populated, owner, now);
  assert.deepEqual(family.writes.slice(1).map(write => write.fields), [{ Deleted: { type: "INT64", value: 1 } }, { Deleted: { type: "INT64", value: 1 } }]);
  assert.deepEqual(JSON.parse(String(family.listWrite!.fields.ReminderIDs.value)), [child.recordName, independent.recordName]);
  const detachedRecord = { ...parent, fields: { ...parent.fields, ...family.writes[0].fields } };
  assert.throws(() => normalizeReminder(detachedRecord, owner), hasCode("PROTOCOL_CHANGED"));
  const normalized = normalizeReminder(detachedRecord, owner, true);
  assert.equal(normalized.listId, null); assert.equal(normalized.deleted, true);
  const confirmations = records.map(record => ({ ...record, recordChangeTag: `next-${record.recordChangeTag}`,
    fields: { ...record.fields, ...family.writes.find(write => write.recordName === record.recordName)!.fields } }));
  const nextList = { ...populated, recordChangeTag: "next-list", fields: { ...populated.fields, ...family.listWrite!.fields } };
  const accepted = await atomicClient({ records: [nextList, ...confirmations].reverse() }, payload => {
    assert.deepEqual(payload.operations[0].record.parent, { recordName: null });
    for (const operation of payload.operations.slice(1)) assert.equal(operation.record.parent, undefined);
  }).modifyLifecycleDeletion(family.writes, family.records, populated, family.listWrite, undefined, family.guards);
  assert.equal(accepted[0].recordName, parent.recordName);
  const guardedIndependent = { ...independent, raw: { parent: { recordName: listId } } };
  const guarded = await planLifecycle(clientFor([parent, child, guardedIndependent]), "delete", target, child, populated, owner, now);
  const directReplies = guarded.records.map(record => ({ ...record, recordChangeTag: `next-${record.recordChangeTag}`,
    fields: { ...record.fields, ...guarded.writes.find(write => write.recordName === record.recordName)?.fields,
      ...(record.recordName === independent.recordName ? { HashtagIDs: { type: "UNKNOWN_LIST", value: [] } } : {}) },
    ...(record.recordName === independent.recordName ? { parent: { recordName: listId, zoneID } } : {}) }));
  const directList = { ...populated, recordChangeTag: "next-list", fields: { ...populated.fields, ...guarded.listWrite!.fields } };
  await atomicClient({ records: [directList, ...directReplies] }).modifyLifecycleDeletion(guarded.writes, guarded.records, populated, guarded.listWrite, undefined, guarded.guards);
  let dispatches = 0;
  const changedParentReplies = directReplies.map(record => record.recordName === independent.recordName ? { ...record, parent: { recordName: "List/OTHER", zoneID } } : record);
  await assert.rejects(atomicClient({ records: [directList, ...changedParentReplies] }, () => { dispatches++; }).modifyLifecycleDeletion(guarded.writes, guarded.records, populated, guarded.listWrite, undefined, guarded.guards), hasCode("WRITE_OUTCOME_UNKNOWN"));
  assert.equal(dispatches, 1);
  const absentMembership = { ...populated, fields: { ...populated.fields, ReminderIDs: { type: "STRING", value: "[]" } } };
  const absent = await planLifecycle(clientFor([parent]), "delete", { listId, reminderId: parent.recordName, recordChangeTag: parent.recordChangeTag! }, parent, absentMembership, owner, now);
  assert.equal(absent.listWrite, undefined); assert.deepEqual(absent.guards.map(record => record.recordName), [listId]);
});

test("family planning refuses stale, incomplete, foreign, unknown, deeper and oversized relationships before dispatch", async () => {
  const input = { listId, reminderId: parent.recordName, recordChangeTag: parent.recordChangeTag! };
  await assert.rejects(planLifecycle(clientFor([parent, child]), "complete", { ...input, recordChangeTag: "stale" }, parent, list, owner), hasCode("CONFLICT"));
  const deeper = record("Reminder/DEEP", child.recordName);
  const unknown = { ...child, fields: { ...child.fields, FutureChildIDs: { type: "STRING_LIST", value: [] } } };
  const foreign = { ...child, zoneID: { ...zoneID, ownerRecordName: "foreign" } };
  for (const [records, code] of [[[parent, child, deeper], "UNSUPPORTED_FEATURE"], [[parent, unknown], "UNSUPPORTED_FEATURE"], [[parent, foreign], "FORBIDDEN"]] as const) {
    await assert.rejects(planLifecycle(clientFor([...records]), "complete", input, parent, list, owner), hasCode(code));
  }
  await assert.rejects(planLifecycle(clientFor([parent, child], [{ ...page([parent, child]), complete: false }]), "complete", input, parent, list, owner), hasCode("UNSUPPORTED_FEATURE"));
  await assert.rejects(planLifecycle(clientFor([parent], [page([parent, child])]), "complete", input, parent, list, owner), hasCode("CONFLICT"));
  const many = Array.from({ length: 31 }, (_, index) => record(`Reminder/CHILD-${index}`, parent.recordName));
  const bounded = clientFor([parent, ...many]);
  const largeList = { ...list, fields: { ...list.fields, ReminderIDs: { type: "STRING", value: JSON.stringify([parent, ...many].map(record => record.recordName)) } } };
  await assert.rejects(planLifecycle(bounded, "complete", input, parent, largeList, owner), hasCode("UNSUPPORTED_FEATURE"));
  assert.equal(bounded.queries(), 1);
});

test("family atomics reject stale child, parent and List versions; unknown acknowledgment never repeats", async () => {
  const independent = completed(record("Reminder/INDEPENDENT", parent.recordName));
  const input = { listId, reminderId: parent.recordName, recordChangeTag: parent.recordChangeTag! };
  const plan = await planLifecycle(clientFor([parent, child, independent]), "complete", input, parent, list, owner, now);
  const operations = plan.writes.map(record => ({ operationType: "update" as const, record }));
  const group = [...plan.writes, ...plan.guards];
  for (const stale of [parent, child, independent, list]) {
    let dispatched = 0;
    const client = atomicClient({ records: group.map(record => ({ recordName: record.recordName,
      serverErrorCode: record.recordName === stale.recordName ? "SERVER_RECORD_CHANGED" : "ATOMIC_ERROR" })) }, () => { dispatched++; });
    await assert.rejects(client.modifyRecords(operations, undefined, plan.guards), hasCode("CONFLICT"));
    assert.equal(dispatched, 1);
  }
  const confirmations = [...plan.records, list].map(record => ({ ...record, recordChangeTag: `next-${record.recordChangeTag}`,
    fields: { ...record.fields, ...plan.writes.find(write => write.recordName === record.recordName)?.fields } }));
  let dispatched = 0;
  const unknown = atomicClient({ records: confirmations.slice(0, -1) }, () => { dispatched++; });
  await assert.rejects(unknown.modifyRecords(operations, undefined, plan.guards), hasCode("WRITE_OUTCOME_UNKNOWN"));
  assert.equal(dispatched, 1);
  const accepted = await atomicClient({ records: confirmations.reverse() }).modifyRecords(operations, undefined, plan.guards);
  assert.deepEqual(accepted.slice(0, 2).map(record => record.recordName), [parent.recordName, child.recordName]);
  const overBudget = atomicClient({}, () => { dispatched++; });
  await assert.rejects(overBudget.modifyRecords(operations, undefined, [...plan.guards, ...Array.from({ length: 29 }, (_, index) => record(`Reminder/GUARD-${index}`))]), hasCode("VALIDATION_ERROR"));
  assert.equal(dispatched, 1);
});

test("current List versions cannot hide a committed child behind a lagging query", async () => {
  const late = record("Reminder/LATE", parent.recordName);
  const members = [parent, child, late];
  const currentList = { ...list, recordChangeTag: "after-native-attachment", fields: { ...list.fields,
    ReminderIDs: { type: "STRING", value: JSON.stringify(members.map(record => record.recordName)) } } };
  const input = { listId, reminderId: parent.recordName, recordChangeTag: parent.recordChangeTag! };
  // Both an omitted identity and an old root relationship can survive in the query index.
  for (const staleQuery of [[parent, child], [parent, child, record(late.recordName)]]) {
    const plan = await planLifecycle(clientFor(members, [page(staleQuery)]), "complete", input, parent, currentList, owner, now);
    assert.deepEqual(plan.writes.map(write => write.recordName), members.map(record => record.recordName));
    assert.deepEqual(plan.writes.map(write => write.fields.CompletionDate.value), [now, now, now]);
  }
  const nested = record("Reminder/NESTED", late.recordName);
  const nestedList = { ...currentList, fields: { ...currentList.fields,
    ReminderIDs: { type: "STRING", value: JSON.stringify([...members, nested].map(record => record.recordName)) } } };
  await assert.rejects(planLifecycle(clientFor([...members, nested], [page([parent, child])]), "complete", input, parent, nestedList, owner, now), hasCode("UNSUPPORTED_FEATURE"));
  await assert.rejects(requireNoChildren(clientFor(members, [page([parent, child])]), owner, currentList, parent.recordName), hasCode("UNSUPPORTED_FEATURE"));
  // Missing responses are not absence evidence, even with apparently current guards.
  await assert.rejects(planLifecycle(clientFor([parent, child], [page([parent, child])]), "complete", input, parent, currentList, owner, now), hasCode("CONFLICT"));
  const retiredId = "Reminder/RETIRED";
  const retainedOrdering = { ...currentList, fields: { ...currentList.fields,
    ReminderIDs: { type: "STRING", value: JSON.stringify([...members.map(record => record.recordName), retiredId]) } } };
  const client = clientFor(members, [page([parent, child])]);
  const lookup = client.lookup;
  client.lookup = async ids => {
    const found = await lookup(ids);
    return ids.includes(retiredId) ? { ...found, complete: false,
      recordErrors: [{ recordName: retiredId, serverErrorCode: "NOT_FOUND", reason: null, raw: {} }] } : found;
  };
  const complete = await planLifecycle(client, "complete", input, parent, retainedOrdering, owner, now);
  assert.deepEqual(complete.writes.map(write => write.recordName), members.map(record => record.recordName));
});

test("creation atomically preserves List parent metadata and exposes the new inventory identity", async () => {
  const parentMetadata = { recordName: "Account/SYNTHETIC", zoneID };
  const before = { ...list, raw: { parent: parentMetadata }, fields: { ...list.fields, Name: { type: "STRING", value: "Synthetic list" },
    ResolutionTokenMap: { type: "STRING", value: JSON.stringify({ map: { reminderIDsMergeableOrdering: { counter: 1, modificationTime: 1_700_000_000, replicaID: crypto.randomUUID() } } }) } } };
  const write = buildCreateReminder(CreateReminderInput.parse({ listId, idempotencyKey: crypto.randomUUID(), title: "Inventory member" }), now);
  const membership = creationMembership(write, before, owner);
  const confirmedList = { ...before, parent: parentMetadata, recordChangeTag: "created-list-next", fields: { ...before.fields, ...membership.fields } };
  const confirmed = { ...write, recordChangeTag: "created-reminder", zoneID, raw: {} };
  let dispatched = 0;
  const client = atomicClient({ records: [confirmed, confirmedList] }, payload => {
    dispatched++;
    assert.equal(payload.operations[0].record.recordName, listId);
    assert.deepEqual(JSON.parse(String((payload.operations[0].record.fields.ReminderIDs as { value: unknown }).value)), [parent.recordName, child.recordName, write.recordName.slice(9)]);
  });
  const created = await client.modifyReminderCreation(write, before);
  assert.equal(created.recordName, write.recordName); assert.equal(dispatched, 1);
  const changedParent = { ...confirmedList, parent: { ...parentMetadata, recordName: "Account/OTHER" } };
  await assert.rejects(atomicClient({ records: [confirmed, changedParent] }).modifyReminderCreation(write, before), hasCode("WRITE_OUTCOME_UNKNOWN"));
});

test("native asset guard normalization excludes only proven signed URLs and preserves asset encryption metadata", async () => {
  const asset = { type: "ASSETID", value: { downloadURL: "https://synthetic.invalid/one", fileChecksum: "checksum", size: 10, wrappingKey: "synthetic-key", referenceChecksum: "reference" } };
  const guarded = { ...list, fields: { ...list.fields, MembershipsOfRemindersInSectionsAsData: asset } };
  const write = buildSetReminderParent({ ...target, parentReminder: null }, child, owner, now + 1000);
  const confirmation = { ...child, recordChangeTag: "next-child", fields: { ...child.fields, ...write.fields } };
  const refreshed = { ...guarded, recordChangeTag: "next-list", fields: { ...guarded.fields,
    MembershipsOfRemindersInSectionsAsData: { ...asset, value: { ...asset.value, downloadURL: "https://synthetic.invalid/two" } } } };
  assert.deepEqual(stableNativePresentation(guarded.fields), stableNativePresentation(refreshed.fields));
  await atomicClient({ records: [confirmation, refreshed] }).modifyRecords([{ operationType: "update", record: write }], undefined, [guarded]);
  for (const property of ["fileChecksum", "size", "wrappingKey", "referenceChecksum"]) {
    const drift = { ...refreshed, fields: { ...refreshed.fields, MembershipsOfRemindersInSectionsAsData: { ...asset,
      value: { ...asset.value, [property]: property === "size" ? 11 : "changed" } } } };
    await assert.rejects(atomicClient({ records: [confirmation, drift] }).modifyRecords([{ operationType: "update", record: write }], undefined, [guarded]), hasCode("WRITE_OUTCOME_UNKNOWN"));
  }
  assert.deepEqual(stableNativePresentation({ FutureAsset: asset }), { FutureAsset: asset });
});


test("scheduled families retain exact dated-member pairs through selective completion, reopening and root deletion", async () => {
  const dated = (before: CloudKitRecord, due: string) => {
    const root = structuredClone(before); root.raw.parent = { recordName: listId };
    root.fields.DueDate = { type: "TIMESTAMP", value: Date.parse(due) }; root.fields.TimeZone = { type: "STRING", value: "Europe/London" }; root.fields.AllDay = { type: "INT64", value: 0 };
    const tokens = JSON.parse(String(fieldValue(root, "ResolutionTokenMap"))); tokens.map.dueDate = { counter: 1, modificationTime: 1_700_000_000, replicaID: crypto.randomUUID() };
    root.fields.ResolutionTokenMap = { type: "STRING", value: JSON.stringify(tokens) };
    root.fields.UrgentPresentationAlarmsAsData = { type: "ASSETID", value: { downloadURL: "https://synthetic.invalid/one", wrappingKey: "synthetic-key", fileChecksum: "checksum", size: 1 } };
    const alarmId = `Alarm/${crypto.randomUUID().toUpperCase()}`, triggerId = `AlarmTrigger/${crypto.randomUUID().toUpperCase()}`;
    root.fields.AlarmIDs = { type: "STRING_LIST", value: [alarmId] };
    const reference = (recordName: string) => ({ type: "REFERENCE", value: { recordName, action: "VALIDATE", zoneID } });
    const alarm: CloudKitRecord = { recordName: alarmId, recordType: "Alarm", recordChangeTag: "alarm-version", zoneID, raw: { parent: { recordName: root.recordName } }, fields: {
      AlarmUID: { type: "STRING", value: alarmId.slice(6) }, TriggerID: { type: "STRING", value: triggerId.slice(13) },
      DueDateResolutionTokenAsNonce: { type: "DOUBLE", value: dueDateNonce(JSON.stringify(tokens)) }, Reminder: reference(root.recordName), Imported: { type: "INT64", value: 0 }, Deleted: { type: "INT64", value: 0 },
    } };
    const trigger: CloudKitRecord = { recordName: triggerId, recordType: "AlarmTrigger", recordChangeTag: "trigger-version", zoneID, raw: { parent: { recordName: alarmId } }, fields: {
      DateComponentsData: { type: "BYTES", value: b64(utf8(JSON.stringify(dateComponents(due, "Europe/London")))) }, Type: { type: "STRING", value: "Date" },
      Alarm: reference(alarmId), Imported: { type: "INT64", value: 0 }, Deleted: { type: "INT64", value: 0 },
    } };
    return [root, alarm, trigger];
  };
  const rootPair = dated(parent, "2027-01-19T09:00:00Z"), childPair = dated(child, "2027-01-20T10:00:00Z"), independent = completed(record("Reminder/SCHEDULED-INDEPENDENT", parent.recordName));
  independent.raw.parent = { recordName: listId };
  const members = [rootPair[0], childPair[0], independent], pairs = [...rootPair.slice(1), ...childPair.slice(1)], snapshots = [...members, ...pairs];
  const populated = { ...list, fields: { ...list.fields, ReminderIDs: { type: "STRING", value: JSON.stringify(members.map(record => record.recordName)) } } };
  const input = { listId, reminderId: parent.recordName, recordChangeTag: parent.recordChangeTag! };
  const inspect = async (action: "complete" | "reopen" | "delete", values: CloudKitRecord[], target = values[0]) => await inspectLifecycleFamily(clientFor(values.filter(record => record.recordType !== "List")), action,
    { listId, reminderId: target.recordName, recordChangeTag: target.recordChangeTag! }, target, populated, owner, true);
  const family = await inspect("complete", snapshots);
  const resolved = await loadScheduledFamilyPairs({ lookupSchedulingRecords: clientFor(snapshots).lookup }, family, owner);
  const plan = planScheduledFamilyLifecycle("complete", input, family, resolved, populated, owner, now);
  assert.equal(plan.operations.length, 8); assert.deepEqual(plan.writes.map(record => record.recordName), [parent.recordName, child.recordName]);
  plan.writes.forEach(record => assert.equal(record.fields.CompletionDate.value, now));
  const apply = (plan: ReturnType<typeof planScheduledFamilyLifecycle>) => plan.expected.map(record => ({ ...structuredClone(record), recordChangeTag: `${record.recordChangeTag}-next` }));
  const after = apply(plan), childAfter = after.find(record => record.recordName === child.recordName)!;
  const reopenFamily = await inspect("reopen", after, after[0]);
  const reopenInput = { ...input, recordChangeTag: after[0].recordChangeTag! };
  const reopened = planScheduledFamilyLifecycle("reopen", reopenInput, reopenFamily, pairs, populated, owner, now + 1000);
  assert.deepEqual(reopened.writes.map(record => record.recordName), [parent.recordName, child.recordName]);
  const childReopen = planScheduledFamilyLifecycle("reopen", { ...target, recordChangeTag: childAfter.recordChangeTag! }, await inspect("reopen", after, childAfter), pairs, populated, owner, now + 2000);
  assert.deepEqual(childReopen.writes.map(record => record.recordName), [child.recordName]);
  assert.equal(fieldValue(childReopen.expected.find(record => record.recordName === parent.recordName)!, "Completed"), 1);
  const directChildDeletion = planScheduledFamilyLifecycle("delete", target, family, pairs, populated, owner, now);
  assert.deepEqual(directChildDeletion.writes.map(write => write.recordName), [child.recordName, parent.recordName]);
  assert.equal(directChildDeletion.writes[0].fields.ParentReminder.value, null);
  assert.deepEqual(Object.keys(directChildDeletion.writes[1].fields).sort(), ["LastModifiedDate", "ResolutionTokenMap"]);
  for (const pair of rootPair.slice(1)) assert.equal(directChildDeletion.operations.find(operation => operation.record.recordName === pair.recordName)!.record.fields.Deleted.value, 0);
  for (const pair of childPair.slice(1)) assert.equal(directChildDeletion.operations.find(operation => operation.record.recordName === pair.recordName)!.record.fields.Deleted.value, 1);
  const undatedChildDeletion = planScheduledFamilyLifecycle("delete", { listId, reminderId: independent.recordName, recordChangeTag: independent.recordChangeTag! }, family, pairs, populated, owner, now);
  for (const pair of pairs) assert.equal(undatedChildDeletion.operations.find(operation => operation.record.recordName === pair.recordName)!.record.fields.Deleted.value, 0);
  const deletion = planScheduledFamilyLifecycle("delete", input, family, pairs, populated, owner, now + 3000);
  for (const pair of pairs) assert.deepEqual(deletion.operations.find(operation => operation.record.recordName === pair.recordName)!.record.fields, { Deleted: { type: "INT64", value: 1 } });
  for (const member of members.slice(1)) assert.deepEqual(deletion.writes.find(write => write.recordName === member.recordName)!.fields, { Deleted: { type: "INT64", value: 1 } });
  assert.deepEqual(JSON.parse(String(deletion.operations.find(operation => operation.record.recordType === "List")!.record.fields.ReminderIDs.value)), members.slice(1).map(record => record.recordName));
  let posts = 0;
  const transport = (variant?: string) => new CloudKitRemindersClient(new AppleHTTP(new CookieJar(), async (_, init) => {
    posts++; const payload = JSON.parse(String(init?.body)); assert.equal(payload.atomic, true); assert.equal(payload.operations.length, 8);
    if (variant === "stale") return Response.json({ records: payload.operations.map((operation: { record: CloudKitRecord }) => ({ recordName: operation.record.recordName, serverErrorCode: operation.record.recordName === child.recordName ? "CONFLICT" : "ATOMIC_ERROR" })) });
    const records = apply(plan).map(record => ({ ...record, parent: record.raw.parent }));
    if (variant === "parent") records.find(record => record.recordName === child.recordName)!.parent = { recordName: "List/OTHER" };
    if (variant === "crypto") ((records[0].fields.UrgentPresentationAlarmsAsData as { value: Record<string, unknown> }).value).wrappingKey = "changed";
    return Response.json({ records });
  }), { dsid: "123", clientId: "synthetic", clientBuildNumber: "synthetic", clientMasteringNumber: "synthetic", cloudKitURL: "https://p01-ckdatabasews.icloud.com/database/1/com.apple.reminders/production/private", remindersZoneOwner: owner });
  await transport().modifyScheduledFamilyLifecycle(plan, async () => {});
  await assert.rejects(transport("stale").modifyScheduledFamilyLifecycle(plan, async () => {}), hasCode("CONFLICT"));
  for (const variant of ["parent", "crypto"]) await assert.rejects(transport(variant).modifyScheduledFamilyLifecycle(plan, async () => {}), hasCode("WRITE_OUTCOME_UNKNOWN"));
  assert.equal(posts, 4);
  await assert.rejects(transport().modifyScheduledFamilyLifecycle({ ...plan, operations: plan.operations.slice(1) }, async () => {}), hasCode("VALIDATION_ERROR")); assert.equal(posts, 4);
  for (const change of [ { ...pairs[0], fields: { ...pairs[0].fields, Deleted: { type: "INT64", value: 0, unknownMetadata: "preserve" } } }, { ...pairs[0], zoneID: { ...zoneID, ownerRecordName: "foreign" } },
    { ...pairs[0], fields: { ...pairs[0].fields, UnexpectedReference: { type: "REFERENCE", value: { recordName: parent.recordName, action: "VALIDATE" } } } } ])
    assert.throws(() => planScheduledFamilyLifecycle("complete", input, family, [change, ...pairs.slice(1)], populated, owner, now), error => error instanceof AppError);
  await assert.rejects(loadScheduledFamilyPairs({ lookupSchedulingRecords: clientFor(snapshots.filter(record => record !== pairs[0])).lookup }, family, owner), hasCode("CONFLICT"));
  const largeFamily = { rootId: parent.recordName, records: [members[0], ...Array.from({ length: 10 }, (_, index) => ({ ...members[1], recordName: `Reminder/EXTRA-${index}` }))] };
  await assert.rejects(loadScheduledFamilyPairs({ lookupSchedulingRecords: clientFor(snapshots).lookup }, largeFamily, owner), hasCode("UNSUPPORTED_FEATURE"));
});
