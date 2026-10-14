import test from "node:test";
import assert from "node:assert/strict";
import { AppleHTTP, APPLE_USER_AGENT, validatedAppleURL } from "../src/transport/apple-http.ts";
import { CookieJar } from "../src/transport/cookie-jar.ts";
import { encodeDocument } from "../src/reminders/crdt.ts";
import { omitField } from "../src/lib/omit-field.ts";
import { matchesReminderSearch, SearchFilters } from "../src/reminders/search.ts";
import { AppError } from "../src/errors.ts";
import { CloudKitRateLimitedError, CloudKitRemindersClient, normalizeList, normalizeReminder, normalizeReminderRelationships, type CloudKitConnection } from "../src/icloud/cloudkit.ts";
import { normalizeReminderTag, normalizeURLAttachment } from "../src/reminders/organization.ts";
import { toolError } from "../src/mcp/results.ts";

const connection: CloudKitConnection = {
  dsid: "123456789",
  clientId: "11111111-2222-3333-4444-555555555555",
  clientBuildNumber: "2534Project66",
  clientMasteringNumber: "2534B22",
  cloudKitURL: "https://p01-ckdatabasews.icloud.com/database/1/com.apple.reminders/production/private",
};

type MockResponse = { status?: number; headers?: Record<string, string>; body: unknown | ((request: CapturedRequest) => unknown) };
type CapturedRequest = { url: URL; method: string | undefined; headers: Headers; body: Record<string, unknown> };

function clientWith(responses: MockResponse[], metadata: CloudKitConnection = connection) {
  const requests: CapturedRequest[] = [];
  const http = new AppleHTTP(new CookieJar(), async (input, init) => {
    const url = new URL(String(input));
    const request = { url, method: init?.method, headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) as Record<string, unknown> };
    requests.push(request);
    const next = responses.shift();
    assert.ok(next, `unexpected request to ${url.pathname}`);
    const body = typeof next.body === "function" ? next.body(request) : next.body;
    return new Response(JSON.stringify(body), { status: next.status ?? 200, headers: next.headers });
  });
  return { api: new CloudKitRemindersClient(http, metadata), requests };
}

function listRecord(recordName = "List/LIST-A") {
  return {
    recordName,
    recordType: "List",
    recordChangeTag: "tag-list-1",
    zoneID: { zoneName: "Reminders", zoneType: "REGULAR_CUSTOM_ZONE", ownerRecordName: "__defaultOwner__" },
    fields: {
      Name: { type: "STRING", value: "<script>alert('list')</script>" },
      Count: { type: "INT64", value: 1 },
      Deleted: { type: "INT64", value: 0 },
      ReminderIDs: { type: "STRING", value: '["Reminder/REM-1"]' },
      NewAppleField: { type: "STRING", value: "retained" },
    },
  };
}

function reminderRecord(title: string) {
  return {
    recordName: "Reminder/REM-1",
    recordType: "Reminder",
    zoneID: { zoneName: "Reminders", zoneType: "REGULAR_CUSTOM_ZONE" },
    fields: {
      TitleDocument: { type: "ENCRYPTED_BYTES", value: encodeDocument(title) },
      NotesDocument: { type: "ENCRYPTED_BYTES", value: encodeDocument("<img src=x onerror=alert(1)>") },
      List: { type: "REFERENCE", value: { recordName: "List/LIST-A", action: "VALIDATE" } },
      Completed: { type: "INT64", value: 0 },
      DueDate: { type: "TIMESTAMP", value: 1_735_862_400_000 },
      Priority: { type: "INT64", value: 5 },
      AlarmIDs: { type: "STRING_LIST", value: ["Alarm/ALARM-1"] },
      AttachmentIDs: { type: "UNKNOWN_LIST", value: [] },
      HashtagIDs: { type: "UNKNOWN_LIST", value: [] },
      RecurrenceRuleIDs: { type: "UNKNOWN_LIST", value: [] },
      CustomFutureField: { type: "STRING", value: "kept" },
    },
  };
}

test("membership failures expose only bounded shape diagnostics and distinguish size limits from malformed data", () => {
  const privateValue = "synthetic-private-membership";
  const cases = [
    { field: { type: privateValue, value: privateValue }, code: "PROTOCOL_CHANGED", fieldType: "OTHER", stringLength: privateValue.length, jsonShape: "not_inspected", arrayLength: null },
    { field: { type: "STRING", value: 42 }, code: "PROTOCOL_CHANGED", fieldType: "STRING", stringLength: null, jsonShape: "not_inspected", arrayLength: null },
    { field: { type: "STRING", value: privateValue }, code: "PROTOCOL_CHANGED", fieldType: "STRING", stringLength: privateValue.length, jsonShape: "invalid", arrayLength: null },
    { field: { type: "STRING", value: JSON.stringify({ [privateValue]: true }) }, code: "PROTOCOL_CHANGED", fieldType: "STRING", stringLength: JSON.stringify({ [privateValue]: true }).length, jsonShape: "object", arrayLength: null },
    { field: { type: "STRING", value: "25" }, code: "PROTOCOL_CHANGED", fieldType: "STRING", stringLength: 2, jsonShape: "scalar", arrayLength: null },
    { field: { type: "STRING", value: JSON.stringify([{}]) }, code: "PROTOCOL_CHANGED", fieldType: "STRING", stringLength: 4, jsonShape: "array", arrayLength: 1 },
    { field: { type: "STRING", value: " ".repeat(131_073) }, code: "UNSUPPORTED_FEATURE", fieldType: "STRING", stringLength: 131_073, jsonShape: "not_inspected", arrayLength: null },
    { field: { type: "STRING", value: JSON.stringify(Array(2001).fill("REM-1")) }, code: "UNSUPPORTED_FEATURE", fieldType: "STRING", stringLength: JSON.stringify(Array(2001).fill("REM-1")).length, jsonShape: "array", arrayLength: 2001 },
  ];
  for (const { field, code, ...diagnostics } of cases) {
    const record = { ...listRecord(), raw: {}, fields: { ...listRecord().fields, ReminderIDs: field } };
    let failure: unknown;
    try { normalizeList(record); } catch (error) { failure = error; }
    assert.ok(failure instanceof AppError);
    const result = toolError(failure);
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.error_code, code);
    assert.equal(result.structuredContent.error.code, code);
    assert.equal(result.structuredContent.error.retryable, false);
    assert.deepEqual(result.structuredContent.error.membershipDiagnostics, diagnostics);
    assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
    assert.equal(JSON.stringify(result).includes(privateValue), false);
    assert.equal(normalizeList(record, false).reminderIds, null);
  }
  for (const value of [undefined, null, "[]", '["REM-1","Reminder/REM-2"]']) {
    const record = { ...listRecord(), raw: {}, fields: { ...listRecord().fields, ReminderIDs: { type: "STRING", value } } };
    assert.deepEqual(normalizeList(record).reminderIds, value == null ? null : value === "[]" ? [] : ["Reminder/REM-1", "Reminder/REM-2"]);
  }
  const ids = Array.from({ length: 1822 }, () => crypto.randomUUID());
  const membership = JSON.stringify(ids);
  assert.equal(membership.length, 71_059);
  const record = { ...listRecord(), raw: {}, fields: { ...listRecord().fields, ReminderIDs: { type: "STRING", value: membership } } };
  assert.deepEqual(normalizeList(record).reminderIds, ids.map(id => `Reminder/${id}`));
});

test("relationship inventory query and lookup project parent links without reminder documents", async () => {
  const projected = { ...reminderRecord("Synthetic large document"), recordChangeTag: "relationship-version" };
  const reply = (request: CapturedRequest) => {
    assert.deepEqual(request.body.desiredKeys, ["List", "ParentReminder", "Deleted"]);
    if (request.url.pathname.endsWith("/records/query")) {
      const query = request.body.query as { recordType: string; filterBy: { fieldName: string; fieldValue: { value: unknown } }[] };
      assert.equal(query.recordType, "reminderList");
      assert.equal(query.filterBy.find(field => field.fieldName === "includeCompleted")?.fieldValue.value, 1);
      assert.equal(query.filterBy.find(field => field.fieldName === "LookupValidatingReference")?.fieldValue.value, 0);
    }
    return { records: [{ ...projected, fields: { List: projected.fields.List, Deleted: { type: "INT64", value: 0 },
      ParentReminder: { type: "REFERENCE", value: { recordName: "Reminder/PARENT", action: "VALIDATE" } } } }] };
  };
  const { api, requests } = clientWith([{ body: reply }, { body: reply }]);
  const page = await api.queryRemindersPage({ listId: "List/LIST-A", includeCompleted: true, limit: 100, projection: "relationships" });
  const found = await api.lookupRelationshipRecords(["Reminder/REM-1"]);
  assert.equal(page.complete, true); assert.equal(found.complete, true);
  for (const record of [page.records[0], found.records[0]]) {
    assert.ok("recordType" in record);
    assert.equal(record.fields.TitleDocument, undefined);
    assert.equal(normalizeReminder(record).parentReminderId, "Reminder/PARENT");
    assert.equal(record.recordChangeTag, "relationship-version");
  }
  await assert.rejects(api.lookupRelationshipRecords(["List/LIST-A"]), error => error instanceof AppError && error.code === "VALIDATION_ERROR");
  assert.equal(requests.length, 2);
});

test("relationship inspection ignores unrelated audit/document formats but validates native links and deletion state", () => {
  const record = { ...reminderRecord("Synthetic"), raw: { created: { timestamp: "unclassified-audit-date" } },
    fields: { ...reminderRecord("Synthetic").fields, Deleted: { type: "INT64", value: 0 }, TitleDocument: { type: "STRING", value: "unclassified-document" } } };
  assert.throws(() => normalizeReminder(record), AppError);
  assert.deepEqual(normalizeReminderRelationships(record, "__defaultOwner__"), { id: record.recordName, listId: "List/LIST-A", deleted: false, parentReminderId: null });
  const detached = { ...record, fields: { ...record.fields, List: { type: "REFERENCE", value: null } } };
  assert.throws(() => normalizeReminderRelationships(detached, "__defaultOwner__"), AppError);
  assert.equal(normalizeReminderRelationships({ ...detached, fields: { ...detached.fields, Deleted: { type: "INT64", value: 1 } } }, "__defaultOwner__").deleted, true);
  const foreign = { ...record, fields: { ...record.fields, ParentReminder: { type: "REFERENCE", value: { recordName: "Reminder/PARENT", action: "VALIDATE", zoneID: { zoneName: "Reminders", ownerRecordName: "foreign" } } } } };
  assert.throws(() => normalizeReminderRelationships(foreign, "__defaultOwner__"), AppError);
});

test("Reminders zone discovery and list query use the pinned private CloudKit request shape", async () => {
  const { api, requests } = clientWith([
    { body: { zones: [
      { zoneID: { zoneName: "Calendar", zoneType: "REGULAR_ZONE" } },
      { zoneID: { zoneName: "Reminders", zoneType: "REGULAR_CUSTOM_ZONE", ownerRecordName: "__defaultOwner__" } },
    ] } },
    { body: { records: [], continuationMarker: "query-next" } },
  ]);

  const discovery = await api.listZones();
  assert.equal(discovery.available, true);
  assert.equal(discovery.remindersZone?.zoneID.zoneName, "Reminders");
  assert.equal(discovery.complete, true);
  const page = await api.queryRemindersPage({ listId: "List/LIST-A", includeCompleted: true, limit: 20 });
  assert.equal(page.complete, false);
  assert.equal(page.paginationComplete, false);
  assert.equal(page.continuation, "query-next");

  for (const request of requests) {
    assert.equal(request.headers.get("origin"), "https://www.icloud.com");
    assert.equal(request.headers.get("referer"), "https://www.icloud.com/");
    assert.equal(request.headers.get("user-agent"), APPLE_USER_AGENT);
  }
  assert.equal(requests[0].method, "POST");
  assert.equal(requests[0].url.pathname, "/database/1/com.apple.reminders/production/private/zones/list");
  assert.deepEqual(Object.fromEntries(requests[0].url.searchParams), {
    remapEnums: "true",
    clientBuildNumber: "2534Project66",
    clientMasteringNumber: "2534B22",
    clientId: connection.clientId,
    dsid: connection.dsid,
  });
  assert.deepEqual(requests[0].body, {});
  assert.equal(requests[1].url.pathname, "/database/1/com.apple.reminders/production/private/records/query");
  assert.deepEqual(requests[1].body, {
    query: { recordType: "reminderList", filterBy: [
      { comparator: "EQUALS", fieldName: "List", fieldValue: { type: "REFERENCE", value: { recordName: "List/LIST-A", action: "VALIDATE" } } },
      { comparator: "EQUALS", fieldName: "includeCompleted", fieldValue: { type: "INT64", value: 1 } },
      { comparator: "EQUALS", fieldName: "LookupValidatingReference", fieldValue: { type: "INT64", value: 1 } },
    ] },
    zoneID: { zoneName: "Reminders", zoneType: "REGULAR_CUSTOM_ZONE" },
    resultsLimit: 20,
  });
});

test("search projection preserves normalized output and filters while default reminder reads retain opaque fields", async () => {
  const desiredKeys = ["List", "ParentReminder", "TitleDocument", "NotesDocument", "Completed", "CompletionDate", "DueDate", "StartDate", "Priority", "Flagged", "AllDay", "Deleted", "TimeZone", "AlarmIDs", "AttachmentIDs", "HashtagIDs", "RecurrenceRuleIDs"];
  const record = {
    ...reminderRecord("Needle in the title"),
    recordName: "Reminder/PROJECTED-DONE", recordChangeTag: "projected-tag",
    created: { timestamp: 1_728_000_000_000 }, modified: { timestamp: 1_728_000_123_000 },
    fields: {
      ...reminderRecord("Needle in the title").fields,
      ParentReminder: { type: "REFERENCE", value: { recordName: "Reminder/PARENT", action: "VALIDATE" } },
      Completed: { type: "INT64", value: 1 },
      CompletionDate: { type: "TIMESTAMP", value: 1_728_100_000_000 },
      DueDate: { type: "TIMESTAMP", value: 1_728_000_000_000 },
      StartDate: { type: "TIMESTAMP", value: 1_727_900_000_000 },
      Priority: { type: "INT64", value: 5 }, Flagged: { type: "INT64", value: 1 },
      AllDay: { type: "INT64", value: 0 }, TimeZone: { type: "STRING", value: "Europe/London" },
      CreationDate: { type: "TIMESTAMP", value: 1_700_000_000_000 },
      LastModifiedDate: { type: "TIMESTAMP", value: 1_728_000_123_000 },
      Imported: { type: "INT64", value: 0 }, AssignmentIDs: { type: "UNKNOWN_LIST", value: [] },
      ResolutionTokenMap: { type: "STRING", value: "opaque-resolution-map" },
    },
  };
  const project = (keys: string[]) => ({ ...record, fields: Object.fromEntries(Object.entries(record.fields).filter(([key]) => keys.includes(key))) });
  const full = clientWith([{ body: { records: [record] } }]);
  const projected = clientWith([{ body: (request: CapturedRequest) => {
    assert.deepEqual(request.body.desiredKeys, desiredKeys);
    return { records: [project(request.body.desiredKeys as string[])] };
  } }]);
  const fullPage = await full.api.queryRemindersPage({ listId: "List/LIST-A", includeCompleted: true });
  const projectedPage = await projected.api.queryRemindersPage({ listId: "List/LIST-A", includeCompleted: true, projection: "search" });
  assert.equal(Object.hasOwn(full.requests[0].body, "desiredKeys"), false, "Default family reads keep the full CloudKit record.");
  assert.deepEqual(projected.requests[0].body.desiredKeys, desiredKeys);
  assert.equal(fullPage.records.length, 1); assert.equal(projectedPage.records.length, 1);
  const fullReminder = normalizeReminder(fullPage.records[0] as Extract<(typeof fullPage.records)[number], { recordType: string }>, "__defaultOwner__");
  const projectedReminder = normalizeReminder(projectedPage.records[0] as Extract<(typeof projectedPage.records)[number], { recordType: string }>, "__defaultOwner__");
  assert.deepEqual(omitField(projectedReminder, "raw"), omitField(fullReminder, "raw"));
  assert.equal(projectedReminder.created, new Date(record.created.timestamp).toISOString());
  assert.equal(projectedReminder.modified, new Date(record.modified.timestamp).toISOString());
  const filters = SearchFilters.parse({ text: "needle", status: "completed", flagged: true, priority: 5,
    dueFrom: "2024-10-04T00:00:00.000Z", dueTo: "2024-10-05T00:00:00.000Z" });
  assert.equal(matchesReminderSearch(projectedReminder, filters), true);
  assert.equal(matchesReminderSearch(fullReminder, filters), true);
  assert.ok("raw" in fullReminder && (fullReminder.raw.fields as Record<string, unknown>).ResolutionTokenMap);
  assert.ok((fullReminder.raw.fields as Record<string, unknown>).CustomFutureField, "Full page reads retain opaque fields for version-guarded family checks.");
  assert.ok("raw" in projectedReminder && !Object.hasOwn(projectedReminder.raw.fields as Record<string, unknown>, "ResolutionTokenMap"));
  assert.ok(!Object.hasOwn(projectedReminder.raw.fields as Record<string, unknown>, "CreationDate"));
  assert.ok(!Object.hasOwn(projectedReminder.raw.fields as Record<string, unknown>, "CustomFutureField"));
});

test("compound subtask pages deduplicate only canonical-JSON-equivalent records and reject conflicting copies", async () => {
  const parent = { ...reminderRecord("Parent"), recordChangeTag: "parent-1" };
  const child = { ...reminderRecord("Child"), recordName: "Reminder/CHILD", recordChangeTag: "child-1",
    fields: { ...reminderRecord("Child").fields, ParentReminder: { type: "REFERENCE", value: { recordName: parent.recordName, action: "VALIDATE" } } } };
  const { api } = clientWith([{ body: { records: [parent, child, structuredClone(parent), structuredClone(child)] } }]);
  const page = await api.queryRemindersPage({ listId: "List/LIST-A", includeCompleted: true });
  assert.equal(page.records.length, 2);
  assert.equal(normalizeReminder(page.records[1] as Extract<(typeof page.records)[number], { recordType: string }>, "__defaultOwner__").parentReminderId, parent.recordName);
  for (const conflicting of [
    { ...child, recordChangeTag: "different" },
    { ...child, fields: { ...child.fields, CustomFutureField: { type: "STRING", value: "different" } } },
    { ...child, deleted: true },
    { ...child, zoneID: { zoneName: "Reminders", ownerRecordName: "foreign" } },
  ]) {
    const { api } = clientWith([{ body: { records: [parent, child, conflicting] } }]);
    await assert.rejects(api.queryRemindersPage({ listId: "List/LIST-A", includeCompleted: true }), AppError);
  }
});

test("shared diagnostics bind exact lookups to authenticated shared-zone discovery without replacing the private owner", async () => {
  const sharedZone = { zoneName: "Reminders", zoneType: "REGULAR_CUSTOM_ZONE", ownerRecordName: "_shared-owner" };
  const discovery = { zones: [{ zoneID: sharedZone }] };
  const record = { ...listRecord(), zoneID: sharedZone };
  const { api, requests } = clientWith([{ body: discovery }, { body: { records: [record, { recordName: "List/MISSING", serverErrorCode: "NOT_FOUND" }] } }], { ...connection, remindersZoneOwner: "_private-owner" });
  assert.deepEqual(await api.probeSharedLists(["List/LIST-A", "List/MISSING"]), { database: "shared", zonesDiscovered: 1, deletedZones: 0, remindersZones: 1, otherZones: 0, lookups: [{ matchedInputIndices: [1], deletedRecords: 0, recordErrors: [{ inputIndex: 2, code: "NOT_FOUND" }] }], complete: true, contentsReturned: false });
  assert.equal(api.remindersZoneOwner, "_private-owner");
  assert.equal(requests[0].url.pathname, "/database/1/com.apple.reminders/production/shared/zones/list");
  assert.equal(requests[1].url.pathname, "/database/1/com.apple.reminders/production/shared/records/lookup");
  assert.deepEqual(requests[1].body.zoneID, sharedZone);
  const trace = JSON.stringify(api.readTrace); for (const value of ["_shared-owner", "List/LIST-A", "List/MISSING"]) assert.ok(!trace.includes(value));
  const spoofed = clientWith([{ body: discovery }, { body: { records: [{ ...record, zoneID: { ...sharedZone, ownerRecordName: "_foreign-owner" } }] } }]);
  await assert.rejects(spoofed.api.probeSharedLists(["List/LIST-A"]), AppError);
  for (const unbound of [
    { ...record, zoneID: { ...sharedZone, ownerRecordName: "__defaultOwner__" } },
    { ...record, fields: { ...record.fields, Share: { type: "REFERENCE", value: { recordName: "List/LIST-A", zoneID: { ...sharedZone, ownerRecordName: "__defaultOwner__" } } } } },
    { recordName: "List/LIST-A", serverErrorCode: "NOT_FOUND", zoneID: { ...sharedZone, ownerRecordName: "__defaultOwner__" } },
  ]) {
    const alias = clientWith([{ body: discovery }, { body: { records: [unbound] } }]);
    await assert.rejects(alias.api.probeSharedLists(["List/LIST-A"]), AppError);
  }
  const excessive = clientWith([{ body: { zones: Array.from({ length: 4 }, (_, index) => ({ zoneID: { ...sharedZone, ownerRecordName: `_owner-${index}` } })) } }]);
  await assert.rejects(excessive.api.probeSharedLists(["List/LIST-A"]), AppError); assert.equal(excessive.requests.length, 1);
  assert.throws(() => validatedAppleURL("https://p01-ckdatabasews.icloud.com/database/1/com.apple.reminders/production/shared/records/modify", true), AppError);
});

test("query pages expose partial per-record errors and continuation; normalizers retain hostile text and raw fields", async () => {
  const { api } = clientWith([
    { body: { records: [listRecord(), { recordName: "List/LIST-B", serverErrorCode: "CONFLICT", reason: "per-record failure" }], continuationMarker: "page-2" } },
    { body: { records: [reminderRecord("<script>alert('title')</script>")] } },
  ]);

  const first = await api.queryPage({ recordType: "List", limit: 2 });
  assert.equal(first.paginationComplete, false);
  assert.equal(first.complete, false);
  assert.equal(first.pendingReason, "continuation");
  assert.equal(first.recordErrors[0]?.serverErrorCode, "CONFLICT");
  const list = normalizeList(first.records[0] as Extract<(typeof first.records)[number], { recordType: string }>);
  assert.equal(list.title, "<script>alert('list')</script>");
  assert.equal(list.reminderIds?.[0], "Reminder/REM-1");
  assert.equal((list.raw.fields as Record<string, unknown>).NewAppleField !== undefined, true);
  const firstRecord = first.records[0] as Parameters<typeof normalizeList>[0];
  const oversizedMembership = { ...firstRecord, fields: { ...firstRecord.fields, ReminderIDs: { type: "STRING", value: JSON.stringify(Array(2001).fill("Reminder/REM-1")) } } };
  assert.throws(() => normalizeList(oversizedMembership), AppError);
  const summary = normalizeList(oversizedMembership, false);
  assert.equal(summary.reminderIds, null); assert.equal(summary.title, list.title);

  const second = await api.queryPage({ recordType: "Reminder", continuation: first.continuation });
  assert.equal(second.complete, true);
  const reminder = normalizeReminder(second.records[0] as Extract<(typeof second.records)[number], { recordType: string }>);
  assert.equal(reminder.title, "<script>alert('title')</script>");
  assert.equal(reminder.notes, "<img src=x onerror=alert(1)>");
  assert.equal(reminder.listId, "List/LIST-A");
  assert.equal(reminder.dueDate, new Date(1_735_862_400_000).toISOString());
  assert.deepEqual(reminder.alarmIds, ["Alarm/ALARM-1"]);
  assert.deepEqual(reminder.attachmentIds, []);
  assert.deepEqual(reminder.hashtagIds, []);
  assert.deepEqual(reminder.recurrenceRuleIds, []);
  const rawReminder = second.records[0] as Parameters<typeof normalizeReminder>[0];
  for (const value of [["Attachment/ATT-1"], null, ""]) {
    assert.throws(() => normalizeReminder({ ...rawReminder, fields: { ...rawReminder.fields, AttachmentIDs: { type: "UNKNOWN_LIST", value } } }), AppError);
  }
  assert.equal((reminder.raw.fields as Record<string, unknown>).CustomFutureField !== undefined, true);

  const versions = [{ ...listRecord(), recordChangeTag: "new-version" }, { ...listRecord(), recordChangeTag: "old-version" }];
  const duplicate = clientWith([{ body: { records: versions } }]);
  await assert.rejects(duplicate.api.queryPage({ recordType: "List" }), AppError);
});

test("organization normalizers expose only observed URL metadata and active tags with a matching reminder backlink", () => {
  const reminderId = "Reminder/REM-1";
  const url = { recordName: "Attachment/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", recordType: "Attachment", recordChangeTag: "url-v1",
    zoneID: { zoneName: "Reminders", zoneType: "REGULAR_CUSTOM_ZONE", ownerRecordName: "__defaultOwner__" }, raw: {}, fields: {
      Type: { type: "STRING", value: "URL" }, UTI: { type: "STRING", value: "public.url" }, Imported: { type: "INT64", value: 0 }, Deleted: { type: "INT64", value: 0 },
      URL: { type: "STRING", value: "https://example.test/reminder", isEncrypted: true }, AssetURL: { type: "STRING", value: "https://signed.invalid/secret" },
      Reminder: { type: "REFERENCE", value: { recordName: reminderId, action: "VALIDATE" } },
    } };
  const hashtag = { recordName: "Hashtag/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", recordType: "Hashtag", recordChangeTag: "tag-v1",
    zoneID: { zoneName: "Reminders", zoneType: "REGULAR_CUSTOM_ZONE", ownerRecordName: "__defaultOwner__" }, raw: {}, fields: {
      CreationDate: { type: "TIMESTAMP", value: 1 }, Type: { type: "INT64", value: 0 }, Imported: { type: "INT64", value: 0 }, Deleted: { type: "INT64", value: 0 },
      Name: { type: "STRING", value: "home", isEncrypted: true }, Reminder: { type: "REFERENCE", value: { recordName: reminderId, action: "VALIDATE" } },
    } };
  assert.deepEqual(normalizeURLAttachment(url, reminderId, "__defaultOwner__"), { id: url.recordName, url: "https://example.test/reminder" });
  assert.deepEqual(normalizeReminderTag(hashtag, reminderId, "__defaultOwner__"), { id: hashtag.recordName, name: "home" });
  assert.equal(JSON.stringify(normalizeURLAttachment(url, reminderId, "__defaultOwner__")).includes("signed.invalid"), false);
  const asset = { ...url, fields: { ...url.fields, Type: { type: "STRING", value: "Asset" }, UTI: { type: "STRING", value: "public.data" } } };
  assert.throws(() => normalizeURLAttachment(asset, reminderId, "__defaultOwner__"), AppError);
  assert.throws(() => normalizeReminderTag({ ...hashtag, fields: { ...hashtag.fields, Reminder: { type: "REFERENCE", value: { recordName: "Reminder/FOREIGN" } } } }, reminderId, "__defaultOwner__"), AppError);
});

test("experimental plural Lists query bootstraps the validated private zone and accepts singular List records", async () => {
  const owner = "_private-owner";
  const { api, requests } = clientWith([
    { body: { zones: [{ zoneID: { zoneName: "Reminders", zoneType: "REGULAR_CUSTOM_ZONE", ownerRecordName: owner } }] } },
    { body: { records: [listRecord()], continuationMarker: "lists-next" } },
  ]);
  const page = await api.queryListsPage({ limit: 25 });
  assert.equal(page.records.length, 1);
  assert.equal(page.complete, false);
  assert.equal(page.continuation, "lists-next");
  assert.equal(requests.length, 2);
  assert.equal(requests[1].url.pathname, "/database/1/com.apple.reminders/production/private/records/query");
  assert.deepEqual(requests[1].body, {
    query: { recordType: "Lists" },
    zoneID: { zoneName: "Reminders", zoneType: "REGULAR_CUSTOM_ZONE", ownerRecordName: owner },
    resultsLimit: 25,
  });
  const wrongType = clientWith([{ body: { records: [{ ...listRecord(), recordName: "Lists/LIST-A", recordType: "Lists" }] } }], { ...connection, remindersZoneOwner: owner });
  await assert.rejects(wrongType.api.queryListsPage(), AppError);
  const wrongErrorType = clientWith([{ body: { records: [{ recordName: "Reminder/NOT-A-LIST", serverErrorCode: "UNKNOWN_ITEM" }] } }], { ...connection, remindersZoneOwner: owner });
  await assert.rejects(wrongErrorType.api.queryListsPage(), AppError);
  const missingContinuation = clientWith([{ body: { records: [], moreComing: true } }], { ...connection, remindersZoneOwner: owner });
  await assert.rejects(missingContinuation.api.queryListsPage(), AppError);
  const malformedContinuation = clientWith([{ body: { records: [], continuationMarker: 42 } }], { ...connection, remindersZoneOwner: owner });
  await assert.rejects(malformedContinuation.api.queryListsPage(), AppError);
});

test("queryAllLists follows continuations, deduplicates summaries, and retains groups and deleted lists without raw contents", async () => {
  const group = { ...listRecord("List/GROUP"), fields: { Name: { type: "STRING", value: "Folder" }, IsGroup: { type: "INT64", value: 1 } } };
  const deleted = { ...listRecord("List/DELETED"), deleted: false, fields: { Name: { type: "STRING", value: "Removed" }, Deleted: { type: "INT64", value: 1 } } };
  const { api, requests } = clientWith([
    { body: { records: [listRecord(), group], continuationMarker: "lists-page-2" } },
    { body: { records: [listRecord(), deleted, { recordName: "List/TOMBSTONE", deleted: true }] } },
  ], { ...connection, remindersZoneOwner: "_private-owner" });
  const result = await api.queryAllLists();
  assert.equal(result.complete, true);
  assert.equal(result.pagesRead, 2);
  assert.equal(requests.length, 2);
  assert.equal(result.lists.length, 4);
  assert.equal(result.lists.find(list => list.id === "List/GROUP")?.isGroup, true);
  assert.equal(result.lists.find(list => list.id === "List/DELETED")?.deleted, true);
  assert.equal(result.lists.find(list => list.id === "List/TOMBSTONE")?.deleted, true);
  assert.ok(result.lists.every(list => list.reminderIds === null && Object.keys(list.raw).length === 0));
  assert.equal(requests.every(request => !Object.hasOwn(request.body, "desiredKeys")), true);
  assert.deepEqual(requests[1].body, {
    query: { recordType: "Lists" },
    zoneID: { zoneName: "Reminders", zoneType: "REGULAR_CUSTOM_ZONE", ownerRecordName: "_private-owner" },
    resultsLimit: 200,
    continuationMarker: "lists-page-2",
  });
});

test("queryAllLists reports record errors and continuation cycles as incomplete", async () => {
  const errors = clientWith([{ body: { records: [{ recordName: "List/FAILED", serverErrorCode: "CONFLICT", reason: "private reason" }] } }], { ...connection, remindersZoneOwner: "_private-owner" });
  assert.deepEqual(await errors.api.queryAllLists(), { lists: [], complete: false, pagesRead: 1, pendingReason: "record_errors" });
  const authentication = clientWith([{ body: { records: [{ recordName: "List/FAILED", serverErrorCode: "AUTHENTICATION_REQUIRED" }] } }], { ...connection, remindersZoneOwner: "_private-owner" });
  await assert.rejects(authentication.api.queryAllLists(), (error: unknown) => error instanceof AppError && error.code === "REAUTH_REQUIRED");
  const cycle = clientWith([
    { body: { records: [], continuationMarker: "cycle-a" } },
    { body: { records: [], continuationMarker: "cycle-b" } },
    { body: { records: [], continuationMarker: "cycle-a" } },
  ], { ...connection, remindersZoneOwner: "_private-owner" });
  assert.deepEqual(await cycle.api.queryAllLists(), { lists: [], complete: false, pagesRead: 3, pendingReason: "continuation_cycle" });
  const immediate = clientWith([
    { body: { records: [], continuationMarker: "same" } },
    { body: { records: [], continuationMarker: "same" } },
  ], { ...connection, remindersZoneOwner: "_private-owner" });
  assert.deepEqual(await immediate.api.queryAllLists(), { lists: [], complete: false, pagesRead: 2, pendingReason: "continuation_cycle" });
});

test("queryAllLists fails conflicting duplicates, malformed records, and unavailable or foreign private zones", async () => {
  const conflict = clientWith([
    { body: { records: [listRecord()], continuationMarker: "next" } },
    { body: { records: [{ ...listRecord(), fields: { Name: { type: "STRING", value: "Changed title" } } }] } },
  ], { ...connection, remindersZoneOwner: "_private-owner" });
  await assert.rejects(conflict.api.queryAllLists(), AppError);
  const malformed = clientWith([{ body: { records: [{ recordName: "List/BAD", recordType: "List", fields: { Count: { type: "STRING", value: "many" } } }] } }], { ...connection, remindersZoneOwner: "_private-owner" });
  await assert.rejects(malformed.api.queryAllLists(), AppError);
  const absent = clientWith([{ body: { zones: [] } }]);
  await assert.rejects(absent.api.queryListsPage(), AppError);
  assert.equal(absent.requests.length, 1);
  const foreign = clientWith([
    { body: { zones: [{ zoneID: { zoneName: "Reminders", ownerRecordName: "_private-owner" } }] } },
    { body: { records: [{ ...listRecord(), zoneID: { zoneName: "Reminders", ownerRecordName: "_foreign-owner" } }] } },
  ]);
  await assert.rejects(foreign.api.queryListsPage(), AppError);
});

test("queryAllLists stops at the aggregate summary byte and page budgets", async () => {
  const largePage = (page: number) => Array.from({ length: 150 }, (_, index) => ({
    recordName: `List/B${page}-${index}`,
    recordType: "List",
    fields: { Name: { type: "STRING", value: "x".repeat(1_000) } },
  }));
  const byteResponses = Array.from({ length: 8 }, (_, page) => ({ body: { records: largePage(page), ...(page < 7 ? { continuationMarker: `byte-${page + 1}` } : {}) } }));
  const bytes = clientWith(byteResponses, { ...connection, remindersZoneOwner: "_private-owner" });
  const byteResult = await bytes.api.queryAllLists();
  assert.equal(byteResult.complete, false);
  assert.equal(byteResult.pendingReason, "summary_byte_limit");
  assert.ok(byteResult.lists.length < 1_200);
  const pageResponses = Array.from({ length: 25 }, (_, page) => ({ body: { records: [], continuationMarker: `page-${page + 1}` } }));
  const pages = clientWith(pageResponses, { ...connection, remindersZoneOwner: "_private-owner" });
  assert.deepEqual(await pages.api.queryAllLists(), { lists: [], complete: false, pagesRead: 25, pendingReason: "page_limit" });
});

test("200-reminder compound pages accept related records but retain hard record and request limits", async () => {
  const records = Array.from({ length: 200 }, (_, index) => ({ ...reminderRecord("Task"), recordName: `Reminder/R-${index}` }));
  const alarms = Array.from({ length: 400 }, (_, index) => ({ recordName: `Alarm/A-${index}`, recordType: "Alarm", fields: {} }));
  const full = clientWith([{ body: { records: [...records, ...alarms] } }]);
  assert.equal((await full.api.queryRemindersPage({ listId: "List/LIST-A", includeCompleted: false, limit: 200 })).records.length, 600);
  assert.equal(full.requests[0].body.resultsLimit, 200);
  const excessive = clientWith([{ body: { records: Array.from({ length: 1001 }, (_, index) => ({ recordName: `Alarm/A-${index}`, recordType: "Alarm", fields: {} })) } }]);
  await assert.rejects(excessive.api.queryRemindersPage({ listId: "List/LIST-A", includeCompleted: false, limit: 200 }), AppError);
  const invalid = clientWith([]);
  await assert.rejects(invalid.api.queryListsPage({ limit: 201 }), AppError);
  assert.equal(invalid.requests.length, 0);
});

test("zone ownership and record zone mismatches fail closed on direct reads", async () => {
  const wrongOwner = clientWith([{ body: { zones: [{ zoneID: { zoneName: "Reminders", zoneType: "REGULAR_CUSTOM_ZONE", ownerRecordName: "_other-user" } }] } }], { ...connection, remindersZoneOwner: "_current-user" });
  await assert.rejects(wrongOwner.api.listZones(), AppError);

  const canonicalOwner = "_synthetic-current-user";
  const canonicalZone = { zoneName: "Reminders", zoneType: "REGULAR_CUSTOM_ZONE", ownerRecordName: canonicalOwner };
  const ownedReminder = { ...reminderRecord("Owner-bound task"), zoneID: canonicalZone, fields: { ...reminderRecord("Owner-bound task").fields, ParentReminder: { type: "REFERENCE", value: null } } };
  const listReference = ownedReminder.fields.List.value as { recordName: string; action: string; zoneID?: typeof canonicalZone };
  listReference.zoneID = canonicalZone;
  const scoped = clientWith([
    { body: { zones: [{ zoneID: canonicalZone }] } },
    { body: { records: [ownedReminder] } },
    { body: { records: [{ ...ownedReminder, fields: { ...ownedReminder.fields, List: { type: "REFERENCE", value: { recordName: "List/LIST-A", action: "VALIDATE", zoneID: { ...canonicalZone, ownerRecordName: "_different-user" } } } } }] } },
  ]);
  assert.equal((await scoped.api.listZones()).available, true);
  assert.equal(scoped.api.remindersZoneOwner, canonicalOwner);
  const ownedPage = await scoped.api.queryRemindersPage({ listId: "List/LIST-A", includeCompleted: true });
  assert.equal(ownedPage.records.length, 1);
  assert.equal(normalizeReminder(ownedPage.records[0] as Extract<(typeof ownedPage.records)[number], { recordType: string }>, canonicalOwner).parentReminderId, null);
  await assert.rejects(scoped.api.queryRemindersPage({ listId: "List/LIST-A", includeCompleted: true }), AppError);
  assert.deepEqual(scoped.requests[1].body.zoneID, canonicalZone);
  const ambiguous = clientWith([{ body: { zones: [{ zoneID: canonicalZone }, { zoneID: { ...canonicalZone, ownerRecordName: "_different-user" } }] } }]);
  await assert.rejects(ambiguous.api.listZones(), AppError); assert.equal(ambiguous.api.remindersZoneOwner, undefined);
  const absent = clientWith([{ body: { zones: [] } }]);
  assert.equal((await absent.api.listZones()).available, false); assert.equal(absent.api.remindersZoneOwner, undefined);

  const wrongZoneRecord = clientWith([{ body: { records: [{ ...listRecord(), zoneID: { zoneName: "Calendar", zoneType: "REGULAR_CUSTOM_ZONE" } }] } }]);
  await assert.rejects(wrongZoneRecord.api.lookup(["List/LIST-A"]), AppError);
});

test("HTTP 200 record errors remain visible and HTTP auth/rate-limit failures stay typed", async () => {
  const perRecord = clientWith([{ body: { records: [{ recordName: "Reminder/REM-MISSING", serverErrorCode: "UNKNOWN_ITEM", reason: "not found" }] } }]);
  const lookup = await perRecord.api.lookup(["Reminder/REM-MISSING"]);
  assert.equal(lookup.complete, false);
  assert.equal(lookup.recordErrors[0]?.serverErrorCode, "UNKNOWN_ITEM");
  assert.deepEqual(lookup.unresolvedRecordNames, []);

  const unauthenticated = clientWith([{ status: 401, body: { reason: "expired" } }]);
  await assert.rejects(unauthenticated.api.listZones(), (error: unknown) => error instanceof AppError && error.code === "REAUTH_REQUIRED" && error.status === 409);
  const limited = clientWith([{ status: 429, headers: { "retry-after": "30" }, body: {} }]);
  await assert.rejects(limited.api.listZones(), (error: unknown) => error instanceof CloudKitRateLimitedError && error.retryAfterSeconds === 30);
  const malformed = clientWith([{ body: { continuationMarker: null } }]);
  await assert.rejects(malformed.api.queryPage({ recordType: "List" }), (error: unknown) => error instanceof AppError && error.code === "PROTOCOL_CHANGED");
  const forbidden = clientWith([{ status: 403, body: {} }]);
  await assert.rejects(forbidden.api.listZones(), (error: unknown) => error instanceof AppError && error.code === "FORBIDDEN");
});

test("discovery URL validation rejects a non-Reminders Apple CloudKit URL", () => {
  assert.throws(() => new CloudKitRemindersClient(new AppleHTTP(), { ...connection, cloudKitURL: "https://p01-ckdatabasews.icloud.com/database/1/com.apple.notes/production/private" }), AppError);
  assert.throws(() => new CloudKitRemindersClient(new AppleHTTP(), { ...connection, cloudKitURL: "https://attacker.example/database/1/com.apple.reminders/production/private" }), AppError);
});
