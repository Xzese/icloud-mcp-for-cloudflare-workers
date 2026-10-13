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
import { membershipsChecksum } from "../../src/reminders/shopping-categories.ts";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const listId = "List/WRITE-ACCEPTANCE";
const searchListId = "List/SEARCH-FILTERS";
const zoneOwner = "synthetic-private-owner";
const reminderId = "Reminder/WRITE-EXISTING";
const opaqueMetadata = "synthetic-private-apple-field";

const jsonResponse = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), {
  status,
  headers: { "content-type": "application/json", ...headers },
});

function field(type, value) { return { type, value }; }

function listRecord(id = listId, reminderIds = []) {
  return {
    recordName: id, recordType: "List", recordChangeTag: "list-tag-1",
    zoneID: { zoneName: "Reminders", zoneType: "REGULAR_CUSTOM_ZONE", ownerRecordName: zoneOwner },
    fields: {
      Name: field("STRING", "Synthetic acceptance list"), Deleted: field("INT64", 0), IsGroup: field("INT64", 0),
      IsLinkedToAccount: field("INT64", 1), ReminderIDs: field("STRING", JSON.stringify(reminderIds)),
      ResolutionTokenMap: field("STRING", JSON.stringify({ map: { reminderIDsMergeableOrdering: {
        counter: 1, modificationTime: 800_000_000, replicaID: "3e6cb834-5b1c-4ce6-8c39-00e752121111",
      } } })),
    },
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

const searchRelationIds = {
  workA: "00000000-0000-4000-8000-000000000001", homeA: "00000000-0000-4000-8000-000000000002",
  urlA: "00000000-0000-4000-8000-000000000003", workB: "00000000-0000-4000-8000-000000000004",
  image: "00000000-0000-4000-8000-000000000005", homeDone: "00000000-0000-4000-8000-000000000006",
  urlDone: "00000000-0000-4000-8000-000000000007", missing: "00000000-0000-4000-8000-000000000008",
  unclassifiedUrl: "00000000-0000-4000-8000-000000000009", unclassifiedPng: "00000000-0000-4000-8000-00000000000a",
};

function searchReminderRecord(id, title, { completed = 0, notes = "", tags = [], attachments = [] } = {}) {
  const record = reminderRecord(id);
  record.fields.List = field("REFERENCE", { recordName: searchListId, action: "VALIDATE", zoneID: record.zoneID });
  record.fields.TitleDocument = field("ENCRYPTED_BYTES", encodeDocument(title));
  record.fields.NotesDocument = field("ENCRYPTED_BYTES", encodeDocument(notes));
  record.fields.Completed = field("INT64", completed);
  record.fields.HashtagIDs = field("STRING_LIST", tags);
  record.fields.AttachmentIDs = field("STRING_LIST", attachments);
  return record;
}

function searchHashtag(id, reminder, name) {
  return { recordName: `Hashtag/${id}`, recordType: "Hashtag", recordChangeTag: `tag-Hashtag-${id}`,
    zoneID: { zoneName: "Reminders", zoneType: "REGULAR_CUSTOM_ZONE", ownerRecordName: zoneOwner },
    fields: { Name: { ...field("STRING", name), isEncrypted: true }, Type: field("INT64", 0), Imported: field("INT64", 0), Deleted: field("INT64", 0),
      Reminder: field("REFERENCE", { recordName: reminder, action: "VALIDATE" }) } };
}

function searchAttachment(id, reminder, { url, image = false } = {}) {
  return { recordName: `Attachment/${id}`, recordType: "Attachment", recordChangeTag: `tag-Attachment-${id}`,
    zoneID: { zoneName: "Reminders", zoneType: "REGULAR_CUSTOM_ZONE", ownerRecordName: zoneOwner },
    fields: { Type: field("STRING", image ? "Image" : "URL"), UTI: field("STRING", image ? "public.jpeg" : "public.url"),
      ...(image ? {} : { URL: { ...field("STRING", url), isEncrypted: true } }), Imported: field("INT64", 0), Deleted: field("INT64", 0),
      Reminder: field("REFERENCE", { recordName: reminder, action: "VALIDATE" }) } };
}

const searchFixtures = (() => {
  const all = searchReminderRecord("Reminder/SEARCH-ALL", "ordinary title", { notes: "ordinary notes",
    tags: [searchRelationIds.workA, searchRelationIds.homeA], attachments: [searchRelationIds.urlA] });
  const work = searchReminderRecord("Reminder/SEARCH-WORK", "ordinary title", { tags: [searchRelationIds.workB] });
  const untagged = searchReminderRecord("Reminder/SEARCH-UNTAGGED", "https://example.test/Path", {
    notes: "https://example.test/Path", attachments: [searchRelationIds.image],
  });
  const done = searchReminderRecord("Reminder/SEARCH-DONE", "completed", { completed: 1,
    tags: [searchRelationIds.homeDone], attachments: [searchRelationIds.urlDone] });
  const records = [all, work, untagged, done];
  const related = [
    searchHashtag(searchRelationIds.workA, all.recordName, "work"), searchHashtag(searchRelationIds.homeA, all.recordName, "home"),
    searchAttachment(searchRelationIds.urlA, all.recordName, { url: "https://example.test/Path" }),
    searchHashtag(searchRelationIds.workB, work.recordName, "work"),
    searchAttachment(searchRelationIds.image, untagged.recordName, { image: true }),
    searchHashtag(searchRelationIds.homeDone, done.recordName, "home"),
    searchAttachment(searchRelationIds.urlDone, done.recordName, { url: "https://other.test/done" }),
  ];
  return { records, related };
})();

function earlyPayloadField(reminderId, accountIdentifier, { unit = 1, count = -1, identifier = randomUUID().toUpperCase() } = {}) {
  const payload = {
    reminderIdentifier: reminderId.slice("Reminder/".length), accountIdentifier,
    minimumSupportedVersion: 20230430,
    dueDateDeltaAlerts: [{ creationDate: 1_700_000_000, identifier, dueDateDeltaUnit: unit, dueDateDeltaCount: count, minimumSupportedAppVersion: 0 }],
  };
  return { field: field("ENCRYPTED_BYTES", Buffer.from(JSON.stringify(payload), "utf8").toString("base64")), payload };
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
      records: new Map([[listId, listRecord(listId, [reminderId.slice("Reminder/".length)])], [reminderId, reminderRecord(reminderId)],
        ["Reminder/WRITE-RECURRING", reminderRecord("Reminder/WRITE-RECURRING", { recurrence: true })],
        ["Reminder/WRITE-ALARMED", reminderRecord("Reminder/WRITE-ALARMED", { alarm: true })],
        [searchListId, listRecord(searchListId)], ...searchFixtures.records.map(record => [record.recordName, record]),
        ...searchFixtures.related.map(record => [record.recordName, record])]),
      omitLookupZoneIds: new Set(), foreignZoneIds: new Set(),
      requests: [], modifies: [], pristineLists: new Set(), firstChildWritten: new Set(), nextModify: null, holdLookup: null, holdModify: null,
    };
    const bindings = {
      ...options.bindings,
      LIVE_APPLE_CONNECTION_APPROVED: login ? "controlled-device-v2" : "",
      APPLE_CRYPTO_REVIEW_APPROVED: "device-proof-v2",
      ...(localEvidence ? { APP_ORIGIN: "http://127.0.0.1:5173", LOCAL_REMINDER_EVIDENCE_ENABLED: "synthetic-v1" } : {}),
    };
    const outboundService = async request => {
      const url = new URL(request.url);
      const body = request.method === "POST" ? await request.clone().json() : undefined;
      state.requests.push({ method: request.method, path: url.pathname, ...(body ? { body } : {}) });
      if (url.hostname === "cvws.icloud-content.com" && state.sectionAssets?.has(url.pathname))
        return new Response(state.sectionAssets.get(url.pathname), { headers: { "content-type": "application/octet-stream" } });
      if (url.pathname.endsWith("/changes/zone") && state.sectionFeedPages) {
        assert.deepEqual(body.desiredRecordTypes, ["ListSection"]);
        const pageIndex = body.zones[0].syncToken ? Number(body.zones[0].syncToken.split("-").at(-1)) : 0;
        const page = state.sectionFeedPages[pageIndex];
        assert.ok(page, "Section pagination must retain its native token.");
        return jsonResponse({ zones: [{ zoneID: { zoneName: "Reminders", ownerRecordName: zoneOwner },
          records: page, moreComing: pageIndex + 1 < state.sectionFeedPages.length, syncToken: `synthetic-section-${pageIndex + 1}` }] });
      }
      if (url.pathname.endsWith("/records/query")) {
        if (body.query.recordType === "Lists") return jsonResponse({ records: [...state.records.values()].filter(record => record.recordType === "List") });
        assert.equal(body.query.recordType, "reminderList");
        const requestedList = body.query.filterBy.find(filter => filter.fieldName === "List").fieldValue.value.recordName;
        if (state.nextListQuery) { const response = state.nextListQuery; state.nextListQuery = null; return jsonResponse(response); }
        assert.ok(state.records.get(requestedList)?.recordType === "List");
        state.onReminderListQuery?.();
        const includeCompleted = body.query.filterBy.find(filter => filter.fieldName === "includeCompleted").fieldValue.value === 1;
        const records = [...state.records.values()].filter(record => record.recordType === "Reminder" && record.fields.List?.value?.recordName === requestedList && record.fields.Deleted.value === 0 && (includeCompleted || record.fields.Completed.value === 0));
        return jsonResponse({ records: records.map(record => state.foreignZoneIds.has(record.recordName)
          ? { ...record, zoneID: { ...record.zoneID, ownerRecordName: "synthetic-foreign-owner" } } : record) });
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
          if (!record) return { recordName, serverErrorCode: "NOT_FOUND" };
          let result = state.foreignZoneIds.has(recordName)
            ? { ...record, zoneID: { ...record.zoneID, ownerRecordName: "synthetic-foreign-owner" } } : record;
          if (localEvidence || state.omitLookupZoneIds.has(recordName)) {
            result = { ...result };
            delete result.zoneID;
          }
          if (Array.isArray(body.desiredKeys)) result = { ...result, fields: Object.fromEntries(Object.entries(result.fields)
            .filter(([key]) => body.desiredKeys.includes(key))) };
          return result;
        });
        if (state.nextDeletionLookup && body.records.length === 1 && body.records[0].recordName === state.nextDeletionLookup.reminderId) {
          const variant = state.nextDeletionLookup; state.nextDeletionLookup = null;
          if (variant.mode === "family-delete-read-failure") return jsonResponse({ serverErrorCode: "SERVICE_UNAVAILABLE" }, 503);
          if (variant.mode === "family-delete-read-tag-drift") records[0] = { ...records[0], recordChangeTag: `${records[0].recordChangeTag}-drift` };
          if (variant.mode === "family-delete-read-field-drift") records[0] = { ...records[0], fields: { ...records[0].fields, Priority: field("INT64", 9) } };
        }
        return jsonResponse({ records: state.unresolvedSectionId ? records.filter(record => record.recordName !== state.unresolvedSectionId) : records });
      }
      if (url.pathname.endsWith("/records/modify")) {
        const operation = body.operations[0];
        const reminderCreate = body.operations.find(candidate => candidate.operationType === "create" && candidate.record.recordType === "Reminder");
        const createParentListId = reminderCreate?.record.parent?.recordName;
        const pristineFirstChild = typeof createParentListId === "string" && state.pristineLists.has(createParentListId) &&
          !state.firstChildWritten.has(createParentListId);
        const firstChildMembershipUpdate = body.operations[0]?.operationType === "update" &&
          Object.hasOwn(body.operations[0].record.fields, "ReminderIDs") && Object.hasOwn(body.operations[0].record.fields, "ResolutionTokenMap");
        const firstChildDeletionGuard = body.operations[0]?.record.fields.Deleted?.value === 0;
        if (pristineFirstChild && (body.operations[0]?.record.recordType !== "List" || body.operations[0]?.record.recordName !== createParentListId ||
          body.operations[0]?.record.recordChangeTag !== state.records.get(createParentListId)?.recordChangeTag ||
          (!firstChildMembershipUpdate && !firstChildDeletionGuard) || body.operations[1] !== reminderCreate)) {
          return jsonResponse({ serverErrorCode: "BAD_REQUEST" }, 400);
        }
        const recurringDeletionScope = body.operations.length === 7 && operation.record.fields.DueDate && !operation.record.fields.Completed &&
          body.operations.filter(candidate => candidate.operationType === "create").every(candidate => ["Alarm", "AlarmTrigger"].includes(candidate.record.recordType)) &&
          body.operations.some(candidate => candidate.operationType === "delete") ? "occurrence" :
          [3, 5].includes(body.operations.length) && operation.record.fields.Deleted?.value === 1 && operation.record.parent?.recordName === null &&
            body.operations.some(candidate => candidate.record.recordType === "RecurrenceRule" && candidate.record.fields.Deleted?.value === 1) ? "all_future" :
            body.operations.length === 3 && operation.record.fields.DueDate && !operation.record.fields.Completed &&
              new Set(body.operations.map(candidate => candidate.record.recordType)).size === 3 && body.operations.every(candidate => candidate.operationType === "update" && ["Reminder", "List", "RecurrenceRule"].includes(candidate.record.recordType)) ? "occurrence" : null;
        if (recurringDeletionScope) {
          assert.equal(body.atomic, true); state.modifies.push({ recurringDeletion: true, scope: recurringDeletionScope, operationCount: body.operations.length });
          const action = state.nextModify; state.nextModify = null;
          const racedType = action === "recurring-delete-rule-race" ? "RecurrenceRule" : action === "recurring-delete-list-race" ? "List" : action === "recurring-delete-alarm-race" ? "Alarm" : null;
          if (racedType) { const raced = body.operations.find(candidate => candidate.record.recordType === racedType && candidate.operationType !== "create"), before = state.records.get(raced.record.recordName); state.records.set(before.recordName, { ...before, recordChangeTag: `${before.recordChangeTag}-concurrent` }); }
          const stale = body.operations.find(candidate => candidate.operationType === "create" ? state.records.has(candidate.record.recordName) : candidate.record.recordChangeTag !== state.records.get(candidate.record.recordName)?.recordChangeTag);
          if (stale) return jsonResponse({ records: body.operations.map(candidate => ({ recordName: candidate.record.recordName, serverErrorCode: candidate === stale ? "CONFLICT" : "ATOMIC_ERROR" })) });
          const records = body.operations.map(candidate => {
            if (candidate.operationType === "delete") { state.records.delete(candidate.record.recordName); return { recordName: candidate.record.recordName, deleted: true }; }
            const before = state.records.get(candidate.record.recordName), next = { ...before, ...candidate.record, fields: { ...before?.fields, ...candidate.record.fields },
              zoneID: { zoneName: "Reminders", ownerRecordName: zoneOwner }, recordChangeTag: `recurring-delete-${state.modifies.length}-${candidate.record.recordName}` };
            if (candidate.record.parent?.recordName === null) delete next.parent;
            else if (next.parent) next.parent = { ...next.parent, zoneID: { zoneName: "Reminders", zoneType: "REGULAR_CUSTOM_ZONE", ownerRecordName: zoneOwner } };
            if (candidate.operationType === "create") {
              const key = next.recordType === "Alarm" ? "Reminder" : "Alarm";
              next.fields[key] = { ...next.fields[key], value: { ...next.fields[key].value, zoneID: { zoneName: "Reminders", zoneType: "REGULAR_CUSTOM_ZONE", ownerRecordName: zoneOwner } } };
            }
            if (action === "recurring-delete-crypto-drift" && next.recordType === "Reminder") next.fields.UrgentPresentationAlarmsAsData.value.wrappingKey = "changed";
            if (action === "recurring-delete-parent-drift" && candidate.operationType === "create" && next.recordType === "Alarm") next.parent = { recordName: "Reminder/OTHER" };
            state.records.set(next.recordName, next); return candidate.record.parent?.recordName === null ? { ...next, parent: before.parent } : next;
          });
          if (action === "committed-500") return jsonResponse({ serverErrorCode: "SERVICE_UNAVAILABLE" }, 500);
          return jsonResponse({ records: records.reverse() });
        }
        const dateAlarmLifecycle = body.operations.length === 4 && body.operations.every(candidate => candidate.operationType === "update") &&
          new Set(body.operations.map(candidate => candidate.record.recordType)).size === 4 &&
          body.operations.every(candidate => ["Reminder", "Alarm", "AlarmTrigger", "List"].includes(candidate.record.recordType)) &&
          (operation.record.fields.Completed !== undefined || operation.record.fields.Deleted?.value === 1);
        const scheduledFamilyLifecycle = body.operations.length > 4 && body.operations.every(candidate => candidate.operationType === "update" && ["Reminder", "Alarm", "AlarmTrigger", "List"].includes(candidate.record.recordType)) &&
          new Set(body.operations.map(candidate => candidate.record.recordType)).size === 4 && body.operations.filter(candidate => candidate.record.recordType === "Reminder").length > 1 &&
          (operation.record.fields.Completed !== undefined || operation.record.fields.Deleted?.value === 1);
        if (dateAlarmLifecycle || scheduledFamilyLifecycle) {
          assert.equal(body.atomic, true);
          state.modifies.push({ dateAlarmLifecycle: true, scheduledFamilyLifecycle, operationCount: body.operations.length, recordName: operation.record.recordName });
          const action = state.nextModify; state.nextModify = null;
          const raced = ["date-alarm-alarm-race", "scheduled-pair-race"].includes(action) ? body.operations.find(candidate => candidate.record.recordType === "Alarm") :
             ["date-alarm-list-race", "scheduled-list-race"].includes(action) ? body.operations.find(candidate => candidate.record.recordType === "List") :
              action === "scheduled-member-race" ? body.operations.find(candidate => candidate.record.recordType === "Reminder" && candidate.record.recordName !== operation.record.recordName) : null;
          if (raced) { const before = state.records.get(raced.record.recordName); state.records.set(before.recordName, { ...before, recordChangeTag: `${before.recordChangeTag}-concurrent` }); }
          const stale = body.operations.find(candidate => candidate.record.recordChangeTag !== state.records.get(candidate.record.recordName)?.recordChangeTag);
          if (stale) return jsonResponse({ records: body.operations.map(candidate => ({ recordName: candidate.record.recordName, serverErrorCode: candidate === stale ? "CONFLICT" : "ATOMIC_ERROR" })) });
          const records = body.operations.map(candidate => {
            const before = state.records.get(candidate.record.recordName), next = { ...before, ...candidate.record, fields: { ...before.fields, ...candidate.record.fields },
              zoneID: { zoneName: "Reminders", ownerRecordName: zoneOwner }, recordChangeTag: `${before.recordChangeTag}-date-lifecycle-${state.modifies.length}` };
            if (candidate.record.parent?.recordName === null) { assert.deepEqual(candidate.record.parent, { recordName: null }); delete next.parent; }
            state.records.set(next.recordName, next);
            if (candidate.record.parent?.recordName === null) return { ...next, parent: before.parent };
            return next;
          });
          if (action === "scheduled-crypto-drift") {
            const root = records.find(record => record.recordType === "Reminder"); root.fields.UrgentPresentationAlarmsAsData.value.wrappingKey = "changed";
          }
          if (action === "scheduled-parent-drift") {
            const sibling = records.find(record => record.recordType === "Reminder" && record.recordName !== operation.record.recordName); sibling.parent = { recordName: "List/OTHER" };
          }
          if (action === "date-alarm-parent-drift") {
            const index = records.findIndex(record => record.recordType === "Alarm"); records[index] = { ...records[index], parent: { recordName: "Reminder/OTHER" } };
          }
          if (action === "committed-500") return jsonResponse({ serverErrorCode: "SERVICE_UNAVAILABLE" }, 500);
          return jsonResponse({ records: records.reverse() });
        }
        const inPlaceRecurring = [0, 1].includes(operation.record.fields.Completed?.value) && !Object.hasOwn(operation.record.fields, "DueDate") &&
          [3, 5].includes(body.operations.length) && new Set(body.operations.map(candidate => candidate.record.recordType)).size === body.operations.length &&
          body.operations.every(candidate => candidate.operationType === "update" && ["Reminder", "List", "RecurrenceRule", "Alarm", "AlarmTrigger"].includes(candidate.record.recordType));
        if (inPlaceRecurring || operation.record.fields.Completed?.value === 0 && body.operations.some(candidate => candidate.operationType === "create" && candidate.record.recordType === "Reminder" && candidate.record.fields.Completed?.value === 1)) {
          assert.equal(body.atomic, true); assert.ok(inPlaceRecurring ? [3, 5].includes(body.operations.length) : [4, 10].includes(body.operations.length));
          state.modifies.push({ recurringCompletion: true, inPlaceRecurring, operationCount: body.operations.length,
            historyId: body.operations.find(candidate => candidate.operationType === "create" && candidate.record.recordType === "Reminder")?.record.recordName });
          const action = state.nextModify; state.nextModify = null;
          const raced = action === "recurring-rule-race" ? body.operations.find(candidate => candidate.record.recordType === "RecurrenceRule") :
            action === "recurring-list-race" ? body.operations.find(candidate => candidate.record.recordType === "List") :
              action === "recurring-alarm-race" ? body.operations.find(candidate => candidate.record.recordType === "Alarm") : null;
          if (raced) { const source = state.records.get(raced.record.recordName); state.records.set(source.recordName, { ...source, recordChangeTag: `${source.recordChangeTag}-concurrent` }); }
          const stale = body.operations.find(candidate => candidate.operationType === "create" ? state.records.has(candidate.record.recordName) : candidate.record.recordChangeTag !== state.records.get(candidate.record.recordName)?.recordChangeTag);
          if (stale) return jsonResponse({ records: body.operations.map(candidate => ({ recordName: candidate.record.recordName, serverErrorCode: candidate === stale ? "CONFLICT" : "ATOMIC_ERROR" })) });
          const records = body.operations.map(candidate => {
            if (candidate.operationType === "delete") { state.records.delete(candidate.record.recordName); return { recordName: candidate.record.recordName, deleted: true }; }
            const source = state.records.get(candidate.record.recordName);
            const next = { ...source, ...candidate.record, fields: { ...source?.fields, ...candidate.record.fields }, zoneID: { zoneName: "Reminders", ownerRecordName: zoneOwner }, recordChangeTag: `recurring-${state.modifies.length}-${candidate.record.recordName}` };
            if (candidate.operationType === "create" && ["Alarm", "AlarmTrigger"].includes(next.recordType)) {
              const key = next.recordType === "Alarm" ? "Reminder" : "Alarm";
              next.fields[key] = { ...next.fields[key], value: { ...next.fields[key].value, zoneID: {
                zoneName: "Reminders", zoneType: "REGULAR_CUSTOM_ZONE", ownerRecordName: action === "recurring-related-reference-foreign" ? "synthetic-foreign-owner" : zoneOwner,
              } } };
            }
            if (next.parent) next.parent = { ...next.parent, zoneID: { zoneName: "Reminders", zoneType: "REGULAR_CUSTOM_ZONE", ownerRecordName: zoneOwner } };
            const invalidParentTarget = action?.startsWith("recurring-history-parent-") ? candidate.operationType === "create" && candidate.record.recordType === "Reminder" :
              action?.startsWith("recurring-active-parent-") ? candidate.record.recordName === operation.record.recordName : false;
            if (invalidParentTarget) {
              if (action.endsWith("missing")) delete next.parent;
              else if (action.endsWith("foreign")) next.parent.zoneID.ownerRecordName = "synthetic-foreign-owner";
              else next.parent = { recordName: "List/OTHER-LIST" };
            }
            state.records.set(next.recordName, next); return next;
          });
          if (action === "recurring-retained-parent-drift") {
            const alarm = records.find(record => record.recordType === "Alarm"); alarm.parent = { recordName: "Reminder/OTHER" };
          }
          if (action === "recurring-retained-crypto-drift") {
            const root = records.find(record => record.recordType === "Reminder");
            root.fields.UrgentPresentationAlarmsAsData.value.wrappingKey = "changed-synthetic-key";
          }
          if (action === "committed-500") return jsonResponse({ serverErrorCode: "SERVICE_UNAVAILABLE" }, 500);
          return jsonResponse({ records: records.reverse() });
        }
        const creationListUpdate = reminderCreate && body.operations.find(candidate => candidate.operationType === "update" &&
          candidate.record.recordType === "List" && candidate.record.recordName === createParentListId && Object.hasOwn(candidate.record.fields, "ReminderIDs"));
        if (reminderCreate && creationListUpdate && body.operations.length <= 3 &&
          body.operations.every(candidate => ["List", "Reminder"].includes(candidate.record.recordType))) {
          assert.equal(body.atomic, true);
          assert.equal(body.operations[0], creationListUpdate, "The List ordering update must precede Reminder creation.");
          assert.equal(body.operations[1], reminderCreate, "The List ordering update must immediately precede Reminder creation.");
          assert.deepEqual(Object.keys(creationListUpdate.record.fields).sort(), ["ReminderIDs", "ResolutionTokenMap"]);
          const listBefore = state.records.get(createParentListId);
          assert.ok(listBefore && listBefore.recordType === "List");
          assert.equal(creationListUpdate.record.recordChangeTag, listBefore.recordChangeTag);
          const previousMembers = JSON.parse(listBefore.fields.ReminderIDs.value);
          assert.deepEqual(JSON.parse(creationListUpdate.record.fields.ReminderIDs.value),
            [...previousMembers, reminderCreate.record.recordName.slice("Reminder/".length)], "Creation appends without changing native List ordering.");
          const previousTokens = JSON.parse(listBefore.fields.ResolutionTokenMap.value).map;
          const nextTokens = JSON.parse(creationListUpdate.record.fields.ResolutionTokenMap.value).map;
          assert.deepEqual(Object.keys(nextTokens).sort(), Object.keys(previousTokens).sort());
          assert.equal(nextTokens.reminderIDsMergeableOrdering.counter, previousTokens.reminderIDsMergeableOrdering.counter + 1);
          assert.equal(nextTokens.reminderIDsMergeableOrdering.replicaID, previousTokens.reminderIDsMergeableOrdering.replicaID);
          for (const [fieldName, token] of Object.entries(previousTokens)) if (fieldName !== "reminderIDsMergeableOrdering") assert.deepEqual(nextTokens[fieldName], token);
          const subtaskParentId = reminderCreate.record.fields.ParentReminder?.value?.recordName;
          const parentGuard = subtaskParentId && body.operations.find(candidate => candidate.operationType === "update" &&
            candidate.record.recordType === "Reminder" && candidate.record.recordName === subtaskParentId);
          if (subtaskParentId) {
            assert.equal(body.operations.length, 3, "A subtask create must atomically guard its current parent.");
            assert.equal(parentGuard, body.operations[2]);
            assert.deepEqual(parentGuard.record.fields, { Deleted: field("INT64", 0) });
          } else assert.equal(body.operations.length, 2, "A root create changes only its List ordering and new Reminder.");
          if (pristineFirstChild) {
            assert.equal(body.operations[0].record.recordName, createParentListId);
            assert.equal(body.operations[1], reminderCreate, "A pristine List's membership must be committed before its first Reminder.");
          }
          state.modifies.push({ operationType: "create", recordName: reminderCreate.record.recordName,
            recordChangeTag: reminderCreate.record.recordChangeTag, fields: Object.keys(reminderCreate.record.fields).sort(),
            atomicCreationGroup: true, operationCount: body.operations.length });
          const action = state.nextModify; state.nextModify = null;
          if (action === "redirect-307") return new Response(null, { status: 307, headers: { location: request.url } });
          if (action === "record-conflict") return jsonResponse({ records: body.operations.map(candidate => ({
            recordName: candidate.record.recordName, serverErrorCode: candidate === reminderCreate ? "CONFLICT" : "ATOMIC_ERROR",
          })) });
          if (action === "family-list-race") {
            state.records.set(listBefore.recordName, { ...listBefore, recordChangeTag: `concurrent-${listBefore.recordChangeTag}` });
          }
          if (action === "parent-race") {
            assert.ok(parentGuard, "Subtask creation retains its exact parent Reminder guard.");
            const parent = state.records.get(parentGuard.record.recordName);
            state.records.set(parent.recordName, { ...parent, recordChangeTag: `concurrent-${parent.recordChangeTag}` });
          }
          const stale = body.operations.find(candidate => candidate.operationType === "create" ? state.records.has(candidate.record.recordName) :
            candidate.record.recordChangeTag !== state.records.get(candidate.record.recordName)?.recordChangeTag);
          if (stale) return jsonResponse({ records: body.operations.map(candidate => ({
            recordName: candidate.record.recordName, serverErrorCode: candidate === stale ? "CONFLICT" : "ATOMIC_ERROR",
          })) });
          const records = body.operations.map(candidate => {
            const current = state.records.get(candidate.record.recordName);
            const next = candidate.operationType === "create"
              ? { ...candidate.record, zoneID: { zoneName: "Reminders", zoneType: "REGULAR_CUSTOM_ZONE", ownerRecordName: zoneOwner } }
              : { ...current, fields: { ...current.fields, ...candidate.record.fields } };
            next.recordChangeTag = `creation-${state.modifies.length}-${next.recordName}`;
            state.records.set(next.recordName, next);
            return next;
          });
          if (pristineFirstChild) state.firstChildWritten.add(createParentListId);
          if (state.holdModify) {
            const held = state.holdModify; state.holdModify = null; held.reached(); await held.releasePromise;
          }
          if (action === "committed-500") return jsonResponse({ serverErrorCode: "SERVICE_UNAVAILABLE" }, 500);
          if (action === "committed-network-drop") throw new Error("Synthetic response lost after atomic List and Reminder creation.");
          if (action === "missing-parent-confirmation") return jsonResponse({ records: records.slice(0, 1) });
          return jsonResponse({ records: records.reverse() });
        }
        const ordinaryListGuard = body.operations.some(candidate => candidate.record.recordType === "List" &&
          Object.keys(candidate.record.fields).length === 1 && candidate.record.fields.Deleted?.value === 0);
        const nativeDelete = operation.record.fields.Deleted?.value === 1 && operation.record.fields.List?.value === null &&
          operation.record.parent?.recordName === null;
        const reminderOperation = reminderCreate ?? operation;
        if ((ordinaryListGuard || nativeDelete) && reminderOperation.record.recordType === "Reminder" &&
          (!Object.hasOwn(reminderOperation.record.fields, "ParentReminder") || nativeDelete) &&
          body.operations.every(candidate => candidate.record.recordType === "Reminder" || candidate.record.recordType === "List" && Object.keys(candidate.record.fields).length <= 2)) {
          assert.equal(body.atomic, true);
          if (nativeDelete) assert.deepEqual(reminderOperation.record.parent, { recordName: null });
          if (pristineFirstChild) {
            assert.equal(body.operations[0].record.recordName, createParentListId);
            assert.equal(body.operations[1], reminderCreate, "A pristine List guard must immediately precede its first Reminder creation.");
          }
          assert.ok(body.operations.length <= 32);
          state.modifies.push({ operationType: reminderOperation.operationType, recordName: reminderOperation.record.recordName,
            recordChangeTag: reminderOperation.record.recordChangeTag, fields: Object.keys(reminderOperation.record.fields).sort(),
            atomicLifecycleGroup: true, operationCount: body.operations.length });
          const action = state.nextModify; state.nextModify = null;
          if (action === "redirect-307") return new Response(null, { status: 307, headers: { location: request.url } });
          if (action?.startsWith("family-") && action.endsWith("-race")) {
            const raced = action === "family-list-race" ? body.operations.find(candidate => candidate.record.recordType === "List") :
              action === "family-parent-race" ? body.operations.find(candidate => candidate.record.recordName.endsWith("FAMILY-PARENT")) :
              body.operations.find(candidate => candidate.record.recordName.endsWith("FAMILY-CHILD"));
            const current = state.records.get(raced.record.recordName);
            state.records.set(current.recordName, { ...current, recordChangeTag: `concurrent-${current.recordChangeTag}` });
          }
          const stale = action === "record-conflict" ? operation : body.operations.find(candidate =>
            candidate.operationType === "create" ? state.records.has(candidate.record.recordName) :
              candidate.record.recordChangeTag !== state.records.get(candidate.record.recordName)?.recordChangeTag);
          if (stale) return jsonResponse({ records: body.operations.map(candidate => ({ recordName: candidate.record.recordName,
            serverErrorCode: candidate === stale ? "CONFLICT" : "ATOMIC_ERROR" })) });
          const records = body.operations.map(candidate => {
            const current = state.records.get(candidate.record.recordName);
            const next = candidate.operationType === "create" ? { ...candidate.record,
              zoneID: { zoneName: "Reminders", zoneType: "REGULAR_CUSTOM_ZONE", ownerRecordName: zoneOwner } } :
              { ...current, fields: { ...current.fields, ...candidate.record.fields } };
            if (candidate.operationType === "create" || candidate.record.parent?.recordName === null) delete next.parent;
            next.recordChangeTag = `tag-${candidate.operationType === "create" ? "created" : "updated"}-${state.modifies.length}-${next.recordName}`;
            state.records.set(next.recordName, next);
            return next;
          });
          if (pristineFirstChild) state.firstChildWritten.add(createParentListId);
          if (state.holdModify) {
            const held = state.holdModify; state.holdModify = null; held.reached(); await held.releasePromise;
          }
          if (action === "committed-500") return jsonResponse({ serverErrorCode: "SERVICE_UNAVAILABLE" }, 500);
          if (action === "committed-network-drop") throw new Error("Synthetic response lost after atomic family commit.");
          if (action === "changed-resolution-tokens") records[0] = { ...records[0], fields: { ...records[0].fields,
            ResolutionTokenMap: field("STRING", JSON.stringify({ map: {} })) } };
          const introducedRelationship = {
            "family-added-parent": { ParentReminder: field("REFERENCE", { recordName: "Reminder/UNEXPECTED-PARENT", action: "VALIDATE" }) },
            "family-added-alarm": { AlarmIDs: field("STRING_LIST", ["Alarm/UNEXPECTED"]) },
            "family-added-recurrence": { RecurrenceRuleIDs: field("STRING_LIST", ["RecurrenceRule/UNEXPECTED"]) },
            "family-added-unknown-relationship": { FutureChildren: field("STRING_LIST", ["Reminder/UNEXPECTED"]) },
            "family-added-empty-relationships": { ParentReminder: field("REFERENCE", null), AlarmIDs: field("UNKNOWN_LIST", []),
              RecurrenceRuleIDs: field("STRING_LIST", []), UrgentPresentationAlarmsAsData: field("ASSETID", {
                downloadURL: "https://synthetic.invalid/presentation", fileChecksum: "synthetic-checksum", wrappingKey: "synthetic-key", size: 10,
              }) },
          }[action];
          if (introducedRelationship) records[0] = { ...records[0], fields: { ...records[0].fields, ...introducedRelationship } };
          if (action === "family-changed-guard-intrinsic-parent") {
            const index = records.findIndex(record => record.recordName === "Reminder/FAMILY-CHILD");
            assert.ok(index >= 0);
            records[index] = { ...records[index], parent: { recordName: "List/UNEXPECTED" } };
          }
          if (nativeDelete && action?.startsWith("family-delete-read-")) {
            const emptyCollections = Object.fromEntries(["AlarmIDs", "HashtagIDs", "RecurrenceRuleIDs", "AssignmentIDs", "AttachmentIDs"]
              .map(name => [name, field("UNKNOWN_LIST", [])]));
            if (action === "family-delete-read-hashtag-introduction") emptyCollections.HashtagIDs = field("STRING_LIST", ["Hashtag/UNEXPECTED"]);
            const detached = { ...records[0], fields: { ...records[0].fields, ...emptyCollections } };
            state.records.set(detached.recordName, detached);
            records[0] = { ...detached, parent: { recordName: listId } };
            state.nextDeletionLookup = { reminderId: detached.recordName, mode: action };
          }
          return jsonResponse({ records: records.reverse() });
        }
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
          const parentOperation = body.operations.find(candidate => Object.hasOwn(candidate.record.fields, "ParentReminder"));
          if (parentOperation) {
            assert.equal(parentOperation.operationType, "update", "Creation is handled with its atomic List membership update above.");
            const listGuard = body.operations.find(candidate => candidate.operationType === "update" && candidate.record.recordType === "List");
            assert.ok(listGuard, "A parent change must guard the full current List version.");
            assert.deepEqual(listGuard.record.fields, { Deleted: field("INT64", 0) });
            assert.equal(listGuard.record.recordChangeTag, state.records.get(listGuard.record.recordName)?.recordChangeTag);
            const previousParent = state.records.get(parentOperation.record.recordName).fields.ParentReminder?.value?.recordName ?? null;
            const nextParent = parentOperation.record.fields.ParentReminder.value?.recordName ?? null;
            const expectedParentIds = [...new Set([previousParent, nextParent].filter(Boolean))].sort();
            const parentGuards = body.operations.filter(candidate => candidate.operationType === "update" && candidate.record.recordType === "Reminder" &&
              candidate.record.recordName !== parentOperation.record.recordName);
            assert.deepEqual(parentGuards.map(candidate => candidate.record.recordName).sort(), expectedParentIds,
              "A parent change guards each affected old and new root version.");
            for (const guard of parentGuards) assert.deepEqual(guard.record.fields, { Deleted: field("INT64", 0) });
            assert.equal(body.operations.length, 2 + expectedParentIds.length, "A parent change atomically includes its target, List and affected roots.");
            state.modifies.push({ atomicSubtaskGroup: true, operationCount: body.operations.length });
            const action = state.nextModify;
            state.nextModify = null;
            if (action === "parent-race") {
              const parentGuard = parentGuards[0];
              assert.ok(parentGuard, "A parent change must retain its exact affected root Reminder guard.");
              const parent = state.records.get(parentGuard.record.recordName);
              state.records.set(parent.recordName, { ...parent, recordChangeTag: `concurrent-${parent.recordChangeTag}` });
            }
            const stale = body.operations.find(candidate => candidate.operationType === "create" ? state.records.has(candidate.record.recordName) :
              candidate.record.recordChangeTag !== state.records.get(candidate.record.recordName)?.recordChangeTag);
            if (stale) return jsonResponse({ records: body.operations.map(candidate => ({
              recordName: candidate.record.recordName, serverErrorCode: candidate === stale ? "CONFLICT" : "ATOMIC_ERROR",
            })) });
            const records = body.operations.map(candidate => {
              const versionGuard = candidate !== parentOperation;
              if (versionGuard) assert.deepEqual(candidate.record.fields, { Deleted: field("INT64", 0) });
              else assert.equal(candidate, parentOperation);
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
          if (body.operations.some(candidate => Object.hasOwn(candidate.record.fields, "DueDateDeltaAlertsData"))) {
            assert.equal(body.operations.length, 2);
            state.modifies.push({ earlyReminderGroup: true, operationCount: body.operations.length });
            const action = state.nextModify; state.nextModify = null;
            const sourceGuard = body.operations.find(candidate => Object.keys(candidate.record.fields).length === 1 && candidate.record.fields.Deleted?.type === "INT64" && candidate.record.fields.Deleted.value === 0);
            assert.ok(sourceGuard, "Early reminder creation must guard its exact metadata source.");
            if (action === "early-source-race") {
              const source = state.records.get(sourceGuard.record.recordName);
              state.records.set(source.recordName, { ...source, recordChangeTag: `concurrent-${source.recordChangeTag}` });
            }
            const stale = body.operations.find(candidate => candidate.record.recordChangeTag !== state.records.get(candidate.record.recordName)?.recordChangeTag);
            if (stale) return jsonResponse({ records: body.operations.map(candidate => ({
              recordName: candidate.record.recordName, serverErrorCode: candidate === stale ? "SERVER_RECORD_CHANGED" : "ATOMIC_ERROR",
            })) });
            const records = body.operations.map(candidate => {
              assert.equal(candidate.operationType, "update");
              if (candidate === sourceGuard) assert.deepEqual(candidate.record.fields, { Deleted: field("INT64", 0) });
              const current = state.records.get(candidate.record.recordName);
              const next = { ...current, fields: { ...current.fields, ...candidate.record.fields },
                recordChangeTag: `early-updated-${state.modifies.length}-${current.recordName}` };
              state.records.set(next.recordName, next);
              return next;
            });
            return jsonResponse({ records: records.reverse() });
          }
          if (body.operations.some(candidate => ["Attachment", "Hashtag"].includes(candidate.record.recordType))) {
            assert.equal(body.atomic, true);
            state.modifies.push({ atomicOrganizationGroup: true, operationCount: body.operations.length });
            const action = state.nextModify; state.nextModify = null;
            if (action === "related-version-race") {
              const guard = body.operations.find(candidate => ["Attachment", "Hashtag"].includes(candidate.record.recordType) &&
                candidate.operationType === "update" && Object.keys(candidate.record.fields).length === 1 &&
                candidate.record.fields.Deleted?.type === "INT64" && candidate.record.fields.Deleted.value === 0);
              assert.ok(guard, "Organization replacement must guard a retained related record.");
              const current = state.records.get(guard.record.recordName);
              state.records.set(current.recordName, { ...current, recordChangeTag: `concurrent-${current.recordChangeTag}` });
            }
            if (action === "transfer-list-race") {
              const listWrites = body.operations.filter(candidate => candidate.record.recordType === "List" &&
                Object.hasOwn(candidate.record.fields, "ReminderIDs"));
              const guard = listWrites.at(-1);
              assert.ok(guard, "A move must atomically write its destination List membership.");
              const current = state.records.get(guard.record.recordName);
              state.records.set(current.recordName, { ...current, recordChangeTag: `concurrent-${current.recordChangeTag}` });
            }
            const stale = body.operations.find(candidate => candidate.operationType === "create" ? state.records.has(candidate.record.recordName) :
              candidate.record.recordChangeTag !== state.records.get(candidate.record.recordName)?.recordChangeTag);
            if (stale) return jsonResponse({ records: body.operations.map(candidate => ({
              recordName: candidate.record.recordName, serverErrorCode: candidate === stale ? "CONFLICT" : "ATOMIC_ERROR",
            })) });
            const records = body.operations.map(candidate => {
              const current = state.records.get(candidate.record.recordName);
              const next = candidate.operationType === "create"
                ? { ...candidate.record, zoneID: { zoneName: "Reminders", zoneType: "REGULAR_CUSTOM_ZONE", ownerRecordName: zoneOwner } }
                : { ...current, fields: { ...current.fields, ...candidate.record.fields } };
              if (Object.hasOwn(candidate.record, "parent")) next.parent = candidate.record.parent;
              next.recordChangeTag = `organization-updated-${state.modifies.length}-${next.recordName}`;
              state.records.set(next.recordName, next);
              return next;
            });
            if (action === "committed-500") return jsonResponse({ serverErrorCode: "SERVICE_UNAVAILABLE" }, 500);
            if (action === "committed-network-drop") throw new Error("Synthetic response lost after atomic organization commit.");
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
        assert.ok(["Reminder", "List"].includes(operation.record.recordType));
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
        if (operation.operationType === "create" && operation.record.recordType === "List") state.pristineLists.add(next.recordName);
        if (["reorder-color-json", "reorder-list-json-receipt"].includes(action) && operation.record.recordType === "List" && next.fields.Color?.type === "STRING") {
          const parsed = JSON.parse(next.fields.Color.value);
          next.fields.Color = { ...next.fields.Color, value: JSON.stringify(Object.fromEntries(Object.entries(parsed).reverse())) };
        }
        if (state.holdModify) {
          const held = state.holdModify;
          state.holdModify = null;
          held.reached();
          await held.releasePromise;
        }
        if (action === "committed-500") return jsonResponse({ serverErrorCode: "SERVICE_UNAVAILABLE" }, 500);
        if (action === "committed-network-drop") throw new Error("Synthetic response lost after commit.");
        if (action === "reorder-list-json-receipt" && operation.record.recordType === "List") {
          const parsed = JSON.parse(next.fields.ResolutionTokenMap.value);
          const map = Object.fromEntries(Object.entries(parsed.map).reverse());
          const prettyTokens = field("STRING", JSON.stringify({ ...parsed, map }, null, 2));
          return jsonResponse({ records: [{ ...next, fields: { ...next.fields, ResolutionTokenMap: prettyTokens } }] });
        }
        if (action === "changed-resolution-tokens") return jsonResponse({ records: [{ ...next, fields: { ...next.fields, ResolutionTokenMap: field("STRING", JSON.stringify({ map: {} })) } }] });
        if (["signed-asset-url-drift", "signed-asset-checksum-drift", "signed-asset-wrapping-drift"].includes(action)) {
          const asset = next.fields.UrgentPresentationAlarmsAsData;
          const key = action === "signed-asset-url-drift" ? "downloadURL" : action === "signed-asset-checksum-drift" ? "fileChecksum" : "wrappingKey";
          return jsonResponse({ records: [{ ...next, fields: { ...next.fields, UrgentPresentationAlarmsAsData: { ...asset, value: { ...asset.value, [key]: "changed" } } } }] });
        }
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
    for (const action of ["create", "update", "complete", "reopen", "delete", "subtasks", "bulkCreate", "bulkUpdate", "bulkComplete", "reminderInspection"]) assert.equal(readyStatus.capabilities[action], true);

    const toolsReply = await mcp("tools/list", {});
    const tools = toolsReply.result.tools;
    assert.deepEqual(tools.map(tool => tool.name).sort(), ["complete_reminder", "connection_status", "create_reminder", "create_reminder_workflow", "duplicate_reminder_list", "create_subtask", "set_reminder_parent", "delete_reminder", "get_all_open_reminders", "get_reminder", "inspect_reminder", "get_reminder_organization", "get_reminder_lists", "get_reminder_list", "get_reminder_list_appearance", "update_reminder_list_appearance", "get_shopping_categories", "get_reminder_list_sections", "set_reminder_category", "create_reminder_list", "rename_reminder_list", "delete_reminder_list", "get_reminders", "search_reminders", "get_reminder_view", "export_reminders", "save_reminder_filter", "get_reminder_filters", "delete_reminder_filter", "run_reminder_filter", "reopen_reminder", "update_reminder", "prepare_reminder_update", "set_reminder_url", "set_reminder_tags", "move_reminder", "copy_reminder", ...JOB_TOOLS].sort());
    const createTool = tools.find(tool => tool.name === "create_reminder");
    const updateTool = tools.find(tool => tool.name === "update_reminder");
    const inspectTool = tools.find(tool => tool.name === "inspect_reminder");
    assert.equal(inspectTool.annotations.readOnlyHint, true);
    assert.deepEqual(inspectTool.inputSchema.required.sort(), ["listId", "reminderId"]);
    assert.deepEqual(inspectTool.outputSchema.properties.actions.properties.complete.properties.status.enum, ["supported", "unsupported", "requires_input"]);
    assert.deepEqual({ readOnly: createTool.annotations.readOnlyHint, destructive: createTool.annotations.destructiveHint, idempotent: createTool.annotations.idempotentHint }, { readOnly: false, destructive: false, idempotent: true });
    assert.deepEqual({ readOnly: updateTool.annotations.readOnlyHint, destructive: updateTool.annotations.destructiveHint, idempotent: updateTool.annotations.idempotentHint }, { readOnly: false, destructive: true, idempotent: true });
    for (const name of ["complete_reminder", "reopen_reminder", "delete_reminder"]) {
      const annotations = tools.find(tool => tool.name === name).annotations;
      assert.deepEqual([annotations.readOnlyHint, annotations.destructiveHint, annotations.idempotentHint], [false, true, true]);
    }
    for (const name of ["complete_reminder", "reopen_reminder", "delete_reminder"]) assert.ok(tools.find(tool => tool.name === name).inputSchema.properties.recurrenceCalendarTimeZone.description.length > 0);
    for (const tool of tools) for (const parameter of Object.values(tool.inputSchema.properties ?? {})) {
      assert.ok(parameter.description?.length > 0, `${tool.name} must describe each parameter in tools/list.`);
    }
    for (const parameter of Object.values(updateTool.inputSchema.properties.changes.properties)) assert.ok(parameter.description?.length > 0);
    const search = async args => mcp("tools/call", { name: "search_reminders", arguments: { expectedGeneration: generation, listId: searchListId, ...args } });
    const allTags = await search({ status: "all", tags: ["work", "home"] });
    assert.equal(allTags.result.isError, undefined, JSON.stringify(allTags.result));
    assert.deepEqual(allTags.result.structuredContent.records.map(record => record.id), ["Reminder/SEARCH-ALL"]);
    assert.ok(!JSON.stringify(allTags.result).includes("https://example.test/Path") && !JSON.stringify(allTags.result).includes("work"));
    const tagLookup = state.requests.filter(request => request.path.endsWith("/records/lookup")).at(-1);
    assert.deepEqual(tagLookup.body.records.map(record => record.recordName), [
      `Hashtag/${searchRelationIds.workA}`, `Hashtag/${searchRelationIds.homeA}`,
      `Hashtag/${searchRelationIds.workB}`, `Hashtag/${searchRelationIds.homeDone}`,
    ], "Tag-only search batches only selected tag relationships.");

    const anyTags = await search({ status: "all", tags: ["work", "home"], tagMatch: "any" });
    assert.deepEqual(anyTags.result.structuredContent.records.map(record => record.id), ["Reminder/SEARCH-ALL", "Reminder/SEARCH-WORK", "Reminder/SEARCH-DONE"]);
    const untagged = await search({ status: "all", hasTags: false });
    assert.deepEqual(untagged.result.structuredContent.records.map(record => record.id), ["Reminder/SEARCH-UNTAGGED"]);
    const urlMatch = await search({ status: "all", urlText: "EXAMPLE.TEST/path" });
    assert.deepEqual(urlMatch.result.structuredContent.records.map(record => record.id), ["Reminder/SEARCH-ALL"], "URL text ignores title, notes and image attachments.");
    const urlLookup = state.requests.filter(request => request.path.endsWith("/records/lookup")).at(-1);
    assert.deepEqual(urlLookup.body.records.map(record => record.recordName), [
      `Attachment/${searchRelationIds.urlA}`, `Attachment/${searchRelationIds.image}`, `Attachment/${searchRelationIds.urlDone}`,
    ], "URL-only search does not fetch tags.");
    const noURL = await search({ status: "all", hasUrl: false });
    assert.deepEqual(noURL.result.structuredContent.records.map(record => record.id), ["Reminder/SEARCH-WORK", "Reminder/SEARCH-UNTAGGED"]);
    const completedOrganizationSearch = await search({ status: "completed", tags: ["home"], hasUrl: true });
    assert.deepEqual(completedOrganizationSearch.result.structuredContent.records.map(record => record.id), ["Reminder/SEARCH-DONE"]);

    const unclassifiedURLReminder = searchReminderRecord("Reminder/SEARCH-UNCLASSIFIED-URL", "unclassified URL", { attachments: [searchRelationIds.unclassifiedUrl] });
    const unclassifiedURLAttachment = searchAttachment(searchRelationIds.unclassifiedUrl, unclassifiedURLReminder.recordName, { url: "https://example.test/unclassified", image: true });
    delete unclassifiedURLAttachment.fields.Type; delete unclassifiedURLAttachment.fields.UTI;
    unclassifiedURLAttachment.fields.URL = { ...field("STRING", "https://example.test/unclassified"), isEncrypted: true };
    state.records.set(unclassifiedURLReminder.recordName, unclassifiedURLReminder);
    state.records.set(unclassifiedURLAttachment.recordName, unclassifiedURLAttachment);
    state.nextListQuery = { records: [], continuationMarker: "search-unclassified-url-next" };
    const unclassifiedURLFirst = await search({ status: "all", urlText: "example.test/unclassified" });
    const unclassifiedURLToken = unclassifiedURLFirst.result.structuredContent.continuation;
    state.nextListQuery = { records: [unclassifiedURLReminder] };
    const unclassifiedURL = await search({ status: "all", urlText: "example.test/unclassified", continuation: unclassifiedURLToken });
    assert.equal(unclassifiedURL.result.structuredContent.error.code, "UNSUPPORTED_FEATURE");
    unclassifiedURLAttachment.fields.Type = field("STRING", "URL");
    unclassifiedURLAttachment.fields.UTI = field("STRING", "public.url");
    state.records.set(unclassifiedURLAttachment.recordName, unclassifiedURLAttachment);
    state.nextListQuery = { records: [unclassifiedURLReminder] };
    const classifiedURLRetry = await search({ status: "all", urlText: "example.test/unclassified", continuation: unclassifiedURLToken });
    assert.deepEqual(classifiedURLRetry.result.structuredContent.records.map(record => record.id), [unclassifiedURLReminder.recordName], "Repairing URL classification lets the same MCP continuation return its match.");

    const unclassifiedPNGReminder = searchReminderRecord("Reminder/SEARCH-UNCLASSIFIED-PNG", "unclassified image", { attachments: [searchRelationIds.unclassifiedPng] });
    const unclassifiedPNGAttachment = searchAttachment(searchRelationIds.unclassifiedPng, unclassifiedPNGReminder.recordName, { image: true });
    delete unclassifiedPNGAttachment.fields.Type; delete unclassifiedPNGAttachment.fields.UTI;
    state.records.set(unclassifiedPNGReminder.recordName, unclassifiedPNGReminder);
    state.records.set(unclassifiedPNGAttachment.recordName, unclassifiedPNGAttachment);
    state.nextListQuery = { records: [], continuationMarker: "search-unclassified-png-next" };
    const unclassifiedPNGFirst = await search({ status: "all", hasUrl: false });
    const unclassifiedPNGToken = unclassifiedPNGFirst.result.structuredContent.continuation;
    state.nextListQuery = { records: [unclassifiedPNGReminder] };
    const unclassifiedPNG = await search({ status: "all", hasUrl: false, continuation: unclassifiedPNGToken });
    assert.equal(unclassifiedPNG.result.structuredContent.error.code, "UNSUPPORTED_FEATURE");
    unclassifiedPNGAttachment.fields.Type = field("STRING", "Image");
    unclassifiedPNGAttachment.fields.UTI = field("STRING", "public.png");
    state.records.set(unclassifiedPNGAttachment.recordName, unclassifiedPNGAttachment);
    state.nextListQuery = { records: [unclassifiedPNGReminder] };
    const classifiedPNGRetry = await search({ status: "all", hasUrl: false, continuation: unclassifiedPNGToken });
    assert.deepEqual(classifiedPNGRetry.result.structuredContent.records.map(record => record.id), [unclassifiedPNGReminder.recordName], "Observed PNG classification lets the same MCP continuation prove there is no URL.");

    state.nextListQuery = { records: [searchFixtures.records[0]], continuationMarker: "search-filter-next" };
    const searchFirst = await search({ status: "all", tags: ["work"] });
    const searchToken = searchFirst.result.structuredContent.continuation;
    assert.ok(searchToken);
    const queriesBeforeChangedFilters = state.requests.filter(request => request.path.endsWith("/records/query")).length;
    const changedHydrationFilters = await search({ status: "all", tags: ["home"], continuation: searchToken });
    assert.equal(changedHydrationFilters.result.structuredContent.error.code, "CONFLICT");
    assert.equal(state.requests.filter(request => request.path.endsWith("/records/query")).length, queriesBeforeChangedFilters);
    state.nextListQuery = { records: [searchFixtures.records[1]] };
    const searchLater = await search({ status: "all", tags: ["work"], continuation: searchToken });
    assert.deepEqual(searchLater.result.structuredContent.records.map(record => record.id), ["Reminder/SEARCH-WORK"]);

    state.nextListQuery = { records: [], continuationMarker: "search-relation-error-next" };
    const relationErrorFirst = await search({ status: "all", tags: ["missing-value"] });
    const relationErrorToken = relationErrorFirst.result.structuredContent.continuation;
    const missingReminder = searchReminderRecord("Reminder/SEARCH-MISSING", "missing relation", { tags: [searchRelationIds.missing] });
    state.records.set(missingReminder.recordName, missingReminder);
    state.nextListQuery = { records: [missingReminder] };
    const missingRelation = await search({ status: "all", tags: ["missing-value"], continuation: relationErrorToken });
    assert.equal(missingRelation.result.structuredContent.error.code, "CONFLICT");
    state.records.set(`Hashtag/${searchRelationIds.missing}`, searchHashtag(searchRelationIds.missing, missingReminder.recordName, "missing-value"));
    state.nextListQuery = { records: [missingReminder] };
    const relationRetry = await search({ status: "all", tags: ["missing-value"], continuation: relationErrorToken });
    assert.deepEqual(relationRetry.result.structuredContent.records.map(record => record.id), ["Reminder/SEARCH-MISSING"]);
    const collectionArguments = { expectedGeneration: generation, view: "all", timeZone: "Europe/London",
      referenceInstant: "2026-10-13T12:00:00Z", sortBy: "title", filters: { listId: searchListId, status: "all" } };
    state.nextListQuery = { records: [searchFixtures.records[1], searchFixtures.records[0]] };
    const collectionReply = await mcp("tools/call", { name: "get_reminder_view", arguments: collectionArguments });
    assert.equal(collectionReply.result.isError, undefined, JSON.stringify(collectionReply.result));
    const collection = collectionReply.result.structuredContent;
    assert.equal(collection.complete, true);
    assert.equal(collection.records.length, 2);
    assert.deepEqual(collection.records.map(record => record.title), [...collection.records.map(record => record.title)].sort());
    assert.equal(collection.consistency, "live-pages-not-snapshot");
    state.nextListQuery = { records: [searchFixtures.records[0]] };
    const exported = await mcp("tools/call", { name: "export_reminders", arguments: { ...collectionArguments, format: "csv" } });
    assert.equal(exported.result.isError, undefined, JSON.stringify(exported.result));
    assert.equal(exported.result.structuredContent.count, 1);
    assert.ok(exported.result.structuredContent.content.startsWith('"id","listId","title"'));

    const savedFilterId = randomUUID();
    const savedFilter = await mcp("tools/call", { name: "save_reminder_filter", arguments: { filterId: savedFilterId, name: "Synthetic sorted view",
      definition: { view: "all", timeZone: "Europe/London", sortBy: "title", filters: collectionArguments.filters } } });
    assert.equal(savedFilter.result.isError, undefined, JSON.stringify(savedFilter.result));
    assert.equal(savedFilter.result.structuredContent.revision, 1);
    const filterList = await mcp("tools/call", { name: "get_reminder_filters", arguments: {} });
    assert.equal(filterList.result.structuredContent.filters[0].filterId, savedFilterId);
    state.nextListQuery = { records: [searchFixtures.records[0]] };
    const filterRun = await mcp("tools/call", { name: "run_reminder_filter", arguments: { filterId: savedFilterId, referenceInstant: collectionArguments.referenceInstant, expectedGeneration: generation } });
    assert.equal(filterRun.result.isError, undefined, JSON.stringify(filterRun.result));
    assert.equal(filterRun.result.structuredContent.records.length, 1);
    const deleteSaved = await mcp("tools/call", { name: "delete_reminder_filter", arguments: { filterId: savedFilterId, expectedRevision: 1 } });
    assert.equal(deleteSaved.result.structuredContent.deleted, true);

    state.records.delete(searchListId);
    for (const record of [...searchFixtures.records, ...searchFixtures.related, missingReminder, unclassifiedURLReminder, unclassifiedURLAttachment,
      unclassifiedPNGReminder, unclassifiedPNGAttachment]) state.records.delete(record.recordName);

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
    const listBeforeCreate = state.records.get(listId);
    listBeforeCreate.fields.SyntheticFutureListField = field("STRING", "preserve-this-list-field");
    const tokenMapBeforeCreate = JSON.parse(listBeforeCreate.fields.ResolutionTokenMap.value);
    tokenMapBeforeCreate.map.syntheticUnrelatedToken = { counter: 2, modificationTime: 757_382_399, replicaID: "4e6cb834-5b1c-4ce6-8c39-00e752121111" };
    listBeforeCreate.fields.ResolutionTokenMap = field("STRING", JSON.stringify(tokenMapBeforeCreate));
    const listFieldsBeforeCreate = structuredClone(listBeforeCreate.fields);
    const createArgs = { listId, idempotencyKey: createKey, title: "Café 🧭 — 東京", notes: "Keep this note 🌿", priority: 1, flagged: true };
    const created = await mcp("tools/call", { name: "create_reminder", arguments: createArgs });
    assert.equal(created.result.isError, undefined, JSON.stringify(created.result.structuredContent));
    assert.equal(created.result.structuredContent.operation, "create");
    assert.equal(created.result.structuredContent.record.title, createArgs.title);
    assert.equal(created.result.structuredContent.record.notes, createArgs.notes);
    assert.equal(created.result.structuredContent.replayed, false);
    assert.equal(state.modifies.length, 1);
    assert.equal(state.modifies[0].recordName, `Reminder/${createKey.toUpperCase()}`);
    assert.equal(state.modifies[0].atomicCreationGroup, true); assert.equal(state.modifies[0].operationCount, 2);
    assert.deepEqual(JSON.parse(state.records.get(listId).fields.ReminderIDs.value),
      [...JSON.parse(listFieldsBeforeCreate.ReminderIDs.value), createKey.toUpperCase()], "Creation appends after existing List members.");
    const tokensAfterCreate = JSON.parse(state.records.get(listId).fields.ResolutionTokenMap.value).map;
    const tokensBeforeCreate = JSON.parse(listFieldsBeforeCreate.ResolutionTokenMap.value).map;
    assert.deepEqual(Object.keys(tokensAfterCreate).sort(), Object.keys(tokensBeforeCreate).sort());
    assert.equal(tokensAfterCreate.reminderIDsMergeableOrdering.counter, tokensBeforeCreate.reminderIDsMergeableOrdering.counter + 1);
    assert.deepEqual(tokensAfterCreate.syntheticUnrelatedToken, tokensBeforeCreate.syntheticUnrelatedToken);
    assert.equal(state.records.get(listId).fields.SyntheticFutureListField.value, "preserve-this-list-field");
    assert.equal(state.records.get(listId).fields.Name.value, listFieldsBeforeCreate.Name.value);
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
    beforeEdit.fields.UrgentPresentationAlarmsAsData = field("ASSETID", { downloadURL: "https://synthetic.invalid/old", wrappingKey: "synthetic-key", fileChecksum: "synthetic-checksum", size: 10 });
    state.nextModify = "signed-asset-url-drift";
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
    assert.equal(deleteReply.result.structuredContent.record.listId, null);
    await repeatLifecycle("delete_reminder", deleteTarget);
    const deletedLookup = await mcp("tools/call", { name: "get_reminder", arguments: { listId, reminderId: lifecycleId } });
    assert.equal(deletedLookup.result.structuredContent.record.deleted, true);
    const missingLookup = await mcp("tools/call", { name: "get_reminder", arguments: { listId, reminderId: "Reminder/READ-MISSING" } });
    assert.deepEqual(missingLookup.result.structuredContent, { generation, record: null, missing: true });
    state.records.set("List/READ-OTHER", { ...listRecord(), recordName: "List/READ-OTHER" });
    const wrongList = await mcp("tools/call", { name: "get_reminder", arguments: { listId: "List/READ-OTHER", reminderId: lifecycleId } });
    assert.equal(wrongList.result.structuredContent.record.listId, null, "Detached deleted records do not invent a relationship to an independently authorized requested List.");
    state.records.delete("List/READ-OTHER");
    assert.deepEqual(state.modifies.at(-1).fields, ["Deleted", "LastModifiedDate", "List", "ResolutionTokenMap"]);
    assert.equal(state.modifies.at(-1).operationType, "update");
    const beforeLifecycleRefusal = state.modifies.length;
    for (const id of ["Reminder/WRITE-RECURRING", "Reminder/WRITE-ALARMED"]) {
      const refused = await mcp("tools/call", { name: "complete_reminder", arguments: { listId, reminderId: id, recordChangeTag: state.records.get(id).recordChangeTag } });
      assert.equal(refused.result.structuredContent.error.code, id.endsWith("WRITE-ALARMED") ? "CONFLICT" : "UNSUPPORTED_FEATURE");
    }
    const child = reminderRecord("Reminder/WRITE-SUBTASK");
    child.fields.ParentReminder = field("REFERENCE", { recordName: reminderId, action: "VALIDATE" });
    state.records.set(child.recordName, child);
    const deeper = reminderRecord("Reminder/WRITE-DEEP");
    deeper.fields.ParentReminder = field("REFERENCE", { recordName: child.recordName, action: "VALIDATE" });
    state.records.set(deeper.recordName, deeper);
    const nestedRefused = await mcp("tools/call", { name: "delete_reminder", arguments: { listId, reminderId: child.recordName, recordChangeTag: child.recordChangeTag } });
    assert.equal(nestedRefused.result.structuredContent.error.code, "UNSUPPORTED_FEATURE");
    state.records.delete(child.recordName);
    state.records.delete(deeper.recordName);
    assert.equal(state.modifies.length, beforeLifecycleRefusal);

    // One mixed family journey exercises the public lifecycle API and atomic dependency races.
    const familyParent = reminderRecord("Reminder/FAMILY-PARENT");
    const familyChild = reminderRecord("Reminder/FAMILY-CHILD");
    const independentChild = reminderRecord("Reminder/FAMILY-INDEPENDENT");
    for (const child of [familyChild, independentChild]) child.fields.ParentReminder = field("REFERENCE", { recordName: familyParent.recordName, action: "VALIDATE" });
    const earlierCompletion = Date.parse("2028-01-02T03:04:05.000Z");
    independentChild.fields.Completed = field("INT64", 1);
    independentChild.fields.CompletionDate = field("TIMESTAMP", earlierCompletion);
    for (const record of [familyParent, familyChild, independentChild]) state.records.set(record.recordName, record);
    const familyList = state.records.get(listId);
    const previousMembership = JSON.parse(familyList.fields.ReminderIDs.value);
    const familyMembers = [familyParent, familyChild, independentChild].map(record => record.recordName.slice("Reminder/".length));
    familyList.fields.ReminderIDs = field("STRING", JSON.stringify([...previousMembership, ...familyMembers]));
    const familyTarget = id => ({ listId, reminderId: id, recordChangeTag: state.records.get(id).recordChangeTag });
    const beforeFamilyInspection = state.modifies.length;
    const familyInspection = await mcp("tools/call", { name: "inspect_reminder", arguments: { listId, reminderId: familyParent.recordName, expectedGeneration: generation } });
    assert.equal(familyInspection.result.isError, undefined, JSON.stringify(familyInspection.result));
    const familyDetails = familyInspection.result.structuredContent;
    assert.equal(familyDetails.subtasks.status, "known");
    assert.deepEqual(familyDetails.subtasks.familyIds, [familyParent.recordName, familyChild.recordName, independentChild.recordName]);
    assert.equal(familyDetails.actions.complete.status, "supported");
    assert.deepEqual(familyDetails.actions.complete.affectedReminderIds, [familyParent.recordName, familyChild.recordName]);
    assert.equal(familyDetails.actions.move.status, "unsupported");
    assert.equal(state.modifies.length, beforeFamilyInspection, "Inspection cannot dispatch a native family mutation.");
    for (const race of ["family-child-race", "family-list-race"]) {
      state.nextModify = race;
      const before = state.modifies.length;
      const rejected = await mcp("tools/call", { name: "complete_reminder", arguments: familyTarget(familyParent.recordName) });
      assert.equal(rejected.result.structuredContent.error.code, "CONFLICT");
      assert.equal(state.modifies.length, before + 1);
      assert.equal(state.records.get(familyParent.recordName).fields.Completed.value, 0);
      assert.equal(state.records.get(familyChild.recordName).fields.Completed.value, 0);
    }
    const beforeLaggingFamilyRead = state.requests.length;
    state.nextListQuery = { records: [familyParent, independentChild] };
    const familyComplete = await mcp("tools/call", { name: "complete_reminder", arguments: familyTarget(familyParent.recordName) });
    assert.deepEqual(familyComplete.result.structuredContent.affectedRecords.map(record => record.id), [familyParent.recordName, familyChild.recordName]);
    const familyReadRequests = state.requests.slice(beforeLaggingFamilyRead);
    const exactFamilyLookupIds = familyReadRequests.filter(request => request.path.endsWith("/records/lookup"))
      .flatMap(request => request.body.records.map(record => record.recordName));
    assert.ok(exactFamilyLookupIds.includes(familyChild.recordName), "Exact List membership resolves a committed child omitted by the lagging compound query.");
    assert.deepEqual(JSON.parse(familyList.fields.ReminderIDs.value), [...previousMembership, ...familyMembers], "Family completion preserves native List ordering.");
    const familyCompletion = state.records.get(familyParent.recordName).fields.CompletionDate.value;
    assert.equal(state.records.get(familyChild.recordName).fields.CompletionDate.value, familyCompletion);
    assert.equal(state.records.get(independentChild.recordName).fields.CompletionDate.value, earlierCompletion);
    assert.equal(state.records.get(familyChild.recordName).fields.ParentReminder.value.recordName, familyParent.recordName);
    assert.equal(state.records.get(familyChild.recordName).fields.TitleDocument.value, familyChild.fields.TitleDocument.value);
    state.nextModify = "family-parent-race";
    const childParentRace = await mcp("tools/call", { name: "reopen_reminder", arguments: familyTarget(familyChild.recordName) });
    assert.equal(childParentRace.result.structuredContent.error.code, "CONFLICT");
    assert.equal(state.records.get(familyChild.recordName).fields.Completed.value, 1);
    const childReopened = await mcp("tools/call", { name: "reopen_reminder", arguments: familyTarget(familyChild.recordName) });
    assert.deepEqual(childReopened.result.structuredContent.affectedRecords.map(record => record.id), [familyChild.recordName]);
    assert.equal(state.records.get(familyParent.recordName).fields.Completed.value, 1);
    const childCompleted = await mcp("tools/call", { name: "complete_reminder", arguments: familyTarget(familyChild.recordName) });
    assert.equal(childCompleted.result.structuredContent.record.completed, true);
    assert.equal(state.records.get(familyParent.recordName).fields.CompletionDate.value, familyCompletion);
    // Independent re-completion receives another timestamp and is preserved by root reopening.
    const independentChildCompletion = state.records.get(familyChild.recordName).fields.CompletionDate.value;
    assert.notEqual(independentChildCompletion, familyCompletion);
    const reopenedFamily = await mcp("tools/call", { name: "reopen_reminder", arguments: familyTarget(familyParent.recordName) });
    assert.deepEqual(reopenedFamily.result.structuredContent.affectedRecords.map(record => record.id), [familyParent.recordName]);
    assert.equal(state.records.get(familyChild.recordName).fields.CompletionDate.value, independentChildCompletion);
    assert.equal(state.records.get(independentChild.recordName).fields.CompletionDate.value, earlierCompletion);
    await mcp("tools/call", { name: "reopen_reminder", arguments: familyTarget(familyChild.recordName) });
    await mcp("tools/call", { name: "complete_reminder", arguments: familyTarget(familyParent.recordName) });
    const selectiveReopen = await mcp("tools/call", { name: "reopen_reminder", arguments: familyTarget(familyParent.recordName) });
    assert.deepEqual(selectiveReopen.result.structuredContent.affectedRecords.map(record => record.id), [familyParent.recordName, familyChild.recordName]);
    assert.equal(selectiveReopen.result.structuredContent.record.completed, false);
    const beforeIncompleteFamily = state.modifies.length;
    state.nextListQuery = { records: [{ recordName: familyChild.recordName, serverErrorCode: "UNKNOWN_ERROR" }] };
    const incompleteFamily = await mcp("tools/call", { name: "complete_reminder", arguments: familyTarget(familyParent.recordName) });
    assert.equal(incompleteFamily.result.structuredContent.error.code, "UNSUPPORTED_FEATURE");
    assert.equal(state.modifies.length, beforeIncompleteFamily);
    for (const mode of ["family-added-parent", "family-added-alarm", "family-added-recurrence", "family-added-unknown-relationship"]) {
      state.nextModify = mode;
      const before = state.modifies.length, submitted = familyTarget(familyParent.recordName);
      const uncertain = await mcp("tools/call", { name: "complete_reminder", arguments: submitted });
      assert.equal(uncertain.result.structuredContent.error.code, "WRITE_OUTCOME_UNKNOWN");
      assert.equal(state.modifies.length, before + 1, "Unexpected receipt relationships must never cause another dispatch.");
      const repeated = await mcp("tools/call", { name: "complete_reminder", arguments: submitted });
      assert.equal(repeated.result.structuredContent.error.code, "CONFLICT");
      assert.equal(state.modifies.length, before + 1);
      const observed = await mcp("tools/call", { name: "get_reminder", arguments: { listId, reminderId: familyParent.recordName } });
      assert.equal(observed.result.structuredContent.record.completed, true);
      await mcp("tools/call", { name: "reopen_reminder", arguments: familyTarget(familyParent.recordName) });
    }
    state.nextModify = "family-added-empty-relationships";
    const emptyRelationships = await mcp("tools/call", { name: "complete_reminder", arguments: familyTarget(familyParent.recordName) });
    assert.equal(emptyRelationships.result.isError, undefined, JSON.stringify(emptyRelationships.result));
    assert.equal(emptyRelationships.result.structuredContent.record.parentReminderId, null);
    assert.deepEqual(emptyRelationships.result.structuredContent.record.alarmIds, []);
    assert.deepEqual(emptyRelationships.result.structuredContent.record.recurrenceRuleIds, []);
    await mcp("tools/call", { name: "reopen_reminder", arguments: familyTarget(familyParent.recordName) });
    // Native deletion detaches the direct target and removes only its membership;
    // descendants in a root cascade retain their links and completion/token history.
    const independentBeforeDelete = structuredClone(state.records.get(independentChild.recordName));
    for (const race of ["family-parent-race", "family-child-race", "family-list-race"]) {
      state.nextModify = race;
      const before = state.modifies.length;
      const rejected = await mcp("tools/call", { name: "delete_reminder", arguments: familyTarget(independentChild.recordName) });
      assert.equal(rejected.result.structuredContent.error.code, "CONFLICT");
      assert.equal(state.modifies.length, before + 1);
      assert.equal(state.records.get(independentChild.recordName).fields.Deleted.value, 0);
    }
    for (const mode of ["family-delete-read-tag-drift", "family-delete-read-field-drift", "family-delete-read-failure", "family-delete-read-hashtag-introduction"]) {
      const id = `Reminder/${mode.toUpperCase()}`, probe = reminderRecord(id);
      probe.parent = { recordName: listId };
      probe.fields.ParentReminder = field("REFERENCE", { recordName: familyParent.recordName, action: "VALIDATE" });
      if (mode === "family-delete-read-hashtag-introduction") probe.fields.HashtagIDs = field("UNKNOWN_LIST", []);
      state.records.set(id, probe);
      const submitted = familyTarget(id), before = state.modifies.length;
      state.nextModify = mode;
      const unknown = await mcp("tools/call", { name: "delete_reminder", arguments: submitted });
      assert.equal(unknown.result.structuredContent.error.code, "WRITE_OUTCOME_UNKNOWN");
      assert.equal(state.modifies.length, before + 1);
      const repeated = await mcp("tools/call", { name: "delete_reminder", arguments: submitted });
      assert.equal(repeated.result.structuredContent.error.code, "CONFLICT");
      assert.equal(state.modifies.length, before + 1);
      if (mode === "family-delete-read-hashtag-introduction") {
        const observed = await mcp("tools/call", { name: "get_reminder", arguments: { listId, reminderId: id } });
        assert.deepEqual(observed.result.structuredContent.record.hashtagIds, ["Hashtag/UNEXPECTED"], "The otherwise matching exact reread retains the introduced relationship, so success must still be refused.");
      }
      state.records.delete(id);
    }
    const guardReceiptTargetId = "Reminder/FAMILY-GUARD-RECEIPT-TARGET";
    const guardReceiptTarget = reminderRecord(guardReceiptTargetId);
    guardReceiptTarget.fields.ParentReminder = field("REFERENCE", { recordName: familyParent.recordName, action: "VALIDATE" });
    state.records.set(guardReceiptTargetId, guardReceiptTarget);
    state.records.get(listId).fields.ReminderIDs = field("STRING", JSON.stringify([...JSON.parse(state.records.get(listId).fields.ReminderIDs.value), guardReceiptTargetId]));
    const submittedGuardDelete = familyTarget(guardReceiptTargetId), beforeGuardReceipt = state.modifies.length;
    state.nextModify = "family-changed-guard-intrinsic-parent";
    const guardReceiptUnknown = await mcp("tools/call", { name: "delete_reminder", arguments: submittedGuardDelete });
    assert.equal(guardReceiptUnknown.result.structuredContent.error.code, "WRITE_OUTCOME_UNKNOWN");
    assert.equal(state.modifies.length, beforeGuardReceipt + 1);
    const guardReceiptRead = await mcp("tools/call", { name: "get_reminder", arguments: { listId, reminderId: guardReceiptTargetId } });
    assert.equal(guardReceiptRead.result.structuredContent.record.deleted, true);
    const guardReceiptRepeat = await mcp("tools/call", { name: "delete_reminder", arguments: submittedGuardDelete });
    assert.equal(guardReceiptRepeat.result.structuredContent.error.code, "CONFLICT");
    assert.equal(state.modifies.length, beforeGuardReceipt + 1, "Changed guard parent receipts must never cause another dispatch.");
    state.records.delete(guardReceiptTargetId);
    state.records.get(independentChild.recordName).parent = { recordName: listId };
    state.nextModify = "family-delete-read-settled";
    const directDeleted = await mcp("tools/call", { name: "delete_reminder", arguments: familyTarget(independentChild.recordName) });
    assert.equal(directDeleted.result.isError, undefined, JSON.stringify(directDeleted.result));
    assert.equal(directDeleted.result.structuredContent.record.listId, null);
    assert.equal(directDeleted.result.structuredContent.record.parentReminderId, null);
    assert.equal(directDeleted.result.structuredContent.record.completed, true);
    assert.equal(state.records.get(independentChild.recordName).fields.CompletionDate.value, earlierCompletion);
    const tokensBeforeDirect = JSON.parse(independentBeforeDelete.fields.ResolutionTokenMap.value).map;
    const tokensAfterDirect = JSON.parse(state.records.get(independentChild.recordName).fields.ResolutionTokenMap.value).map;
    for (const token of ["completed", "completionDate", "deleted"]) assert.deepEqual(tokensAfterDirect[token], tokensBeforeDirect[token]);
    assert.deepEqual(JSON.parse(state.records.get(listId).fields.ReminderIDs.value), [...previousMembership, familyParent.recordName.slice("Reminder/".length), familyChild.recordName.slice("Reminder/".length)]);
    await mcp("tools/call", { name: "complete_reminder", arguments: familyTarget(familyChild.recordName) });
    const cascadeChildBefore = structuredClone(state.records.get(familyChild.recordName));
    state.nextModify = "family-child-race";
    const staleCascade = await mcp("tools/call", { name: "delete_reminder", arguments: familyTarget(familyParent.recordName) });
    assert.equal(staleCascade.result.structuredContent.error.code, "CONFLICT");
    assert.equal(state.records.get(familyParent.recordName).fields.Deleted.value, 0);
    const submittedDelete = familyTarget(familyParent.recordName), beforeLostDelete = state.modifies.length;
    state.nextModify = "committed-network-drop";
    const unknownDelete = await mcp("tools/call", { name: "delete_reminder", arguments: submittedDelete });
    assert.equal(unknownDelete.result.structuredContent.error.code, "WRITE_OUTCOME_UNKNOWN");
    assert.equal(state.modifies.length, beforeLostDelete + 1);
    const detachedRead = await mcp("tools/call", { name: "get_reminder", arguments: { listId, reminderId: familyParent.recordName } });
    assert.equal(detachedRead.result.structuredContent.missing, false);
    assert.equal(detachedRead.result.structuredContent.record.listId, null);
    assert.equal(detachedRead.result.structuredContent.record.deleted, true);
    const cascadedRead = await mcp("tools/call", { name: "get_reminder", arguments: { listId, reminderId: familyChild.recordName } });
    assert.equal(cascadedRead.result.structuredContent.record.deleted, true);
    assert.equal(cascadedRead.result.structuredContent.record.listId, listId);
    assert.equal(cascadedRead.result.structuredContent.record.parentReminderId, familyParent.recordName);
    for (const key of ["Completed", "CompletionDate", "LastModifiedDate", "ResolutionTokenMap"]) assert.deepEqual(state.records.get(familyChild.recordName).fields[key], cascadeChildBefore.fields[key]);
    assert.deepEqual(JSON.parse(state.records.get(listId).fields.ReminderIDs.value), [...previousMembership, familyChild.recordName.slice("Reminder/".length)]);
    const repeatDeleted = await mcp("tools/call", { name: "delete_reminder", arguments: submittedDelete });
    assert.equal(repeatDeleted.result.structuredContent.error.code, "CONFLICT");
    assert.equal(state.modifies.length, beforeLostDelete + 1, "Read-only deletion reconciliation and stale replay must never dispatch again.");
    for (const record of [familyParent, familyChild, independentChild]) state.records.delete(record.recordName);
    state.records.get(listId).fields.ReminderIDs = field("STRING", JSON.stringify(previousMembership));

    const seedScheduledFamily = (suffix, rootAlarm = true, thirdAlarm = false) => {
      const root = reminderRecord(`Reminder/SCHEDULED-${suffix}-PARENT`), child = reminderRecord(`Reminder/SCHEDULED-${suffix}-CHILD`), independent = reminderRecord(`Reminder/SCHEDULED-${suffix}-INDEPENDENT`);
      root.parent = child.parent = independent.parent = { recordName: listId };
      for (const record of [child, independent]) record.fields.ParentReminder = field("REFERENCE", { recordName: root.recordName, action: "VALIDATE" });
      independent.fields.Completed = field("INT64", 1); independent.fields.CompletionDate = field("TIMESTAMP", earlierCompletion);
      const pairs = [];
      const datedMembers = [...(rootAlarm ? [[root, "2030-10-19T08:00:00Z"]] : []), [child, "2030-10-20T09:00:00Z"], ...(thirdAlarm ? [[independent, "2030-10-21T10:00:00Z"]] : [])];
      for (const [record, due] of datedMembers) {
        record.fields.DueDate = field("TIMESTAMP", Date.parse(due)); record.fields.TimeZone = field("STRING", "Europe/London"); record.fields.AllDay = field("INT64", 0);
        record.fields.UrgentPresentationAlarmsAsData = field("ASSETID", { downloadURL: "https://synthetic.invalid/one", wrappingKey: "synthetic-key", fileChecksum: "checksum", size: 1 });
        const tokens = JSON.parse(record.fields.ResolutionTokenMap.value); tokens.map.dueDate = { counter: 1, modificationTime: 1_700_000_000, replicaID: randomUUID() }; record.fields.ResolutionTokenMap = field("STRING", JSON.stringify(tokens));
        const alarmId = `Alarm/${randomUUID().toUpperCase()}`, triggerId = `AlarmTrigger/${randomUUID().toUpperCase()}`; record.fields.AlarmIDs = field("STRING_LIST", [alarmId]);
        pairs.push({ recordName: alarmId, recordType: "Alarm", recordChangeTag: `tag-${alarmId}`, zoneID: record.zoneID, parent: { recordName: record.recordName }, fields: {
          AlarmUID: field("STRING", alarmId.slice(6)), TriggerID: field("STRING", triggerId.slice(13)), DueDateResolutionTokenAsNonce: field("DOUBLE", dueDateNonce(record.fields.ResolutionTokenMap.value)),
          Reminder: field("REFERENCE", { recordName: record.recordName, action: "VALIDATE", zoneID: record.zoneID }), Imported: field("INT64", 0), Deleted: field("INT64", 0),
        } }, { recordName: triggerId, recordType: "AlarmTrigger", recordChangeTag: `tag-${triggerId}`, zoneID: record.zoneID, parent: { recordName: alarmId }, fields: {
          DateComponentsData: field("BYTES", Buffer.from(JSON.stringify(dateComponents(due, "Europe/London"))).toString("base64")), Type: field("STRING", "Date"),
          Alarm: field("REFERENCE", { recordName: alarmId, action: "VALIDATE", zoneID: record.zoneID }), Imported: field("INT64", 0), Deleted: field("INT64", 0),
        } });
      }
      for (const record of [root, child, independent, ...pairs]) state.records.set(record.recordName, record);
      const list = state.records.get(listId); list.fields.ReminderIDs = field("STRING", JSON.stringify([...JSON.parse(list.fields.ReminderIDs.value), root.recordName, child.recordName, independent.recordName]));
      return { root, child, independent, pairs, args: record => ({ listId, reminderId: record.recordName, recordChangeTag: state.records.get(record.recordName).recordChangeTag, expectedGeneration: generation }) };
    };
    const scheduled = seedScheduledFamily("JOURNEY"), beforeScheduled = state.modifies.length;
    for (const race of ["scheduled-member-race", "scheduled-pair-race", "scheduled-list-race"]) {
      const before = state.modifies.length; state.nextModify = race;
      const rejected = await mcp("tools/call", { name: "complete_reminder", arguments: scheduled.args(scheduled.root) });
      assert.equal(rejected.result.structuredContent.error.code, "CONFLICT"); assert.equal(state.modifies.length, before + 1);
      assert.equal(state.records.get(scheduled.root.recordName).fields.Completed.value, 0); assert.equal(state.modifies.at(-1).operationCount, 8);
    }
    state.nextListQuery = { records: [{ recordName: scheduled.child.recordName, serverErrorCode: "UNKNOWN_ERROR" }] };
    const incompleteScheduled = await mcp("tools/call", { name: "complete_reminder", arguments: scheduled.args(scheduled.root) });
    assert.equal(incompleteScheduled.result.structuredContent.error.code, "UNSUPPORTED_FEATURE"); assert.equal(state.modifies.length, beforeScheduled + 3);
    state.foreignZoneIds.add(scheduled.pairs[0].recordName);
    const foreignScheduledPair = await mcp("tools/call", { name: "complete_reminder", arguments: scheduled.args(scheduled.root) });
    assert.equal(foreignScheduledPair.result.isError, true); assert.equal(state.modifies.length, beforeScheduled + 3); state.foreignZoneIds.delete(scheduled.pairs[0].recordName);
    const scheduledSource = state.records.get(scheduled.root.recordName);
    scheduledSource.fields.UnknownScheduledRelationship = field("REFERENCE", { recordName: scheduled.child.recordName, action: "VALIDATE" });
    const unknownScheduledGraph = await mcp("tools/call", { name: "complete_reminder", arguments: scheduled.args(scheduled.root) });
    assert.equal(unknownScheduledGraph.result.structuredContent.error.code, "UNSUPPORTED_FEATURE"); assert.equal(state.modifies.length, beforeScheduled + 3); delete scheduledSource.fields.UnknownScheduledRelationship;
    const extraScheduled = Array.from({ length: 10 }, (_, index) => {
      const record = structuredClone(scheduled.child); record.recordName = `Reminder/SCHEDULED-EXTRA-${index}`; record.fields.AlarmIDs = field("STRING_LIST", [`Alarm/${randomUUID().toUpperCase()}`]); state.records.set(record.recordName, record); return record;
    });
    const oversizedScheduled = await mcp("tools/call", { name: "complete_reminder", arguments: scheduled.args(scheduled.root) });
    assert.equal(oversizedScheduled.result.structuredContent.error.code, "UNSUPPORTED_FEATURE"); assert.equal(state.modifies.length, beforeScheduled + 3);
    for (const record of extraScheduled) state.records.delete(record.recordName);
    const pairFields = scheduled.pairs.map(record => structuredClone(state.records.get(record.recordName).fields));
    const scheduledCompleted = await mcp("tools/call", { name: "complete_reminder", arguments: scheduled.args(scheduled.root) });
    assert.equal(scheduledCompleted.result.isError, undefined, JSON.stringify(scheduledCompleted.result));
    assert.deepEqual(scheduledCompleted.result.structuredContent.affectedRecords.map(record => record.id), [scheduled.root.recordName, scheduled.child.recordName]);
    const scheduledTimestamp = state.records.get(scheduled.root.recordName).fields.CompletionDate.value;
    assert.equal(state.records.get(scheduled.child.recordName).fields.CompletionDate.value, scheduledTimestamp); assert.equal(state.records.get(scheduled.independent.recordName).fields.CompletionDate.value, earlierCompletion);
    const scheduledReopened = await mcp("tools/call", { name: "reopen_reminder", arguments: scheduled.args(scheduled.root) });
    assert.equal(scheduledReopened.result.isError, undefined, JSON.stringify(scheduledReopened.result));
    assert.deepEqual(scheduledReopened.result.structuredContent.affectedRecords.map(record => record.id), [scheduled.root.recordName, scheduled.child.recordName]);
    await mcp("tools/call", { name: "complete_reminder", arguments: scheduled.args(scheduled.root) });
    const independentDatedReopen = await mcp("tools/call", { name: "reopen_reminder", arguments: scheduled.args(scheduled.child) });
    assert.equal(independentDatedReopen.result.isError, undefined, JSON.stringify(independentDatedReopen.result));
    assert.deepEqual(independentDatedReopen.result.structuredContent.affectedRecords.map(record => record.id), [scheduled.child.recordName]); assert.equal(state.records.get(scheduled.root.recordName).fields.Completed.value, 1);
    const childLostArgs = scheduled.args(scheduled.child), beforeChildLost = state.modifies.length; state.nextModify = "committed-500";
    const scheduledChildLost = await mcp("tools/call", { name: "complete_reminder", arguments: childLostArgs });
    assert.equal(scheduledChildLost.result.structuredContent.error.code, "WRITE_OUTCOME_UNKNOWN"); assert.equal(state.modifies.length, beforeChildLost + 1);
    const readScheduledChild = await mcp("tools/call", { name: "get_reminder", arguments: { listId, reminderId: scheduled.child.recordName } });
    assert.equal(readScheduledChild.result.structuredContent.record.completed, true);
    const originalScheduledRetry = await mcp("tools/call", { name: "complete_reminder", arguments: childLostArgs });
    assert.equal(originalScheduledRetry.result.structuredContent.error.code, "CONFLICT"); assert.equal(state.modifies.length, beforeChildLost + 1);
    const selectiveScheduled = await mcp("tools/call", { name: "reopen_reminder", arguments: scheduled.args(scheduled.root) });
    assert.deepEqual(selectiveScheduled.result.structuredContent.affectedRecords.map(record => record.id), [scheduled.root.recordName]); assert.equal(state.records.get(scheduled.child.recordName).fields.Completed.value, 1);
    for (const mode of ["scheduled-crypto-drift", "scheduled-parent-drift"]) {
      const probe = seedScheduledFamily(mode), before = state.modifies.length, args = probe.args(probe.root); state.nextModify = mode;
      const changedReceipt = await mcp("tools/call", { name: "complete_reminder", arguments: args });
      assert.equal(changedReceipt.result.structuredContent.error.code, "WRITE_OUTCOME_UNKNOWN"); assert.equal(state.modifies.length, before + 1);
      const originalRetry = await mcp("tools/call", { name: "complete_reminder", arguments: args });
      assert.equal(originalRetry.result.structuredContent.error.code, "CONFLICT"); assert.equal(state.modifies.length, before + 1);
    }
    assert.deepEqual(scheduled.pairs.map(record => state.records.get(record.recordName).fields), pairFields);
    const directScheduled = seedScheduledFamily("DIRECT", true, true), directArgs = directScheduled.args(directScheduled.child), beforeDirect = state.modifies.length;
    const beforeDirectRoot = structuredClone(state.records.get(directScheduled.root.recordName)), beforeDirectSibling = structuredClone(state.records.get(directScheduled.independent.recordName));
    const beforeDirectPairs = directScheduled.pairs.map(record => structuredClone(state.records.get(record.recordName)));
    state.nextModify = "committed-500";
    const directScheduledLost = await mcp("tools/call", { name: "delete_reminder", arguments: directArgs });
    assert.equal(directScheduledLost.result.structuredContent.error.code, "WRITE_OUTCOME_UNKNOWN"); assert.equal(state.modifies.length, beforeDirect + 1); assert.equal(state.modifies.at(-1).operationCount, 10);
    const deletedDatedChild = await mcp("tools/call", { name: "get_reminder", arguments: { listId, reminderId: directScheduled.child.recordName } });
    assert.equal(deletedDatedChild.result.structuredContent.record.deleted, true); assert.equal(deletedDatedChild.result.structuredContent.record.listId, null); assert.equal(deletedDatedChild.result.structuredContent.record.parentReminderId, null);
    const originalDirectRetry = await mcp("tools/call", { name: "delete_reminder", arguments: directArgs });
    assert.equal(originalDirectRetry.result.structuredContent.error.code, "CONFLICT"); assert.equal(state.modifies.length, beforeDirect + 1);
    const afterDirectRoot = state.records.get(directScheduled.root.recordName);
    assert.deepEqual(Object.fromEntries(Object.entries(afterDirectRoot.fields).filter(([key]) => !["LastModifiedDate", "ResolutionTokenMap"].includes(key))), Object.fromEntries(Object.entries(beforeDirectRoot.fields).filter(([key]) => !["LastModifiedDate", "ResolutionTokenMap"].includes(key))));
    assert.deepEqual(state.records.get(directScheduled.independent.recordName).fields, beforeDirectSibling.fields);
    for (const pair of beforeDirectPairs) {
      const selectedPair = pair.recordType === "Alarm" ? pair.fields.Reminder.value.recordName === directScheduled.child.recordName :
        beforeDirectPairs.find(alarm => alarm.recordName === pair.fields.Alarm.value.recordName).fields.Reminder.value.recordName === directScheduled.child.recordName;
      assert.deepEqual(state.records.get(pair.recordName).fields, { ...pair.fields, Deleted: field("INT64", selectedPair ? 1 : 0) });
      assert.deepEqual(state.records.get(pair.recordName).parent, pair.parent);
    }
    const undatedDeleteFamily = seedScheduledFamily("UNDATED-DELETE"), undatedPairFields = undatedDeleteFamily.pairs.map(record => structuredClone(record.fields));
    const deleteUndatedSibling = await mcp("tools/call", { name: "delete_reminder", arguments: undatedDeleteFamily.args(undatedDeleteFamily.independent) });
    assert.equal(deleteUndatedSibling.result.isError, undefined, JSON.stringify(deleteUndatedSibling.result));
    assert.deepEqual(deleteUndatedSibling.result.structuredContent.affectedRecords.map(record => record.id), [undatedDeleteFamily.independent.recordName, undatedDeleteFamily.root.recordName]);
    assert.deepEqual(undatedDeleteFamily.pairs.map(record => state.records.get(record.recordName).fields), undatedPairFields);
    const confirmedDatedChildDelete = await mcp("tools/call", { name: "delete_reminder", arguments: undatedDeleteFamily.args(undatedDeleteFamily.child) });
    assert.equal(confirmedDatedChildDelete.result.isError, undefined, JSON.stringify(confirmedDatedChildDelete.result));
    assert.equal(confirmedDatedChildDelete.result.structuredContent.record.listId, null); assert.equal(confirmedDatedChildDelete.result.structuredContent.record.parentReminderId, null);
    assert.deepEqual(confirmedDatedChildDelete.result.structuredContent.affectedRecords.map(record => record.id), [undatedDeleteFamily.child.recordName, undatedDeleteFamily.root.recordName]);

    state.omitLookupZoneIds.add(listId);
    const deletedScheduled = await mcp("tools/call", { name: "delete_reminder", arguments: scheduled.args(scheduled.root) });
    assert.equal(deletedScheduled.result.isError, undefined, JSON.stringify(deletedScheduled.result)); assert.equal(deletedScheduled.result.structuredContent.record.listId, null);
    assert.deepEqual(deletedScheduled.result.structuredContent.affectedRecords.map(record => record.id), [scheduled.root.recordName, scheduled.child.recordName, scheduled.independent.recordName]);
    for (const record of [scheduled.child, scheduled.independent]) {
      const deleted = state.records.get(record.recordName); assert.equal(deleted.fields.Deleted.value, 1); assert.equal(deleted.fields.List.value.recordName, listId); assert.equal(deleted.fields.ParentReminder.value.recordName, scheduled.root.recordName); assert.equal(deleted.parent.recordName, listId);
    }
    for (const [index, pair] of scheduled.pairs.entries()) assert.deepEqual(state.records.get(pair.recordName).fields, { ...pairFields[index], Deleted: field("INT64", 1) });
    const scheduledMembers = JSON.parse(state.records.get(listId).fields.ReminderIDs.value); assert.equal(scheduledMembers.includes(scheduled.root.recordName), false); assert.equal(scheduledMembers.includes(scheduled.child.recordName), true);
    state.omitLookupZoneIds.delete(listId);
    const unalarmedScheduled = seedScheduledFamily("UNALARMED-ROOT", false);
    const unalarmedParentComplete = await mcp("tools/call", { name: "complete_reminder", arguments: unalarmedScheduled.args(unalarmedScheduled.root) });
    assert.equal(unalarmedParentComplete.result.isError, undefined, JSON.stringify(unalarmedParentComplete.result)); assert.equal(state.modifies.at(-1).operationCount, 6);
    const unalarmedParentDelete = await mcp("tools/call", { name: "delete_reminder", arguments: unalarmedScheduled.args(unalarmedScheduled.root) });
    assert.equal(unalarmedParentDelete.result.isError, undefined, JSON.stringify(unalarmedParentDelete.result));

    const createListRaceArgs = { listId, idempotencyKey: randomUUID(), title: "List race" };
    state.nextModify = "family-list-race";
    const listRaceCreate = await mcp("tools/call", { name: "create_reminder", arguments: createListRaceArgs });
    assert.equal(listRaceCreate.result.structuredContent.error.code, "CONFLICT");
    assert.equal(state.records.has(`Reminder/${createListRaceArgs.idempotencyKey.toUpperCase()}`), false);

    const recurringId = "Reminder/RECURRING-ACTIVE", recurrenceId = "RecurrenceRule/RECURRING-ACTIVE";
    const recurring = reminderRecord(recurringId);
    recurring.parent = { recordName: listId };
    recurring.fields.RecurrenceRuleIDs = field("STRING_LIST", [recurrenceId]); recurring.fields.TitleDocument.type = "ENCRYPTED_BYTES";
    const recurringAlarmId = `Alarm/${randomUUID().toUpperCase()}`, recurringTriggerId = `AlarmTrigger/${randomUUID().toUpperCase()}`;
    recurring.fields.AlarmIDs = field("STRING_LIST", [recurringAlarmId]);
    recurring.fields.ResolutionTokenMap = field("STRING", JSON.stringify({ map: { dueDate: { counter: 1, modificationTime: 1_600_000_000, replicaID: randomUUID().toUpperCase() } } }));
    state.records.set(recurringId, recurring);
    state.records.set(recurringAlarmId, { recordName: recurringAlarmId, recordType: "Alarm", recordChangeTag: "recurring-alarm-before", zoneID: recurring.zoneID, fields: {
      AlarmUID: field("STRING", recurringAlarmId.slice(6)), TriggerID: field("STRING", recurringTriggerId.slice(13)),
      DueDateResolutionTokenAsNonce: field("DOUBLE", dueDateNonce(recurring.fields.ResolutionTokenMap.value)), Imported: field("INT64", 0), Deleted: field("INT64", 0),
      Reminder: field("REFERENCE", { recordName: recurringId, action: "VALIDATE", zoneID: recurring.zoneID }),
    } });
    state.records.set(recurringTriggerId, { recordName: recurringTriggerId, recordType: "AlarmTrigger", recordChangeTag: "recurring-trigger-before", zoneID: recurring.zoneID, fields: {
      DateComponentsData: field("BYTES", Buffer.from(JSON.stringify(dateComponents("2030-03-04T09:15:00.000Z", "Europe/London"))).toString("base64")),
      Type: field("STRING", "Date"), Imported: field("INT64", 0), Deleted: field("INT64", 0),
      Alarm: field("REFERENCE", { recordName: recurringAlarmId, action: "VALIDATE", zoneID: recurring.zoneID }),
    } });
    state.records.set(recurrenceId, { recordName: recurrenceId, recordType: "RecurrenceRule", recordChangeTag: "recurring-rule-before", zoneID: recurring.zoneID, fields: {
      Frequency: field("INT64", 1), Interval: field("INT64", 1), OccurrenceCount: field("INT64", 0), FirstDayOfTheWeek: field("INT64", 0),
      Imported: field("INT64", 0), Deleted: field("INT64", 0), Reminder: field("REFERENCE", { recordName: recurringId, action: "VALIDATE" }),
    } });
    const submittedOccurrence = { listId, reminderId: recurringId, recordChangeTag: recurring.recordChangeTag, expectedGeneration: generation };
    const beforeOccurrence = state.modifies.length;
    state.nextModify = "committed-500";
    const unknownOccurrence = await mcp("tools/call", { name: "complete_reminder", arguments: submittedOccurrence });
    assert.equal(unknownOccurrence.result.structuredContent.error.code, "WRITE_OUTCOME_UNKNOWN");
    assert.equal(state.modifies.length, beforeOccurrence + 1);
    const historyId = state.modifies.at(-1).historyId;
    assert.equal(state.records.get(historyId).fields.TitleDocument.value, recurring.fields.TitleDocument.value);
    assert.equal(state.records.get(historyId).fields.CreationDate.value, recurring.fields.CreationDate.value);
    const reconciledOccurrence = await mcp("tools/call", { name: "complete_reminder", arguments: submittedOccurrence });
    assert.equal(reconciledOccurrence.result.isError, undefined, JSON.stringify(reconciledOccurrence.result));
    assert.equal(reconciledOccurrence.result.structuredContent.replayed, true);
    assert.equal(reconciledOccurrence.result.structuredContent.record.completed, false);
    assert.equal(reconciledOccurrence.result.structuredContent.completedOccurrence.id, historyId);
    assert.equal(reconciledOccurrence.result.structuredContent.completedOccurrence.completed, true);
    assert.equal(reconciledOccurrence.result.structuredContent.record.dueDate, "2030-03-11T09:15:00.000Z");
    assert.equal(state.modifies.length, beforeOccurrence + 1);
    await mcp("tools/call", { name: "complete_reminder", arguments: submittedOccurrence });
    assert.equal(state.modifies.length, beforeOccurrence + 1);
    assert.equal(state.records.has(recurringAlarmId), false); assert.equal(state.records.has(recurringTriggerId), false);
    const nextOccurrenceResponse = await mcp("tools/call", { name: "complete_reminder", arguments: { ...submittedOccurrence, recordChangeTag: state.records.get(recurringId).recordChangeTag } });
    assert.equal(nextOccurrenceResponse.result.isError, undefined, JSON.stringify(nextOccurrenceResponse.result));
    const nextOccurrence = nextOccurrenceResponse.result.structuredContent;
    assert.equal(nextOccurrence.record.dueDate, "2030-03-18T09:15:00.000Z");
    assert.equal(nextOccurrence.completedOccurrence.completed, true);
    const foreignReferenceArgs = { ...submittedOccurrence, recordChangeTag: state.records.get(recurringId).recordChangeTag };
    const beforeForeignReference = state.modifies.length;
    state.nextModify = "recurring-related-reference-foreign";
    for (let attempt = 0; attempt < 2; attempt++) {
      const invalidRelatedReference = await mcp("tools/call", { name: "complete_reminder", arguments: foreignReferenceArgs });
      assert.equal(invalidRelatedReference.result.structuredContent.error.code, "WRITE_OUTCOME_UNKNOWN");
      assert.equal(state.modifies.length, beforeForeignReference + 1, "Foreign related references never cause recurring redispatch.");
    }

    for (const mode of ["recurring-history-parent-missing", "recurring-history-parent-wrong", "recurring-history-parent-foreign", "recurring-active-parent-missing", "recurring-active-parent-wrong"]) {
      const id = `Reminder/${mode.toUpperCase()}`, rule = `RecurrenceRule/${mode.toUpperCase()}`;
      const active = reminderRecord(id); active.parent = { recordName: listId };
      active.fields.RecurrenceRuleIDs = field("STRING_LIST", [rule]);
      state.records.set(id, active);
      state.records.set(rule, { ...state.records.get(recurrenceId), recordName: rule, recordChangeTag: `tag-${rule}`,
        fields: { ...state.records.get(recurrenceId).fields, Reminder: field("REFERENCE", { recordName: id, action: "VALIDATE" }) } });
      const args = { listId, reminderId: id, recordChangeTag: active.recordChangeTag, expectedGeneration: generation };
      const before = state.modifies.length;
      state.nextModify = mode;
      const invalidReceipt = await mcp("tools/call", { name: "complete_reminder", arguments: args });
      assert.equal(invalidReceipt.result.structuredContent.error.code, "WRITE_OUTCOME_UNKNOWN", mode);
      assert.equal(state.modifies.length, before + 1);
      const invalidReplay = await mcp("tools/call", { name: "complete_reminder", arguments: args });
      assert.equal(invalidReplay.result.structuredContent.error.code, "WRITE_OUTCOME_UNKNOWN", mode);
      assert.equal(state.modifies.length, before + 1, "Invalid intrinsic parents must never cause recurring redispatch.");
    }

    const seedEndedWeekly = (suffix, dueDate = "2030-10-28T09:15:00Z") => {
      const id = `Reminder/ENDED-WEEKLY-${suffix}`, ruleId = `RecurrenceRule/ENDED-WEEKLY-${suffix}`;
      const alarmId = `Alarm/${randomUUID().toUpperCase()}`, triggerId = `AlarmTrigger/${randomUUID().toUpperCase()}`;
      const active = structuredClone(recurring); active.recordName = id; active.recordChangeTag = `tag-${id}`;
      active.fields.DueDate = field("TIMESTAMP", Date.parse(dueDate)); active.fields.RecurrenceRuleIDs = field("STRING_LIST", [ruleId]); active.fields.AlarmIDs = field("STRING_LIST", [alarmId]);
      active.fields.UrgentPresentationAlarmsAsData = field("ASSETID", { downloadURL: "https://synthetic.invalid/one", fileChecksum: "synthetic-checksum", wrappingKey: "synthetic-key", referenceChecksum: "reference", size: 1 });
      const alarm = { recordName: alarmId, recordType: "Alarm", recordChangeTag: `tag-${alarmId}`, zoneID: active.zoneID, parent: { recordName: id }, fields: {
        AlarmUID: field("STRING", alarmId.slice(6)), TriggerID: field("STRING", triggerId.slice(13)), DueDateResolutionTokenAsNonce: field("DOUBLE", dueDateNonce(active.fields.ResolutionTokenMap.value)),
        Imported: field("INT64", 0), Deleted: field("INT64", 0), Reminder: field("REFERENCE", { recordName: id, action: "VALIDATE", zoneID: active.zoneID }),
      } };
      const trigger = { recordName: triggerId, recordType: "AlarmTrigger", recordChangeTag: `tag-${triggerId}`, zoneID: active.zoneID, parent: { recordName: alarmId }, fields: {
        DateComponentsData: field("BYTES", Buffer.from(JSON.stringify(dateComponents(dueDate, "Europe/London"))).toString("base64")),
        Type: field("STRING", "Date"), Imported: field("INT64", 0), Deleted: field("INT64", 0), Alarm: field("REFERENCE", { recordName: alarmId, action: "VALIDATE", zoneID: active.zoneID }),
      } };
      const rule = { ...structuredClone(state.records.get(recurrenceId)), recordName: ruleId, recordChangeTag: `tag-${ruleId}`, parent: { recordName: id }, fields: {
        ...state.records.get(recurrenceId).fields, EndDate: field("TIMESTAMP", Date.parse("2030-10-28T09:15:00Z")), Reminder: field("REFERENCE", { recordName: id, action: "VALIDATE", zoneID: active.zoneID }),
      } };
      for (const record of [active, alarm, trigger, rule]) state.records.set(record.recordName, record);
      const list = state.records.get(listId); list.fields.ReminderIDs = field("STRING", JSON.stringify([...JSON.parse(list.fields.ReminderIDs.value), id]));
      return { active, rule, alarm, trigger, args: { listId, reminderId: id, recordChangeTag: active.recordChangeTag, expectedGeneration: generation } };
    };
    const seedTimedDaily = suffix => {
      const fixture = seedEndedWeekly(`TIMED-DAILY-${suffix}`, "2027-03-27T09:00:00Z");
      fixture.rule.fields.Frequency = field("INT64", 0); delete fixture.rule.fields.EndDate;
      return fixture;
    };
    const dailyJourney = seedTimedDaily("JOURNEY"), beforeTimedDaily = state.modifies.length;
    const dailyRuleBefore = structuredClone(dailyJourney.rule.fields), dailyPresentationBefore = structuredClone(dailyJourney.active.fields.UrgentPresentationAlarmsAsData);
    state.nextModify = "committed-500";
    const dailyLost = await mcp("tools/call", { name: "complete_reminder", arguments: dailyJourney.args });
    assert.equal(dailyLost.result.structuredContent.error.code, "WRITE_OUTCOME_UNKNOWN");
    assert.equal(state.modifies.length, beforeTimedDaily + 1);
    const dailyReconciled = await mcp("tools/call", { name: "complete_reminder", arguments: dailyJourney.args });
    assert.equal(dailyReconciled.result.isError, undefined, JSON.stringify(dailyReconciled.result));
    const dailyResult = dailyReconciled.result.structuredContent;
    assert.equal(dailyResult.replayed, true); assert.equal(dailyResult.record.id, dailyJourney.active.recordName);
    assert.equal(dailyResult.record.dueDate, "2027-03-28T08:00:00.000Z"); assert.equal(dailyResult.record.completed, false);
    assert.equal(dailyResult.completedOccurrence.dueDate, "2027-03-27T09:00:00.000Z"); assert.equal(dailyResult.completedOccurrence.completed, true);
    assert.deepEqual(state.records.get(dailyJourney.rule.recordName).fields, dailyRuleBefore);
    assert.deepEqual(state.records.get(dailyJourney.active.recordName).fields.UrgentPresentationAlarmsAsData, dailyPresentationBefore);
    assert.equal(state.records.has(dailyJourney.alarm.recordName), false); assert.equal(state.records.has(dailyJourney.trigger.recordName), false);
    const dailyHistory = state.records.get(dailyResult.completedOccurrence.id), historyAlarmIds = structuredClone(dailyHistory.fields.AlarmIDs);
    const activeAfterDaily = structuredClone(state.records.get(dailyJourney.active.recordName));
    const dailyHistoryReopened = await mcp("tools/call", { name: "reopen_reminder", arguments: { listId, reminderId: dailyHistory.recordName, recordChangeTag: dailyHistory.recordChangeTag, expectedGeneration: generation } });
    assert.equal(dailyHistoryReopened.result.isError, undefined, JSON.stringify(dailyHistoryReopened.result));
    assert.equal(dailyHistoryReopened.result.structuredContent.record.completed, false);
    assert.deepEqual(state.records.get(dailyHistory.recordName).fields.AlarmIDs, historyAlarmIds);
    assert.deepEqual(state.records.get(dailyJourney.active.recordName), activeAfterDaily);
    assert.equal(state.modifies.length, beforeTimedDaily + 2);
    const driftDaily = seedTimedDaily("DRIFT"), beforeDailyDrift = state.modifies.length;
    state.nextModify = "recurring-retained-crypto-drift";
    const dailyDrift = await mcp("tools/call", { name: "complete_reminder", arguments: driftDaily.args });
    assert.equal(dailyDrift.result.structuredContent.error.code, "WRITE_OUTCOME_UNKNOWN");
    const dailyDriftReplay = await mcp("tools/call", { name: "complete_reminder", arguments: driftDaily.args });
    assert.equal(dailyDriftReplay.result.structuredContent.error.code, "WRITE_OUTCOME_UNKNOWN"); assert.equal(state.modifies.length, beforeDailyDrift + 1);
    const endedTimedDaily = seedTimedDaily("ENDED"); endedTimedDaily.rule.fields.EndDate = field("TIMESTAMP", Date.parse("2027-03-29T08:00:00Z"));
    const endedDailyRefused = await mcp("tools/call", { name: "complete_reminder", arguments: endedTimedDaily.args });
    assert.equal(endedDailyRefused.result.structuredContent.error.code, "UNSUPPORTED_FEATURE"); assert.equal(state.modifies.length, beforeDailyDrift + 1);
    for (const mode of ["recurring-rule-race", "recurring-list-race", "recurring-alarm-race", "recurring-retained-parent-drift", "recurring-retained-crypto-drift"]) {
      const { active, args } = seedEndedWeekly(mode), before = state.modifies.length;
      state.nextModify = mode;
      const invalidFinal = await mcp("tools/call", { name: "complete_reminder", arguments: args });
      assert.equal(invalidFinal.result.structuredContent.error.code, mode.endsWith("-race") ? "CONFLICT" : "WRITE_OUTCOME_UNKNOWN", mode);
      assert.equal(state.modifies.length, before + 1); assert.equal(state.modifies.at(-1).operationCount, 5); assert.equal(state.modifies.at(-1).historyId, undefined);
      assert.equal(state.records.get(active.recordName).fields.Completed.value, mode.endsWith("-race") ? 0 : 1);
      const invalidReplay = await mcp("tools/call", { name: "complete_reminder", arguments: args });
      assert.equal(invalidReplay.result.structuredContent.error.code, "WRITE_OUTCOME_UNKNOWN", mode); assert.equal(state.modifies.length, before + 1);
    }
    const weeklyJourney = seedEndedWeekly("JOURNEY", "2030-10-21T08:15:00Z"), beforeWeeklyEnd = state.modifies.length;
    for (const end of ["2030-10-29T09:15:00Z", "2030-10-28T08:15:00Z"]) {
      weeklyJourney.rule.fields.EndDate = field("TIMESTAMP", Date.parse(end));
      const unsupported = await mcp("tools/call", { name: "complete_reminder", arguments: weeklyJourney.args });
      assert.equal(unsupported.result.structuredContent.error.code, "UNSUPPORTED_FEATURE"); assert.equal(state.modifies.length, beforeWeeklyEnd);
    }
    weeklyJourney.rule.fields.EndDate = field("TIMESTAMP", Date.parse("2030-10-28T09:15:00Z"));
    const weeklyZoneArg = await mcp("tools/call", { name: "complete_reminder", arguments: { ...weeklyJourney.args, recurrenceCalendarTimeZone: "Europe/London" } });
    assert.equal(weeklyZoneArg.result.structuredContent.error.code, "UNSUPPORTED_FEATURE"); assert.equal(state.modifies.length, beforeWeeklyEnd);
    const weeklyNonce = weeklyJourney.alarm.fields.DueDateResolutionTokenAsNonce.value;
    weeklyJourney.alarm.fields.DueDateResolutionTokenAsNonce.value = weeklyNonce + 1;
    const badWeeklyNonce = await mcp("tools/call", { name: "complete_reminder", arguments: weeklyJourney.args });
    assert.equal(badWeeklyNonce.result.structuredContent.error.code, "CONFLICT"); assert.equal(state.modifies.length, beforeWeeklyEnd);
    weeklyJourney.alarm.fields.DueDateResolutionTokenAsNonce.value = weeklyNonce;
    const weeklyPenultimate = await mcp("tools/call", { name: "complete_reminder", arguments: weeklyJourney.args });
    assert.equal(weeklyPenultimate.result.isError, undefined, JSON.stringify(weeklyPenultimate.result));
    assert.equal(weeklyPenultimate.result.structuredContent.record.dueDate, "2030-10-28T09:15:00.000Z");
    assert.equal(weeklyPenultimate.result.structuredContent.completedOccurrence.dueDate, "2030-10-21T08:15:00.000Z");
    assert.equal(state.records.has(weeklyJourney.alarm.recordName), false); assert.equal(state.records.has(weeklyJourney.trigger.recordName), false);
    const weeklyCurrent = state.records.get(weeklyJourney.active.recordName), retainedAlarm = state.records.get(`Alarm/${weeklyCurrent.fields.AlarmIDs.value[0].replace(/^Alarm\//, "")}`);
    const retainedTrigger = state.records.get(`AlarmTrigger/${retainedAlarm.fields.TriggerID.value}`);
    retainedAlarm.parent = { recordName: weeklyCurrent.recordName }; retainedTrigger.parent = { recordName: retainedAlarm.recordName };
    const retainedFields = [retainedAlarm, retainedTrigger, weeklyJourney.rule, state.records.get(listId)].map(record => structuredClone(record.fields));
    const weeklyFinalArgs = { ...weeklyJourney.args, recordChangeTag: weeklyCurrent.recordChangeTag }, keysBeforeWeeklyFinal = [...state.records.keys()].sort();
    state.foreignZoneIds.add(retainedAlarm.recordName);
    const foreignRetainedAlarm = await mcp("tools/call", { name: "complete_reminder", arguments: weeklyFinalArgs });
    assert.equal(foreignRetainedAlarm.result.isError, true); assert.equal(state.modifies.length, beforeWeeklyEnd + 1);
    state.foreignZoneIds.delete(retainedAlarm.recordName); state.omitLookupZoneIds.add(listId);
    state.nextModify = "committed-500";
    const lostWeeklyFinal = await mcp("tools/call", { name: "complete_reminder", arguments: weeklyFinalArgs });
    assert.equal(lostWeeklyFinal.result.structuredContent.error.code, "WRITE_OUTCOME_UNKNOWN"); assert.equal(state.modifies.length, beforeWeeklyEnd + 2);
    const weeklyFinalRead = await mcp("tools/call", { name: "complete_reminder", arguments: weeklyFinalArgs });
    assert.equal(weeklyFinalRead.result.isError, undefined, JSON.stringify(weeklyFinalRead.result));
    assert.equal(weeklyFinalRead.result.structuredContent.replayed, true); assert.equal(weeklyFinalRead.result.structuredContent.record.completed, true);
    assert.equal(weeklyFinalRead.result.structuredContent.record.dueDate, "2030-10-28T09:15:00.000Z"); assert.equal(weeklyFinalRead.result.structuredContent.completedOccurrence, undefined);
    assert.equal(weeklyFinalRead.result.structuredContent.affectedRecords.length, 1); assert.equal(state.modifies.length, beforeWeeklyEnd + 2);
    assert.deepEqual([...state.records.keys()].sort(), keysBeforeWeeklyFinal);
    const weeklyReopenArgs = { ...weeklyFinalArgs, recordChangeTag: state.records.get(weeklyCurrent.recordName).recordChangeTag };
    const weeklyReopened = await mcp("tools/call", { name: "reopen_reminder", arguments: weeklyReopenArgs });
    assert.equal(weeklyReopened.result.isError, undefined, JSON.stringify(weeklyReopened.result));
    assert.equal(weeklyReopened.result.structuredContent.record.completed, false); assert.equal(weeklyReopened.result.structuredContent.record.completedDate, null);
    assert.equal(weeklyReopened.result.structuredContent.completedOccurrence, undefined); assert.equal(state.modifies.length, beforeWeeklyEnd + 3);
    assert.deepEqual([...state.records.keys()].sort(), keysBeforeWeeklyFinal);
    assert.deepEqual([retainedAlarm, retainedTrigger, weeklyJourney.rule, state.records.get(listId)].map(record => state.records.get(record.recordName).fields), retainedFields);
    const replayWeeklyReopen = await mcp("tools/call", { name: "reopen_reminder", arguments: weeklyReopenArgs });
    assert.equal(replayWeeklyReopen.result.structuredContent.replayed, true); assert.equal(state.modifies.length, beforeWeeklyEnd + 3);
    state.omitLookupZoneIds.delete(listId);

    const beforeRecurringDeleteJourney = new Set(state.records.keys());
    const seedRecurringDelete = suffix => { const fixture = seedEndedWeekly(`DELETE-${suffix}`, "2030-10-21T08:15:00Z"); delete fixture.rule.fields.EndDate; return fixture; };
    for (const mode of ["recurring-delete-rule-race", "recurring-delete-list-race", "recurring-delete-alarm-race", "recurring-delete-crypto-drift", "recurring-delete-parent-drift"]) {
      const fixture = seedRecurringDelete(mode), args = { ...fixture.args, recurringDeletionScope: "occurrence" }, before = state.modifies.length;
      state.nextModify = mode;
      const rejected = await mcp("tools/call", { name: "delete_reminder", arguments: args });
      assert.equal(rejected.result.structuredContent.error.code, mode.endsWith("-race") ? "CONFLICT" : "WRITE_OUTCOME_UNKNOWN", mode); assert.equal(state.modifies.length, before + 1);
      const reconciled = await mcp("tools/call", { name: "delete_reminder", arguments: args });
      assert.equal(reconciled.result.structuredContent.error.code, "WRITE_OUTCOME_UNKNOWN", mode); assert.equal(state.modifies.length, before + 1, "Scoped uncertain deletion never redispatches.");
    }
    const deleteFixture = seedRecurringDelete("JOURNEY"), deleteBase = deleteFixture.args, beforeRecurringDelete = state.modifies.length;
    const missingDeleteScope = await mcp("tools/call", { name: "delete_reminder", arguments: deleteBase });
    assert.equal(missingDeleteScope.result.structuredContent.error.code, "VALIDATION_ERROR"); assert.equal(state.modifies.length, beforeRecurringDelete);
    const ordinaryScopeRecord = reminderRecord("Reminder/DELETE-SCOPE-ORDINARY"); state.records.set(ordinaryScopeRecord.recordName, ordinaryScopeRecord);
    const ordinaryScope = await mcp("tools/call", { name: "delete_reminder", arguments: { listId, reminderId: ordinaryScopeRecord.recordName, recordChangeTag: ordinaryScopeRecord.recordChangeTag, recurringDeletionScope: "all_future" } });
    assert.equal(ordinaryScope.result.structuredContent.error.code, "VALIDATION_ERROR"); assert.equal(state.modifies.length, beforeRecurringDelete);
    const unsupportedCalendar = await mcp("tools/call", { name: "delete_reminder", arguments: { ...deleteBase, recurringDeletionScope: "occurrence", recurrenceCalendarTimeZone: "Europe/London" } });
    assert.equal(unsupportedCalendar.result.structuredContent.error.code, "UNSUPPORTED_FEATURE"); assert.equal(state.modifies.length, beforeRecurringDelete);
    const retainedHistory = reminderRecord("Reminder/RECURRING-DELETE-PRIOR-HISTORY"); retainedHistory.fields.Completed = field("INT64", 1); retainedHistory.fields.CompletionDate = field("TIMESTAMP", Date.parse("2030-10-14T10:00:00Z"));
    state.records.set(retainedHistory.recordName, retainedHistory);
    const priorHistorySnapshot = structuredClone(retainedHistory), memberList = state.records.get(listId); memberList.fields.ReminderIDs = field("STRING", JSON.stringify([...JSON.parse(memberList.fields.ReminderIDs.value), retainedHistory.recordName]));
    const occurrenceDeleteArgs = { ...deleteBase, recurringDeletionScope: "occurrence" }, beforeOccurrenceKeys = new Set(state.records.keys());
    state.nextModify = "committed-500";
    const lostOccurrenceDelete = await mcp("tools/call", { name: "delete_reminder", arguments: occurrenceDeleteArgs });
    assert.equal(lostOccurrenceDelete.result.structuredContent.error.code, "WRITE_OUTCOME_UNKNOWN"); assert.equal(state.modifies.length, beforeRecurringDelete + 1);
    const newPairIds = [...state.records.keys()].filter(id => !beforeOccurrenceKeys.has(id)); assert.equal(newPairIds.length, 2); assert.ok(newPairIds.every(id => /^(Alarm|AlarmTrigger)\//.test(id)));
    assert.equal(state.records.has(deleteFixture.alarm.recordName), false); assert.equal(state.records.has(deleteFixture.trigger.recordName), false);
    const otherScopeOldTag = await mcp("tools/call", { name: "delete_reminder", arguments: { ...deleteBase, recurringDeletionScope: "all_future" } });
    assert.equal(otherScopeOldTag.result.structuredContent.error.code, "CONFLICT"); assert.equal(state.modifies.length, beforeRecurringDelete + 1);
    const completeOldTag = await mcp("tools/call", { name: "complete_reminder", arguments: deleteBase });
    assert.equal(completeOldTag.result.structuredContent.error.code, "CONFLICT"); assert.equal(state.modifies.length, beforeRecurringDelete + 1);
    const occurrenceDeleteReplay = await mcp("tools/call", { name: "delete_reminder", arguments: occurrenceDeleteArgs });
    assert.equal(occurrenceDeleteReplay.result.isError, undefined, JSON.stringify(occurrenceDeleteReplay.result)); assert.equal(occurrenceDeleteReplay.result.structuredContent.replayed, true);
    assert.equal(occurrenceDeleteReplay.result.structuredContent.record.dueDate, "2030-10-28T09:15:00.000Z"); assert.equal(occurrenceDeleteReplay.result.structuredContent.record.completed, false); assert.equal(occurrenceDeleteReplay.result.structuredContent.record.deleted, false);
    assert.equal(state.modifies.length, beforeRecurringDelete + 1); assert.deepEqual(state.records.get(retainedHistory.recordName), priorHistorySnapshot);
    const activeBeforeFuture = structuredClone(state.records.get(deleteFixture.active.recordName));
    const activeAlarmBeforeFuture = state.records.get(`Alarm/${activeBeforeFuture.fields.AlarmIDs.value[0].replace(/^Alarm\//, "")}`), triggerBeforeFuture = state.records.get(`AlarmTrigger/${activeAlarmBeforeFuture.fields.TriggerID.value}`);
    const retainedFutureRecords = [activeAlarmBeforeFuture, triggerBeforeFuture, state.records.get(deleteFixture.rule.recordName)].map(record => structuredClone(record));
    const futureDeleteArgs = { ...deleteBase, recordChangeTag: activeBeforeFuture.recordChangeTag, recurringDeletionScope: "all_future" };
    state.omitLookupZoneIds.add(listId); state.nextModify = "committed-500";
    const lostFutureDelete = await mcp("tools/call", { name: "delete_reminder", arguments: futureDeleteArgs });
    assert.equal(lostFutureDelete.result.structuredContent.error.code, "WRITE_OUTCOME_UNKNOWN"); assert.equal(state.modifies.length, beforeRecurringDelete + 2);
    const futureDeleteReplay = await mcp("tools/call", { name: "delete_reminder", arguments: futureDeleteArgs });
    assert.equal(futureDeleteReplay.result.isError, undefined, JSON.stringify(futureDeleteReplay.result)); assert.equal(futureDeleteReplay.result.structuredContent.replayed, true);
    assert.equal(futureDeleteReplay.result.structuredContent.record.deleted, true); assert.equal(futureDeleteReplay.result.structuredContent.record.listId, null); assert.equal(futureDeleteReplay.result.structuredContent.record.dueDate, "2030-10-28T09:15:00.000Z");
    assert.equal(state.modifies.length, beforeRecurringDelete + 2); assert.deepEqual(state.records.get(retainedHistory.recordName), priorHistorySnapshot);
    assert.equal(state.records.get(deleteFixture.active.recordName).parent, undefined);
    for (const before of retainedFutureRecords) { assert.deepEqual(state.records.get(before.recordName).fields, { ...before.fields, Deleted: field("INT64", 1) }); assert.deepEqual(state.records.get(before.recordName).parent, before.parent); }
    assert.equal(JSON.parse(state.records.get(listId).fields.ReminderIDs.value).includes(deleteFixture.active.recordName), false);
    const changedConfirmedOccurrence = await mcp("tools/call", { name: "delete_reminder", arguments: occurrenceDeleteArgs });
    assert.equal(changedConfirmedOccurrence.result.structuredContent.error.code, "CONFLICT"); assert.equal(state.modifies.length, beforeRecurringDelete + 2);
    state.omitLookupZoneIds.delete(listId);
    const normalFutureFixture = seedRecurringDelete("NORMAL-FUTURE"), normalFutureArgs = { ...normalFutureFixture.args, recurringDeletionScope: "all_future" };
    const normalFutureDelete = await mcp("tools/call", { name: "delete_reminder", arguments: normalFutureArgs });
    assert.equal(normalFutureDelete.result.isError, undefined, JSON.stringify(normalFutureDelete.result)); assert.equal(normalFutureDelete.result.structuredContent.record.listId, null);
    const normalFutureReplay = await mcp("tools/call", { name: "delete_reminder", arguments: normalFutureArgs }); assert.equal(normalFutureReplay.result.structuredContent.replayed, true);
    const endedWeeklyDelete = seedEndedWeekly("DELETE-ENDED-JOURNEY", "2030-10-21T04:00:00Z");
    endedWeeklyDelete.rule.fields.EndDate = field("TIMESTAMP", Date.parse("2030-10-28T06:26:20Z"));
    const endedWeeklyBefore = state.modifies.length, endedWeeklyArgs = { ...endedWeeklyDelete.args, recurringDeletionScope: "occurrence" };
    const endedWeeklyRuleFields = structuredClone(endedWeeklyDelete.rule.fields);
    const weeklyCalendarRefused = await mcp("tools/call", { name: "delete_reminder", arguments: { ...endedWeeklyArgs, recurrenceCalendarTimeZone: "Europe/London" } });
    assert.equal(weeklyCalendarRefused.result.structuredContent.error.code, "UNSUPPORTED_FEATURE"); assert.equal(state.modifies.length, endedWeeklyBefore);
    const endedWeeklyAdvance = await mcp("tools/call", { name: "delete_reminder", arguments: endedWeeklyArgs });
    assert.equal(endedWeeklyAdvance.result.isError, undefined, JSON.stringify(endedWeeklyAdvance.result)); assert.equal(endedWeeklyAdvance.result.structuredContent.record.dueDate, "2030-10-28T05:00:00.000Z");
    assert.equal(endedWeeklyAdvance.result.structuredContent.record.completed, false); assert.equal(state.modifies.at(-1).operationCount, 7);
    assert.deepEqual(state.records.get(endedWeeklyDelete.rule.recordName).fields, endedWeeklyRuleFields);
    const endedWeeklyAdvanceReplay = await mcp("tools/call", { name: "delete_reminder", arguments: endedWeeklyArgs });
    assert.equal(endedWeeklyAdvanceReplay.result.structuredContent.replayed, true); assert.equal(state.modifies.length, endedWeeklyBefore + 1);
    const endedWeeklyRootBeforeFinal = state.records.get(endedWeeklyDelete.active.recordName), endedWeeklyAlarm = state.records.get(`Alarm/${endedWeeklyRootBeforeFinal.fields.AlarmIDs.value[0].replace(/^Alarm\//, "")}`);
    const endedWeeklyPairBeforeFinal = [endedWeeklyAlarm, state.records.get(`AlarmTrigger/${endedWeeklyAlarm.fields.TriggerID.value}`), state.records.get(endedWeeklyDelete.rule.recordName)].map(record => structuredClone(record));
    const endedWeeklyFinalArgs = { ...endedWeeklyArgs, recordChangeTag: endedWeeklyRootBeforeFinal.recordChangeTag }, endedWeeklyKeys = [...state.records.keys()].sort();
    const finalMemberList = state.records.get(listId); finalMemberList.fields.ReminderIDs = field("STRING", JSON.stringify(JSON.parse(finalMemberList.fields.ReminderIDs.value).filter(id => id !== endedWeeklyDelete.active.recordName)));
    const endedWeeklyMembership = finalMemberList.fields.ReminderIDs.value, endedWeeklyOrdering = JSON.parse(finalMemberList.fields.ResolutionTokenMap.value).map.reminderIDsMergeableOrdering.counter;
    state.nextModify = "committed-500";
    const endedWeeklyFinalLost = await mcp("tools/call", { name: "delete_reminder", arguments: endedWeeklyFinalArgs });
    assert.equal(endedWeeklyFinalLost.result.structuredContent.error.code, "WRITE_OUTCOME_UNKNOWN"); assert.equal(state.modifies.length, endedWeeklyBefore + 2); assert.equal(state.modifies.at(-1).operationCount, 5);
    const endedWeeklyFinalReplay = await mcp("tools/call", { name: "delete_reminder", arguments: endedWeeklyFinalArgs });
    assert.equal(endedWeeklyFinalReplay.result.isError, undefined, JSON.stringify(endedWeeklyFinalReplay.result)); assert.equal(endedWeeklyFinalReplay.result.structuredContent.replayed, true);
    assert.equal(endedWeeklyFinalReplay.result.structuredContent.record.listId, null); assert.equal(endedWeeklyFinalReplay.result.structuredContent.record.dueDate, "2030-10-28T05:00:00.000Z");
    assert.deepEqual([...state.records.keys()].sort(), endedWeeklyKeys); assert.equal(state.modifies.length, endedWeeklyBefore + 2);
    for (const before of endedWeeklyPairBeforeFinal) { assert.deepEqual(state.records.get(before.recordName).fields, { ...before.fields, Deleted: field("INT64", 1) }); assert.deepEqual(state.records.get(before.recordName).parent, before.parent); }
    assert.equal(state.records.get(listId).fields.ReminderIDs.value, endedWeeklyMembership);
    assert.equal(JSON.parse(state.records.get(listId).fields.ResolutionTokenMap.value).map.reminderIDsMergeableOrdering.counter, endedWeeklyOrdering + 1);
    const endedWeeklyChangedScope = await mcp("tools/call", { name: "delete_reminder", arguments: { ...endedWeeklyFinalArgs, recurringDeletionScope: "all_future" } });
    assert.equal(endedWeeklyChangedScope.result.structuredContent.error.code, "CONFLICT"); assert.equal(state.modifies.length, endedWeeklyBefore + 2);
    const noAdvanceWeekly = seedEndedWeekly("DELETE-ENDED-EDGE", "2030-10-21T08:15:00Z"); noAdvanceWeekly.rule.fields.EndDate = field("TIMESTAMP", Date.parse("2030-10-28T06:15:53Z"));
    const noAdvanceArgs = { ...noAdvanceWeekly.args, recurringDeletionScope: "occurrence" };
    const noAdvance = await mcp("tools/call", { name: "delete_reminder", arguments: noAdvanceArgs });
    assert.equal(noAdvance.result.structuredContent.error.code, "VALIDATION_ERROR"); assert.match(noAdvance.result.structuredContent.error.message, /all_future/); assert.equal(state.modifies.length, endedWeeklyBefore + 2);
    assert.equal(state.records.get(noAdvanceWeekly.active.recordName).recordChangeTag, noAdvanceWeekly.args.recordChangeTag);
    const noAdvanceFuture = await mcp("tools/call", { name: "delete_reminder", arguments: { ...noAdvanceArgs, recurringDeletionScope: "all_future" } });
    assert.equal(noAdvanceFuture.result.isError, undefined, JSON.stringify(noAdvanceFuture.result)); assert.equal(noAdvanceFuture.result.structuredContent.record.listId, null); assert.equal(state.modifies.length, endedWeeklyBefore + 3);
    const sameDayWeekly = seedEndedWeekly("DELETE-ENDED-SAMEDAY", "2030-10-21T08:15:00Z"); sameDayWeekly.rule.fields.EndDate = field("TIMESTAMP", Date.parse("2030-10-21T05:26:40Z"));
    const sameDayDeleted = await mcp("tools/call", { name: "delete_reminder", arguments: { ...sameDayWeekly.args, recurringDeletionScope: "occurrence" } });
    assert.equal(sameDayDeleted.result.isError, undefined, JSON.stringify(sameDayDeleted.result)); assert.equal(sameDayDeleted.result.structuredContent.record.listId, null);
    assert.equal(sameDayDeleted.result.structuredContent.record.dueDate, "2030-10-21T08:15:00.000Z"); assert.equal(state.modifies.length, endedWeeklyBefore + 4);
    const pastWeekly = seedEndedWeekly("DELETE-ENDED-PAST", "2030-10-21T08:15:00Z"); pastWeekly.rule.fields.EndDate = field("TIMESTAMP", Date.parse("2030-10-20T12:00:00Z"));
    const pastWeeklyRefused = await mcp("tools/call", { name: "delete_reminder", arguments: { ...pastWeekly.args, recurringDeletionScope: "all_future" } });
    assert.equal(pastWeeklyRefused.result.structuredContent.error.code, "UNSUPPORTED_FEATURE"); assert.equal(state.modifies.length, endedWeeklyBefore + 4);
    const seedDailyDelete = suffix => {
      const id = `Reminder/DELETE-DAILY-${suffix}`, ruleId = `RecurrenceRule/DELETE-DAILY-${suffix}`, active = reminderRecord(id);
      active.parent = { recordName: listId }; active.fields.AllDay = field("INT64", 1); active.fields.DueDate = field("TIMESTAMP", Date.parse("2030-10-19T00:00:00Z")); delete active.fields.TimeZone;
      active.fields.AlarmIDs = field("UNKNOWN_LIST", []); active.fields.RecurrenceRuleIDs = field("STRING_LIST", [ruleId]);
      const rule = { ...structuredClone(state.records.get(recurrenceId)), recordName: ruleId, recordChangeTag: `tag-${ruleId}`, parent: { recordName: id }, fields: {
        ...state.records.get(recurrenceId).fields, Frequency: field("INT64", 0), Reminder: field("REFERENCE", { recordName: id, action: "VALIDATE", zoneID: active.zoneID }),
      } };
      state.records.set(id, active); state.records.set(ruleId, rule);
      return { active, rule, args: { listId, reminderId: id, recordChangeTag: active.recordChangeTag, expectedGeneration: generation } };
    };
    const dailyDeleteFixture = seedDailyDelete("JOURNEY"), beforeDailyDelete = state.modifies.length;
    const dailyDeleteBase = dailyDeleteFixture.args, dailyOccurrenceArgs = { ...dailyDeleteBase, recurringDeletionScope: "occurrence" }, dailyKeysBefore = [...state.records.keys()].sort();
    const dailyMembershipBefore = state.records.get(listId).fields.ReminderIDs.value;
    assert.equal(JSON.parse(dailyMembershipBefore).includes(dailyDeleteFixture.active.recordName), false);
    dailyDeleteFixture.rule.fields.EndDate = field("TIMESTAMP", Date.parse("2030-10-20T09:00:00Z"));
    for (const scope of ["occurrence", "all_future"]) {
      const refused = await mcp("tools/call", { name: "delete_reminder", arguments: { ...dailyDeleteBase, recurringDeletionScope: scope } });
      assert.equal(refused.result.structuredContent.error.code, "UNSUPPORTED_FEATURE"); assert.equal(state.modifies.length, beforeDailyDelete);
    }
    delete dailyDeleteFixture.rule.fields.EndDate;
    dailyDeleteFixture.active.fields.TimeZone = field("STRING", "Europe/London");
    const zonedDailyDelete = await mcp("tools/call", { name: "delete_reminder", arguments: dailyOccurrenceArgs });
    assert.equal(zonedDailyDelete.result.structuredContent.error.code, "UNSUPPORTED_FEATURE"); assert.equal(state.modifies.length, beforeDailyDelete); delete dailyDeleteFixture.active.fields.TimeZone;
    state.nextModify = "committed-500";
    const lostDailyOccurrence = await mcp("tools/call", { name: "delete_reminder", arguments: dailyOccurrenceArgs });
    assert.equal(lostDailyOccurrence.result.structuredContent.error.code, "WRITE_OUTCOME_UNKNOWN"); assert.equal(state.modifies.length, beforeDailyDelete + 1); assert.equal(state.modifies.at(-1).operationCount, 3);
    const dailyOccurrenceReplay = await mcp("tools/call", { name: "delete_reminder", arguments: dailyOccurrenceArgs });
    assert.equal(dailyOccurrenceReplay.result.isError, undefined, JSON.stringify(dailyOccurrenceReplay.result)); assert.equal(dailyOccurrenceReplay.result.structuredContent.replayed, true);
    assert.equal(dailyOccurrenceReplay.result.structuredContent.record.dueDate, "2030-10-20T00:00:00.000Z"); assert.equal(dailyOccurrenceReplay.result.structuredContent.record.completed, false);
    assert.deepEqual(dailyOccurrenceReplay.result.structuredContent.record.alarmIds, []); assert.deepEqual([...state.records.keys()].sort(), dailyKeysBefore); assert.equal(state.modifies.length, beforeDailyDelete + 1);
    const otherDailyScope = await mcp("tools/call", { name: "delete_reminder", arguments: { ...dailyDeleteBase, recurringDeletionScope: "all_future" } });
    assert.equal(otherDailyScope.result.structuredContent.error.code, "CONFLICT"); assert.equal(state.modifies.length, beforeDailyDelete + 1);
    const dailyFutureArgs = { ...dailyDeleteBase, recordChangeTag: state.records.get(dailyDeleteFixture.active.recordName).recordChangeTag, recurringDeletionScope: "all_future" };
    const dailyListTokensBefore = JSON.parse(state.records.get(listId).fields.ResolutionTokenMap.value).map, dailyRuleBeforeRetire = structuredClone(state.records.get(dailyDeleteFixture.rule.recordName));
    state.omitLookupZoneIds.add(listId); state.nextModify = "committed-500";
    const lostDailyFuture = await mcp("tools/call", { name: "delete_reminder", arguments: dailyFutureArgs });
    assert.equal(lostDailyFuture.result.structuredContent.error.code, "WRITE_OUTCOME_UNKNOWN"); assert.equal(state.modifies.length, beforeDailyDelete + 2);
    const dailyFutureReplay = await mcp("tools/call", { name: "delete_reminder", arguments: dailyFutureArgs });
    assert.equal(dailyFutureReplay.result.isError, undefined, JSON.stringify(dailyFutureReplay.result)); assert.equal(dailyFutureReplay.result.structuredContent.replayed, true);
    assert.equal(dailyFutureReplay.result.structuredContent.record.deleted, true); assert.equal(dailyFutureReplay.result.structuredContent.record.listId, null); assert.equal(dailyFutureReplay.result.structuredContent.record.dueDate, "2030-10-20T00:00:00.000Z");
    assert.equal(state.modifies.length, beforeDailyDelete + 2); assert.deepEqual([...state.records.keys()].sort(), dailyKeysBefore);
    assert.deepEqual(state.records.get(dailyDeleteFixture.rule.recordName).fields, { ...dailyRuleBeforeRetire.fields, Deleted: field("INT64", 1) });
    assert.deepEqual(state.records.get(dailyDeleteFixture.rule.recordName).parent, dailyRuleBeforeRetire.parent); assert.equal(state.records.get(listId).fields.ReminderIDs.value, dailyMembershipBefore);
    const dailyListTokensAfter = JSON.parse(state.records.get(listId).fields.ResolutionTokenMap.value).map;
    assert.equal(dailyListTokensAfter.reminderIDsMergeableOrdering.counter, dailyListTokensBefore.reminderIDsMergeableOrdering.counter + 1);
    assert.deepEqual(Object.fromEntries(Object.entries(dailyListTokensAfter).filter(([key]) => key !== "reminderIDsMergeableOrdering")), Object.fromEntries(Object.entries(dailyListTokensBefore).filter(([key]) => key !== "reminderIDsMergeableOrdering")));
    state.omitLookupZoneIds.delete(listId);
    const normalDailyFixture = seedDailyDelete("NORMAL"), normalDailyOccurrence = await mcp("tools/call", { name: "delete_reminder", arguments: { ...normalDailyFixture.args, recurringDeletionScope: "occurrence" } });
    assert.equal(normalDailyOccurrence.result.isError, undefined, JSON.stringify(normalDailyOccurrence.result)); assert.equal(normalDailyOccurrence.result.structuredContent.replayed, false);
    const normalDailyFuture = await mcp("tools/call", { name: "delete_reminder", arguments: { ...normalDailyFixture.args, recordChangeTag: state.records.get(normalDailyFixture.active.recordName).recordChangeTag, recurringDeletionScope: "all_future" } });
    assert.equal(normalDailyFuture.result.isError, undefined, JSON.stringify(normalDailyFuture.result)); assert.equal(normalDailyFuture.result.structuredContent.record.listId, null);
    const endedDelete = seedDailyDelete("ENDED"), endedDeleteBefore = state.modifies.length;
    endedDelete.active.fields.DueDate = field("TIMESTAMP", Date.parse("2030-10-26T00:00:00Z"));
    endedDelete.rule.fields.EndDate = field("TIMESTAMP", Date.parse("2030-10-26T23:51:29Z"));
    const endedSkipArgs = { ...endedDelete.args, recurringDeletionScope: "occurrence", recurrenceCalendarTimeZone: "Europe/London" };
    for (const args of [{ ...endedDelete.args, recurringDeletionScope: "occurrence" }, { ...endedSkipArgs, recurrenceCalendarTimeZone: "Unknown/Invalid" },
      { ...normalDailyFixture.args, recurringDeletionScope: "occurrence", recurrenceCalendarTimeZone: "Europe/London", recordChangeTag: state.records.get(normalDailyFixture.active.recordName).recordChangeTag }]) {
      const refused = await mcp("tools/call", { name: "delete_reminder", arguments: args });
      assert.equal(refused.result.isError, true); assert.equal(state.modifies.length, endedDeleteBefore);
    }
    const endedSkip = await mcp("tools/call", { name: "delete_reminder", arguments: endedSkipArgs });
    assert.equal(endedSkip.result.isError, undefined, JSON.stringify(endedSkip.result)); assert.equal(endedSkip.result.structuredContent.record.dueDate, "2030-10-27T00:00:00.000Z");
    assert.equal(endedSkip.result.structuredContent.record.deleted, false); assert.equal(state.modifies.at(-1).operationCount, 3);
    const endedSkipReplay = await mcp("tools/call", { name: "delete_reminder", arguments: endedSkipArgs });
    assert.equal(endedSkipReplay.result.structuredContent.replayed, true); assert.equal(state.modifies.length, endedDeleteBefore + 1);
    const endedFinalArgs = { ...endedSkipArgs, recordChangeTag: state.records.get(endedDelete.active.recordName).recordChangeTag };
    const endedKeys = [...state.records.keys()].sort(), endedRuleBefore = structuredClone(state.records.get(endedDelete.rule.recordName));
    const endedMembership = state.records.get(listId).fields.ReminderIDs.value, endedOrdering = JSON.parse(state.records.get(listId).fields.ResolutionTokenMap.value).map.reminderIDsMergeableOrdering.counter;
    state.nextModify = "committed-500";
    const endedFinalLost = await mcp("tools/call", { name: "delete_reminder", arguments: endedFinalArgs });
    assert.equal(endedFinalLost.result.structuredContent.error.code, "WRITE_OUTCOME_UNKNOWN"); assert.equal(state.modifies.length, endedDeleteBefore + 2);
    const endedFinalReplay = await mcp("tools/call", { name: "delete_reminder", arguments: endedFinalArgs });
    assert.equal(endedFinalReplay.result.isError, undefined, JSON.stringify(endedFinalReplay.result)); assert.equal(endedFinalReplay.result.structuredContent.replayed, true);
    assert.equal(endedFinalReplay.result.structuredContent.record.deleted, true); assert.equal(endedFinalReplay.result.structuredContent.record.listId, null);
    assert.equal(endedFinalReplay.result.structuredContent.record.dueDate, "2030-10-27T00:00:00.000Z"); assert.equal(endedFinalReplay.result.structuredContent.record.completed, false);
    assert.deepEqual([...state.records.keys()].sort(), endedKeys); assert.deepEqual(state.records.get(endedDelete.rule.recordName).fields, { ...endedRuleBefore.fields, Deleted: field("INT64", 1) });
    assert.deepEqual(state.records.get(endedDelete.rule.recordName).parent, endedRuleBefore.parent); assert.equal(state.records.get(listId).fields.ReminderIDs.value, endedMembership);
    assert.equal(JSON.parse(state.records.get(listId).fields.ResolutionTokenMap.value).map.reminderIDsMergeableOrdering.counter, endedOrdering + 1);
    for (const change of [{ recurrenceCalendarTimeZone: "UTC" }, { recurringDeletionScope: "all_future" }]) {
      const changed = await mcp("tools/call", { name: "delete_reminder", arguments: { ...endedFinalArgs, ...change } });
      assert.equal(changed.result.structuredContent.error.code, "CONFLICT"); assert.equal(state.modifies.length, endedDeleteBefore + 2);
    }
    const endedFuture = seedDailyDelete("ENDED-FUTURE"); endedFuture.rule.fields.EndDate = field("TIMESTAMP", Date.parse("2030-10-20T00:00:00Z"));
    const futureList = state.records.get(listId), futureMembers = JSON.parse(futureList.fields.ReminderIDs.value);
    futureList.fields.ReminderIDs = field("STRING", JSON.stringify([...futureMembers, endedFuture.active.recordName]));
    const futureRetire = await mcp("tools/call", { name: "delete_reminder", arguments: { ...endedFuture.args, recurringDeletionScope: "all_future" } });
    assert.equal(futureRetire.result.isError, undefined, JSON.stringify(futureRetire.result)); assert.equal(futureRetire.result.structuredContent.record.listId, null);
    assert.deepEqual(JSON.parse(state.records.get(listId).fields.ReminderIDs.value), futureMembers); assert.equal(state.modifies.length, endedDeleteBefore + 3);
    const normalFinalDelete = seedDailyDelete("ENDED-FINAL-NORMAL"); normalFinalDelete.rule.fields.EndDate = field("TIMESTAMP", Date.parse("2030-10-19T00:00:00Z"));
    const normalFinalArgs = { ...normalFinalDelete.args, recurringDeletionScope: "occurrence" };
    const normalFinal = await mcp("tools/call", { name: "delete_reminder", arguments: normalFinalArgs });
    assert.equal(normalFinal.result.isError, undefined, JSON.stringify(normalFinal.result)); assert.equal(normalFinal.result.structuredContent.record.listId, null);
    assert.equal(normalFinal.result.structuredContent.record.dueDate, "2030-10-19T00:00:00.000Z"); assert.equal(state.modifies.at(-1).operationCount, 3);
    const normalFinalAgain = await mcp("tools/call", { name: "delete_reminder", arguments: normalFinalArgs }); assert.equal(normalFinalAgain.result.structuredContent.replayed, true);
    const beyondEnd = seedDailyDelete("BEYOND"); beyondEnd.rule.fields.EndDate = field("TIMESTAMP", Date.parse("2030-10-18T00:00:00Z"));
    const beyondRefused = await mcp("tools/call", { name: "delete_reminder", arguments: { ...beyondEnd.args, recurringDeletionScope: "all_future" } });
    assert.equal(beyondRefused.result.structuredContent.error.code, "UNSUPPORTED_FEATURE"); assert.equal(state.modifies.length, endedDeleteBefore + 4);
    const monthlyDeleteFixture = seedDailyDelete("LAST-DAY-MONTHLY"), monthlyDeleteBefore = state.modifies.length;
    monthlyDeleteFixture.active.fields.DueDate = field("TIMESTAMP", Date.parse("2030-10-31T00:00:00Z"));
    Object.assign(monthlyDeleteFixture.rule.fields, { Frequency: field("INT64", 2), DaysOfTheMonth: field("BYTES", Buffer.from("[28,29,30,31]").toString("base64")), SetPositions: field("BYTES", Buffer.from("[-1]").toString("base64")) });
    const monthlyDeleteArgs = { ...monthlyDeleteFixture.args, recurringDeletionScope: "occurrence" };
    for (const change of [{ root: { DueDate: field("TIMESTAMP", Date.parse("2030-10-30T00:00:00Z")) } }, { rule: { EndDate: field("TIMESTAMP", Date.parse("2030-11-30T00:00:00Z")) } },
      { rule: { OccurrenceCount: field("INT64", 2) } }, { rule: { Imported: field("INT64", 1) } }, { rule: { SetPositions: field("BYTES", Buffer.from("[1]").toString("base64")) } },
      { root: { UnknownParentRelationship: field("REFERENCE", { recordName: "Reminder/OTHER", action: "VALIDATE" }) } }]) {
      const record = change.root ? monthlyDeleteFixture.active : monthlyDeleteFixture.rule, originalFields = structuredClone(record.fields);
      Object.assign(record.fields, change.root ?? change.rule);
      const rejected = await mcp("tools/call", { name: "delete_reminder", arguments: monthlyDeleteArgs });
      assert.equal(rejected.result.isError, true); assert.equal(state.modifies.length, monthlyDeleteBefore); record.fields = originalFields;
    }
    const monthlyCalendarRefused = await mcp("tools/call", { name: "delete_reminder", arguments: { ...monthlyDeleteArgs, recurrenceCalendarTimeZone: "UTC" } });
    assert.equal(monthlyCalendarRefused.result.structuredContent.error.code, "UNSUPPORTED_FEATURE"); assert.equal(state.modifies.length, monthlyDeleteBefore);
    const monthlyKeys = [...state.records.keys()].sort(), monthlyRootBefore = structuredClone(monthlyDeleteFixture.active), monthlyRuleBefore = structuredClone(monthlyDeleteFixture.rule);
    const monthlyListFields = structuredClone(state.records.get(listId).fields);
    state.nextModify = "committed-500";
    const monthlySkipLost = await mcp("tools/call", { name: "delete_reminder", arguments: monthlyDeleteArgs });
    assert.equal(monthlySkipLost.result.structuredContent.error.code, "WRITE_OUTCOME_UNKNOWN"); assert.equal(state.modifies.length, monthlyDeleteBefore + 1); assert.equal(state.modifies.at(-1).operationCount, 3);
    const monthlySkipReplay = await mcp("tools/call", { name: "delete_reminder", arguments: monthlyDeleteArgs });
    assert.equal(monthlySkipReplay.result.isError, undefined, JSON.stringify(monthlySkipReplay.result)); assert.equal(monthlySkipReplay.result.structuredContent.replayed, true);
    assert.equal(monthlySkipReplay.result.structuredContent.record.dueDate, "2030-11-30T00:00:00.000Z"); assert.equal(monthlySkipReplay.result.structuredContent.record.completed, false);
    assert.deepEqual([...state.records.keys()].sort(), monthlyKeys); assert.equal(state.modifies.length, monthlyDeleteBefore + 1);
    assert.deepEqual(state.records.get(monthlyDeleteFixture.rule.recordName).fields, monthlyRuleBefore.fields); assert.deepEqual(state.records.get(listId).fields, monthlyListFields);
    const monthlyRootAfter = state.records.get(monthlyDeleteFixture.active.recordName);
    for (const [key, value] of Object.entries(monthlyRootBefore.fields)) if (!["DueDate", "LastModifiedDate", "ResolutionTokenMap"].includes(key)) assert.deepEqual(monthlyRootAfter.fields[key], value);
    assert.deepEqual(monthlyRootAfter.parent, { ...monthlyRootBefore.parent, zoneID: { zoneName: "Reminders", zoneType: "REGULAR_CUSTOM_ZONE", ownerRecordName: zoneOwner } });
    const monthlyOtherScope = await mcp("tools/call", { name: "delete_reminder", arguments: { ...monthlyDeleteArgs, recurringDeletionScope: "all_future" } });
    assert.equal(monthlyOtherScope.result.structuredContent.error.code, "CONFLICT"); assert.equal(state.modifies.length, monthlyDeleteBefore + 1);
    const monthlyRetireArgs = { ...monthlyDeleteArgs, recurringDeletionScope: "all_future", recordChangeTag: monthlyRootAfter.recordChangeTag };
    const monthlyOrderingBefore = JSON.parse(state.records.get(listId).fields.ResolutionTokenMap.value).map.reminderIDsMergeableOrdering.counter;
    state.nextModify = "committed-500";
    const monthlyRetireLost = await mcp("tools/call", { name: "delete_reminder", arguments: monthlyRetireArgs });
    assert.equal(monthlyRetireLost.result.structuredContent.error.code, "WRITE_OUTCOME_UNKNOWN"); assert.equal(state.modifies.length, monthlyDeleteBefore + 2);
    const monthlyRetireReplay = await mcp("tools/call", { name: "delete_reminder", arguments: monthlyRetireArgs });
    assert.equal(monthlyRetireReplay.result.isError, undefined, JSON.stringify(monthlyRetireReplay.result)); assert.equal(monthlyRetireReplay.result.structuredContent.replayed, true);
    assert.equal(monthlyRetireReplay.result.structuredContent.record.deleted, true); assert.equal(monthlyRetireReplay.result.structuredContent.record.listId, null);
    assert.equal(monthlyRetireReplay.result.structuredContent.record.dueDate, "2030-11-30T00:00:00.000Z"); assert.deepEqual([...state.records.keys()].sort(), monthlyKeys);
    assert.deepEqual(state.records.get(monthlyDeleteFixture.rule.recordName).fields, { ...monthlyRuleBefore.fields, Deleted: field("INT64", 1) });
    assert.deepEqual(state.records.get(monthlyDeleteFixture.rule.recordName).parent, { ...monthlyRuleBefore.parent, zoneID: { zoneName: "Reminders", zoneType: "REGULAR_CUSTOM_ZONE", ownerRecordName: zoneOwner } });
    assert.equal(state.records.get(listId).fields.ReminderIDs.value, monthlyListFields.ReminderIDs.value);
    assert.equal(JSON.parse(state.records.get(listId).fields.ResolutionTokenMap.value).map.reminderIDsMergeableOrdering.counter, monthlyOrderingBefore + 1);
    assert.equal(state.modifies.length, monthlyDeleteBefore + 2);
    // Keep unrelated later journeys within the same deliberately bounded scan.
    const recurringDeleteFixtureIds = new Set([...state.records.keys()].filter(id => !beforeRecurringDeleteJourney.has(id)));
    for (const id of recurringDeleteFixtureIds) state.records.delete(id);
    const afterDeleteList = state.records.get(listId);
    afterDeleteList.fields.ReminderIDs = field("STRING", JSON.stringify(JSON.parse(afterDeleteList.fields.ReminderIDs.value).filter(id => !recurringDeleteFixtureIds.has(id.startsWith("Reminder/") ? id : `Reminder/${id}`))));


    const seedEndedDaily = (suffix, dueDate) => {
      const id = `Reminder/ENDED-DAILY-${suffix}`, ruleId = `RecurrenceRule/ENDED-DAILY-${suffix}`;
      const active = reminderRecord(id); active.parent = { recordName: listId };
      active.fields.AllDay = field("INT64", 1); active.fields.DueDate = field("TIMESTAMP", Date.parse(dueDate)); delete active.fields.TimeZone;
      active.fields.RecurrenceRuleIDs = field("STRING_LIST", [ruleId]);
      const rule = { ...state.records.get(recurrenceId), recordName: ruleId, recordChangeTag: `tag-${ruleId}`, fields: {
        ...state.records.get(recurrenceId).fields, Frequency: field("INT64", 0), EndDate: field("TIMESTAMP", Date.parse("2030-03-05T00:00:00Z")),
        Reminder: field("REFERENCE", { recordName: id, action: "VALIDATE", zoneID: active.zoneID }),
      } };
      state.records.set(id, active); state.records.set(ruleId, rule);
      const list = state.records.get(listId); list.fields.ReminderIDs = field("STRING", JSON.stringify([...JSON.parse(list.fields.ReminderIDs.value), id]));
      return { active, rule, args: { listId, reminderId: id, recordChangeTag: active.recordChangeTag, expectedGeneration: generation } };
    };
    for (const mode of ["recurring-rule-race", "recurring-list-race"]) {
      const { active, args } = seedEndedDaily(mode, "2030-03-05T00:00:00Z"), before = state.modifies.length;
      state.nextModify = mode;
      const staleFinal = await mcp("tools/call", { name: "complete_reminder", arguments: args });
      assert.equal(staleFinal.result.structuredContent.error.code, "CONFLICT");
      assert.equal(state.modifies.length, before + 1); assert.equal(state.records.get(active.recordName).fields.Completed.value, 0);
      assert.equal(state.modifies.at(-1).operationCount, 3); assert.equal(state.modifies.at(-1).historyId, undefined);
      const observedAtomicRejection = await mcp("tools/call", { name: "complete_reminder", arguments: args });
      assert.equal(observedAtomicRejection.result.structuredContent.error.code, "WRITE_OUTCOME_UNKNOWN");
      assert.equal(state.modifies.length, before + 1, "A definitively rejected retained request remains read-only on replay.");
    }
    const { active: endedDaily, rule: endedDailyRule, args: penultimateArgs } = seedEndedDaily("JOURNEY", "2030-03-04T00:00:00Z");
    const beforeDaily = state.modifies.length;
    endedDailyRule.fields.EndDate = field("TIMESTAMP", Date.parse("2030-03-05T09:00:00Z"));
    const unsupportedEnd = await mcp("tools/call", { name: "complete_reminder", arguments: penultimateArgs });
    assert.equal(unsupportedEnd.result.structuredContent.error.code, "UNSUPPORTED_FEATURE"); assert.equal(state.modifies.length, beforeDaily);
    endedDailyRule.fields.EndDate = field("TIMESTAMP", Date.parse("2030-03-05T00:00:00Z"));
    const staleDailyTag = await mcp("tools/call", { name: "complete_reminder", arguments: { ...penultimateArgs, recordChangeTag: "stale-daily-tag" } });
    assert.equal(staleDailyTag.result.structuredContent.error.code, "CONFLICT"); assert.equal(state.modifies.length, beforeDaily);
    const penultimateResponse = await mcp("tools/call", { name: "complete_reminder", arguments: penultimateArgs });
    assert.equal(penultimateResponse.result.isError, undefined, JSON.stringify(penultimateResponse.result));
    const penultimateDaily = penultimateResponse.result.structuredContent;
    assert.equal(penultimateDaily.record.completed, false); assert.equal(penultimateDaily.record.dueDate, "2030-03-05T00:00:00.000Z");
    assert.equal(penultimateDaily.completedOccurrence.dueDate, "2030-03-04T00:00:00.000Z"); assert.equal(state.modifies.length, beforeDaily + 1);
    const finalArgs = { ...penultimateArgs, recordChangeTag: state.records.get(endedDaily.recordName).recordChangeTag };
    const keysBeforeFinal = [...state.records.keys()].sort(), activeBeforeFinal = structuredClone(state.records.get(endedDaily.recordName));
    const ruleFieldsBeforeFinal = structuredClone(state.records.get(endedDailyRule.recordName).fields), listFieldsBeforeFinal = structuredClone(state.records.get(listId).fields);
    state.foreignZoneIds.add(listId);
    const foreignFinalList = await mcp("tools/call", { name: "complete_reminder", arguments: finalArgs });
    assert.equal(foreignFinalList.result.structuredContent.error.code, "PROTOCOL_CHANGED"); assert.equal(state.modifies.length, beforeDaily + 1);
    state.foreignZoneIds.delete(listId); state.omitLookupZoneIds.add(listId);
    state.nextModify = "committed-500";
    const lostFinal = await mcp("tools/call", { name: "complete_reminder", arguments: finalArgs });
    assert.equal(lostFinal.result.structuredContent.error.code, "WRITE_OUTCOME_UNKNOWN"); assert.equal(state.modifies.length, beforeDaily + 2);
    assert.deepEqual([...state.records.keys()].sort(), keysBeforeFinal); assert.equal(state.modifies.at(-1).operationCount, 3);
    const finalResponse = await mcp("tools/call", { name: "complete_reminder", arguments: finalArgs });
    assert.equal(finalResponse.result.isError, undefined, JSON.stringify(finalResponse.result));
    const completedDaily = finalResponse.result.structuredContent;
    assert.equal(completedDaily.replayed, true); assert.equal(completedDaily.record.completed, true); assert.equal(completedDaily.completedOccurrence, undefined);
    assert.equal(completedDaily.affectedRecords.length, 1); assert.equal(completedDaily.record.id, endedDaily.recordName);
    assert.equal(completedDaily.record.dueDate, "2030-03-05T00:00:00.000Z");
    assert.deepEqual(state.records.get(endedDailyRule.recordName).fields, ruleFieldsBeforeFinal); assert.deepEqual(state.records.get(listId).fields, listFieldsBeforeFinal);
    assert.deepEqual(JSON.parse(state.records.get(endedDaily.recordName).fields.ResolutionTokenMap.value).map.dueDate, JSON.parse(activeBeforeFinal.fields.ResolutionTokenMap.value).map.dueDate);
    assert.deepEqual(state.records.get(endedDaily.recordName).fields.RecurrenceRuleIDs, activeBeforeFinal.fields.RecurrenceRuleIDs);
    await mcp("tools/call", { name: "complete_reminder", arguments: finalArgs }); assert.equal(state.modifies.length, beforeDaily + 2);
    const reopenDailyArgs = { ...finalArgs, recordChangeTag: state.records.get(endedDaily.recordName).recordChangeTag };
    const reopenDailyResponse = await mcp("tools/call", { name: "reopen_reminder", arguments: reopenDailyArgs });
    assert.equal(reopenDailyResponse.result.isError, undefined, JSON.stringify(reopenDailyResponse.result));
    const reopenedDaily = reopenDailyResponse.result.structuredContent;
    assert.equal(reopenedDaily.operation, "reopen"); assert.equal(reopenedDaily.record.completed, false); assert.equal(reopenedDaily.record.completedDate, null);
    assert.equal(reopenedDaily.completedOccurrence, undefined); assert.equal(reopenedDaily.affectedRecords.length, 1);
    assert.equal(reopenedDaily.record.dueDate, "2030-03-05T00:00:00.000Z"); assert.equal(state.modifies.length, beforeDaily + 3);
    assert.deepEqual([...state.records.keys()].sort(), keysBeforeFinal);
    assert.deepEqual(state.records.get(endedDailyRule.recordName).fields, ruleFieldsBeforeFinal); assert.deepEqual(state.records.get(listId).fields, listFieldsBeforeFinal);
    const reopenedDailyReplay = await mcp("tools/call", { name: "reopen_reminder", arguments: reopenDailyArgs });
    assert.equal(reopenedDailyReplay.result.structuredContent.replayed, true); assert.equal(state.modifies.length, beforeDaily + 3);
    state.omitLookupZoneIds.delete(listId);

    const { active: calendarDaily, rule: calendarRule, args: calendarBaseArgs } = seedEndedDaily("CALENDAR", "2030-10-26T00:00:00Z");
    calendarRule.fields.EndDate = field("TIMESTAMP", Date.parse("2030-10-26T23:51:29Z"));
    const calendarArgs = { ...calendarBaseArgs, recurrenceCalendarTimeZone: "Europe/London" }, beforeCalendar = state.modifies.length;
    const omittedCalendar = await mcp("tools/call", { name: "complete_reminder", arguments: calendarBaseArgs });
    assert.equal(omittedCalendar.result.structuredContent.error.code, "UNSUPPORTED_FEATURE"); assert.equal(state.modifies.length, beforeCalendar);
    const invalidCalendar = await mcp("tools/call", { name: "complete_reminder", arguments: { ...calendarArgs, recurrenceCalendarTimeZone: "+01:00" } });
    assert.ok(invalidCalendar.result?.isError || invalidCalendar.error); assert.equal(state.modifies.length, beforeCalendar);
    state.nextModify = "committed-500";
    const lostCalendarAdvance = await mcp("tools/call", { name: "complete_reminder", arguments: calendarArgs });
    assert.equal(lostCalendarAdvance.result.structuredContent.error.code, "WRITE_OUTCOME_UNKNOWN"); assert.equal(state.modifies.length, beforeCalendar + 1);
    const calendarHistoryId = state.modifies.at(-1).historyId;
    for (const args of [calendarBaseArgs, { ...calendarArgs, recurrenceCalendarTimeZone: "UTC" }]) {
      const differentCalendar = await mcp("tools/call", { name: "complete_reminder", arguments: args });
      assert.equal(differentCalendar.result.structuredContent.error.code, "CONFLICT"); assert.equal(state.modifies.length, beforeCalendar + 1);
    }
    const calendarAdvanceResponse = await mcp("tools/call", { name: "complete_reminder", arguments: calendarArgs });
    assert.equal(calendarAdvanceResponse.result.isError, undefined, JSON.stringify(calendarAdvanceResponse.result));
    const calendarAdvanced = calendarAdvanceResponse.result.structuredContent;
    assert.equal(calendarAdvanced.replayed, true); assert.equal(calendarAdvanced.record.dueDate, "2030-10-27T00:00:00.000Z");
    assert.equal(calendarAdvanced.record.timeZone, null); assert.equal(calendarAdvanced.completedOccurrence.id, calendarHistoryId); assert.equal(state.modifies.length, beforeCalendar + 1);
    const calendarFinalArgs = { ...calendarArgs, recordChangeTag: state.records.get(calendarDaily.recordName).recordChangeTag };
    const wrongCalendarBoundary = await mcp("tools/call", { name: "complete_reminder", arguments: { ...calendarFinalArgs, recurrenceCalendarTimeZone: "UTC" } });
    assert.equal(wrongCalendarBoundary.result.structuredContent.error.code, "UNSUPPORTED_FEATURE"); assert.equal(state.modifies.length, beforeCalendar + 1);
    const calendarKeys = [...state.records.keys()].sort(), rawCalendarRule = structuredClone(state.records.get(calendarRule.recordName).fields);
    state.nextModify = "committed-500";
    const lostCalendarFinal = await mcp("tools/call", { name: "complete_reminder", arguments: calendarFinalArgs });
    assert.equal(lostCalendarFinal.result.structuredContent.error.code, "WRITE_OUTCOME_UNKNOWN"); assert.equal(state.modifies.length, beforeCalendar + 2);
    const calendarFinalResponse = await mcp("tools/call", { name: "complete_reminder", arguments: calendarFinalArgs });
    assert.equal(calendarFinalResponse.result.isError, undefined, JSON.stringify(calendarFinalResponse.result));
    assert.equal(calendarFinalResponse.result.structuredContent.replayed, true); assert.equal(calendarFinalResponse.result.structuredContent.record.completed, true);
    assert.equal(calendarFinalResponse.result.structuredContent.completedOccurrence, undefined); assert.equal(state.modifies.length, beforeCalendar + 2);
    assert.deepEqual([...state.records.keys()].sort(), calendarKeys); assert.deepEqual(state.records.get(calendarRule.recordName).fields, rawCalendarRule);
    const calendarReopenArgs = { ...calendarFinalArgs, recordChangeTag: state.records.get(calendarDaily.recordName).recordChangeTag };
    const wrongReopenCalendar = await mcp("tools/call", { name: "reopen_reminder", arguments: { ...calendarReopenArgs, recurrenceCalendarTimeZone: "UTC" } });
    assert.equal(wrongReopenCalendar.result.structuredContent.error.code, "UNSUPPORTED_FEATURE"); assert.equal(state.modifies.length, beforeCalendar + 2);
    const calendarReopenResponse = await mcp("tools/call", { name: "reopen_reminder", arguments: calendarReopenArgs });
    assert.equal(calendarReopenResponse.result.isError, undefined, JSON.stringify(calendarReopenResponse.result));
    assert.equal(calendarReopenResponse.result.structuredContent.record.completed, false); assert.equal(calendarReopenResponse.result.structuredContent.record.dueDate, "2030-10-27T00:00:00.000Z");
    const calendarReopenReplay = await mcp("tools/call", { name: "reopen_reminder", arguments: calendarReopenArgs });
    assert.equal(calendarReopenReplay.result.structuredContent.replayed, true); assert.equal(state.modifies.length, beforeCalendar + 3);
    assert.deepEqual([...state.records.keys()].sort(), calendarKeys); assert.deepEqual(state.records.get(calendarRule.recordName).fields, rawCalendarRule);

    const dateAlarmRoot = reminderRecord("Reminder/ORDINARY-DATE-LIFECYCLE"); dateAlarmRoot.parent = { recordName: listId };
    const dateAlarmId = `Alarm/${randomUUID().toUpperCase()}`, dateTriggerId = `AlarmTrigger/${randomUUID().toUpperCase()}`;
    dateAlarmRoot.fields.AlarmIDs = field("STRING_LIST", [dateAlarmId]);
    dateAlarmRoot.fields.ResolutionTokenMap = field("STRING", JSON.stringify({ map: { dueDate: { counter: 1, modificationTime: 1_600_000_000, replicaID: randomUUID().toUpperCase() } } }));
    const dateAlarm = { recordName: dateAlarmId, recordType: "Alarm", recordChangeTag: "ordinary-date-alarm-before", zoneID: dateAlarmRoot.zoneID, parent: { recordName: dateAlarmRoot.recordName }, fields: {
      AlarmUID: field("STRING", dateAlarmId.slice(6)), TriggerID: field("STRING", dateTriggerId.slice(13)), DueDateResolutionTokenAsNonce: field("DOUBLE", dueDateNonce(dateAlarmRoot.fields.ResolutionTokenMap.value)),
      Reminder: field("REFERENCE", { recordName: dateAlarmRoot.recordName, action: "VALIDATE", zoneID: dateAlarmRoot.zoneID }), Imported: field("INT64", 0), Deleted: field("INT64", 0),
    } };
    const dateTrigger = { recordName: dateTriggerId, recordType: "AlarmTrigger", recordChangeTag: "ordinary-date-trigger-before", zoneID: dateAlarmRoot.zoneID, parent: { recordName: dateAlarmId }, fields: {
      DateComponentsData: field("BYTES", Buffer.from(JSON.stringify(dateComponents("2030-03-04T09:15:00.000Z", "Europe/London"))).toString("base64")), Type: field("STRING", "Date"),
      Alarm: field("REFERENCE", { recordName: dateAlarmId, action: "VALIDATE", zoneID: dateAlarmRoot.zoneID }), Imported: field("INT64", 0), Deleted: field("INT64", 0),
    } };
    for (const record of [dateAlarmRoot, dateAlarm, dateTrigger]) state.records.set(record.recordName, record);
    state.records.get(listId).fields.ReminderIDs = field("STRING", JSON.stringify([...JSON.parse(state.records.get(listId).fields.ReminderIDs.value), dateAlarmRoot.recordName]));
    const dateArgs = { listId, reminderId: dateAlarmRoot.recordName, recordChangeTag: dateAlarmRoot.recordChangeTag, expectedGeneration: generation };
    const beforeDate = state.modifies.length;
    const nonce = dateAlarm.fields.DueDateResolutionTokenAsNonce;
    dateAlarm.fields.DueDateResolutionTokenAsNonce = field("DOUBLE", 0);
    const badDateNonce = await mcp("tools/call", { name: "complete_reminder", arguments: dateArgs });
    assert.equal(badDateNonce.result.structuredContent.error.code, "CONFLICT"); assert.equal(state.modifies.length, beforeDate); dateAlarm.fields.DueDateResolutionTokenAsNonce = nonce;
    dateAlarmRoot.fields.MysteryRelationship = field("REFERENCE", { recordName: "Reminder/OTHER", action: "VALIDATE" });
    const unknownDateRelationship = await mcp("tools/call", { name: "complete_reminder", arguments: dateArgs });
    assert.equal(unknownDateRelationship.result.structuredContent.error.code, "UNSUPPORTED_FEATURE"); assert.equal(state.modifies.length, beforeDate); delete dateAlarmRoot.fields.MysteryRelationship;
    state.foreignZoneIds.add(dateAlarmId);
    const foreignDateAlarm = await mcp("tools/call", { name: "complete_reminder", arguments: dateArgs });
    assert.equal(foreignDateAlarm.result.structuredContent.error.code, "PROTOCOL_CHANGED"); assert.equal(state.modifies.length, beforeDate); state.foreignZoneIds.delete(dateAlarmId);
    const alarmedChild = reminderRecord("Reminder/DATE-ROOT-CHILD"); alarmedChild.fields.ParentReminder = field("REFERENCE", { recordName: dateAlarmRoot.recordName, action: "VALIDATE" });
    alarmedChild.fields.DueDateDeltaAlertsData = field("BYTES", Buffer.from("synthetic-unrecognized-relative-payload").toString("base64"));
    state.records.set(alarmedChild.recordName, alarmedChild);
    const unsupportedDateFamily = await mcp("tools/call", { name: "complete_reminder", arguments: dateArgs });
    assert.equal(unsupportedDateFamily.result.structuredContent.error.code, "UNSUPPORTED_FEATURE"); assert.equal(state.modifies.length, beforeDate); state.records.delete(alarmedChild.recordName);
    for (const mode of ["date-alarm-alarm-race", "date-alarm-list-race"]) {
      state.nextModify = mode;
      const racedDate = await mcp("tools/call", { name: "complete_reminder", arguments: dateArgs });
      assert.equal(racedDate.result.structuredContent.error.code, "CONFLICT"); assert.equal(state.records.get(dateAlarmRoot.recordName).fields.Completed.value, 0);
    }
    const beforeDateCommit = state.modifies.length, datePairBefore = [structuredClone(state.records.get(dateAlarmId)), structuredClone(state.records.get(dateTriggerId))];
    const keysBeforeDate = [...state.records.keys()].sort();
    for (const id of [listId, dateAlarmId, dateTriggerId]) state.omitLookupZoneIds.add(id);
    state.nextModify = "committed-500";
    const lostDateComplete = await mcp("tools/call", { name: "complete_reminder", arguments: dateArgs });
    assert.equal(lostDateComplete.result.structuredContent.error.code, "WRITE_OUTCOME_UNKNOWN"); assert.equal(state.modifies.length, beforeDateCommit + 1);
    const oldDateArgs = await mcp("tools/call", { name: "complete_reminder", arguments: dateArgs });
    assert.equal(oldDateArgs.result.structuredContent.error.code, "CONFLICT"); assert.equal(state.modifies.length, beforeDateCommit + 1);
    const completedDateRead = await mcp("tools/call", { name: "get_reminder", arguments: { listId, reminderId: dateAlarmRoot.recordName } });
    assert.equal(completedDateRead.result.structuredContent.record.completed, true);
    const dateReopenArgs = { ...dateArgs, recordChangeTag: state.records.get(dateAlarmRoot.recordName).recordChangeTag };
    const reopenedDateResponse = await mcp("tools/call", { name: "reopen_reminder", arguments: dateReopenArgs });
    assert.equal(reopenedDateResponse.result.isError, undefined, JSON.stringify(reopenedDateResponse.result));
    assert.equal(reopenedDateResponse.result.structuredContent.record.completed, false);
    assert.equal(reopenedDateResponse.result.structuredContent.record.dueDate, "2030-03-04T09:15:00.000Z");
    for (const before of datePairBefore) { assert.deepEqual(state.records.get(before.recordName).fields, before.fields); assert.deepEqual(state.records.get(before.recordName).parent, before.parent); }
    const dateDeleteArgs = { ...dateArgs, recordChangeTag: state.records.get(dateAlarmRoot.recordName).recordChangeTag };
    const deletedDateResponse = await mcp("tools/call", { name: "delete_reminder", arguments: dateDeleteArgs });
    assert.equal(deletedDateResponse.result.isError, undefined, JSON.stringify(deletedDateResponse.result));
    assert.equal(deletedDateResponse.result.structuredContent.record.deleted, true); assert.equal(deletedDateResponse.result.structuredContent.record.listId, null);
    assert.deepEqual([...state.records.keys()].sort(), keysBeforeDate);
    for (const before of datePairBefore) {
      assert.deepEqual(state.records.get(before.recordName).fields, { ...before.fields, Deleted: field("INT64", 1) });
      assert.deepEqual(state.records.get(before.recordName).parent, before.parent);
    }
    assert.equal(state.records.get(dateAlarmRoot.recordName).parent, undefined);
    const oldDateDelete = await mcp("tools/call", { name: "delete_reminder", arguments: dateDeleteArgs });
    assert.equal(oldDateDelete.result.structuredContent.error.code, "CONFLICT"); assert.equal(state.modifies.length, beforeDateCommit + 3);
    for (const id of [listId, dateAlarmId, dateTriggerId]) state.omitLookupZoneIds.delete(id);
    const parentReceiptRoot = structuredClone(dateAlarmRoot); parentReceiptRoot.recordName = "Reminder/DATE-PARENT-RECEIPT"; parentReceiptRoot.recordChangeTag = "parent-receipt-before";
    const parentReceiptAlarm = structuredClone(dateAlarm), parentReceiptTrigger = structuredClone(dateTrigger);
    parentReceiptAlarm.recordName = `Alarm/${randomUUID().toUpperCase()}`; parentReceiptTrigger.recordName = `AlarmTrigger/${randomUUID().toUpperCase()}`;
    parentReceiptRoot.fields.AlarmIDs = field("STRING_LIST", [parentReceiptAlarm.recordName]);
    parentReceiptAlarm.parent = { recordName: parentReceiptRoot.recordName }; parentReceiptAlarm.fields.Reminder.value.recordName = parentReceiptRoot.recordName;
    parentReceiptAlarm.fields.AlarmUID.value = parentReceiptAlarm.recordName.slice(6); parentReceiptAlarm.fields.TriggerID.value = parentReceiptTrigger.recordName.slice(13);
    parentReceiptTrigger.parent = { recordName: parentReceiptAlarm.recordName }; parentReceiptTrigger.fields.Alarm.value.recordName = parentReceiptAlarm.recordName;
    for (const record of [parentReceiptRoot, parentReceiptAlarm, parentReceiptTrigger]) state.records.set(record.recordName, record);
    const parentReceiptArgs = { ...dateArgs, reminderId: parentReceiptRoot.recordName, recordChangeTag: parentReceiptRoot.recordChangeTag }, beforeParentReceipt = state.modifies.length;
    state.nextModify = "date-alarm-parent-drift";
    const wrongPairParent = await mcp("tools/call", { name: "complete_reminder", arguments: parentReceiptArgs });
    assert.equal(wrongPairParent.result.structuredContent.error.code, "WRITE_OUTCOME_UNKNOWN"); assert.equal(state.modifies.length, beforeParentReceipt + 1);
    const wrongPairParentReplay = await mcp("tools/call", { name: "complete_reminder", arguments: parentReceiptArgs });
    assert.equal(wrongPairParentReplay.result.structuredContent.error.code, "CONFLICT"); assert.equal(state.modifies.length, beforeParentReceipt + 1);

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
      if (reply.result.isError) throw Object.assign(new Error(JSON.stringify(reply.result)), { code: reply.result.structuredContent?.error?.code });
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
    for (const mode of ["signed-asset-checksum-drift", "signed-asset-wrapping-drift"]) {
      state.nextModify = mode;
      const count = state.modifies.length;
      const rejected = await mcp("tools/call", { name: "update_reminder", arguments: { listId, reminderId,
        recordChangeTag: state.records.get(reminderId).recordChangeTag, changes: { title: `Receipt ${mode}` }, expectedGeneration: generation } });
      assert.equal(rejected.result.structuredContent.error.code, "WRITE_OUTCOME_UNKNOWN");
      assert.equal(state.modifies.length, count + 1);
    }

    // Creating an early alarm copies only validated account metadata from an exact same-list source and atomically guards it.
    const accountIdentifier = "8a187515-3b92-4658-a9d0-815b5fd95a52";
    const earlySourceId = "Reminder/62C454A0-052A-486A-8325-C05F76215D16";
    const earlyTargetId = "Reminder/8E1C9422-9FA4-4D6B-9E6D-25D796196CE4";
    const earlyRaceId = "Reminder/28466777-079D-49F5-B217-BD8E45184B5D";
    const earlyAlarmId = "Alarm/EARLY-SOURCE-ALARM";
    const earlyTriggerUuid = "3c48b583-32f2-4b25-adb2-16be6b21f0a4";
    const earlySource = reminderRecord(earlySourceId);
    earlySource.fields.AllDay = field("INT64", 1);
    earlySource.fields.DueDate = field("TIMESTAMP", Date.parse("2030-03-04T00:00:00.000Z"));
    earlySource.fields.TimeZone = field("STRING", null);
    earlySource.fields.AlarmIDs = field("STRING_LIST", [earlyAlarmId]);
    const { field: sourcePayloadField, payload: sourcePayload } = earlyPayloadField(earlySourceId, accountIdentifier, { unit: 4, count: -1 });
    earlySource.fields.DueDateDeltaAlertsData = sourcePayloadField;
    state.records.set(earlyAlarmId, { recordName: earlyAlarmId, recordType: "Alarm", recordChangeTag: "early-source-alarm-tag",
      zoneID: { zoneName: "Reminders", zoneType: "REGULAR_CUSTOM_ZONE", ownerRecordName: zoneOwner },
      fields: { Deleted: field("INT64", 0), TriggerID: field("STRING", earlyTriggerUuid) } });
    state.records.set("AlarmTrigger/" + earlyTriggerUuid, { recordName: "AlarmTrigger/" + earlyTriggerUuid, recordType: "AlarmTrigger", recordChangeTag: "early-source-trigger-tag",
      zoneID: { zoneName: "Reminders", zoneType: "REGULAR_CUSTOM_ZONE", ownerRecordName: zoneOwner }, fields: { Deleted: field("INT64", 0) } });
    const earlyTarget = reminderRecord(earlyTargetId);
    earlyTarget.fields.AllDay = field("INT64", 1);
    earlyTarget.fields.DueDate = field("TIMESTAMP", Date.parse("2030-03-04T00:00:00.000Z"));
    earlyTarget.fields.TimeZone = field("STRING", null);
    state.records.set(earlySourceId, earlySource);
    // Native lookup omits the source record's zoneID; the exact list query and
    // target lookup already establish the authenticated private Reminders zone.
    state.omitLookupZoneIds.add(earlySourceId);
    state.records.set(earlyTargetId, earlyTarget);
    const earlyRequest = { listId, reminderId: earlyTargetId, recordChangeTag: earlyTarget.recordChangeTag,
      changes: { earlyReminder: { unit: "weeks", count: 1 } }, expectedGeneration: generation };
    const beforeEarlyPreview = state.modifies.length;
    const earlyPreview = await invoke("prepare_reminder_update", earlyRequest);
    assert.equal(earlyPreview.supported, true, earlyPreview.unsupportedReason ?? "");
    assert.equal(earlyPreview.after.earlyReminder.unit, "weeks");
    assert.equal(state.modifies.length, beforeEarlyPreview);
    const sourceFieldsBefore = structuredClone(earlySource.fields);
    const earlyCreated = await invoke("update_reminder", { ...earlyRequest, preparationToken: earlyPreview.preparationToken });
    assert.equal(earlyCreated.record.allDay, true, "A dated all-day target can receive an early reminder.");
    assert.equal(state.modifies.at(-1).earlyReminderGroup, true);
    assert.equal(state.modifies.at(-1).operationCount, 2);
    const createdPayload = JSON.parse(Buffer.from(state.records.get(earlyTargetId).fields.DueDateDeltaAlertsData.value, "base64").toString("utf8"));
    assert.equal(createdPayload.reminderIdentifier, earlyTargetId.slice("Reminder/".length));
    assert.equal(createdPayload.accountIdentifier, accountIdentifier);
    assert.equal(createdPayload.minimumSupportedVersion, 20230430);
    assert.equal(createdPayload.dueDateDeltaAlerts[0].dueDateDeltaUnit, 3);
    assert.equal(createdPayload.dueDateDeltaAlerts[0].dueDateDeltaCount, -1);
    assert.notEqual(createdPayload.dueDateDeltaAlerts[0].identifier, sourcePayload.dueDateDeltaAlerts[0].identifier);
    assert.deepEqual(state.records.get(earlySourceId).fields, sourceFieldsBefore, "The metadata source guard must not change source fields.");
    assert.ok(!JSON.stringify(earlyCreated).includes(accountIdentifier), "Private account metadata must not leave the Apple write payload.");

    const earlyForeignTarget = reminderRecord("Reminder/8FA06F35-D472-4496-A8DE-771F8D3BE288");
    state.records.set(earlyForeignTarget.recordName, earlyForeignTarget);
    state.foreignZoneIds.add(earlySourceId);
    const beforeForeignZone = state.modifies.length;
    const foreignZonePreview = await mcp("tools/call", { name: "prepare_reminder_update", arguments: { listId, reminderId: earlyForeignTarget.recordName,
      recordChangeTag: earlyForeignTarget.recordChangeTag, changes: { earlyReminder: { unit: "hours", count: 1 } }, expectedGeneration: generation } });
    assert.equal(foreignZonePreview.result.structuredContent.error.code, "PROTOCOL_CHANGED", "An explicit foreign source owner must be refused.");
    assert.equal(state.modifies.length, beforeForeignZone);
    state.foreignZoneIds.delete(earlySourceId);

    const earlyRace = reminderRecord(earlyRaceId);
    state.records.set(earlyRaceId, earlyRace);
    const earlyRaceBefore = structuredClone(earlyRace);
    state.nextModify = "early-source-race";
    const earlyRaceReply = await mcp("tools/call", { name: "update_reminder", arguments: { ...earlyRequest, reminderId: earlyRaceId,
      recordChangeTag: earlyRace.recordChangeTag, preparationToken: undefined } });
    assert.equal(earlyRaceReply.result.structuredContent.error.code, "CONFLICT");
    assert.deepEqual(state.records.get(earlyRaceId), earlyRaceBefore, "A concurrent source version change must reject the atomic write without changing its target.");

    // A valid source in another list cannot supply metadata when the selected list has none.
    state.records.delete(earlySourceId); state.records.delete(earlyTargetId); state.records.delete(earlyRaceId); state.records.delete(earlyForeignTarget.recordName);
    state.records.delete(earlyAlarmId); state.records.delete("AlarmTrigger/" + earlyTriggerUuid); state.omitLookupZoneIds.delete(earlySourceId);
    const otherListId = "List/WRITE-OTHER-SOURCE";
    state.records.set(otherListId, { ...listRecord(), recordName: otherListId });
    const crossListSource = reminderRecord("Reminder/DA4F3D41-9D2C-4E88-A80D-3E7CFF17453F");
    crossListSource.fields.List = field("REFERENCE", { recordName: otherListId, action: "VALIDATE", zoneID: { zoneName: "Reminders", ownerRecordName: zoneOwner } });
    crossListSource.fields.DueDateDeltaAlertsData = earlyPayloadField(crossListSource.recordName, accountIdentifier).field;
    const crossListTarget = reminderRecord("Reminder/7531E813-2CC9-4A89-953D-8CF28C189A44");
    state.records.set(crossListSource.recordName, crossListSource);
    state.records.set(crossListTarget.recordName, crossListTarget);
    const crossListRequest = { listId, reminderId: crossListTarget.recordName, recordChangeTag: crossListTarget.recordChangeTag,
      changes: { earlyReminder: { unit: "days", count: 1 } }, expectedGeneration: generation };
    const beforeNoSource = state.modifies.length;
    const noSourcePreview = await invoke("prepare_reminder_update", crossListRequest);
    assert.equal(noSourcePreview.supported, false);
    assert.match(noSourcePreview.unsupportedReason, /this list/);
    const noSourceMutation = await mcp("tools/call", { name: "update_reminder", arguments: crossListRequest });
    assert.equal(noSourceMutation.result.structuredContent.error.code, "UNSUPPORTED_FEATURE");
    assert.equal(state.modifies.length, beforeNoSource, "Cross-list metadata must never produce an Apple write.");

    // Organization edits and transfers stay atomic across the root, linked records, and List membership.
    const organizationListId = "List/ORG-SOURCE";
    const organizationDestinationId = "List/ORG-DESTINATION";
    const organizationCopyListId = "List/ORG-COPY-DESTINATION";
    const organizationLostAckListId = "List/ORG-LOST-ACK-DESTINATION";
    const organizationReminderId = "Reminder/9B7634D4-1517-4AA8-9A50-74AC3BAE4A54";
    const organizationUrlId = "Attachment/11111111-2222-4333-8444-555555555555";
    const keepTagId = "Hashtag/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const removeTagId = "Hashtag/bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
    const sourceListMember = organizationReminderId.slice("Reminder/".length);
    state.records.set(organizationListId, listRecord(organizationListId, [sourceListMember]));
    state.records.set(organizationDestinationId, listRecord(organizationDestinationId));
    state.records.set(organizationCopyListId, listRecord(organizationCopyListId));
    state.records.set(organizationLostAckListId, listRecord(organizationLostAckListId));
    const organizationReminder = reminderRecord(organizationReminderId);
    organizationReminder.fields.List = field("REFERENCE", { recordName: organizationListId, action: "VALIDATE", zoneID: { zoneName: "Reminders", ownerRecordName: zoneOwner } });
    organizationReminder.fields.DueDate = field("TIMESTAMP", null);
    organizationReminder.fields.TimeZone = field("STRING", null);
    organizationReminder.fields.StartDate = field("TIMESTAMP", null);
    organizationReminder.fields.AttachmentIDs = field("STRING_LIST", [organizationUrlId.slice("Attachment/".length)]);
    organizationReminder.fields.HashtagIDs = field("STRING_LIST", [keepTagId.slice("Hashtag/".length), removeTagId.slice("Hashtag/".length)]);
    organizationReminder.parent = { recordName: organizationListId };
    state.records.set(organizationReminderId, organizationReminder);
    const backlink = { type: "REFERENCE", value: { recordName: organizationReminderId, action: "VALIDATE" } };
    state.records.set(organizationUrlId, { recordName: organizationUrlId, recordType: "Attachment", recordChangeTag: "organization-url-v1",
      zoneID: organizationReminder.zoneID, fields: { Type: field("STRING", "URL"), UTI: field("STRING", "public.url"), Imported: field("INT64", 0),
        Deleted: field("INT64", 0), URL: { ...field("STRING", "https://example.invalid/original"), isEncrypted: true }, Reminder: backlink } });
    const makeTag = (id, name, version) => ({ recordName: id, recordType: "Hashtag", recordChangeTag: version,
      zoneID: organizationReminder.zoneID, fields: { CreationDate: field("TIMESTAMP", 1_700_000_000_000), Type: field("INT64", 0),
        Imported: field("INT64", 0), Deleted: field("INT64", 0), Name: { ...field("STRING", name), isEncrypted: true }, Reminder: backlink } });
    state.records.set(keepTagId, makeTag(keepTagId, "Keep", "organization-tag-keep-v1"));
    state.records.set(removeTagId, makeTag(removeTagId, "Remove", "organization-tag-remove-v1"));
    const organizationTarget = async () => (await invoke("get_reminder", { listId: state.records.get(organizationReminderId).fields.List.value.recordName, reminderId: organizationReminderId })).record;
    const organizationMutationTarget = async () => ({ listId: organizationListId, reminderId: organizationReminderId,
      recordChangeTag: (await organizationTarget()).recordChangeTag, expectedGeneration: generation });
    const organizationView = await invoke("get_reminder_organization", { listId: organizationListId, reminderId: organizationReminderId, expectedGeneration: generation });
    assert.equal(organizationView.url.url, "https://example.invalid/original");
    assert.equal(organizationView.url.id, organizationUrlId);
    assert.deepEqual(organizationView.tags.map(tag => tag.name), ["Keep", "Remove"]);
    assert.deepEqual(organizationView.otherAttachmentIds, []);
    assert.ok(!JSON.stringify(organizationView).includes(opaqueMetadata));

    const beforeOrganizationInspection = state.modifies.length;
    const inspectOrganization = async () => invoke("inspect_reminder", { listId: organizationListId, reminderId: organizationReminderId, expectedGeneration: generation });
    const inspection = await inspectOrganization();
    assert.equal(inspection.inspectionOnly, true);
    assert.equal(inspection.record.id, organizationReminderId);
    assert.equal(inspection.schedule.status, "known");
    assert.deepEqual([inspection.schedule.recurrence, inspection.schedule.earlyReminder, inspection.schedule.locationAlarm], [null, null, null]);
    assert.equal(inspection.organization.status, "known");
    assert.equal(inspection.organization.url.url, "https://example.invalid/original");
    assert.deepEqual(inspection.organization.tags.map(tag => tag.name), ["Keep", "Remove"]);
    assert.equal(inspection.category.status, "not_applicable");
    assert.equal(inspection.actions.move.status, "requires_input");
    assert.equal(inspection.actions.copy.status, "requires_input");
    assert.ok(inspection.actions.copy.requiredInputs.includes("destinationListChangeTag"));
    assert.ok(!JSON.stringify(inspection).includes(opaqueMetadata));
    const apiInspectionReply = await request("/api/reminders/inspect", { method: "POST", body: { listId: organizationListId, reminderId: organizationReminderId, expectedGeneration: generation } });
    assert.equal(apiInspectionReply.status, 200);
    assert.deepEqual((await apiInspectionReply.json()).organization, inspection.organization);
    const missingGenerationInspection = await request("/api/reminders/inspect", { method: "POST", body: { listId: organizationListId, reminderId: organizationReminderId } });
    assert.equal((await missingGenerationInspection.json()).error.code, "VALIDATION_ERROR");
    organizationReminder.fields.DueDateDeltaAlertsData = field("ENCRYPTED_BYTES", "synthetic-unclassified-private-payload");
    const unknownScheduleInspection = await inspectOrganization();
    assert.equal(unknownScheduleInspection.schedule.status, "unknown");
    assert.equal(unknownScheduleInspection.actions.update.status, "requires_input");
    assert.equal(unknownScheduleInspection.actions.move.status, "unsupported");
    assert.ok(!JSON.stringify(unknownScheduleInspection).includes("synthetic-unclassified-private-payload"));
    organizationReminder.fields.DueDateDeltaAlertsData = field("ENCRYPTED_BYTES", null);
    assert.equal((await inspectOrganization()).schedule.status, "known", "A cleared native early payload is known absence.");
    delete organizationReminder.fields.DueDateDeltaAlertsData;
    state.records.delete(organizationUrlId);
    const unresolvedOrganization = await inspectOrganization();
    assert.equal(unresolvedOrganization.organization.status, "unknown");
    assert.equal(unresolvedOrganization.actions.copy.status, "unsupported", "Unresolved URL data cannot become transfer eligibility.");
    state.records.set(organizationUrlId, { recordName: organizationUrlId, recordType: "Attachment", recordChangeTag: "organization-url-v1",
      zoneID: organizationReminder.zoneID, fields: { Type: field("STRING", "URL"), UTI: field("STRING", "public.url"), Imported: field("INT64", 0),
        Deleted: field("INT64", 0), URL: { ...field("STRING", "https://example.invalid/original"), isEncrypted: true }, Reminder: backlink } });
    assert.equal(state.modifies.length, beforeOrganizationInspection, "Inspection performs no Apple mutation or asset upload.");

    const originalOrganizationRoot = structuredClone(state.records.get(organizationReminderId));
    const urlResult = await invoke("set_reminder_url", { ...(await organizationMutationTarget()), url: "https://example.invalid/updated" });
    const updatedURLId = `Attachment/${state.records.get(organizationReminderId).fields.AttachmentIDs.value[0]}`;
    assert.equal(urlResult.record.id, organizationReminderId);
    assert.notEqual(updatedURLId, organizationUrlId, "Replacing a URL creates a fresh linked attachment identity.");
    assert.equal(state.records.get(updatedURLId).fields.URL.value, "https://example.invalid/updated");
    assert.equal(state.records.get(updatedURLId).fields.URL.isEncrypted, true);
    assert.equal(state.records.get(updatedURLId).fields.Reminder.value.recordName, organizationReminderId);
    assert.equal(state.records.get(organizationUrlId).fields.Deleted.value, 1);
    assert.equal(state.records.get(organizationUrlId).fields.Reminder.value, null);
    assert.equal(state.records.get(organizationReminderId).fields.NotesDocument.value, originalOrganizationRoot.fields.NotesDocument.value);

    const initialTags = await invoke("get_reminder_organization", { listId: organizationListId, reminderId: organizationReminderId, expectedGeneration: generation });
    const tagResult = await invoke("set_reminder_tags", { ...(await organizationMutationTarget()), tags: ["Keep", "Added"] });
    const afterTagEdit = await invoke("get_reminder_organization", { listId: organizationListId, reminderId: organizationReminderId, expectedGeneration: generation });
    assert.deepEqual(afterTagEdit.tags.map(tag => tag.name), ["Keep", "Added"]);
    const addedTag = afterTagEdit.tags.find(tag => tag.name === "Added");
    assert.ok(addedTag && !initialTags.tags.some(tag => tag.id === addedTag.id), "New tags receive fresh linked identities.");
    assert.equal(state.records.get(removeTagId).fields.Deleted.value, 1);
    assert.equal(state.records.get(removeTagId).fields.Reminder.value, null);
    assert.equal(state.records.get(addedTag.id).fields.Name.isEncrypted, true);
    assert.equal(tagResult.record.recordChangeTag, state.records.get(organizationReminderId).recordChangeTag);

    const rootBeforeRelatedRace = structuredClone(state.records.get(organizationReminderId));
    const addedBeforeRelatedRace = structuredClone(state.records.get(addedTag.id));
    const modifyCountBeforeRelatedRace = state.modifies.length;
    state.nextModify = "related-version-race";
    const relatedRace = await mcp("tools/call", { name: "set_reminder_tags", arguments: {
      ...(await organizationMutationTarget()), tags: ["Keep", "Fresh"],
    } });
    assert.equal(relatedRace.result.structuredContent.error.code, "CONFLICT");
    assert.equal(state.modifies.length, modifyCountBeforeRelatedRace + 1);
    assert.equal(state.records.get(organizationReminderId).recordChangeTag, rootBeforeRelatedRace.recordChangeTag);
    assert.deepEqual(state.records.get(organizationReminderId).fields.HashtagIDs, rootBeforeRelatedRace.fields.HashtagIDs,
      "A raced retained tag rejects the root unlink/link as one atomic group.");
    assert.deepEqual(state.records.get(addedTag.id).fields, addedBeforeRelatedRace.fields, "A rejected tag replacement does not retire another tag.");
    assert.equal([...state.records.values()].some(record => record.recordType === "Hashtag" && record.fields.Name?.value === "Fresh"), false,
      "A rejected tag replacement does not create its new related record.");

    const tagRetry = await invoke("set_reminder_tags", { ...(await organizationMutationTarget()), tags: ["Keep", "Fresh"] });
    assert.deepEqual((await invoke("get_reminder_organization", { listId: organizationListId, reminderId: organizationReminderId,
      expectedGeneration: generation })).tags.map(tag => tag.name), ["Keep", "Fresh"]);
    assert.equal(state.records.get(addedTag.id).fields.Deleted.value, 1);
    assert.equal(tagRetry.record.recordChangeTag, state.records.get(organizationReminderId).recordChangeTag);

    const snapshotList = async id => (await invoke("get_reminder_list", { listId: id, expectedGeneration: generation })).list;
    const beforeMoveRoot = await organizationTarget();
    const beforeMoveSourceList = await snapshotList(organizationListId);
    const beforeMoveDestinationList = await snapshotList(organizationDestinationId);
    const moveArgs = { listId: organizationListId, reminderId: organizationReminderId, recordChangeTag: beforeMoveRoot.recordChangeTag,
      destinationListId: organizationDestinationId, sourceListChangeTag: beforeMoveSourceList.recordChangeTag,
      destinationListChangeTag: beforeMoveDestinationList.recordChangeTag, expectedGeneration: generation };
    const sourceMembershipBeforeRace = state.records.get(organizationListId).fields.ReminderIDs.value;
    const destinationMembershipBeforeRace = state.records.get(organizationDestinationId).fields.ReminderIDs.value;
    const beforeMoveModifyCount = state.modifies.length;
    state.nextModify = "transfer-list-race";
    const listRace = await mcp("tools/call", { name: "move_reminder", arguments: moveArgs });
    assert.equal(listRace.result.structuredContent.error.code, "CONFLICT");
    assert.equal(state.modifies.length, beforeMoveModifyCount + 1);
    assert.equal(state.records.get(organizationReminderId).fields.List.value.recordName, organizationListId);
    assert.equal(state.records.get(organizationListId).fields.ReminderIDs.value, sourceMembershipBeforeRace);
    assert.equal(state.records.get(organizationDestinationId).fields.ReminderIDs.value, destinationMembershipBeforeRace,
      "A stale destination List version rejects both membership changes and the Reminder move.");

    const refreshedMoveSource = await snapshotList(organizationListId);
    const refreshedMoveDestination = await snapshotList(organizationDestinationId);
    const moved = await invoke("move_reminder", { ...moveArgs, recordChangeTag: (await organizationTarget()).recordChangeTag,
      sourceListChangeTag: refreshedMoveSource.recordChangeTag, destinationListChangeTag: refreshedMoveDestination.recordChangeTag });
    assert.equal(moved.record.listId, organizationDestinationId);
    assert.equal(state.records.get(organizationReminderId).parent.recordName, organizationDestinationId,
      "The atomic response and local Apple fixture retain the native parent supplied by the transfer.");
    assert.deepEqual(JSON.parse(state.records.get(organizationListId).fields.ReminderIDs.value), []);
    assert.deepEqual(JSON.parse(state.records.get(organizationDestinationId).fields.ReminderIDs.value), [sourceListMember]);
    assert.deepEqual(state.records.get(organizationReminderId).fields.HashtagIDs.value.map(id => `Hashtag/${id}`).map(id => state.records.get(id).fields.Name.value),
      ["Keep", "Fresh"], "Moving preserves the existing native tag links.");

    const copySource = await organizationTarget();
    const copySourceList = await snapshotList(organizationDestinationId);
    const copyDestinationList = await snapshotList(organizationCopyListId);
    const sourceRelatedIds = [updatedURLId, ...state.records.get(organizationReminderId).fields.HashtagIDs.value.map(id => `Hashtag/${id}`)];
    const guardTagsBeforeCopy = new Map([organizationReminderId, organizationDestinationId, ...sourceRelatedIds]
      .map(id => [id, state.records.get(id).recordChangeTag]));
    const copyKey = randomUUID();
    const copyArgs = { listId: organizationDestinationId, reminderId: organizationReminderId, recordChangeTag: copySource.recordChangeTag,
      destinationListId: organizationCopyListId, sourceListChangeTag: copySourceList.recordChangeTag,
      destinationListChangeTag: copyDestinationList.recordChangeTag, idempotencyKey: copyKey, expectedGeneration: generation };
    const copied = await invoke("copy_reminder", copyArgs);
    const copiedId = `Reminder/${copyKey.toUpperCase()}`;
    assert.equal(copied.record.id, copiedId);
    assert.equal(copied.idempotencyKey, copyKey);
    assert.notEqual(state.records.get(copiedId).parent.recordName, organizationDestinationId);
    assert.equal(state.records.get(copiedId).parent.recordName, organizationCopyListId);
    const copiedURLId = `Attachment/${state.records.get(copiedId).fields.AttachmentIDs.value[0]}`;
    const copiedTagIds = state.records.get(copiedId).fields.HashtagIDs.value.map(id => `Hashtag/${id}`);
    assert.notEqual(copiedURLId, updatedURLId, "A copied URL receives a fresh Attachment identity.");
    assert.ok(copiedTagIds.every(id => !sourceRelatedIds.includes(id)), "Copied tags receive fresh Hashtag identities.");
    assert.equal(state.records.get(copiedURLId).fields.URL.value, state.records.get(updatedURLId).fields.URL.value);
    assert.equal(state.records.get(copiedURLId).fields.Reminder.value.recordName, copiedId);
    assert.deepEqual(copiedTagIds.map(id => state.records.get(id).fields.Name.value), ["Keep", "Fresh"]);
    for (const [id, previousTag] of guardTagsBeforeCopy) assert.notEqual(state.records.get(id).recordChangeTag, previousTag,
      `The atomic copy must version-guard and advance ${id}.`);
    const modifyCountAfterCopy = state.modifies.length;
    const copyReplay = await invoke("copy_reminder", copyArgs);
    assert.equal(copyReplay.replayed, true);
    assert.equal(state.modifies.length, modifyCountAfterCopy,
      "An identical copy replays without Apple writes even after source, list, and related guards advanced.");
    const changedCopyInput = await mcp("tools/call", { name: "copy_reminder", arguments: { ...copyArgs,
      recordChangeTag: (await organizationTarget()).recordChangeTag,
      sourceListChangeTag: (await snapshotList(organizationDestinationId)).recordChangeTag,
      destinationListId: organizationLostAckListId,
      destinationListChangeTag: (await snapshotList(organizationLostAckListId)).recordChangeTag,
    } });
    assert.equal(changedCopyInput.result.structuredContent.error.code, "CONFLICT");
    assert.equal(state.modifies.length, modifyCountAfterCopy, "A copy key cannot be reused for changed input.");

    const lostAckKey = randomUUID();
    const lostAckDestination = await snapshotList(organizationLostAckListId);
    const lostAckArgs = { ...copyArgs, recordChangeTag: (await organizationTarget()).recordChangeTag,
      sourceListChangeTag: (await snapshotList(organizationDestinationId)).recordChangeTag, destinationListId: organizationLostAckListId,
      destinationListChangeTag: lostAckDestination.recordChangeTag, idempotencyKey: lostAckKey };
    const beforeLostAck = state.modifies.length;
    state.nextModify = "committed-network-drop";
    const lostAck = await mcp("tools/call", { name: "copy_reminder", arguments: lostAckArgs });
    assert.equal(lostAck.result.structuredContent.error.code, "WRITE_OUTCOME_UNKNOWN");
    assert.equal(lostAck.result.structuredContent.error.idempotencyKey, lostAckKey);
    assert.equal(state.modifies.length, beforeLostAck + 1);
    const lostAckReplay = await invoke("copy_reminder", lostAckArgs);
    assert.equal(lostAckReplay.replayed, true);
    assert.equal(state.modifies.length, beforeLostAck + 1,
      "A lost copy acknowledgement is reconciled with its same key and never resubmitted.");

    // Native empty relationships are untyped until their first member. URL
    // edits and moves must preserve an untouched UNKNOWN_LIST representation.
    const emptyId = "Reminder/7A6C6A09-1A9D-4D57-8643-30A851409650";
    const emptyRoot = reminderRecord(emptyId);
    emptyRoot.fields.List.value.recordName = organizationListId;
    emptyRoot.fields.DueDate.value = null; emptyRoot.fields.TimeZone.value = null;
    emptyRoot.fields.AttachmentIDs = field("UNKNOWN_LIST", []);
    emptyRoot.fields.HashtagIDs = field("UNKNOWN_LIST", []);
    state.records.set(emptyId, emptyRoot);
    state.records.get(organizationListId).fields.ReminderIDs.value = JSON.stringify([emptyId.slice("Reminder/".length)]);
    const emptyURL = await invoke("set_reminder_url", { listId: organizationListId, reminderId: emptyId,
      recordChangeTag: emptyRoot.recordChangeTag, url: "https://example.invalid/first-url", expectedGeneration: generation });
    assert.equal(state.records.get(emptyId).fields.HashtagIDs.type, "UNKNOWN_LIST");
    const emptySource = await snapshotList(organizationListId), emptyDestination = await snapshotList(organizationDestinationId);
    const emptyMove = await invoke("move_reminder", { listId: organizationListId, reminderId: emptyId, recordChangeTag: emptyURL.record.recordChangeTag,
      destinationListId: organizationDestinationId, sourceListChangeTag: emptySource.recordChangeTag,
      destinationListChangeTag: emptyDestination.recordChangeTag, expectedGeneration: generation });
    assert.equal(emptyMove.record.listId, organizationDestinationId);
    assert.equal(state.records.get(emptyId).fields.HashtagIDs.type, "UNKNOWN_LIST");

    // A child record remains outside the supported ordinary-root transfer shape.
    const childListId = "List/ORG-CHILD-REFUSAL";
    const childParentId = "Reminder/410F770D-2E1C-47CB-9BF0-123C1C98A987";
    const childId = "Reminder/510F770D-2E1C-47CB-9BF0-123C1C98A987";
    const childDestinationId = "List/ORG-CHILD-DESTINATION";
    state.records.set(childListId, listRecord(childListId, [childParentId.slice("Reminder/".length), childId.slice("Reminder/".length)]));
    state.records.set(childDestinationId, listRecord(childDestinationId));
    const childParent = reminderRecord(childParentId);
    childParent.fields.List.value.recordName = childListId; childParent.fields.DueDate.value = null; childParent.fields.TimeZone.value = null;
    const childReminder = reminderRecord(childId);
    childReminder.fields.List.value.recordName = childListId; childReminder.fields.DueDate.value = null; childReminder.fields.TimeZone.value = null;
    childReminder.fields.ParentReminder = field("REFERENCE", { recordName: childParentId, action: "VALIDATE" });
    state.records.set(childParentId, childParent); state.records.set(childId, childReminder);
    const childSourceSnapshot = await snapshotList(childListId), childDestinationSnapshot = await snapshotList(childDestinationId);
    const beforeChildRefusal = state.modifies.length;
    const childMove = await mcp("tools/call", { name: "move_reminder", arguments: { listId: childListId, reminderId: childId,
      recordChangeTag: childReminder.recordChangeTag, destinationListId: childDestinationId,
      sourceListChangeTag: childSourceSnapshot.recordChangeTag, destinationListChangeTag: childDestinationSnapshot.recordChangeTag,
      expectedGeneration: generation } });
    assert.equal(childMove.result.structuredContent.error.code, "UNSUPPORTED_FEATURE");
    assert.equal(state.modifies.length, beforeChildRefusal, "A child reminder is refused before atomic transfer dispatch.");

    // Native D1 ledger and real MCP schemas exercise simple request-driven jobs.
    const jobListId = "List/REQUEST-DRIVEN-JOBS";
    state.records.set(jobListId, listRecord(jobListId));
    state.pristineLists.add(jobListId);
    const jobKey = randomUUID();
    const job = await invoke("create_reminder_job", { kind: "bulk_create", idempotencyKey: jobKey, expectedGeneration: generation });
    assert.equal(job.jobId, jobKey);
    assert.equal((await invoke("create_reminder_job", { kind: "bulk_create", idempotencyKey: jobKey, expectedGeneration: generation })).jobId, job.jobId);
    const jobItems = [0, 1, 2, 3].map(index => ({ kind: "bulk_create", clientItemKey: `ordered-${index}`, input: { listId: jobListId, idempotencyKey: randomUUID(), title: "Equal titles are distinct", notes: `Synthetic job ${index}` } }));
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
    assert.equal(firstSlice.counts.succeeded, 3, JSON.stringify(firstSlice)); assert.equal(firstSlice.counts.pending, 1);
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

    // Bulk authorization remains childless-only when a second, otherwise exact
    // family scan sees a newly attached child after the first scan saw none.
    const deletionRootId = `Reminder/${jobItems[0].input.idempotencyKey.toUpperCase()}`;
    const deletionTarget = { listId: jobListId, reminderId: deletionRootId, recordChangeTag: state.records.get(deletionRootId).recordChangeTag };
    const deletionJob = await invoke("create_reminder_job", { kind: "bulk_delete", idempotencyKey: randomUUID(), expectedGeneration: generation });
    const deletionAppend = await invoke("append_reminder_job_items", { jobId: deletionJob.jobId, chunkKey: randomUUID(), expectedRevision: deletionJob.revision,
      items: [{ kind: "bulk_delete", clientItemKey: "childless-only", input: deletionTarget }] });
    const deletionPreview = await invoke("preview_reminder_job", { jobId: deletionJob.jobId, expectedRevision: deletionAppend.revision });
    assert.equal(deletionPreview.counts.failed, 0);
    await invoke("start_reminder_job", { jobId: deletionJob.jobId, previewToken: deletionPreview.previewToken });
    let deletionScans = 0;
    const racingChildId = "Reminder/BULK-SECOND-SCAN-CHILD";
    state.onReminderListQuery = () => {
      if (++deletionScans !== 2) return;
      const child = reminderRecord(racingChildId);
      child.fields.List.value.recordName = jobListId;
      child.fields.ParentReminder = field("REFERENCE", { recordName: deletionRootId, action: "VALIDATE" });
      state.records.set(racingChildId, child);
      state.onReminderListQuery = null;
    };
    const beforeDeletionRace = state.modifies.length;
    const rejectedDeletion = await invoke("continue_reminder_job", { jobId: deletionJob.jobId });
    assert.equal(deletionScans, 2);
    assert.equal(rejectedDeletion.counts.failed, 1);
    assert.equal(rejectedDeletion.results[0].result.code, "UNSUPPORTED_FEATURE");
    assert.equal(state.modifies.length, beforeDeletionRace, "A family found by the final bulk deletion plan must never dispatch.");
    assert.equal(state.records.get(deletionRootId).fields.Deleted.value, 0);
    assert.equal(state.records.get(racingChildId).fields.Deleted.value, 0);
    state.records.delete(racingChildId);

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
      const subtaskList = state.records.get(listId);
      const membersBeforeParents = JSON.parse(subtaskList.fields.ReminderIDs.value);
      subtaskList.fields.ReminderIDs = field("STRING", JSON.stringify([...membersBeforeParents,
        firstParent.slice("Reminder/".length), secondParent.slice("Reminder/".length)]));
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
      assert.equal(state.modifies.length, 1); assert.equal(state.modifies[0].atomicCreationGroup, true); assert.equal(state.modifies[0].operationCount, 3);
      assert.deepEqual(JSON.parse(state.records.get(listId).fields.ReminderIDs.value), [...membersBeforeParents,
        firstParent.slice("Reminder/".length), secondParent.slice("Reminder/".length), childId.slice("Reminder/".length)]);
      assert.deepEqual(state.records.get(firstParent).fields, parentFields);
      const changedList = state.records.get(listId);
      state.records.set(listId, { ...changedList, recordChangeTag: `${changedList.recordChangeTag}-concurrent` });
      assert.equal((await invokeSubtask("create_subtask", input)).replayed, true);
      assert.equal(state.modifies.length, 1, "A matching-key replay stays read-only after the List version changes.");
      const conflictingReplay = await subtaskHarness.mcp("tools/call", { name: "create_subtask", arguments: { ...input, parentReminder: parentTarget(secondParent) } });
      assert.equal(conflictingReplay.result.structuredContent.error.code, "CONFLICT");
      const staleParent = await subtaskHarness.mcp("tools/call", { name: "create_subtask", arguments: { ...input, idempotencyKey: randomUUID() } });
      assert.equal(staleParent.result.structuredContent.error.code, "CONFLICT");
      assert.equal(state.modifies.length, 1);
      for (const action of ["reopen"]) {
        const before = state.modifies.length;
        const reply = await subtaskHarness.mcp("tools/call", { name: `${action}_reminder`, arguments: { listId, ...parentTarget(firstParent) } });
        assert.ok(["UNSUPPORTED_FEATURE", "CONFLICT"].includes(reply.result.structuredContent.error.code));
        assert.equal(state.modifies.length, before);
      }
      const beforeMove = structuredClone(state.records.get(childId).fields);
      const move = { listId, ...parentTarget(childId), parentReminder: parentTarget(secondParent) };
      const beforeMoveRequests = state.requests.length;
      const moved = await invokeSubtask("set_reminder_parent", move);
      assert.equal(moved.record.parentReminderId, secondParent);
      assert.equal(state.modifies.at(-1).operationCount, 4);
      const moveRequests = state.requests.slice(beforeMoveRequests);
      assert.ok(moveRequests.some(request => request.path.endsWith("/records/query")), "Parent changes inspect the current List.");
      const exactMoveIds = new Set(moveRequests.filter(request => request.path.endsWith("/records/lookup"))
        .flatMap(request => request.body.records.map(record => record.recordName)));
      for (const id of [listId, childId, firstParent, secondParent]) assert.ok(exactMoveIds.has(id), `The exact parent plan resolves ${id}.`);
      for (const [key, value] of Object.entries(beforeMove)) if (!["ParentReminder", "ResolutionTokenMap", "LastModifiedDate"].includes(key)) {
        assert.deepEqual(state.records.get(childId).fields[key], value);
      }
      const replayMove = await subtaskHarness.mcp("tools/call", { name: "set_reminder_parent", arguments: move });
      assert.equal(replayMove.result.structuredContent.error.code, "CONFLICT");
      const detached = await invokeSubtask("set_reminder_parent", { listId, ...parentTarget(childId), parentReminder: null });
      assert.equal(detached.record.parentReminderId, null);
      assert.equal(state.modifies.at(-1).operationCount, 3);
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

    // Standard list lifecycle follows native shapes, including missing Count/zone metadata.
    const listHarness = await makeWorker();
    try {
      const { state, mcp } = listHarness;
      const generation = await listHarness.seedReady();
      await mcp("tools/list", {});
      const callList = async (name, args) => {
        const response = await mcp("tools/call", { name, arguments: { ...args, expectedGeneration: generation } });
        return response.result;
      };
      const name = "Synthetic standard list 📝", key = randomUUID(), id = `List/${key.toUpperCase()}`;
      const creationReply = await callList("create_reminder_list", { name, idempotencyKey: key });
      assert.equal(creationReply.isError, undefined, JSON.stringify(creationReply));
      const created = creationReply.structuredContent;
      assert.equal(created.list.id, id); assert.equal(created.list.title, name);
      assert.equal(created.list.count, null, "Native standard lists omit Count.");
      assert.equal(created.replayed, false);
      assert.equal(state.records.get(id).fields.IsLinkedToAccount.value, 1);
      assert.equal(state.records.get(id).fields.ShouldAutoCategorizeItems.isEncrypted, true);
      assert.equal(state.records.get(id).fields.Name.isEncrypted, true);

      const firstChildKey = randomUUID(), firstChildArgs = { listId: id, idempotencyKey: firstChildKey, title: "First reminder in a fresh List" };
      state.records.get(id).fields.SyntheticFutureListField = field("STRING", "preserve-future-list-field");
      const firstListTokens = JSON.parse(state.records.get(id).fields.ResolutionTokenMap.value);
      firstListTokens.map.syntheticUnrelatedToken = { counter: 3, modificationTime: 757_382_399, replicaID: "4e6cb834-5b1c-4ce6-8c39-00e752121111" };
      state.records.get(id).fields.ResolutionTokenMap = field("STRING", JSON.stringify(firstListTokens));
      const freshListFields = structuredClone(state.records.get(id).fields), beforeFirstChild = state.modifies.length;
      const firstChild = await callList("create_reminder", firstChildArgs);
      assert.equal(firstChild.isError, undefined, JSON.stringify(firstChild));
      assert.equal(firstChild.structuredContent.record.id, `Reminder/${firstChildKey.toUpperCase()}`);
      assert.equal(firstChild.structuredContent.replayed, false);
      assert.equal(state.modifies.length, beforeFirstChild + 1);
      assert.equal(state.modifies.at(-1).operationCount, 2);
      assert.deepEqual(JSON.parse(state.records.get(id).fields.ReminderIDs.value), [firstChildKey.toUpperCase()]);
      assert.equal(JSON.parse(state.records.get(id).fields.ResolutionTokenMap.value).map.reminderIDsMergeableOrdering.counter,
        JSON.parse(freshListFields.ResolutionTokenMap.value).map.reminderIDsMergeableOrdering.counter + 1);
      assert.deepEqual(JSON.parse(state.records.get(id).fields.ResolutionTokenMap.value).map.syntheticUnrelatedToken,
        JSON.parse(freshListFields.ResolutionTokenMap.value).map.syntheticUnrelatedToken);
      for (const [fieldName, fieldValue] of Object.entries(freshListFields)) if (!["ReminderIDs", "ResolutionTokenMap"].includes(fieldName)) {
        assert.deepEqual(state.records.get(id).fields[fieldName], fieldValue, "Creation preserves unrelated native List fields.");
      }
      const afterFirstChildFields = structuredClone(state.records.get(id).fields);
      assert.equal((await callList("create_reminder", firstChildArgs)).structuredContent.replayed, true);
      assert.equal(state.modifies.length, beforeFirstChild + 1, "A matching first-child key replays without another POST.");
      assert.deepEqual(state.records.get(id).fields, afterFirstChildFields, "A matching replay leaves confirmed List membership and tokens unchanged.");

      const lostAckKey = randomUUID(), lostAckArgs = { listId: id, idempotencyKey: lostAckKey, title: "First-child lost acknowledgement" };
      state.nextModify = "committed-network-drop";
      const lostAck = await callList("create_reminder", lostAckArgs);
      assert.equal(lostAck.structuredContent.error.code, "WRITE_OUTCOME_UNKNOWN");
      const lostAckId = `Reminder/${lostAckKey.toUpperCase()}`;
      assert.equal(state.records.has(lostAckId), true, "The fake commits before dropping the create acknowledgement.");
      const exactReadback = await callList("get_reminder", { listId: id, reminderId: lostAckId });
      assert.equal(exactReadback.isError, undefined, JSON.stringify(exactReadback));
      assert.equal(exactReadback.structuredContent.record.id, lostAckId);
      const afterLostAck = state.modifies.length;
      assert.equal((await callList("create_reminder", lostAckArgs)).structuredContent.replayed, true);
      assert.equal(state.modifies.length, afterLostAck, "Exact UUID readback makes a lost-ack replay read-only.");
      assert.deepEqual(JSON.parse(state.records.get(id).fields.ReminderIDs.value), [firstChildKey.toUpperCase(), lostAckKey.toUpperCase()]);
      assert.equal(JSON.parse(state.records.get(id).fields.ResolutionTokenMap.value).map.reminderIDsMergeableOrdering.counter,
        JSON.parse(freshListFields.ResolutionTokenMap.value).map.reminderIDsMergeableOrdering.counter + 2);
      const afterLostAckFields = structuredClone(state.records.get(id).fields);
      assert.equal(state.records.get(id).fields.SyntheticFutureListField.value, freshListFields.SyntheticFutureListField.value);

      const staleChildKey = randomUUID(), staleChildArgs = { listId: id, idempotencyKey: staleChildKey, title: "Stale List guard" };
      state.nextModify = "family-list-race";
      const staleListGuard = await callList("create_reminder", staleChildArgs);
      assert.equal(staleListGuard.structuredContent.error.code, "CONFLICT");
      assert.equal(state.records.has(`Reminder/${staleChildKey.toUpperCase()}`), false, "A stale List guard must atomically refuse the create.");
      assert.deepEqual(state.records.get(id).fields, afterLostAckFields, "A stale List guard does not change membership, tokens or other List fields.");

      state.records.delete(`Reminder/${firstChildKey.toUpperCase()}`);
      state.records.delete(lostAckId);
      state.records.get(id).fields = structuredClone(freshListFields);
      state.records.get(id).recordChangeTag = created.list.recordChangeTag;
      state.firstChildWritten.delete(id);

      const writes = state.modifies.length;
      assert.equal((await callList("create_reminder_list", { name, idempotencyKey: key })).structuredContent.replayed, true);
      assert.equal((await callList("create_reminder_list", { name: "Different", idempotencyKey: key })).structuredContent.error.code, "CONFLICT");
      assert.equal(state.modifies.length, writes);
      state.omitLookupZoneIds.add(id);
      const exact = (await callList("get_reminder_list", { listId: id })).structuredContent.list;
      assert.equal(exact.id, id); assert.equal(exact.recordChangeTag, created.list.recordChangeTag);
      const originalList = state.records.get(id);
      originalList.fields.PinnedDate = field("TIMESTAMP", Date.parse("2030-02-03T04:05:06.000Z"));
      originalList.fields.FutureAppearanceMetadata = field("STRING", "preserve opaque metadata");
      const appearanceTokenMap = JSON.parse(originalList.fields.ResolutionTokenMap.value);
      for (let tokenIndex = 0; tokenIndex < 24; tokenIndex += 1) {
        const tokenName = `retainedAppearanceReplica${String(tokenIndex).padStart(2, "0")}`;
        appearanceTokenMap.map[tokenName] = { counter: tokenIndex + 1, modificationTime: 1_700_000_000 + tokenIndex,
          replicaID: `11111111-2222-4333-8444-${String(tokenIndex + 1).padStart(12, "0")}` };
      }
      originalList.fields.ResolutionTokenMap = field("STRING", JSON.stringify(appearanceTokenMap));
      assert.ok(originalList.fields.ResolutionTokenMap.value.length > 2_048, "The token fixture exercises the full native token-map budget.");
      const appearanceBefore = (await callList("get_reminder_list_appearance", { listId: id })).structuredContent;
      assert.deepEqual(appearanceBefore.color, { kind: "default" });
      assert.deepEqual(appearanceBefore.badge, { kind: "none" });
      const appearanceArgs = { listId: id, recordChangeTag: appearanceBefore.recordChangeTag, colorPreset: "blue", emoji: "🧭" };
      state.nextModify = "reorder-list-json-receipt";
      const beforeAppearanceWrite = state.modifies.length;
      const appearanceSet = await callList("update_reminder_list_appearance", appearanceArgs);
      assert.equal(appearanceSet.isError, undefined, JSON.stringify(appearanceSet));
      assert.deepEqual(appearanceSet.structuredContent.color, { kind: "preset", preset: "blue" });
      assert.deepEqual(appearanceSet.structuredContent.badge, { kind: "emoji", emoji: "🧭" });
      assert.equal(state.modifies.length, beforeAppearanceWrite + 1);
      const updatedAppearanceList = state.records.get(id);
      assert.deepEqual(JSON.parse(updatedAppearanceList.fields.Color.value), {
        colorRGBSpace: 2, red: 0, daHexString: "#0088FF", green: 0.5333333333333333, alpha: 1,
        daSymbolicColorName: "blue", ckSymbolicColorName: "blue", blue: 1,
      });
      assert.equal(updatedAppearanceList.fields.BadgeEmblem.value, '{"Emoji" : "🧭"}');
      assert.deepEqual(updatedAppearanceList.fields.PinnedDate, originalList.fields.PinnedDate);
      assert.deepEqual(updatedAppearanceList.fields.FutureAppearanceMetadata, originalList.fields.FutureAppearanceMetadata);
      const beforeAppearanceTokens = JSON.parse(originalList.fields.ResolutionTokenMap.value).map;
      const afterAppearanceTokens = JSON.parse(updatedAppearanceList.fields.ResolutionTokenMap.value).map;
      assert.deepEqual(afterAppearanceTokens.reminderIDsMergeableOrdering, beforeAppearanceTokens.reminderIDsMergeableOrdering);
      for (let tokenIndex = 0; tokenIndex < 24; tokenIndex += 1) {
        const tokenName = `retainedAppearanceReplica${String(tokenIndex).padStart(2, "0")}`;
        assert.deepEqual(afterAppearanceTokens[tokenName], beforeAppearanceTokens[tokenName], "Appearance edits preserve extra token replicas.");
      }
      assert.equal(afterAppearanceTokens.color.counter, 1); assert.equal(afterAppearanceTokens.badgeEmblem.counter, 1);
      for (const invalid of [
        { ...appearanceArgs, colorPreset: "#ff0000" },
        { ...appearanceArgs, emoji: "shopping" },
        { ...appearanceArgs, emoji: "🧭🛒" },
      ]) {
        const beforeInvalid = state.modifies.length;
        assert.equal((await callList("update_reminder_list_appearance", invalid)).isError, true);
        assert.equal(state.modifies.length, beforeInvalid, "Malformed appearance input must not dispatch.");
      }
      const staleAppearanceWrites = state.modifies.length;
      assert.equal((await callList("update_reminder_list_appearance", appearanceArgs)).structuredContent.error.code, "CONFLICT");
      assert.equal(state.modifies.length, staleAppearanceWrites, "An exact stale appearance request must not be posted.");

      const sharedAppearance = { ...state.records.get(id), share: { recordName: "Share/SYNTHETIC" } };
      state.records.set(id, sharedAppearance);
      const appearanceRefusals = state.modifies.length;
      assert.equal((await callList("update_reminder_list_appearance", { listId: id, recordChangeTag: sharedAppearance.recordChangeTag, colorPreset: "rose" })).isError, true);
      const unsharedAppearance = { ...sharedAppearance }; delete unsharedAppearance.share; state.records.set(id, unsharedAppearance);
      state.omitLookupZoneIds.delete(id);
      state.foreignZoneIds.add(id);
      assert.equal((await callList("update_reminder_list_appearance", { listId: id, recordChangeTag: sharedAppearance.recordChangeTag, colorPreset: "rose" })).isError, true);
      state.foreignZoneIds.delete(id);
      state.omitLookupZoneIds.add(id);
      const groupAppearance = { ...state.records.get(id), fields: { ...state.records.get(id).fields, IsGroup: field("INT64", 1) } };
      state.records.set(id, groupAppearance);
      assert.equal((await callList("update_reminder_list_appearance", { listId: id, recordChangeTag: groupAppearance.recordChangeTag, emoji: "🌱" })).structuredContent.error.code, "UNSUPPORTED_FEATURE");
      assert.equal(state.modifies.length, appearanceRefusals, "Shared, foreign and group appearances must be refused before dispatch.");
      const restoredGroup = { ...groupAppearance, fields: { ...groupAppearance.fields, IsGroup: field("INT64", 0) } };
      const customColor = { type: "STRING", value: '{"colorRGBSpace":2,"red":0.2,"green":0.3,"blue":0.4,"alpha":1,"custom":true}' };
      restoredGroup.fields.Color = customColor;
      restoredGroup.recordChangeTag = `${restoredGroup.recordChangeTag}-custom`;
      state.records.set(id, restoredGroup);
      const customAppearance = (await callList("get_reminder_list_appearance", { listId: id })).structuredContent;
      assert.deepEqual(customAppearance.color, { kind: "custom" });
      const emojiOnly = { listId: id, recordChangeTag: customAppearance.recordChangeTag, emoji: "📌" };
      state.nextModify = "reorder-color-json";
      const emojiOnlyReply = await callList("update_reminder_list_appearance", emojiOnly);
      assert.equal(emojiOnlyReply.isError, undefined, JSON.stringify(emojiOnlyReply));
      assert.deepEqual(emojiOnlyReply.structuredContent.color, { kind: "custom" });
      assert.deepEqual(JSON.parse(state.records.get(id).fields.Color.value), JSON.parse(customColor.value));
      assert.deepEqual(state.records.get(id).fields.PinnedDate, originalList.fields.PinnedDate);
      assert.deepEqual(state.records.get(id).fields.FutureAppearanceMetadata, originalList.fields.FutureAppearanceMetadata);

      const uncertainAppearanceRead = (await callList("get_reminder_list_appearance", { listId: id })).structuredContent;
      const uncertainAppearanceArgs = { listId: id, recordChangeTag: uncertainAppearanceRead.recordChangeTag, colorPreset: "rose" };
      state.nextModify = "committed-network-drop";
      const beforeUnknownAppearance = state.modifies.length;
      assert.equal((await callList("update_reminder_list_appearance", uncertainAppearanceArgs)).structuredContent.error.code, "WRITE_OUTCOME_UNKNOWN");
      assert.equal(state.modifies.length, beforeUnknownAppearance + 1);
      const reconciledAppearance = (await callList("get_reminder_list_appearance", { listId: id })).structuredContent;
      assert.deepEqual(reconciledAppearance.color, { kind: "preset", preset: "rose" });
      const beforeOldAppearanceRetry = state.modifies.length;
      assert.equal((await callList("update_reminder_list_appearance", uncertainAppearanceArgs)).structuredContent.error.code, "CONFLICT");
      assert.equal(state.modifies.length, beforeOldAppearanceRetry, "A lost appearance acknowledgement must never replay its old arguments.");
      const original = structuredClone(state.records.get(id));
      const currentList = (await callList("get_reminder_list", { listId: id })).structuredContent.list;
      const rename = { listId: id, recordChangeTag: currentList.recordChangeTag, name: "Renamed synthetic list" };
      const renamed = (await callList("rename_reminder_list", rename)).structuredContent.list;
      assert.equal(renamed.title, rename.name);
      const current = state.records.get(id);
      for (const [fieldName, field] of Object.entries(original.fields))
        if (!["Name", "ResolutionTokenMap"].includes(fieldName)) assert.deepEqual(current.fields[fieldName], field);
      const beforeMap = JSON.parse(original.fields.ResolutionTokenMap.value).map;
      const afterMap = JSON.parse(current.fields.ResolutionTokenMap.value).map;
      assert.equal(afterMap.name.replicaID, beforeMap.name.replicaID);
      assert.equal(afterMap.name.counter, beforeMap.name.counter + 1);
      for (const fieldName of Object.keys(beforeMap)) if (fieldName !== "name") assert.deepEqual(afterMap[fieldName], beforeMap[fieldName]);
      const beforeRefusal = state.modifies.length;
      assert.equal((await callList("rename_reminder_list", rename)).structuredContent.error.code, "CONFLICT");
      const deletion = { listId: id, recordChangeTag: renamed.recordChangeTag, confirmName: renamed.title };
      assert.equal((await callList("delete_reminder_list", { ...deletion, confirmName: "Wrong name" })).structuredContent.error.code, "CONFLICT");
      state.omitLookupZoneIds.delete(id);
      state.foreignZoneIds.add(id);
      assert.equal((await callList("rename_reminder_list", { ...rename, recordChangeTag: renamed.recordChangeTag })).isError, true);
      state.foreignZoneIds.delete(id);
      state.omitLookupZoneIds.add(id);
      const group = structuredClone(current); group.fields.IsGroup = field("INT64", 1); state.records.set(id, group);
      assert.equal((await callList("delete_reminder_list", deletion)).structuredContent.error.code, "UNSUPPORTED_FEATURE");
      state.records.set(id, current);
      const member = reminderRecord(`Reminder/${randomUUID().toUpperCase()}`);
      member.fields.List.value.recordName = id; member.fields.Completed = field("INT64", 1); state.records.set(member.recordName, member);
      assert.equal((await callList("delete_reminder_list", deletion)).structuredContent.error.code, "UNSUPPORTED_FEATURE", "Completed reminders must prevent deletion even when membership appears empty.");
      member.fields.Completed = field("INT64", 0);
      assert.equal((await callList("delete_reminder_list", deletion)).structuredContent.error.code, "UNSUPPORTED_FEATURE");
      assert.equal(state.modifies.length, beforeRefusal, "All preflight refusals must avoid writes.");
      state.records.delete(member.recordName);
      state.nextListQuery = { records: [{ recordName: "Reminder/PAGE-FAIL", serverErrorCode: "NOT_FOUND" }] };
      assert.equal((await callList("delete_reminder_list", deletion)).structuredContent.error.code, "UNSUPPORTED_FEATURE");
      assert.equal(state.modifies.length, beforeRefusal);
      state.nextModify = "record-conflict";
      assert.equal((await callList("delete_reminder_list", deletion)).structuredContent.error.code, "CONFLICT", "Definitive atomic rejection must not be reported as an unknown write.");
      assert.equal(state.records.get(id).fields.Deleted.value, 0);
      state.nextListQuery = { records: [], continuationMarker: "synthetic-empty-next" };
      const beforeEmptyPages = state.requests.filter(request => request.path.endsWith("/records/query")).length;
      const deleted = (await callList("delete_reminder_list", deletion)).structuredContent.list;
      assert.equal(state.requests.filter(request => request.path.endsWith("/records/query")).length, beforeEmptyPages + 2, "Empty-list deletion must follow a valid continued page before writing.");
      assert.equal(deleted.deleted, true); assert.equal(state.records.get(id).fields.IsLinkedToAccount.value, 0);
      assert.equal((await callList("get_reminder_list", { listId: id })).structuredContent.list.deleted, true);
      const afterDeletion = state.modifies.length;
      assert.equal((await callList("delete_reminder_list", deletion)).isError, true);
      assert.equal(state.modifies.length, afterDeletion);
      assert.equal(state.records.get(listId).fields.Deleted.value, 0, "Unrelated lists remain intact.");

      const uncertainKey = randomUUID(), uncertainId = `List/${uncertainKey.toUpperCase()}`;
      const uncertainInput = { name: "Lost list creation response", idempotencyKey: uncertainKey };
      state.nextModify = "committed-network-drop";
      const beforeUnknown = state.modifies.length;
      const unknownError = (await callList("create_reminder_list", uncertainInput)).structuredContent.error;
      assert.equal(unknownError.code, "WRITE_OUTCOME_UNKNOWN");
      assert.equal(unknownError.listId, uncertainId); assert.equal(unknownError.reminderId, undefined);
      assert.match(unknownError.message, /get_reminder_list/);
      assert.equal(state.modifies.length, beforeUnknown + 1);
      assert.equal((await callList("get_reminder_list", { listId: uncertainId })).structuredContent.list.title, uncertainInput.name);
      assert.equal((await callList("create_reminder_list", uncertainInput)).structuredContent.replayed, true);
      assert.equal(state.modifies.length, beforeUnknown + 1, "Read-only creation reconciliation must not replay a committed request.");
      const beforeLostDelete = state.modifies.length;
      const unknownList = (await callList("get_reminder_list", { listId: uncertainId })).structuredContent.list;
      state.nextModify = "committed-network-drop";
      assert.equal((await callList("delete_reminder_list", { listId: uncertainId, recordChangeTag: unknownList.recordChangeTag, confirmName: unknownList.title })).structuredContent.error.code, "WRITE_OUTCOME_UNKNOWN");
      assert.equal((await callList("get_reminder_list", { listId: uncertainId })).structuredContent.list.deleted, true);
      assert.equal(state.modifies.length, beforeLostDelete + 1);

    } finally { await listHarness.worker.dispose(); }

    const workflowHarness = await makeWorker();
    try {
      const workflowGeneration = await workflowHarness.seedReady();
      await workflowHarness.mcp("tools/list", {});
      const workflowId = randomUUID();
      const input = { workflowId, expectedGeneration: workflowGeneration,
        create: { listId, title: "Synthetic compound root", notes: "Preserve compound creation content", priority: 5, flagged: true },
        url: "https://example.invalid/compound", tags: ["workflow"] };
      const invokeWorkflow = async args => {
        const response = await workflowHarness.mcp("tools/call", { name: "create_reminder_workflow", arguments: args });
        assert.equal(response.result.isError, undefined, JSON.stringify(response.result));
        return response.result.structuredContent;
      };
      const created = await invokeWorkflow(input);
      assert.equal(created.state, "completed");
      assert.deepEqual(created.stages.map(stage => stage.status), ["confirmed", "confirmed", "confirmed"]);
      const writes = workflowHarness.state.modifies.length;
      assert.equal((await invokeWorkflow(input)).state, "completed");
      assert.equal(workflowHarness.state.modifies.length, writes, "Completed compound requests never repeat their stages.");
      const organization = await workflowHarness.mcp("tools/call", { name: "get_reminder_organization", arguments: { expectedGeneration: workflowGeneration, listId, reminderId: created.reminderId } });
      assert.equal(organization.result.structuredContent.url.url, input.url);
      assert.deepEqual(organization.result.structuredContent.tags.map(tag => tag.name), input.tags);
      workflowHarness.state.nextModify = "committed-network-drop";
      const uncertainInput = { ...input, workflowId: randomUUID(), create: { ...input.create, title: "Synthetic lost workflow response" } };
      const uncertain = await invokeWorkflow(uncertainInput);
      assert.equal(uncertain.state, "recovery_required");
      assert.equal(uncertain.recovery.readOnly, true);
      const uncertainWrites = workflowHarness.state.modifies.length;
      const recovered = await invokeWorkflow(uncertainInput);
      assert.equal(recovered.state, "recovery_required");
      assert.equal(recovered.recovery.inspectionStatus, "observed");
      assert.equal(workflowHarness.state.modifies.length, uncertainWrites, "Uncertain compound creation must perform only recovery reads.");
    } finally { await workflowHarness.worker.dispose(); }

    const duplicationHarness = await makeWorker();
    try {
      const duplicationGeneration = await duplicationHarness.seedReady();
      await duplicationHarness.mcp("tools/list", {});
      const call = async (name, args) => {
        const response = await duplicationHarness.mcp("tools/call", { name, arguments: { ...args, expectedGeneration: duplicationGeneration } });
        assert.equal(response.result.isError, undefined, JSON.stringify(response.result));
        return response.result.structuredContent;
      };
      const source = await call("create_reminder_list", { name: "Synthetic duplication source", idempotencyKey: randomUUID() });
      const root = await call("create_reminder", { listId: source.list.id, idempotencyKey: randomUUID(), title: "Synthetic duplication item", notes: "Preserve snapshot notes", priority: 5, flagged: true });
      const url = await call("set_reminder_url", { listId: source.list.id, reminderId: root.record.id, recordChangeTag: root.record.recordChangeTag, url: "https://example.invalid/duplicate" });
      await call("set_reminder_tags", { listId: source.list.id, reminderId: root.record.id, recordChangeTag: url.record.recordChangeTag, tags: ["duplicate"] });
      const sourceRead = await call("get_reminder_list", { listId: source.list.id });
      const input = { duplicationId: randomUUID(), sourceListId: source.list.id, sourceListRecordChangeTag: sourceRead.list.recordChangeTag, name: "Synthetic duplicated list" };
      const duplicated = await call("duplicate_reminder_list", input);
      assert.equal(duplicated.status, "completed", JSON.stringify(duplicated));
      assert.equal(duplicated.items.length, 1);
      assert.equal(duplicated.items[0].status, "confirmed");
      const writes = duplicationHarness.state.modifies.length;
      assert.equal((await call("duplicate_reminder_list", { ...input, duplicationId: input.duplicationId.toUpperCase() })).status, "completed");
      assert.equal(duplicationHarness.state.modifies.length, writes, "Completed list duplication never issues another write.");
      const copied = await call("get_reminder", { listId: duplicated.destinationListId, reminderId: duplicated.items[0].destinationReminderId });
      assert.equal(copied.record.title, root.record.title);
      assert.equal(copied.record.notes, root.record.notes);
      const copiedOrganization = await call("get_reminder_organization", { listId: duplicated.destinationListId, reminderId: copied.record.id });
      assert.equal(copiedOrganization.url.url, "https://example.invalid/duplicate");
      assert.deepEqual(copiedOrganization.tags.map(tag => tag.name), ["duplicate"]);
      const nextSource = await call("get_reminder_list", { listId: source.list.id });
      duplicationHarness.state.nextModify = "committed-network-drop";
      const uncertainInput = { ...input, duplicationId: randomUUID(), sourceListRecordChangeTag: nextSource.list.recordChangeTag, name: "Synthetic uncertain duplicate" };
      assert.equal((await call("duplicate_reminder_list", uncertainInput)).status, "uncertain");
      const uncertainWrites = duplicationHarness.state.modifies.length;
      assert.equal((await call("duplicate_reminder_list", uncertainInput)).status, "uncertain");
      assert.equal(duplicationHarness.state.modifies.length, uncertainWrites, "Unknown destination creation cannot replay or start copies.");
    } finally { await duplicationHarness.worker.dispose(); }

    const sectionHarness = await makeWorker();
    try {
      const generation = await sectionHarness.seedReady();
      await sectionHarness.mcp("tools/list", {});
      const sectionListId = `List/${randomUUID().toUpperCase()}`, memberId = `Reminder/${randomUUID().toUpperCase()}`;
      const alphaId = `ListSection/${randomUUID().toUpperCase()}`, emptyId = `ListSection/${randomUUID().toUpperCase()}`;
      const memberships = { minimumSupportedVersion: 20230430, memberships: [{ memberID: memberId.slice(9), groupID: alphaId.slice(12), modifiedOn: 800000000 }] };
      const ordering = { minimumSupportedVersion: 20230430, orderedIdentifiers: [emptyId.slice(12), alphaId.slice(12)] };
      const asset = (name, value) => {
        const bytes = Buffer.from(JSON.stringify(value));
        sectionHarness.state.sectionAssets.set(`/B/${name}`, bytes);
        return field("ASSETID", { fileChecksum: "synthetic-file-checksum", wrappingKey: "synthetic-wrapping-key", referenceChecksum: "synthetic-reference-checksum", size: bytes.byteLength,
          downloadURL: `https://cvws.icloud-content.com/B/${name}` });
      };
      sectionHarness.state.sectionAssets = new Map();
      const selectedList = listRecord(sectionListId, [memberId.slice(9)]);
      selectedList.fields.ShouldCategorizeGroceryItems = { ...field("INT64", 0), isEncrypted: true };
      selectedList.fields.MembershipsOfRemindersInSectionsAsData = asset("section-memberships", memberships);
      selectedList.fields.MembershipsOfRemindersInSectionsChecksum = { ...field("STRING", await membershipsChecksum(memberships)), isEncrypted: true };
      selectedList.fields.SectionIDsOrderingAsData = asset("section-ordering", ordering);
      const section = (id, name, parent = sectionListId) => ({ recordName: id, recordType: "ListSection", recordChangeTag: "section-v1", zoneID: selectedList.zoneID,
        fields: { DisplayName: { ...field("STRING", name), isEncrypted: true }, List: field("REFERENCE", { recordName: parent, action: "VALIDATE" }), Deleted: field("INT64", 0) } });
      const alpha = section(alphaId, "Synthetic Alpha"), empty = section(emptyId, "Synthetic Empty");
      sectionHarness.state.records.set(sectionListId, selectedList);
      const member = reminderRecord(memberId);
      member.fields.List = field("REFERENCE", { recordName: sectionListId, action: "VALIDATE", zoneID: selectedList.zoneID });
      sectionHarness.state.records.set(memberId, member);
      sectionHarness.state.records.set(alphaId, alpha); sectionHarness.state.records.set(emptyId, empty);
      sectionHarness.state.sectionFeedPages = [[section(`ListSection/${randomUUID().toUpperCase()}`, "Unrelated", listId)], [], [alpha, empty]];
      const call = async args => (await sectionHarness.mcp("tools/call", { name: "get_reminder_list_sections", arguments: { listId: sectionListId, expectedGeneration: generation, limit: 2, ...args } })).result;
      const first = (await call({})).structuredContent;
      assert.equal(first.complete, false); assert.equal(first.orderingStatus, "explicit");
      assert.deepEqual(first.sections.map(x => x.name).sort(), ["Synthetic Alpha", "Synthetic Empty"]);
      assert.deepEqual(first.memberships, [{ reminderId: memberId, sectionId: alphaId }]);
      assert.deepEqual(first.orderedSectionIds, [emptyId, alphaId]);
      const second = (await call({ continuation: first.continuation })).structuredContent;
      assert.equal(second.complete, false, "An empty native feed page must keep its continuation.");
      assert.notEqual(second.continuation, first.continuation);
      assert.equal((await call({ continuation: first.continuation })).structuredContent.error.code, "CONFLICT");
      const final = (await call({ continuation: second.continuation })).structuredContent;
      assert.equal(final.complete, true); assert.equal(final.continuation, null); assert.equal(final.pagesRead, 3);
      const stale = (await call({})).structuredContent;
      selectedList.recordChangeTag = "list-changed";
      assert.equal((await call({ continuation: stale.continuation })).structuredContent.error.code, "CONFLICT");
      delete selectedList.fields.SectionIDsOrderingAsData;
      sectionHarness.state.sectionFeedPages = [[alpha, empty]];
      const implicit = (await call({})).structuredContent;
      assert.equal(implicit.complete, true); assert.equal(implicit.orderingStatus, "not_materialized");
      assert.deepEqual(implicit.orderedSectionIds, [], "Native default ordering is not invented.");
      sectionHarness.state.sectionFeedPages = [[alpha], [empty]];
      const hydrationStart = (await call({})).structuredContent;
      sectionHarness.state.unresolvedSectionId = emptyId;
      assert.equal((await call({ continuation: hydrationStart.continuation })).structuredContent.error.code, "PROTOCOL_CHANGED");
      delete sectionHarness.state.unresolvedSectionId;
      const hydrated = (await call({ continuation: hydrationStart.continuation })).structuredContent;
      assert.equal(hydrated.complete, true, "An omitted exact lookup must not acknowledge the page or consume its cursor.");
      assert.ok(hydrated.sections.some(section => section.sectionId === emptyId));
      assert.equal(sectionHarness.state.modifies.length, 0);
      assert.ok(!JSON.stringify(implicit).includes("cvws.icloud-content.com"));
    } finally { await sectionHarness.worker.dispose(); }

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
      "guarded-family-completion-selective-reopening-and-independent-child-lifecycle",
      "permanent-linked-date-preview-atomic-update-stale-dependency-and-unknown-no-retry",
      "API-linked-zone-change-preserves-instant-and-token-and-unrelated-text-edits",
      "native-standard-list-create-rename-empty-delete-and-unknown-reconciliation",
      "typed-list-appearance-read-preset-emoji-preservation-and-unknown-no-retry",
      "list-metadata-omissions-completed-items-stale-version-and-owner-group-refusals",
      "native-URL-tag-retirement-and-retained-expanded-reference-guards",
      "ordinary-move-membership-parent-and-stale-list-atomic-conflict",
      "copy-fresh-related-IDs-encrypted-intent-and-lost-ack-no-write-replay",
      "native-empty-UNKNOWN_LIST-preservation-and-child-transfer-refusal",
      "complete-connector-views-export-and-encrypted-saved-filters",
      "durable-compound-creation-and-lost-ack-read-only-recovery",
      "bounded-plain-list-duplication-and-no-replay-recovery",
      "standard-sections-empty-membership-order-and-single-use-pagination",
    ] };
  } finally {
    if (workerHarness) await workerHarness.worker.dispose();
  }
}
