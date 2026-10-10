import test from "node:test";
import assert from "node:assert/strict";
import { AtomicProtectionInput, captureEvidenceGraph, sanitizeEvidence, evidenceTitle, verifyAtomicProtection } from "../src/reminders/evidence.ts";
import { buildCreateReminder, CreateReminderInput } from "../src/reminders/writes.ts";
import { CloudKitRemindersClient, type CloudKitRecord, type CloudKitLookupResult } from "../src/icloud/cloudkit.ts";
import { AppleHTTP } from "../src/transport/apple-http.ts";
import { CookieJar } from "../src/transport/cookie-jar.ts";
import { AppError } from "../src/errors.ts";
import { AppleConnectionService } from "../src/auth/service.ts";
import { parseEvidenceArgs, compareEvidence } from "../scripts/dev/capture-reminder-evidence.mjs";
import { reminderQueueConfig } from "../scripts/deploy/reminder-queue-config.mjs";
import { jobExecutionMode } from "../src/jobs/execution.ts";
import { readFileSync } from "node:fs";
import { planReminderUpdate } from "../src/reminders/mutation-plan.ts";
import { loadSchedulingGraph } from "../src/reminders/linked-records.ts";

const caseId = "c0fe6563-4ce5-4bfb-a78e-0568d5a5ec5f", owner = "synthetic-owner", listId = "List/EVIDENCE";
const hasCode = (code: string) => (error: unknown) => error instanceof AppError && error.code === code;
function root(): CloudKitRecord {
  const write = buildCreateReminder(CreateReminderInput.parse({ listId, title: evidenceTitle(caseId), notes: "Private contents must not be exported", idempotencyKey: caseId }), 1_800_000_000_000);
  return { ...write, recordChangeTag: "private-version", raw: { privateAudit: "private-user" }, zoneID: { zoneName: "Reminders", ownerRecordName: owner } };
}
function lookup(records: CloudKitRecord[]) {
  return async (ids: string[]): Promise<CloudKitLookupResult> => ({
    requestedRecordNames: ids, records: ids.flatMap(id => records.filter(record => record.recordName === id)),
    recordErrors: [], unresolvedRecordNames: ids.filter(id => !records.some(record => record.recordName === id)), complete: ids.every(id => records.some(record => record.recordName === id)),
  });
}

test("evidence traverses explicit alarm-trigger references without enabling a writable recipe", async () => {
  const reminder = root();
  reminder.fields.AlarmIDs = { type: "STRING_LIST", value: ["Alarm/SYNTHETIC"] };
  const alarm = { ...reminder, recordType: "Alarm", recordName: "Alarm/SYNTHETIC", fields: { Trigger: { type: "REFERENCE", value: { recordName: "AlarmTrigger/SYNTHETIC" } } } };
  const trigger = { ...reminder, recordType: "AlarmTrigger", recordName: "AlarmTrigger/SYNTHETIC", fields: { DueDate: { type: "TIMESTAMP", value: 1_800_000_000_000 }, UnknownSecret: { type: "STRING", value: "private-value" } } };
  const graph = await captureEvidenceGraph(reminder, owner, listId, caseId, lookup([reminder, alarm, trigger]));
  assert.equal(graph.records.length, 3); assert.equal(graph.edges.length, 2);
  const snapshot = await sanitizeEvidence(graph, caseId, 1);
  assert.equal(snapshot.writableGraphProven, false);
  assert.equal(snapshot.rootRecordName, snapshot.records.find(record => record.recordType === "Reminder")?.recordName);
  assert.equal(snapshot.appleAppVerified, false);
  const text = JSON.stringify(snapshot);
  for (const privateValue of ["private-version", "private-value", "private-user", "Private contents", reminder.fields.TitleDocument, "Alarm/SYNTHETIC"]) {
    assert.ok(!text.includes(typeof privateValue === "string" ? privateValue : JSON.stringify(privateValue)));
  }
  assert.ok(text.includes("1800000000000"));
  const next = await sanitizeEvidence(graph, caseId, 1);
  assert.deepEqual(snapshot.records, next.records);
});

test("evidence rejects personal reminders, incomplete references, foreign zones and synchronization drift", async () => {
  const reminder = root(), personal = root();
  personal.fields = { ...personal.fields, ...buildCreateReminder(CreateReminderInput.parse({ listId, title: "Personal", idempotencyKey: caseId })).fields };
  await assert.rejects(captureEvidenceGraph(personal, owner, listId, caseId, lookup([personal])), hasCode("FORBIDDEN"));
  reminder.fields.AlarmIDs = { type: "STRING_LIST", value: ["Alarm/MISSING"] };
  await assert.rejects(captureEvidenceGraph(reminder, owner, listId, caseId, lookup([reminder])), hasCode("UNSUPPORTED_FEATURE"));
  const foreign = root();
  foreign.fields.Trigger = { type: "REFERENCE", value: { recordName: "Alarm/FOREIGN", zoneID: { zoneName: "Other", ownerRecordName: owner } } };
  await assert.rejects(captureEvidenceGraph(foreign, owner, listId, caseId, lookup([foreign])), hasCode("FORBIDDEN"));
  const stable = root(), changed = { ...stable, recordChangeTag: "changed" };
  await assert.rejects(captureEvidenceGraph(stable, owner, listId, caseId, lookup([changed])), hasCode("CONFLICT"));
  const differing = { ...stable, fields: { ...stable.fields, UnknownPrivateValue: { type: "STRING", value: "never-export-this" } } };
  await assert.rejects(captureEvidenceGraph(stable, owner, listId, caseId, lookup([differing])), (error: unknown) => {
    assert.ok(error instanceof AppError && error.code === "CONFLICT");
    assert.ok(error.message.includes("UnknownPrivateValue"));
    assert.ok(!error.message.includes("never-export-this") && !error.message.includes(stable.recordName));
    return true;
  });
  await assert.rejects(new AppleConnectionService({ APP_ORIGIN: "https://private.example.test", LOCAL_REMINDER_EVIDENCE_ENABLED: "synthetic-v1" }, owner).captureEvidence({}), hasCode("FORBIDDEN"));
  await assert.rejects(new AppleConnectionService({ APP_ORIGIN: "https://private.example.test", LOCAL_REMINDER_EVIDENCE_ENABLED: "synthetic-v1" }, owner).verifyAtomicEvidence({}), hasCode("FORBIDDEN"));
  await assert.rejects(new AppleConnectionService({ APP_ORIGIN: "http://127.0.0.1:5173" }, owner).verifyAtomicEvidence({}), hasCode("FORBIDDEN"));
});

test("diagnostic Alarm TriggerID UUID lookup resolves the live-observed shape and rejects missing triggers", async () => {
  const reminder = root(), triggerId = "3296B33C-CF67-4DC0-8421-2591D072C34A";
  reminder.fields.AlarmIDs = { type: "STRING_LIST", value: ["Alarm/SYNTHETIC"] };
  const alarm = { ...reminder, recordType: "Alarm", recordName: "Alarm/SYNTHETIC",
    fields: { TriggerID: { type: "STRING", value: triggerId }, Reminder: { type: "REFERENCE", value: { recordName: reminder.recordName } } } };
  const trigger = { ...reminder, recordType: "AlarmTrigger", recordName: `AlarmTrigger/${triggerId}`,
    fields: { Alarm: { type: "REFERENCE", value: { recordName: alarm.recordName } }, Type: { type: "STRING", value: "synthetic" } } };
  const graph = await captureEvidenceGraph(reminder, owner, listId, caseId, lookup([reminder, alarm, trigger]));
  assert.equal(graph.records.length, 3);
  assert.ok(graph.edges.some(edge => edge.from === alarm.recordName && edge.field === "TriggerID" && edge.to === trigger.recordName));
  await assert.rejects(captureEvidenceGraph(reminder, owner, listId, caseId, lookup([reminder, alarm])), hasCode("UNSUPPORTED_FEATURE"));
  const invalid = { ...alarm, fields: { ...alarm.fields, TriggerID: { type: "STRING", value: "unverified-shape" } } };
  await assert.rejects(captureEvidenceGraph(reminder, owner, listId, caseId, lookup([reminder, invalid])), hasCode("UNSUPPORTED_FEATURE"));
  const duplicated = { ...alarm, fields: { ...alarm.fields, TriggerID: { type: "STRING", value: trigger.recordName } } };
  const prefixed = await captureEvidenceGraph(reminder, owner, listId, caseId, lookup([reminder, duplicated, trigger]));
  assert.equal(prefixed.edges.filter(edge => edge.field === "TriggerID").length, 1);
});

test("evidence redacts unknown nested content, unsafe timezone values and account metadata", async () => {
  const reminder = root();
  reminder.fields.Unknown = { type: "STRING", value: { url: "https://private.test/?token=private-credential", userRecordName: "private-account", "private dynamic name": [1, "private-note"] } };
  reminder.fields.TimeZone = { type: "STRING", value: "private-credential" };
  const snapshot = await sanitizeEvidence({ records: [reminder], edges: [] }, caseId, 1);
  assert.ok(!JSON.stringify(snapshot).includes("private-"));
});

test("capture CLI requires explicit synthetic scope and comparison never approves a recipe", async () => {
  assert.throws(() => parseEvidenceArgs(["seed", "--case-id", caseId, "--list-name", "Test"]));
  assert.throws(() => parseEvidenceArgs(["capture", "--confirm-synthetic", "--case-id", caseId, "--list-name", "Personal", "--phase", "before"]));
  assert.equal(parseEvidenceArgs(["seed", "--confirm-synthetic", "--case-id", caseId, "--list-name", "Test"]).command, "seed");
  const historyId = "Reminder/00000000-0000-4000-8000-000000000002";
  assert.equal(parseEvidenceArgs(["capture", "--confirm-synthetic", "--case-id", caseId, "--list-name", "Test", "--phase", "completion-history", "--reminder-id", historyId]).reminderId, historyId);
  assert.throws(() => parseEvidenceArgs(["seed", "--confirm-synthetic", "--case-id", caseId, "--list-name", "Test", "--reminder-id", historyId]));
  assert.throws(() => parseEvidenceArgs(["capture", "--confirm-synthetic", "--case-id", caseId, "--list-name", "Test", "--phase", "../history", "--reminder-id", historyId]));
  assert.throws(() => parseEvidenceArgs(["capture", "--confirm-synthetic", "--case-id", caseId, "--list-name", "Test", "--phase", "completion-history", "--reminder-id", "Reminder/OTHER"]));
  assert.equal(parseEvidenceArgs(["compare", "--confirm-synthetic", "--case-id", caseId, "--apple-app-confirmed", "--transition", "next-occurrence"]).transition, "next-occurrence");
  assert.throws(() => parseEvidenceArgs(["compare", "--confirm-synthetic", "--case-id", caseId, "--apple-app-confirmed", "--transition", "../next"]));
  assert.throws(() => parseEvidenceArgs(["capture", "--confirm-synthetic", "--case-id", caseId, "--list-name", "Test", "--phase", "next-after", "--transition", "next-occurrence"]));
  const atomicArgs = ["atomic-check", "--confirm-synthetic", "--case-id", caseId, "--list-name", "Test", "--dependency-type", "Alarm"];
  assert.throws(() => parseEvidenceArgs(atomicArgs));
  assert.equal(parseEvidenceArgs([...atomicArgs, "--confirm-version-guard-writes"]).dependencyType, "Alarm");
  assert.throws(() => parseEvidenceArgs([...atomicArgs, "--confirm-version-guard-writes", "--reminder-id", historyId]));
  assert.throws(() => parseEvidenceArgs([...atomicArgs, "--confirm-version-guard-writes", "--phase", "after"]));
  assert.equal(AtomicProtectionInput.safeParse({ caseId, listId, reminderId: root().recordName, expectedGeneration: 1, dependencyType: "Alarm" }).success, false);
  const reminder = root(), before = await sanitizeEvidence({ records: [reminder], edges: [] }, caseId, 1);
  const after = { ...before, capturedAt: before.capturedAt + 1, records: before.records.map(record => ({ ...record, recordChangeTag: "opaque-next", fields: { ...record.fields, AllDay: { type: "INT64", value: 1 } } })) };
  const report = compareEvidence(before, after);
  assert.equal(report.writableRecipeApproved, false);
  assert.deepEqual(report.changed[0].fields, ["AllDay"]);
  assert.throws(() => compareEvidence(before, { ...after, generation: 2 }));
  const explicit = { ...before, rootRecordName: before.records[0].recordName };
  assert.throws(() => compareEvidence(explicit, { ...after, rootRecordName: historyId }));
});

test("controlled atomic experiment advances only versions and refuses each genuinely stale linked dependency without partial changes", async () => {
  for (const dependencyType of ["Alarm", "AlarmTrigger", "RecurrenceRule"] as const) {
    const reminder = root(), triggerUuid = "3296B33C-CF67-4DC0-8421-2591D072C34A";
    reminder.fields.AlarmIDs = { type: "STRING_LIST", value: ["Alarm/SYNTHETIC"] };
    reminder.fields.RecurrenceRuleIDs = { type: "STRING_LIST", value: ["RecurrenceRule/SYNTHETIC"] };
    const alarm = { ...root(), recordType: "Alarm", recordName: "Alarm/SYNTHETIC", fields: {
      Deleted: { type: "INT64", value: 0 }, TriggerID: { type: "STRING", value: triggerUuid },
      Reminder: { type: "REFERENCE", value: { recordName: reminder.recordName } }, DueDateResolutionTokenAsNonce: { type: "DOUBLE", value: 500_000_000_001.25 } } };
    const trigger = { ...root(), recordType: "AlarmTrigger", recordName: `AlarmTrigger/${triggerUuid}`, fields: {
      Deleted: { type: "INT64", value: 0 }, Alarm: { type: "REFERENCE", value: { recordName: alarm.recordName } },
      DateComponentsData: { type: "BYTES", value: "preserved-components" } } };
    const rule = { ...root(), recordType: "RecurrenceRule", recordName: "RecurrenceRule/SYNTHETIC", fields: {
      Deleted: { type: "INT64", value: 0 }, Frequency: { type: "INT64", value: 1 },
      Reminder: { type: "REFERENCE", value: { recordName: reminder.recordName } }, UnknownAnchor: { type: "STRING", value: "preserved-anchor" } } };
    const before = [reminder, alarm, trigger, rule], store = new Map(before.map(record => [record.recordName, structuredClone(record)]));
    const graph = await captureEvidenceGraph(reminder, owner, listId, caseId, lookup(before));
    let modifies = 0, dispatches = 0;
    const http = new AppleHTTP(new CookieJar(), async (url, init) => {
      const payload = JSON.parse(String(init?.body));
      if (String(url).includes("/records/lookup")) return Response.json({ records: payload.records.map(({ recordName }: { recordName: string }) => ({
        ...store.get(recordName), zoneID: undefined,
      })) });
      assert.ok(String(url).includes("/records/modify")); assert.equal(payload.atomic, true);
      modifies++;
      const stale = payload.operations.find((operation: { record: CloudKitRecord }) => operation.record.recordChangeTag !== store.get(operation.record.recordName)!.recordChangeTag);
      if (stale) {
        assert.equal(stale.record.recordType, dependencyType);
        assert.equal(payload.operations.length, 4);
        return Response.json({ records: payload.operations.map((operation: { record: CloudKitRecord }) => ({ recordName: operation.record.recordName,
          serverErrorCode: operation === stale ? "CONFLICT" : "ATOMIC_ERROR" })) });
      }
      assert.equal(modifies, 1); assert.equal(payload.operations.length, 2);
      const confirmations = payload.operations.map((operation: { record: CloudKitRecord }) => {
        assert.deepEqual(operation.record.fields, { Deleted: { type: "INT64", value: 0 } });
        const current = store.get(operation.record.recordName)!;
        const updated = { ...current, recordChangeTag: `${current.recordChangeTag}-advanced` };
        store.set(updated.recordName, updated);
        return updated;
      });
      return Response.json({ records: confirmations.reverse() });
    });
    const client = new CloudKitRemindersClient(http, { dsid: "123", clientId: "synthetic", clientBuildNumber: "synthetic", clientMasteringNumber: "synthetic",
      cloudKitURL: "https://p01-ckdatabasews.icloud.com/database/1/com.apple.reminders/production/private", remindersZoneOwner: owner });
    const report = await verifyAtomicProtection(graph, owner, dependencyType, client, async () => { dispatches++; });
    assert.equal(report.staleGuardRejected, true);
    assert.equal(report.groupFieldsAndVersionsUnchangedAfterRejection, true);
    assert.equal(report.writableRecipeApproved, false);
    assert.equal(report.probeMutation, "nondeleted-marker");
    assert.equal(modifies, 2); assert.equal(dispatches, 2);
    for (const record of before) assert.deepEqual(store.get(record.recordName)!.fields, record.fields);
  }
});

test("observed Apple date edit replaces alarm/trigger while preserving recurrence and is not a writable recipe", () => {
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/linked-date-observation.json", import.meta.url), "utf8"));
  assert.equal(fixture.source, "authorized-synthetic-apple-app-observation");
  assert.equal(fixture.writableRecipeApproved, false);
  const comparison = compareEvidence(fixture.before, fixture.after);
  assert.deepEqual(comparison.added, ["Alarm/NEW", "AlarmTrigger/NEW"]);
  assert.deepEqual(comparison.removedOrUnlinked, ["Alarm/OLD", "AlarmTrigger/OLD"]);
  assert.equal(comparison.changed.length, 1);
  assert.deepEqual(comparison.changed[0].fields, ["AlarmIDs", "DueDate", "LastModifiedDate", "ResolutionTokenMap"]);
  assert.equal(comparison.changed[0].recordName, "Reminder/SYNTHETIC");
  const beforeRule = fixture.before.records.find((record: CloudKitRecord) => record.recordType === "RecurrenceRule");
  const afterRule = fixture.after.records.find((record: CloudKitRecord) => record.recordType === "RecurrenceRule");
  assert.deepEqual(beforeRule, afterRule);
  assert.equal(fixture.after.records[0].fields.DueDate.value, Date.parse("2026-10-10T09:00:00+01:00"));
  assert.equal(fixture.additionalAfterObservation.oldAlarmRetirementProven, false);
  assert.equal(fixture.additionalAfterObservation.commitTimeDependencyProtectionProven, false);
});

test("observed recurring completion keeps the original active and creates history under a separate identity", async () => {
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/linked-completion-observation.json", import.meta.url), "utf8"));
  assert.equal(fixture.active.id, fixture.before.id);
  assert.notEqual(fixture.history.id, fixture.active.id);
  assert.equal(fixture.active.completed, false);
  assert.equal(fixture.active.dueDate, "2026-10-17T08:00:00.000Z");
  assert.equal(fixture.history.completed, true);
  assert.equal(fixture.history.dueDate, fixture.before.dueDate);
  assert.equal(fixture.history.recurrenceCount, 0);
  assert.equal(fixture.history.completeStableGraphCaptured, false);
  assert.equal(fixture.automaticSuccessorTargetingProven, false);
  const history = root();
  history.recordName = fixture.history.id;
  history.fields.Completed = { type: "INT64", value: 1 };
  history.fields.CompletionDate = { type: "TIMESTAMP", value: Date.parse(fixture.history.completedDate) };
  history.fields.DueDate = { type: "TIMESTAMP", value: Date.parse(fixture.history.dueDate) };
  history.fields.TimeZone = { type: "STRING", value: fixture.history.timeZone };
  let lookups = 0;
  const graph = await loadSchedulingGraph(history, owner, async () => { lookups++; throw new Error("No other occurrence may be looked up implicitly."); });
  const before = structuredClone(history);
  assert.throws(() => planReminderUpdate(graph, { listId, reminderId: fixture.history.id, recordChangeTag: history.recordChangeTag!,
    changes: { dueDate: "2027-01-10T09:00:00+00:00" } }, owner, 1_800_000_000_000), hasCode("CONFLICT"));
  assert.equal(lookups, 0);
  assert.deepEqual(history, before);
});

test("observed active January rescheduling preserves the recurrence and historical normalized state without approving writes", () => {
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/linked-next-occurrence-observation.json", import.meta.url), "utf8"));
  assert.equal(fixture.source, "authorized-synthetic-apple-app-observation");
  assert.equal(fixture.writableRecipeApproved, false);
  const comparison = compareEvidence(fixture.before, fixture.after);
  assert.equal(comparison.writableRecipeApproved, false);
  assert.deepEqual(comparison.added, ["Alarm/NEW", "AlarmTrigger/NEW"]);
  assert.deepEqual(comparison.removedOrUnlinked, ["Alarm/OLD", "AlarmTrigger/OLD"]);
  assert.deepEqual(comparison.changed, [{ recordName: "Reminder/ACTIVE", recordType: "Reminder", versionChanged: true,
    fields: ["AlarmIDs", "DueDate", "LastModifiedDate", "ResolutionTokenMap"] }]);
  const before = fixture.before.records[0], after = fixture.after.records[0];
  assert.equal(before.fields.DueDate.value, Date.parse("2026-10-17T09:00:00+01:00"));
  assert.equal(after.fields.DueDate.value, Date.parse("2027-01-10T09:00:00+00:00"));
  for (const field of ["TimeZone", "AllDay", "Completed", "RecurrenceRuleIDs", "TitleDocument", "NotesDocument"]) {
    assert.deepEqual(after.fields[field], before.fields[field]);
  }
  assert.deepEqual(fixture.before.records[1], fixture.after.records[1]);
  assert.equal(fixture.historicalObservation.exactNormalizedStateAndVersionUnchanged, true);
  assert.equal(fixture.historicalObservation.dueDate, "2026-10-10T08:00:00.000Z");
  assert.equal(fixture.historicalObservation.completed, true);
  assert.equal(fixture.historicalObservation.completeStableGraphCaptured, false);
  assert.equal(fixture.additionalAfterObservation.generalNonceConstructionProven, false);
  assert.equal(fixture.additionalAfterObservation.oldAlarmRetirementProven, false);
  assert.equal(fixture.additionalAfterObservation.commitTimeDependencyProtectionProven, false);
  assert.throws(() => compareEvidence(fixture.before, { ...fixture.after, rootRecordName: "Reminder/HISTORY" }));
});

test("Queue deployment config requires explicit bindings, bounded batches and only the outbox schedule", () => {
  const configured = { vars: { REMINDER_JOB_EXECUTION_MODE: "queue-v1", REMINDER_JOB_QUEUE_NAME: "synthetic-jobs" },
    queues: { producers: [{ binding: "REMINDER_JOB_QUEUE", queue: "synthetic-jobs" }],
      consumers: [{ queue: "synthetic-jobs", max_batch_size: 1, max_batch_timeout: 1, max_concurrency: 1, max_retries: 5 }] },
    triggers: { crons: ["* * * * *"] } };
  assert.deepEqual(reminderQueueConfig(configured), { queues: configured.queues, triggers: configured.triggers });
  assert.deepEqual(reminderQueueConfig({}), {});
  assert.throws(() => reminderQueueConfig({ ...configured, vars: {} }));
  assert.throws(() => reminderQueueConfig({ ...configured, triggers: { crons: ["0 * * * *"] } }));
  assert.equal(jobExecutionMode({}), "request-driven");
  assert.throws(() => jobExecutionMode({ REMINDER_JOB_EXECUTION_MODE: "queue-v1" }), hasCode("CONFIGURATION_REQUIRED"));
});
