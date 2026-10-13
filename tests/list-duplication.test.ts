import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JobSQLiteD1 } from "./helpers/sqlite-d1.ts";
import { Envelopes } from "../src/crypto/envelopes.ts";
import { ServiceSettingsRepository } from "../src/persistence/service-settings.ts";
import { AppError } from "../src/errors.ts";
import type { CloudKitPage, CloudKitRecord } from "../src/icloud/cloudkit.ts";
import { buildCreateReminder } from "../src/reminders/writes.ts";
import { planURLChange } from "../src/reminders/organization.ts";
import { ReminderListDuplicationService, type ListDuplicationFacade } from "../src/reminders/list-duplication.ts";

const owner = "test-owner", zoneOwner = "private-zone-owner", generation = 7, accountId = "synthetic-account";
const duplicationId = "11111111-2222-4333-8444-555555555555";
const sourceListId = "List/SOURCE";
const rootId = "Reminder/AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE";

function listRecord(id: string, tag: string, name: string, ids: string[]): CloudKitRecord {
  return { recordName: id, recordType: "List", recordChangeTag: tag,
    zoneID: { zoneName: "Reminders", zoneType: "REGULAR_CUSTOM_ZONE", ownerRecordName: zoneOwner },
    fields: { Name: { type: "STRING", value: name }, Count: { type: "INT64", value: ids.length }, IsGroup: { type: "INT64", value: 0 }, Deleted: { type: "INT64", value: 0 },
      ReminderIDs: { type: "STRING", value: JSON.stringify(ids.map(id => id.slice("Reminder/".length))) } }, raw: {} };
}

function reminderRecord(): CloudKitRecord {
  const write = buildCreateReminder({ listId: sourceListId, idempotencyKey: rootId.slice("Reminder/".length), title: "Plain title", notes: "Plain notes", priority: 5, flagged: true, allDay: false });
  return { recordName: rootId, recordType: "Reminder", recordChangeTag: "reminder-v1", zoneID: { zoneName: "Reminders", zoneType: "REGULAR_CUSTOM_ZONE", ownerRecordName: zoneOwner }, fields: write.fields, raw: {} };
}

class DuplicationFacade implements ListDuplicationFacade {
  owner = owner; zoneOwner = zoneOwner; accountId = accountId; generation = generation;
  source = listRecord(sourceListId, "source-v1", "Source", [rootId]);
  root = reminderRecord();
  attachments: CloudKitRecord[] = [];
  mutateURLOnCreate = false;
  destination: CloudKitRecord | null = null;
  pages: CloudKitPage[] | null = null;
  pageCalls = 0;
  copyCalls = 0; createCalls = 0; mutateSourceOnCreate = false; loseCopyAck = false;
  async assertCurrent(expected: number, expectedAccount: string) { assert.equal(expected, generation); assert.equal(expectedAccount, accountId); }
  async readDuplicationList(expected: number, listId: string, allowMissing = false) {
    assert.equal(expected, generation);
    const record = listId === sourceListId ? this.source : this.destination?.recordName === listId ? this.destination : null;
    if (!record && !allowMissing) throw new Error("list missing");
    return { generation, zoneOwner, record };
  }
  async readDuplicationPage(expected: number, _listId: string, continuation: string | null, limit: number) {
    assert.equal(expected, generation); assert.equal(limit, 200);
    if (this.pages) return { generation, page: this.pages[this.pageCalls++]! };
    assert.equal(continuation, null);
    const page: CloudKitPage = { records: [this.root], recordErrors: [], complete: true, paginationComplete: true, continuation: null, pendingReason: null };
    return { generation, page };
  }
  async inspectDuplicationSource() { return { generation, zoneOwner, complete: true, record: this.root, children: [], attachments: this.attachments, hashtags: [] }; }
  async createList(request: { name: string; idempotencyKey: string; expectedGeneration: number }) {
    this.createCalls++;
    const id = `List/${request.idempotencyKey.toUpperCase()}`;
    this.destination = listRecord(id, "destination-v1", request.name, []);
    if (this.mutateSourceOnCreate) this.source.recordChangeTag = "source-drift";
    if (this.mutateURLOnCreate) this.attachments[0]!.recordChangeTag = "attachment-drift";
    return { generation, listId: id, recordChangeTag: "destination-v1" };
  }
  async copyReminder(request: { destinationListId: string; idempotencyKey: string; expectedGeneration: number }) {
    this.copyCalls++;
    assert.equal(request.destinationListId, this.destination?.recordName);
    const id = `Reminder/${request.idempotencyKey.toUpperCase()}`;
    this.destination!.fields.ReminderIDs = { type: "STRING", value: JSON.stringify([request.idempotencyKey.toUpperCase()]) };
    this.destination!.recordChangeTag = "destination-v2";
    if (this.loseCopyAck) throw new Error("simulated lost acknowledgment");
    return { generation, destinationReminderId: id, destinationReminderRecordChangeTag: "copy-v1", listVersions: [
      { listId: sourceListId, recordChangeTag: this.source.recordChangeTag! }, { listId: request.destinationListId, recordChangeTag: "destination-v2" },
    ] };
  }
  async observeDuplicationReminder(expected: number, _listId: string, reminderId: string) {
    assert.equal(expected, generation);
    if (this.destination) {
      const memberIds = JSON.parse(String((this.destination.fields.ReminderIDs as { value: string }).value)) as string[];
      if (memberIds.some(id => `Reminder/${id}`.toLowerCase() === reminderId.toLowerCase()) || (this.loseCopyAck && this.copyCalls > 0)) return { generation, zoneOwner, record: { ...this.root, recordName: reminderId, recordChangeTag: "copy-v1" } };
    }
    return { generation, zoneOwner, record: null };
  }
}

function setup(facade: DuplicationFacade, installMigration = true) {
  const d1 = new JobSQLiteD1();
  if (installMigration) d1.sqlite.exec(readFileSync(new URL("../migrations/0007_list_duplication.sql", import.meta.url), "utf8"));
  else d1.sqlite.exec("DROP TABLE IF EXISTS reminder_list_duplications");
  const env = { ...d1.env(), REMINDERS_OWNER_ID: owner };
  const key = Buffer.alloc(32, 7).toString("base64");
  const service = new ReminderListDuplicationService(env, owner, facade, new Envelopes("test", { test: key }));
  return { d1, env, service };
}

const input = () => ({ duplicationId, sourceListId, sourceListRecordChangeTag: "source-v1", name: "Snapshot", expectedGeneration: generation });

test("duplication final persistence, completed replay and uncertain observation fence release without redispatch", async () => {
  for (const outcome of ["confirmed", "replay", "uncertain"] as const) {
    const facade = new DuplicationFacade(), { d1, env, service } = setup(facade);
    let release!: () => void;
    try {
      const settings = new ServiceSettingsRepository(env, owner);
      if (outcome === "replay") await service.duplicate(input());
      if (outcome === "uncertain") facade.loseCopyAck = true;
      let entered!: () => void;
      const reached = new Promise<void>(resolve => { entered = resolve; });
      const held = new Promise<void>(resolve => { release = resolve; });
      d1.afterStatement = async sql => {
        if (sql.startsWith("UPDATE reminder_list_duplications SET lease_id = NULL")) {
          d1.afterStatement = null; entered(); await held;
        }
      };
      const rejected = assert.rejects(service.duplicate(input()), error => error instanceof AppError && error.code === (outcome === "confirmed" ? "FORBIDDEN" : "CONFLICT"));
      await reached;
      const receipt = d1.sqlite.prepare("SELECT * FROM reminder_list_duplications").get();
      const current = await settings.load();
      await settings.save({ expectedRevision: current.revision, settings: { ...current.settings, reminders: { ...current.settings.reminders, write: false } } });
      if (outcome !== "confirmed") await settings.save({ expectedRevision: current.revision + 1, settings: current.settings });
      release(); await rejected;
      assert.deepEqual(d1.sqlite.prepare("SELECT * FROM reminder_list_duplications").get(), receipt);
      if (outcome === "confirmed") await settings.save({ expectedRevision: current.revision + 1, settings: current.settings });
      facade.loseCopyAck = false;
      const copies = facade.copyCalls, creates = facade.createCalls;
      const retry = await service.duplicate(input());
      assert.equal(retry.status, outcome === "uncertain" ? "uncertain" : "completed");
      assert.equal(facade.copyCalls, copies); assert.equal(facade.createCalls, creates);
    } finally { release?.(); d1.sqlite.close(); }
  }
});

test("duplicates a supported list snapshot and completed repeats do not write", async () => {
  const facade = new DuplicationFacade(), { service } = setup(facade);
  const first = await service.duplicate(input());
  assert.equal(first.status, "completed"); assert.equal(first.items[0]?.status, "confirmed");
  assert.equal(facade.createCalls, 1); assert.equal(facade.copyCalls, 1);
  const repeat = await service.duplicate(input());
  assert.equal(repeat.status, "completed"); assert.equal(facade.createCalls, 1); assert.equal(facade.copyCalls, 1);
});

test("source list drift after destination creation blocks every copy", async () => {
  const facade = new DuplicationFacade(); facade.mutateSourceOnCreate = true;
  const { service } = setup(facade);
  await assert.rejects(service.duplicate(input()), error => error instanceof Error && "code" in error && error.code === "CONFLICT");
  assert.equal(facade.createCalls, 1); assert.equal(facade.copyCalls, 0);
  const changedURL = new DuplicationFacade();
  const plan = planURLChange(changedURL.root, [], { url: "https://example.invalid/original" }, zoneOwner, changedURL.root.recordChangeTag!);
  changedURL.root.fields = { ...changedURL.root.fields, ...plan.root.fields };
  const attachment = plan.dependencies[0]!.record;
  changedURL.attachments = [{ ...attachment, recordChangeTag: "attachment-v1", zoneID: changedURL.root.zoneID, raw: {} } as CloudKitRecord];
  changedURL.mutateURLOnCreate = true;
  await assert.rejects(setup(changedURL).service.duplicate(input()), error => error instanceof Error && "code" in error && error.code === "CONFLICT");
  assert.equal(changedURL.copyCalls, 0, "A related URL version can change while the root and List versions remain unchanged.");
});

test("preflight follows an empty nonterminal source page", async () => {
  const facade = new DuplicationFacade();
  facade.pages = [
    { records: [], recordErrors: [], complete: false, paginationComplete: false, continuation: "empty-page-next", pendingReason: "continuation" },
    { records: [facade.root], recordErrors: [], complete: true, paginationComplete: true, continuation: null, pendingReason: null },
  ];
  const { service } = setup(facade);
  const result = await service.duplicate(input());
  assert.equal(result.status, "completed"); assert.equal(facade.pageCalls, 2); assert.equal(facade.copyCalls, 1);
});

test("lost copy acknowledgment is observed read-only and never replayed", async () => {
  const facade = new DuplicationFacade(); facade.loseCopyAck = true;
  const { service } = setup(facade);
  const first = await service.duplicate(input());
  assert.equal(first.status, "uncertain"); assert.equal(facade.copyCalls, 1);
  const repeat = await service.duplicate(input());
  assert.equal(repeat.items[0]?.status, "observed"); assert.equal(facade.copyCalls, 1); assert.equal(facade.createCalls, 1);
});

test("unsupported source scheduling is refused before destination creation", async () => {
  const facade = new DuplicationFacade(); facade.root.fields.AlarmIDs = { type: "STRING_LIST", value: ["Alarm/unsupported"] };
  const { service } = setup(facade);
  await assert.rejects(service.duplicate(input()), error => error instanceof Error && "code" in error && error.code === "UNSUPPORTED_FEATURE");
  assert.equal(facade.createCalls, 0); assert.equal(facade.copyCalls, 0);
});

test("missing duplication migration is reported as configuration required", async () => {
  const facade = new DuplicationFacade(), { service } = setup(facade, false);
  await assert.rejects(service.duplicate(input()), error => error instanceof Error && "code" in error && error.code === "CONFIGURATION_REQUIRED");
  assert.equal(facade.createCalls, 0); assert.equal(facade.copyCalls, 0);
});
