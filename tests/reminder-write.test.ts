import test from "node:test";
import assert from "node:assert/strict";
import { AppError, WriteOutcomeUnknownError } from "../src/errors.ts";
import type { CloudKitRecord } from "../src/icloud/cloudkit.ts";
import { decodeDocument } from "../src/reminders/crdt.ts";
import { buildCreateReminder, buildUpdateReminder, buildLifecycleReminder, CreateReminderInput, matchesCreatedReminder } from "../src/reminders/writes.ts";
import { planTagChange, planURLChange } from "../src/reminders/organization.ts";
import { AppleHTTP } from "../src/transport/apple-http.ts";
import { CookieJar } from "../src/transport/cookie-jar.ts";
import { CloudKitRemindersClient } from "../src/icloud/cloudkit.ts";
import { parseWriteTestArgs } from "../scripts/dev/validate-local-reminder-writes.mjs";

const owner = "owner-test";
const baseInput = {
  listId: "List/LIST-A",
  idempotencyKey: "11111111-2222-4333-8444-555555555555",
  title: "Café 🧭",
  notes: "Remember the 🫖\n",
  priority: 5 as const,
  flagged: true,
  dueDate: "2026-06-01T09:30:00+01:00",
  timeZone: "Europe/London",
  allDay: true,
};

test("local live-write testing requires explicit confirmation, an exact list name, and a valid retained key", () => {
  for (const args of [[], ["--list-name", "MCP Test"], ["--confirm"], ["--confirm", "--list-name", "MCP Test", "--idempotency-key"], ["--confirm", "--list-name", "MCP Test", "--idempotency-key", "invalid"], ["--confirm", "--list-name", "MCP Test", "--unknown"]]) {
    assert.throws(() => parseWriteTestArgs(args), error => error instanceof Error && "code" in error && error.code === "INVALID_ARGUMENT");
  }
  const explicit = parseWriteTestArgs(["--confirm", "--list-name", "MCP Test", "--idempotency-key", baseInput.idempotencyKey]);
  assert.deepEqual(explicit, { listName: "MCP Test", idempotencyKey: baseInput.idempotencyKey });
  assert.match(parseWriteTestArgs(["--confirm", "--list-name", "MCP Test"]).idempotencyKey, /^[0-9a-f-]{36}$/);
  assert.throws(() => parseWriteTestArgs(["--confirm", "--list-name", "MCP Test", "--finish-existing"]));
  assert.deepEqual(parseWriteTestArgs(["--confirm", "--list-name", "MCP Test", "--finish-existing", "--idempotency-key", baseInput.idempotencyKey]), { ...explicit, finishExisting: true });
});

function currentRecord(): CloudKitRecord {
  const create = buildCreateReminder(baseInput, 1_800_000_000_000);
  const fields = {
    ...create.fields,
    ResolutionTokenMap: create.fields.ResolutionTokenMap,
    AlarmIDs: { type: "STRING_LIST", value: [] },
    RecurrenceRuleIDs: { type: "STRING_LIST", value: [] },
    CustomFutureField: { type: "STRING", value: "keep this" },
  };
  return {
    recordName: create.recordName,
    recordType: "Reminder",
    fields,
    recordChangeTag: "tag-current",
    zoneID: { zoneName: "Reminders", zoneType: "REGULAR_CUSTOM_ZONE", ownerRecordName: owner },
    raw: {},
  };
}

function parsedMap(record: CloudKitRecord) {
  const wrapper = record.fields.ResolutionTokenMap as { value: string };
  return JSON.parse(wrapper.value) as { map: Record<string, unknown> };
}

test("create builder writes pinned fields, Unicode CRDT documents, parent, and resolution tokens", () => {
  const write = buildCreateReminder(baseInput, 1_800_000_000_000);
  assert.equal(write.recordName, `Reminder/${baseInput.idempotencyKey.toUpperCase()}`);
  assert.equal(write.recordType, "Reminder");
  assert.deepEqual(write.parent, { recordName: baseInput.listId });
  assert.equal(write.fields.List.type, "REFERENCE");
  assert.deepEqual(write.fields.List.value, { recordName: baseInput.listId, action: "VALIDATE" });
  assert.equal(write.fields.Completed.value, 0);
  assert.deepEqual(write.fields.CompletionDate, { type: "TIMESTAMP", value: null });
  assert.equal(write.fields.Deleted.value, 0);
  assert.equal(write.fields.Imported.value, 0);
  assert.equal(write.fields.AllDay.value, 1);
  assert.equal(write.fields.Priority.value, 5);
  assert.equal(write.fields.DueDate.value, Date.parse(baseInput.dueDate));
  assert.equal(decodeDocument(write.fields.TitleDocument.value as string).text, baseInput.title);
  assert.equal(decodeDocument(write.fields.NotesDocument.value as string).text, baseInput.notes);
  const tokens = parsedMap({ ...currentRecord(), fields: write.fields }).map;
  assert.deepEqual(Object.keys(tokens).sort(), ["allDay", "titleDocument", "notesDocument", "parentReminder", "priority", "icsDisplayOrder", "creationDate", "list", "flagged", "completed", "completionDate", "lastModifiedDate", "recurrenceRuleIDs", "dueDate", "timeZone"].sort());
  for (const token of Object.values(tokens)) {
    assert.deepEqual(Object.keys(token as object).sort(), ["counter", "modificationTime", "replicaID"]);
    assert.equal((token as { counter: number }).counter, 1);
    assert.match((token as { replicaID: string }).replicaID, /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/);
  }
  assert.equal(matchesCreatedReminder(baseInput, currentRecord(), owner), true);
});

test("partial update emits only changed fields and keeps omitted resolution tokens and source content", () => {
  const current = currentRecord();
  const originalTokens = parsedMap(current).map;
  const write = buildUpdateReminder({
    listId: baseInput.listId,
    reminderId: current.recordName,
    recordChangeTag: "tag-current",
    changes: { title: "New title 🪁" },
  }, current, owner, 1_800_000_100_000);

  assert.deepEqual(Object.keys(write.fields).sort(), ["LastModifiedDate", "ResolutionTokenMap", "TitleDocument"].sort());
  assert.equal(decodeDocument(write.fields.TitleDocument.value as string).text, "New title 🪁");
  assert.equal(write.fields.LastModifiedDate.value, 1_800_000_100_000);
  const newTokens = JSON.parse(write.fields.ResolutionTokenMap.value as string) as { map: Record<string, unknown> };
  assert.deepEqual(newTokens.map.notesDocument, originalTokens.notesDocument);
  assert.deepEqual(newTokens.map.priority, originalTokens.priority);
  assert.notDeepEqual(newTokens.map.titleDocument, originalTokens.titleDocument);
  assert.equal(current.fields.CustomFutureField && (current.fields.CustomFutureField as { value: string }).value, "keep this");
  assert.equal(current.fields.NotesDocument && (current.fields.NotesDocument as { value: string }).value, buildCreateReminder(baseInput, 1_800_000_000_000).fields.NotesDocument.value);

  const clearDueDate = buildUpdateReminder({
    listId: baseInput.listId,
    reminderId: current.recordName,
    recordChangeTag: "tag-current",
    changes: { dueDate: null },
  }, current, owner, 1_800_000_100_000);
  assert.deepEqual(clearDueDate.fields.DueDate, { type: "TIMESTAMP", value: null });
  assert.deepEqual(clearDueDate.fields.AllDay, { type: "INT64", value: 0 });
  assert.deepEqual(clearDueDate.fields.TimeZone, { type: "STRING", value: null });

  // Apple's undated records may retain AllDay=1. A title-only edit must leave
  // that date state intact rather than refuse an otherwise safe patch.
  const undated = { ...current, fields: { ...current.fields, DueDate: { type: "TIMESTAMP", value: null }, TimeZone: { type: "STRING", value: null } } };
  const titleOnly = buildUpdateReminder({ listId: baseInput.listId, reminderId: current.recordName, recordChangeTag: "tag-current", changes: { title: "Undated item renamed" } }, undated, owner);
  assert.equal(decodeDocument(titleOnly.fields.TitleDocument.value as string).text, "Undated item renamed");
  assert.equal(Object.hasOwn(titleOnly.fields, "AllDay"), false);
  assert.equal(Object.hasOwn(titleOnly.fields, "DueDate"), false);
  assert.equal(Object.hasOwn(titleOnly.fields, "TimeZone"), false);
});

test("schemas and update builder reject invalid input, conflicts, malformed tokens, and unsupported linked changes", () => {
  assert.equal(CreateReminderInput.safeParse({ ...baseInput, dueDate: "2026-02-30T10:00:00Z" }).success, false);
  assert.equal(CreateReminderInput.safeParse({ ...baseInput, title: "bad\u0000title" }).success, false);
  assert.equal(CreateReminderInput.safeParse({ ...baseInput, title: "\ud800" }).success, false);
  assert.equal(CreateReminderInput.safeParse({ ...baseInput, extra: true }).success, false);
  assert.equal(CreateReminderInput.safeParse({ ...baseInput, listId: "List/LIST/A" }).success, false);

  const current = currentRecord();
  const update = { listId: baseInput.listId, reminderId: current.recordName, recordChangeTag: "tag-current", changes: { flagged: false } };
  const rejectsWithCode = (fn: () => unknown, code: string) => assert.throws(fn, error => error instanceof AppError && error.code === code);
  rejectsWithCode(() => buildUpdateReminder({ ...update, changes: {} }, current, owner), "VALIDATION_ERROR");
  rejectsWithCode(() => buildUpdateReminder({ ...update, recordChangeTag: "stale" }, current, owner), "CONFLICT");
  rejectsWithCode(() => buildUpdateReminder({ ...update, listId: "List/OTHER" }, current, owner), "CONFLICT");
  rejectsWithCode(() => buildUpdateReminder(update, { ...current, zoneID: { zoneName: "Reminders", ownerRecordName: "foreign" } }, owner), "FORBIDDEN");
  const unknownCompletion = { ...current, fields: { ...current.fields, Completed: { type: "INT64", value: null } } };
  rejectsWithCode(() => buildUpdateReminder(update, unknownCompletion, owner), "CONFLICT");
  assert.equal(matchesCreatedReminder(baseInput, unknownCompletion, owner), false);

  const recurring = { ...current, fields: { ...current.fields, RecurrenceRuleIDs: { type: "STRING_LIST", value: ["RecurrenceRule/RULE-A"] } } };
  rejectsWithCode(() => buildUpdateReminder({ ...update, changes: { dueDate: "2026-07-01T09:30:00+01:00" } }, recurring, owner), "UNSUPPORTED_FEATURE");

  const malformedTokens = { ...current, fields: { ...current.fields, ResolutionTokenMap: { type: "STRING", value: "{bad json" } } };
  rejectsWithCode(() => buildUpdateReminder(update, malformedTokens, owner), "PROTOCOL_CHANGED");
  const tokenMap = parsedMap(current);
  const unknownTokenMapProperty = { ...current, fields: { ...current.fields, ResolutionTokenMap: { type: "STRING", value: JSON.stringify({ ...tokenMap, future: true }) } } };
  rejectsWithCode(() => buildUpdateReminder(update, unknownTokenMapProperty, owner), "PROTOCOL_CHANGED");
});

test("completion, reopening and soft deletion preserve content/tokens and enforce exact state and version", () => {
  const current = currentRecord();
  const target = { listId: baseInput.listId, reminderId: current.recordName, recordChangeTag: "tag-current" };
  const now = 1_800_000_100_000;
  const completed = buildLifecycleReminder("complete", target, current, owner, now);
  assert.deepEqual(completed.fields.Completed, { type: "INT64", value: 1 });
  assert.deepEqual(completed.fields.CompletionDate, { type: "TIMESTAMP", value: now });
  assert.deepEqual(Object.keys(completed.fields).sort(), ["Completed", "CompletionDate", "LastModifiedDate", "ResolutionTokenMap"]);
  const before = parsedMap(current).map;
  const tokens = JSON.parse(completed.fields.ResolutionTokenMap.value as string).map;
  assert.deepEqual(tokens.titleDocument, before.titleDocument);
  assert.deepEqual(tokens.notesDocument, before.notesDocument);
  assert.notDeepEqual(tokens.completed, before.completed);
  const completedRecord = { ...current, fields: { ...current.fields, ...completed.fields } };
  const reopened = buildLifecycleReminder("reopen", target, completedRecord, owner, now + 1000);
  assert.deepEqual(reopened.fields.Completed, { type: "INT64", value: 0 });
  assert.deepEqual(reopened.fields.CompletionDate, { type: "TIMESTAMP", value: null });
  const deleted = buildLifecycleReminder("delete", target, completedRecord, owner, now + 2000);
  assert.deepEqual(deleted.fields.Deleted, { type: "INT64", value: 1 });
  assert.deepEqual(Object.keys(deleted.fields).sort(), ["Deleted", "LastModifiedDate", "ResolutionTokenMap"]);
  assert.deepEqual(JSON.parse(deleted.fields.ResolutionTokenMap.value as string).map.completed, tokens.completed);
  const rejects = (action: "complete" | "reopen" | "delete", record: CloudKitRecord, code: string, tag = "tag-current") => assert.throws(() => buildLifecycleReminder(action, { ...target, recordChangeTag: tag }, record, owner), error => error instanceof AppError && error.code === code);
  rejects("complete", completedRecord, "CONFLICT");
  rejects("reopen", current, "CONFLICT");
  rejects("delete", current, "CONFLICT", "stale");
  rejects("delete", { ...current, fields: { ...current.fields, Deleted: { type: "INT64", value: 1 } } }, "CONFLICT");
  rejects("complete", { ...current, fields: { ...current.fields, RecurrenceRuleIDs: { type: "STRING_LIST", value: ["RecurrenceRule/RULE-A"] } } }, "UNSUPPORTED_FEATURE");
  rejects("delete", { ...current, fields: { ...current.fields, ParentReminder: { type: "REFERENCE", value: { recordName: "Reminder/PARENT-A" } } } }, "UNSUPPORTED_FEATURE");
});

test("updates advance native resolution counters on the same replica and preserve unrelated tokens", () => {
  const current = currentRecord();
  const encoded = JSON.parse(String((current.fields.ResolutionTokenMap as { value: string }).value));
  encoded.map.titleDocument.counter = 7; encoded.map.lastModifiedDate.counter = 9;
  current.fields.ResolutionTokenMap = { type: "STRING", value: JSON.stringify(encoded) };
  const request = { listId: baseInput.listId, reminderId: current.recordName, recordChangeTag: "tag-current", changes: { title: "Native counter edit" } };
  const write = buildUpdateReminder(request, current, owner, 1_800_000_100_000);
  const changed = JSON.parse(String(write.fields.ResolutionTokenMap.value)).map;
  assert.equal(changed.titleDocument.counter, 8); assert.equal(changed.lastModifiedDate.counter, 10);
  assert.equal(changed.titleDocument.replicaID, encoded.map.titleDocument.replicaID);
  assert.equal(changed.lastModifiedDate.replicaID, encoded.map.lastModifiedDate.replicaID);
  assert.ok(changed.titleDocument.modificationTime > encoded.map.titleDocument.modificationTime);
  assert.deepEqual(changed.notesDocument, encoded.map.notesDocument);
  const olderClock = buildUpdateReminder(request, current, owner, 1_799_999_000_000);
  const older = JSON.parse(String(olderClock.fields.ResolutionTokenMap.value)).map;
  assert.equal(older.titleDocument.counter, 8); assert.equal(older.titleDocument.modificationTime, encoded.map.titleDocument.modificationTime);
  encoded.map.titleDocument.counter = Number.MAX_SAFE_INTEGER;
  current.fields.ResolutionTokenMap = { type: "STRING", value: JSON.stringify(encoded) };
  assert.throws(() => buildUpdateReminder(request, current, owner, 1_800_000_100_000), error => error instanceof AppError && error.code === "PROTOCOL_CHANGED");
});

function organizationReminder(extra: Record<string, unknown> = {}): CloudKitRecord {
  const record = currentRecord();
  return { ...record, fields: { ...record.fields, AttachmentIDs: { type: "UNKNOWN_LIST", value: [] }, HashtagIDs: { type: "UNKNOWN_LIST", value: [] }, ...extra } };
}

function organizationRecord(type: "Attachment" | "Hashtag", id: string, reminderId: string, fields: Record<string, unknown>, tag = `${type}-version`): CloudKitRecord {
  return { recordName: `${type}/${id}`, recordType: type, recordChangeTag: tag, zoneID: { zoneName: "Reminders", zoneType: "REGULAR_CUSTOM_ZONE", ownerRecordName: owner },
    fields: { Reminder: { type: "REFERENCE", value: { recordName: reminderId, action: "VALIDATE" } }, Deleted: { type: "INT64", value: 0 }, ...fields }, raw: {} };
}

test("URL organization writes create the observed attachment while preserving and guarding an unrelated asset", () => {
  const asset = organizationRecord("Attachment", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "Reminder/11111111-2222-4333-8444-555555555555", {
    Type: { type: "INT64", value: 7 }, UTI: { type: "STRING", value: "public.data" }, Imported: { type: "INT64", value: 0 },
    AssetURL: { type: "STRING", value: "https://signed.invalid/private?token=secret" },
  });
  const root = organizationReminder({ AttachmentIDs: { type: "STRING_LIST", value: [asset.recordName.slice("Attachment/".length)] } });
  const plan = planURLChange(root, [asset], { url: "https://example.test/path?q=1" }, owner, "tag-current", 1_800_000_100_000);
  assert.deepEqual(plan.root.fields.AttachmentIDs, { type: "STRING_LIST", value: [asset.recordName.slice("Attachment/".length), plan.dependencies[0].record.recordName.slice("Attachment/".length)] });
  assert.equal(plan.dependencies.length, 1);
  assert.equal(plan.dependencies[0].operationType, "create");
  assert.deepEqual(plan.dependencies[0].record.fields, {
    Type: { type: "STRING", value: "URL" }, UTI: { type: "STRING", value: "public.url" }, Imported: { type: "INT64", value: 0 },
    Deleted: { type: "INT64", value: 0 }, URL: { type: "STRING", value: "https://example.test/path?q=1", isEncrypted: true },
    Reminder: { type: "REFERENCE", value: { recordName: root.recordName, action: "VALIDATE" } },
  });
  assert.deepEqual(plan.guards.map(record => record.recordName), [asset.recordName]);
  assert.deepEqual(plan.guards[0].fields, asset.fields);
  assert.equal(JSON.stringify({ root: plan.root, dependencies: plan.dependencies }).includes("signed.invalid"), false);
});

test("URL retirement and tag replacement preserve native records and reuse exact matching tag identities", () => {
  const rootId = "Reminder/11111111-2222-4333-8444-555555555555";
  const urlId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const urlRecord = organizationRecord("Attachment", urlId, rootId, {
    Type: { type: "STRING", value: "URL" }, UTI: { type: "STRING", value: "public.url" }, Imported: { type: "INT64", value: 0 },
    URL: { type: "STRING", value: "https://example.test/old", isEncrypted: true }, UnknownNativeField: { type: "STRING", value: "retained" },
  });
  const urlRoot = organizationReminder({ AttachmentIDs: { type: "STRING_LIST", value: [urlId] } });
  const remove = planURLChange(urlRoot, [urlRecord], { url: null }, owner, "tag-current", 1_800_000_100_000);
  assert.deepEqual(remove.root.fields.AttachmentIDs, { type: "STRING_LIST", value: [] });
  assert.deepEqual(remove.dependencies[0], { operationType: "update", record: {
    recordName: urlRecord.recordName, recordType: "Attachment", recordChangeTag: urlRecord.recordChangeTag,
    fields: { Deleted: { type: "INT64", value: 1 }, Reminder: { type: "REFERENCE", value: null } },
  } });
  assert.equal(urlRecord.fields.UnknownNativeField && (urlRecord.fields.UnknownNativeField as { value: string }).value, "retained");

  const keepId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc", removeId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const keep = organizationRecord("Hashtag", keepId, rootId, { CreationDate: { type: "TIMESTAMP", value: 1 }, Type: { type: "INT64", value: 0 }, Imported: { type: "INT64", value: 0 }, Name: { type: "STRING", value: "work", isEncrypted: true } });
  const old = organizationRecord("Hashtag", removeId, rootId, { CreationDate: { type: "TIMESTAMP", value: 2 }, Type: { type: "INT64", value: 0 }, Imported: { type: "INT64", value: 0 }, Name: { type: "STRING", value: "old", isEncrypted: true } });
  const tagRoot = organizationReminder({ HashtagIDs: { type: "STRING_LIST", value: [keepId, removeId] } });
  const tags = planTagChange(tagRoot, [keep, old], { tags: ["work", "new"] }, owner, "tag-current", 1_800_000_100_000);
  assert.equal((tags.root.fields.HashtagIDs.value as string[])[0], keepId);
  assert.deepEqual(tags.guards.map(record => record.recordName), [keep.recordName]);
  assert.deepEqual(tags.dependencies.map(item => item.operationType), ["create", "update"]);
  assert.deepEqual(tags.dependencies[1].record.fields, { Deleted: { type: "INT64", value: 1 }, Reminder: { type: "REFERENCE", value: null } });
  assert.equal(tags.dependencies[0].record.fields.Name.value, "new");
  assert.equal(tags.dependencies[0].record.fields.Name.isEncrypted, true);
});

test("organization transport sends one atomic group and treats a stale related guard as a definite conflict", async () => {
  const assetId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const rootId = "Reminder/11111111-2222-4333-8444-555555555555";
  const asset = organizationRecord("Attachment", assetId, rootId, { Type: { type: "STRING", value: "Asset" }, UTI: { type: "STRING", value: "public.data" }, Imported: { type: "INT64", value: 0 } });
  const root = organizationReminder({ AttachmentIDs: { type: "STRING_LIST", value: [assetId] } });
  const plan = planURLChange(root, [asset], { url: "https://example.test/new" }, owner, "tag-current", 1_800_000_100_000);
  let calls = 0, intents = 0;
  const http = new AppleHTTP(new CookieJar(), async (_, init) => {
    calls++;
    const payload = JSON.parse(String(init?.body));
    assert.equal(payload.atomic, true);
    assert.equal(payload.operations.length, 3);
    assert.deepEqual(payload.operations.map((operation: { operationType: string }) => operation.operationType), ["update", "create", "update"]);
    return Response.json({ records: payload.operations.map((operation: { operationType: string; record: { recordName: string; recordType: string; recordChangeTag?: string; fields: Record<string, unknown> } }) =>
      operation.record.recordName === asset.recordName ? { recordName: asset.recordName, serverErrorCode: "CONFLICT" } :
      { recordName: operation.record.recordName, serverErrorCode: "ATOMIC_ERROR" }) });
  });
  const client = new CloudKitRemindersClient(http, { dsid: "123456789", clientId: "synthetic-client", clientBuildNumber: "2534Project66", clientMasteringNumber: "2534B22",
    cloudKitURL: "https://p01-ckdatabasews.icloud.com/database/1/com.apple.reminders/production/private", remindersZoneOwner: owner });
  await assert.rejects(client.modifyOrganization(plan.root, plan.dependencies, plan.guards, async () => { intents++; }), error => error instanceof AppError && error.code === "CONFLICT");
  assert.equal(calls, 1); assert.equal(intents, 1);
});

test("move transport atomically updates both exact List memberships and the observed Reminder parent", async () => {
  const root = currentRecord();
  const sourceId = "List/LIST-A", destinationId = "List/LIST-B";
  const reminderSuffix = root.recordName.slice("Reminder/".length);
  const sourceToken = { counter: 4, modificationTime: 10, replicaID: "11111111-2222-4333-8444-555555555555" };
  const destinationToken = { counter: 2, modificationTime: 20, replicaID: "22222222-3333-4444-8555-666666666666" };
  const list = (recordName: string, member: string | null, token: typeof sourceToken, tag: string): CloudKitRecord => ({
    recordName, recordType: "List", recordChangeTag: tag, zoneID: { zoneName: "Reminders", zoneType: "REGULAR_CUSTOM_ZONE", ownerRecordName: owner }, raw: {},
    fields: { Deleted: { type: "INT64", value: 0 }, ReminderIDs: { type: "STRING", value: JSON.stringify(member ? [member] : []) },
      ResolutionTokenMap: { type: "STRING", value: JSON.stringify({ map: { reminderIDsMergeableOrdering: token, name: { counter: 1, modificationTime: 0, replicaID: "33333333-4444-4555-8666-777777777777" } } }) } },
  });
  const source = list(sourceId, reminderSuffix, sourceToken, "source-v1");
  const destination = list(destinationId, null, destinationToken, "destination-v1");
  const advance = (token: typeof sourceToken) => ({ ...token, counter: token.counter + 1, modificationTime: token.modificationTime + 1 });
  const rootWrite = { recordName: root.recordName, recordType: "Reminder" as const, recordChangeTag: root.recordChangeTag,
    parent: { recordName: destinationId }, fields: {
      List: { type: "REFERENCE", value: { recordName: destinationId, action: "VALIDATE" } },
      LastModifiedDate: { type: "TIMESTAMP", value: 1_800_000_100_000 }, ResolutionTokenMap: { type: "STRING", value: "{}" },
    } };
  const membership = (record: CloudKitRecord, members: string[], token: typeof sourceToken) => ({ recordName: record.recordName, recordType: "List" as const,
    recordChangeTag: record.recordChangeTag, fields: { ReminderIDs: { type: "STRING", value: JSON.stringify(members) }, ResolutionTokenMap: { type: "STRING", value:
      JSON.stringify({ map: { reminderIDsMergeableOrdering: advance(token), name: (JSON.parse(String((record.fields.ResolutionTokenMap as { value: string }).value)) as { map: { name: unknown } }).map.name } }) } } });
  const writes = [membership(source, [], sourceToken), membership(destination, [reminderSuffix], destinationToken)];
  let sent: Record<string, unknown> | undefined, intents = 0;
  const http = new AppleHTTP(new CookieJar(), async (_, init) => {
    sent = JSON.parse(String(init?.body));
    assert.ok(sent);
    const operations = (sent.operations as { operationType: string; record: { recordName: string; recordType: string; fields: Record<string, unknown>; parent?: { recordName: string } } }[]);
    const snapshots = new Map([source, destination].map(record => [record.recordName, record]));
    return Response.json({ records: operations.map(operation => {
      const before = snapshots.get(operation.record.recordName) ?? root;
      return { recordName: operation.record.recordName, recordType: operation.record.recordType, recordChangeTag: `${before.recordChangeTag}-after`,
        zoneID: { zoneName: "Reminders", zoneType: "REGULAR_CUSTOM_ZONE", ownerRecordName: owner },
        ...(operation.record.parent ? { parent: operation.record.parent } : {}), raw: { parent: operation.record.parent },
        fields: { ...before.fields, ...operation.record.fields } };
    }) });
  });
  const client = new CloudKitRemindersClient(http, { dsid: "123456789", clientId: "synthetic-client", clientBuildNumber: "2534Project66", clientMasteringNumber: "2534B22",
    cloudKitURL: "https://p01-ckdatabasews.icloud.com/database/1/com.apple.reminders/production/private", remindersZoneOwner: owner });
  const result = await client.modifyTransfer("update", rootWrite, writes, [source, destination], [], [], async () => { intents++; }, sourceId);
  assert.equal(result.length, 3);
  assert.equal(result[0].recordName, root.recordName);
  assert.deepEqual((sent?.operations as { record: { parent?: unknown } }[])[0].record.parent, { recordName: destinationId });
  assert.equal((sent?.operations as unknown[]).length, 3);
  assert.equal(intents, 1);
});

test("copy transport creates fresh related IDs and tolerates only signed urgency asset URL drift", async () => {
  const sourceListId = "List/LIST-A", destinationId = "List/LIST-B";
  const sourceCreate = buildCreateReminder({ listId: sourceListId, idempotencyKey: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", title: "Copy source", notes: "", priority: 5, flagged: false, allDay: false }, 1_800_000_000_000);
  const sourceId = sourceCreate.recordName;
  const sourceAttachmentId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", sourceTagId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const source: CloudKitRecord = { ...sourceCreate, recordChangeTag: "source-v1", zoneID: { zoneName: "Reminders", zoneType: "REGULAR_CUSTOM_ZONE", ownerRecordName: owner }, raw: {},
    fields: { ...sourceCreate.fields, AttachmentIDs: { type: "STRING_LIST", value: [sourceAttachmentId] }, HashtagIDs: { type: "STRING_LIST", value: [sourceTagId] },
      UrgentPresentationAlarmsAsData: { type: "ASSETID", value: { fileChecksum: "synthetic-asset-checksum", size: 123, wrappingKey: "synthetic-wrapping-key", referenceChecksum: "synthetic-reference", downloadURL: "https://example.test/asset?signature=first" } } } };
  const sourceURL = organizationRecord("Attachment", sourceAttachmentId, sourceId, { Type: { type: "STRING", value: "URL" }, UTI: { type: "STRING", value: "public.url" },
    Imported: { type: "INT64", value: 0 }, URL: { type: "STRING", value: "https://example.test/copy", isEncrypted: true } });
  const sourceTag = organizationRecord("Hashtag", sourceTagId, sourceId, { CreationDate: { type: "TIMESTAMP", value: 1 }, Type: { type: "INT64", value: 0 },
    Imported: { type: "INT64", value: 0 }, Name: { type: "STRING", value: "work", isEncrypted: true } });
  const sourceListToken = { counter: 3, modificationTime: 2, replicaID: "11111111-2222-4333-8444-555555555555" };
  const destinationToken = { counter: 4, modificationTime: 3, replicaID: "22222222-3333-4444-8555-666666666666" };
  const list = (recordName: string, members: string[], token: typeof sourceListToken, tag: string): CloudKitRecord => ({ recordName, recordType: "List", recordChangeTag: tag,
    zoneID: { zoneName: "Reminders", zoneType: "REGULAR_CUSTOM_ZONE", ownerRecordName: owner }, raw: {}, fields: {
      Deleted: { type: "INT64", value: 0 }, ReminderIDs: { type: "STRING", value: JSON.stringify(members) },
      ResolutionTokenMap: { type: "STRING", value: JSON.stringify({ map: { reminderIDsMergeableOrdering: token } }) },
    } });
  const sourceList = list(sourceListId, [sourceId.slice("Reminder/".length)], sourceListToken, "source-list-v1");
  const destination = list(destinationId, [], destinationToken, "destination-v1");
  const destinationTokenNext = { ...destinationToken, counter: destinationToken.counter + 1, modificationTime: destinationToken.modificationTime + 1 };
  const copy = buildCreateReminder({ listId: destinationId, idempotencyKey: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", title: "Copy source", notes: "", priority: 5, flagged: false, allDay: false }, 1_800_000_000_000);
  const copiedAttachmentId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", copiedTagId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
  const rootWrite = { ...copy, fields: { ...copy.fields, AttachmentIDs: { type: "STRING_LIST", value: [copiedAttachmentId] }, HashtagIDs: { type: "STRING_LIST", value: [copiedTagId] } } };
  const dependency = (type: "Attachment" | "Hashtag", id: string, fields: Record<string, unknown>) => ({ operationType: "create" as const,
    record: { recordName: `${type}/${id}`, recordType: type, fields: { ...fields, Reminder: { type: "REFERENCE", value: { recordName: copy.recordName, action: "VALIDATE" } } } } });
  const dependencies = [
    dependency("Attachment", copiedAttachmentId, { Type: { type: "STRING", value: "URL" }, UTI: { type: "STRING", value: "public.url" }, Imported: { type: "INT64", value: 0 },
      Deleted: { type: "INT64", value: 0 }, URL: { type: "STRING", value: "https://example.test/copy", isEncrypted: true } }),
    dependency("Hashtag", copiedTagId, { CreationDate: { type: "TIMESTAMP", value: 1_800_000_000_000 }, Type: { type: "INT64", value: 0 }, Imported: { type: "INT64", value: 0 },
      Deleted: { type: "INT64", value: 0 }, Name: { type: "STRING", value: "work", isEncrypted: true } }),
  ];
  const destinationWrite = { recordName: destinationId, recordType: "List" as const, recordChangeTag: destination.recordChangeTag, fields: {
    ReminderIDs: { type: "STRING", value: JSON.stringify([copy.recordName.slice("Reminder/".length)]) },
    ResolutionTokenMap: { type: "STRING", value: JSON.stringify({ map: { reminderIDsMergeableOrdering: destinationTokenNext } }) },
  } };
  const guards = [source, sourceList, sourceURL, sourceTag];
  let corruptChecksum = false;
  let sent: Record<string, unknown> | undefined;
  const http = new AppleHTTP(new CookieJar(), async (_, init) => {
    sent = JSON.parse(String(init?.body)); assert.ok(sent);
    const operations = sent.operations as { operationType: string; record: { recordName: string; recordType: string; fields: Record<string, unknown>; parent?: { recordName: string } } }[];
    const before = new Map<string, CloudKitRecord>([[sourceId, source], [sourceListId, sourceList], [destinationId, destination], [sourceURL.recordName, sourceURL], [sourceTag.recordName, sourceTag]]);
    return Response.json({ records: operations.map(operation => {
      const previous = before.get(operation.record.recordName);
      const base = previous?.fields ?? {};
      const changed = { ...base, ...operation.record.fields };
      if (operation.operationType === "create" && operation.record.recordType === "Reminder") {
        for (const key of ["TitleDocument", "NotesDocument"]) changed[key] = { ...changed[key] as Record<string, unknown>, type: "ENCRYPTED_BYTES" };
        delete changed.CompletionDate;
      }
      for (const key of ["List", "Reminder"]) {
        const reference = changed[key] as { type?: unknown; value?: unknown } | undefined;
        if (Object.hasOwn(operation.record.fields, key) && reference?.type === "REFERENCE" && reference.value && typeof reference.value === "object") {
          changed[key] = { ...reference, value: { ...reference.value, zoneID: { zoneName: "Reminders", zoneType: "REGULAR_CUSTOM_ZONE", ownerRecordName: owner } } };
        }
      }
      if (operation.record.recordName === sourceId) changed.UrgentPresentationAlarmsAsData = { type: "ASSETID", value: { ...(source.fields.UrgentPresentationAlarmsAsData as { value: Record<string, unknown> }).value, downloadURL: "https://example.test/asset?signature=second", ...(corruptChecksum ? { fileChecksum: "different-checksum" } : {}) } };
      return { recordName: operation.record.recordName, recordType: operation.record.recordType, recordChangeTag: `${previous?.recordChangeTag ?? "new"}-after`,
        zoneID: { zoneName: "Reminders", zoneType: "REGULAR_CUSTOM_ZONE", ownerRecordName: owner }, ...(operation.record.parent ? { parent: operation.record.parent } : {}),
        raw: { ...(operation.record.parent ? { parent: operation.record.parent } : {}) }, fields: changed };
    }) });
  });
  const client = new CloudKitRemindersClient(http, { dsid: "123456789", clientId: "synthetic-client", clientBuildNumber: "2534Project66", clientMasteringNumber: "2534B22",
    cloudKitURL: "https://p01-ckdatabasews.icloud.com/database/1/com.apple.reminders/production/private", remindersZoneOwner: owner });
  const result = await client.modifyTransfer("create", rootWrite, [destinationWrite], [destination], dependencies, guards, undefined, sourceListId);
  assert.equal(result.length, 8);
  assert.equal(result[0].recordName, copy.recordName);
  assert.deepEqual((sent?.operations as { record: { parent?: unknown } }[])[0].record.parent, { recordName: destinationId });
  assert.equal((sent?.operations as unknown[]).length, 8);
  corruptChecksum = true;
  await assert.rejects(client.modifyTransfer("create", rootWrite, [destinationWrite], [destination], dependencies, guards, undefined, sourceListId), (error: unknown) => error instanceof WriteOutcomeUnknownError);
});
