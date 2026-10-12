import test from "node:test";
import assert from "node:assert/strict";
import { AppError } from "../src/errors.ts";
import { buildCreateList, buildRenameList, buildDeleteList, CreateListInput,
  RenameListInput, DeleteListInput, requireMutableList } from "../src/reminders/list-writes.ts";
import type { CloudKitRecord } from "../src/icloud/cloudkit.ts";

const id = "List/11111111-2222-4333-8444-555555555555";
const key = "11111111-2222-4333-8444-555555555555";
const owner = "private-owner";
const nameReplica = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
const accountReplica = "BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB";
const unchangedReplica = "CCCCCCCC-CCCC-4CCC-8CCC-CCCCCCCCCCCC";
const tokenMap = () => ({ map: {
  name: { counter: 3, modificationTime: 10, replicaID: nameReplica },
  parentAccount: { counter: 4, modificationTime: 20, replicaID: accountReplica },
  retainedNativeField: { counter: 5, modificationTime: 30, replicaID: unchangedReplica },
} });
const current = (): CloudKitRecord => ({
  recordName: id, recordType: "List", recordChangeTag: "v1",
  zoneID: { zoneName: "Reminders", zoneType: "REGULAR_CUSTOM_ZONE", ownerRecordName: owner },
  fields: {
    Name: { type: "STRING", value: "Old name" },
    Color: { type: "STRING", value: "#007AFF" },
    IsGroup: { type: "INT64", value: 0 },
    Deleted: { type: "INT64", value: 0 },
    Count: { type: "INT64", value: 0 },
    ResolutionTokenMap: { type: "STRING", value: JSON.stringify(tokenMap()) },
  }, raw: {},
});

test("list create matches the observed native shape and uses a stable UUID", () => {
  const a = buildCreateList({ name: "Shopping", idempotencyKey: key }, 1_800_000_000_000);
  assert.equal(a.recordName, id);
  assert.equal(a.recordType, "List");
  assert.deepEqual(Object.keys(a.fields).sort(), ["Deleted", "Imported", "IsGroup", "IsLinkedToAccount", "Name",
    "ReminderIDs", "ResolutionTokenMap", "ShouldAutoCategorizeItems", "ShouldCategorizeGroceryItems", "SortingStyle"].sort());
  assert.equal(a.fields.Name.value, "Shopping");
  assert.equal(a.fields.Name.isEncrypted, true);
  assert.equal(a.fields.SortingStyle.value, "manual");
  assert.equal(a.fields.IsLinkedToAccount.value, 1);
  assert.equal(a.fields.Imported.value, 0);
  assert.equal(a.fields.Deleted.value, 0);
  assert.equal(a.fields.IsGroup.value, 0);
  assert.equal(a.fields.ReminderIDs.value, "[]");
  assert.deepEqual(a.fields.ShouldAutoCategorizeItems, { type: "INT64", value: 0, isEncrypted: true });
  assert.deepEqual(a.fields.ShouldCategorizeGroceryItems, { type: "INT64", value: 0, isEncrypted: true });
  const createdTokens = JSON.parse(String(a.fields.ResolutionTokenMap.value)).map;
  assert.deepEqual(Object.keys(createdTokens).sort(), ["minimumSupportedVersion", "sortingStyle", "parentAccount", "name",
    "shouldAutoCategorizeItems", "shouldCategorizeGroceryItems", "reminderIDsMergeableOrdering"].sort());
  assert.equal(Object.hasOwn(a.fields, "Count"), false);
  assert.equal(Object.hasOwn(a.fields, "Color"), false);
  assert.equal(Object.hasOwn(a.fields, "CreationDate"), false);
  assert.equal(Object.hasOwn(a.fields, "LastModifiedDate"), false);
  for (const name of ["", "   ", "bad\u0000list", "bad\ud800", "x".repeat(257)])
    assert.equal(CreateListInput.safeParse({ name, idempotencyKey: key }).success, false);
});

test("list rename uses exact version and only advances the name token", () => {
  const existing = current();
  existing.fields.FutureField = { type: "STRING", value: "preserve" };
  const write = buildRenameList({ listId: id, recordChangeTag: "v1", name: "New name" }, existing, owner, 1_800_000_000_000);
  assert.deepEqual(Object.keys(write.fields).sort(), ["Name", "ResolutionTokenMap"]);
  assert.equal(write.recordChangeTag, "v1");
  assert.equal(write.fields.Name.value, "New name");
  assert.equal(write.fields.Name.isEncrypted, true);
  const updated = JSON.parse(String(write.fields.ResolutionTokenMap.value)).map;
  assert.deepEqual(updated.name, { counter: 4, modificationTime: 821_692_800, replicaID: nameReplica });
  assert.deepEqual(updated.parentAccount, tokenMap().map.parentAccount);
  assert.deepEqual(updated.retainedNativeField, tokenMap().map.retainedNativeField);
  assert.equal(existing.fields.Name && (existing.fields.Name as { value: string }).value, "Old name");
  assert.throws(() => buildRenameList({ listId: id, recordChangeTag: "stale", name: "Other" }, existing, owner),
    e => e instanceof AppError && e.code === "CONFLICT");
});

test("list deletion unlinks the list and only advances the parent-account token", () => {
  const write = buildDeleteList({ listId: id, recordChangeTag: "v1", confirmName: "Old name" }, current(), owner, 1_800_000_000_000);
  assert.equal(write.fields.Deleted.value, 1);
  assert.equal(write.fields.IsLinkedToAccount.value, 0);
  assert.equal(write.recordChangeTag, "v1");
  assert.deepEqual(Object.keys(write.fields).sort(), ["Deleted", "IsLinkedToAccount", "ResolutionTokenMap"]);
  assert.equal(Object.hasOwn(write.fields, "ReminderIDs"), false);
  const updated = JSON.parse(String(write.fields.ResolutionTokenMap.value)).map;
  assert.deepEqual(updated.parentAccount, { counter: 5, modificationTime: 821_692_800, replicaID: accountReplica });
  assert.deepEqual(updated.name, tokenMap().map.name);
  assert.deepEqual(updated.retainedNativeField, tokenMap().map.retainedNativeField);
  assert.throws(() => buildDeleteList({ listId: id, recordChangeTag: "v1", confirmName: "Wrong" }, current(), owner),
    e => e instanceof AppError && e.code === "CONFLICT");
});

test("reject shared list, group, tombstone, missing tags and unsafe names", () => {
  const shared = current(); shared.zoneID!.ownerRecordName = "another-owner";
  assert.throws(() => requireMutableList(shared, owner));
  const explicitShare = current(); explicitShare.raw.share = { recordName: "Share/opaque" };
  assert.throws(() => requireMutableList(explicitShare, owner));
  const wrongZoneType = current(); wrongZoneType.zoneID!.zoneType = "REGULAR_ZONE";
  assert.throws(() => requireMutableList(wrongZoneType, owner));
  const group = current(); group.fields.IsGroup = { type: "INT64", value: 1 };
  assert.throws(() => requireMutableList(group, owner));
  const deleted = current(); deleted.fields.Deleted = { type: "INT64", value: 1 };
  assert.throws(() => requireMutableList(deleted, owner));
  const missing = current(); delete missing.recordChangeTag;
  assert.throws(() => requireMutableList(missing, owner));
  assert.equal(RenameListInput.safeParse({ listId: id, recordChangeTag: "v1", name: "ok" }).success, true);
  assert.equal(DeleteListInput.safeParse({ listId: id, recordChangeTag: "v1", confirmName: "ok" }).success, true);
});
