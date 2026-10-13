import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JobSQLiteD1 } from "./helpers/sqlite-d1.ts";
import { AppError, WriteOutcomeUnknownError } from "../src/errors.ts";
import { b64 } from "../src/crypto/bytes.ts";
import { ServiceSettingsRepository } from "../src/persistence/service-settings.ts";
import { accountScope } from "../src/lib/canonical.ts";
import { normalizeReminder, type CloudKitRecord } from "../src/icloud/cloudkit.ts";
import { buildCreateReminder, CreateReminderInput, UpdateReminderInput } from "../src/reminders/writes.ts";
import { planReminderUpdate } from "../src/reminders/mutation-plan.ts";
import { loadSchedulingGraph } from "../src/reminders/linked-records.ts";
import { planURLChange, planTagChange, readReminderOrganization } from "../src/reminders/organization.ts";
import { CreateWorkflowService, CreateWorkflowInput, CreateWorkflowOutput, CREATE_WORKFLOW_LEASE_MS,
  type CreateWorkflowAppleFacade, type CreateWorkflowInputData } from "../src/reminders/create-workflow.ts";

class SQLiteD1 extends JobSQLiteD1 {
  constructor() { super(); this.sqlite.exec(readFileSync(new URL("../migrations/0006_create_workflows.sql", import.meta.url), "utf8")); }
}
const owner = "synthetic-workflow-owner";
const hasCode = (code: string) => (error: unknown) => error instanceof AppError && error.code === code;
type Mutation = Parameters<CreateWorkflowAppleFacade["mutate"]>[0];

/** Synthetic Apple state, exercising the actual existing create/schedule/organization planners. */
class Apple implements CreateWorkflowAppleFacade {
  account = "";
  generation = 7;
  records = new Map<string, CloudKitRecord>();
  beforeMutation: ((input: Mutation) => Promise<void>) | null = null;
  afterMutation: ((input: Mutation) => Promise<void>) | null = null;
  beforeRead: (() => Promise<void>) | null = null;
  serial = 0;
  async binding() { return { account: this.account, generation: this.generation }; }
  fence(generation: number) { if (generation !== this.generation) throw new AppError("CONFLICT", "Synthetic session changed", 409); }
  async lookup(ids: string[]) {
    const records = ids.flatMap(id => this.records.has(id) ? [this.records.get(id)!] : []);
    return { records, requestedRecordNames: ids, recordErrors: [], unresolvedRecordNames: ids.filter(id => !this.records.has(id)), complete: records.length === ids.length };
  }
  outcome(root: CloudKitRecord) {
    const record = Object.fromEntries(Object.entries(normalizeReminder(root, owner)).filter(([key]) => key !== "raw"));
    return { generation: this.generation, record };
  }
  async readReminderForMCP(generation: number, _listId: string, reminderId: string) {
    this.fence(generation); await this.beforeRead?.(); this.fence(generation);
    const root = this.records.get(reminderId);
    return root ? { ...this.outcome(root), missing: false } : { generation: this.generation, record: null, missing: true };
  }
  async prepareUpdate(input: Parameters<CreateWorkflowAppleFacade["prepareUpdate"]>[0]) {
    this.fence(input.expectedGeneration);
    const root = this.records.get(input.reminderId)!;
    const graph = await loadSchedulingGraph(root, owner, ids => this.lookup(ids));
    const plan = planReminderUpdate(graph, UpdateReminderInput.parse({ listId: input.listId, reminderId: input.reminderId,
      recordChangeTag: input.recordChangeTag, changes: input.changes }), owner, Date.now());
    return { generation: this.generation, supported: plan.supported, preparationToken: plan.supported ? "synthetic-preparation" : null };
  }
  apply(write: { recordName: string; recordType: string; fields: Record<string, unknown>; recordChangeTag?: string }) {
    const previous = this.records.get(write.recordName);
    if (write.recordChangeTag && previous?.recordChangeTag !== write.recordChangeTag) throw new AppError("CONFLICT", "Synthetic exact version changed", 409);
    const record: CloudKitRecord = { ...previous, ...write, fields: { ...previous?.fields, ...write.fields },
      recordChangeTag: `synthetic-version-${++this.serial}`, zoneID: { zoneName: "Reminders", ownerRecordName: owner }, raw: {} };
    this.records.set(write.recordName, record);
    return record;
  }
  async mutate(input: Mutation) {
    this.fence(input.expectedGeneration); await this.beforeMutation?.(input); this.fence(input.expectedGeneration);
    let root: CloudKitRecord;
    if (input.action === "create") {
      const { action, expectedGeneration, ...create } = input;
      assert.equal(action, "create"); this.fence(expectedGeneration);
      const write = buildCreateReminder(CreateReminderInput.parse(create));
      if (this.records.has(write.recordName)) throw new AppError("CONFLICT", "Synthetic root already exists", 409);
      root = this.apply(write);
    } else {
      const current = this.records.get(input.reminderId)!;
      if (current.recordChangeTag !== input.recordChangeTag) throw new AppError("CONFLICT", "Synthetic root changed", 409);
      if (input.action === "update") {
        assert.equal(input.preparationToken, "synthetic-preparation");
        const graph = await loadSchedulingGraph(current, owner, ids => this.lookup(ids));
        const plan = planReminderUpdate(graph, UpdateReminderInput.parse({ listId: input.listId, reminderId: input.reminderId,
          recordChangeTag: input.recordChangeTag, changes: input.changes }), owner, Date.now());
        if (!plan.supported) throw new AppError("UNSUPPORTED_FEATURE", "Synthetic unverified schedule");
        plan.dependencies.forEach(write => this.apply(write));
        root = this.apply(plan.write);
      } else {
        const related = [...this.records.values()].filter(record => record.recordType === (input.action === "set_url" ? "Attachment" : "Hashtag"));
        const plan = input.action === "set_url" ? planURLChange(current, related, { url: input.url }, owner, input.recordChangeTag)
          : planTagChange(current, related, { tags: input.tags }, owner, input.recordChangeTag);
        plan.dependencies.forEach(item => this.apply(item.record));
        root = this.apply(plan.root);
      }
    }
    await this.afterMutation?.(input);
    return this.outcome(root);
  }
  root(id: string) { return this.records.get(`Reminder/${id.toUpperCase()}`)!; }
  organization(id: string) {
    return readReminderOrganization(this.root(id), [...this.records.values()].filter(record => record.recordType === "Attachment"),
      [...this.records.values()].filter(record => record.recordType === "Hashtag"), owner);
  }
}

async function setup() {
  const db = new SQLiteD1(), apple = new Apple(); apple.account = await accountScope(owner, "synthetic-account");
  const env = { ...db.env(), REMINDERS_OWNER_ID: owner, ENCRYPTION_KEY_ID: "synthetic",
    ENCRYPTION_KEYS_JSON: JSON.stringify({ synthetic: b64(crypto.getRandomValues(new Uint8Array(32))) }) };
  const service = () => new CreateWorkflowService(env, owner, apple);
  const input: CreateWorkflowInputData = { workflowId: crypto.randomUUID(), expectedGeneration: apple.generation,
    create: { listId: "List/SYNTHETIC", title: "Synthetic compound root", notes: "Private synthetic notes",
      dueDate: "2026-10-20T00:00:00Z", timeZone: "Europe/London", allDay: true },
    schedule: { recurrence: { frequency: "weekly", interval: 1, weekdays: [2] } },
    url: "https://synthetic.invalid/task", tags: ["synthetic", "compound"] };
  return { db, apple, env, service, input };
}

test("workflow final persistence, completed replay and uncertain recovery retain receipts but fence result release", async () => {
  for (const outcome of ["confirmed", "replay", "uncertain"] as const) {
    const { db, apple, env, service, input } = await setup();
    let release!: () => void;
    try {
      const request = { workflowId: input.workflowId, expectedGeneration: input.expectedGeneration, create: input.create };
      const settings = new ServiceSettingsRepository(env, owner);
      if (outcome === "replay") await service().run(request);
      if (outcome === "uncertain") apple.afterMutation = async () => { throw new WriteOutcomeUnknownError(apple.root(input.workflowId).recordName); };
      let entered!: () => void;
      const reached = new Promise<void>(resolve => { entered = resolve; });
      const held = new Promise<void>(resolve => { release = resolve; });
      db.afterStatement = async sql => {
        if (outcome === "replay" ? sql.startsWith("SELECT * FROM reminder_create_workflows")
          : sql.startsWith("UPDATE reminder_create_workflows SET lease_id = NULL")) {
          db.afterStatement = null; entered(); await held;
        }
      };
      const rejected = assert.rejects(service().run(request), hasCode(outcome === "confirmed" ? "FORBIDDEN" : "CONFLICT"));
      await reached;
      const receipt = db.sqlite.prepare("SELECT * FROM reminder_create_workflows").get();
      const current = await settings.load();
      await settings.save({ expectedRevision: current.revision, settings: { ...current.settings, reminders: { ...current.settings.reminders, write: false } } });
      if (outcome !== "confirmed") await settings.save({ expectedRevision: current.revision + 1, settings: current.settings });
      release(); await rejected;
      assert.deepEqual(db.sqlite.prepare("SELECT * FROM reminder_create_workflows").get(), receipt, "The result fence never erases or rewrites committed receipts.");
      if (outcome === "confirmed") await settings.save({ expectedRevision: current.revision + 1, settings: current.settings });
      apple.afterMutation = null;
      const mutations = apple.serial;
      const retry = await service().run(request);
      assert.equal(retry.state, outcome === "uncertain" ? "recovery_required" : "completed");
      assert.equal(apple.serial, mutations, "A new permitted request reconciles the ledger without redispatch.");
      assert.equal(apple.records.size, 1);
    } finally { release?.(); db.sqlite.close(); }
  }
});

test("confirmed stages resume across service instances and completed replays preserve one root and its native links", async () => {
  const { db, apple, env, service, input } = await setup();
  try {
    let pause = true;
    apple.beforeRead = async () => { if (pause) { pause = false; throw new AppError("UPSTREAM_UNAVAILABLE", "Synthetic read interrupted", 503); } };
    const partial = await service().run(input);
    assert.equal(partial.state, "paused");
    assert.equal(partial.record?.recordChangeTag, apple.root(input.workflowId).recordChangeTag);
    assert.deepEqual(partial.stages.map(stage => stage.status), ["confirmed", "pending", "pending", "pending"]);
    const completed = await service().run(input);
    assert.equal(completed.state, "completed");
    assert.ok(completed.stages.every(stage => stage.status === "confirmed"));
    for (let index = 1; index < completed.stages.length; index++)
      assert.equal(completed.stages[index].inputVersion, completed.stages[index - 1].record!.recordChangeTag);
    const organization = apple.organization(input.workflowId);
    assert.equal(organization.url?.url, input.url);
    assert.deepEqual(organization.tags.map(tag => tag.name), input.tags);
    assert.equal(normalizeReminder(apple.root(input.workflowId), owner).recurrenceRuleIds?.length, 1);
    const beforeReplay = structuredClone([...apple.records]);
    assert.deepEqual(await service().run({ ...input, workflowId: input.workflowId.toUpperCase() }), completed);
    assert.deepEqual([...apple.records], beforeReplay);
    assert.equal([...apple.records.values()].filter(record => record.recordType === "Reminder").length, 1);
    const persisted = JSON.stringify(db.sqlite.prepare("SELECT * FROM reminder_create_workflows").all());
    for (const secret of [owner, input.create.title, input.create.notes!, input.create.listId, input.url!, "synthetic-version", "weekly", "Europe/London"])
      assert.equal(persisted.includes(secret), false, `encrypted content: ${secret}`);
    await assert.rejects(service().run({ ...input, create: { ...input.create, title: "Changed request" } }), hasCode("CONFLICT"));
    const other = new CreateWorkflowService({ ...env, REMINDERS_OWNER_ID: "other-owner" }, "other-owner", apple);
    const isolated = await other.run(input);
    assert.equal(isolated.state, "recovery_required"); // Another owner's confirmed workflow was not replayed or adopted.
    assert.equal(isolated.record, null);
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS count FROM reminder_create_workflows").get()!.count, 2);
  } finally { db.sqlite.close(); }
});

test("lost Apple acknowledgements freeze each possible stage and retries only inspect the exact root", async () => {
  for (const action of ["create", "update", "set_url", "set_tags"] as const) {
    const { db, apple, service, input } = await setup();
    try {
      apple.afterMutation = async mutation => { if (mutation.action === action) throw new WriteOutcomeUnknownError(apple.root(input.workflowId).recordName); };
      const partial = await service().run(input);
      const position = ["create", "update", "set_url", "set_tags"].indexOf(action);
      assert.equal(partial.state, "recovery_required");
      assert.deepEqual(partial.stages.map(stage => stage.status), [0, 1, 2, 3].map(index => index < position ? "confirmed" : index === position ? "uncertain" : "pending"));
      assert.equal(partial.recovery?.readOnly, true);
      assert.equal(partial.recovery?.inspection?.id, partial.reminderId);
      const snapshot = structuredClone([...apple.records]);
      apple.afterMutation = null;
      const retry = await service().run(input);
      assert.equal(retry.state, "recovery_required");
      assert.deepEqual([...apple.records], snapshot);
      assert.equal(apple.organization(input.workflowId).tags.length, action === "set_tags" ? 2 : 0);
      if (position < 2) assert.equal(apple.organization(input.workflowId).url, null);
      apple.beforeRead = async () => { throw new AppError("UPSTREAM_UNAVAILABLE", "Synthetic inspection unavailable", 503); };
      const unavailable = await service().run(input);
      assert.equal(unavailable.recovery?.inspectionStatus, "unavailable");
      assert.deepEqual(unavailable.stages, retry.stages);
    } finally { db.sqlite.close(); }
  }
});

test("a lost durable-start acknowledgement and an expired in-flight lease cannot redispatch", async () => {
  const { db, apple, service, input } = await setup();
  try {
    let lost = true;
    db.afterStatement = async sql => {
      if (lost && sql.includes("SET envelope")) { lost = false; throw new Error("Synthetic D1 acknowledgement lost"); }
    };
    const first = await service().run(input);
    assert.equal(first.stages[0].status, "started");
    assert.equal(first.recovery?.inspectionStatus, "missing");
    assert.equal(apple.records.size, 0);
    db.afterStatement = null;
    assert.equal((await service().run(input)).state, "recovery_required");
    assert.equal(apple.records.size, 0);
  } finally { db.sqlite.close(); }

  const next = await setup();
  try {
    let retry: Awaited<ReturnType<CreateWorkflowService["run"]>> | null = null;
    next.apple.afterMutation = async mutation => {
      if (mutation.action === "create") {
        next.db.sqlite.prepare("UPDATE reminder_create_workflows SET lease_until = ?").run(Date.now() - CREATE_WORKFLOW_LEASE_MS);
        retry = await next.service().run(next.input);
      }
    };
    const result = await next.service().run(next.input);
    assert.equal(result.state, "recovery_required");
    assert.equal(result.stages[0].status, "started");
    assert.equal((retry as unknown as typeof result).recovery?.readOnly, true);
    assert.equal(next.apple.records.size, 1);
    assert.equal((await next.service().run(next.input)).state, "recovery_required");
    assert.equal(next.apple.records.size, 1);
  } finally { next.db.sqlite.close(); }
});

test("changed root versions and account/session generations cannot be silently adopted", async () => {
  const { db, apple, service, input } = await setup();
  try {
    let interrupted = true;
    apple.beforeRead = async () => { if (interrupted) { interrupted = false; throw new AppError("UPSTREAM_UNAVAILABLE", "Synthetic pause", 503); } };
    const partial = await service().run(input);
    apple.root(input.workflowId).recordChangeTag = "synthetic-native-edit";
    const blocked = await service().run(input);
    assert.equal(blocked.state, "blocked");
    assert.equal(blocked.stages[1].failure, "CONFLICT");
    assert.equal(blocked.record?.recordChangeTag, partial.record?.recordChangeTag);
    assert.equal(apple.records.size, 1);
    apple.account = await accountScope(owner, "different-synthetic-account");
    await assert.rejects(service().run(input), hasCode("CONFLICT"));
    apple.account = await accountScope(owner, "synthetic-account"); apple.generation++;
    await assert.rejects(service().run(input), hasCode("CONFLICT"));
    await assert.rejects(service().run({ ...input, expectedGeneration: apple.generation }), hasCode("CONFLICT"));
    assert.equal(apple.records.size, 1);
  } finally { db.sqlite.close(); }

  const active = await setup();
  try {
    active.apple.beforeRead = async () => { active.apple.account = await accountScope(owner, "replacement-during-workflow"); };
    await assert.rejects(active.service().run(active.input), hasCode("CONFLICT"));
    assert.equal(active.apple.records.size, 1, "account replacement between confirmed phases cannot dispatch the next mutation");
    assert.equal(active.apple.organization(active.input.workflowId).url, null);
  } finally { active.db.sqlite.close(); }
});

test("concurrent calls compete for one SQL lease before any dispatch", async () => {
  const { db, apple, service, input } = await setup();
  try {
    let notify!: () => void, release!: () => void;
    const claimed = new Promise<void>(resolve => { notify = resolve; });
    const hold = new Promise<void>(resolve => { release = resolve; });
    let pause = true;
    db.afterStatement = async sql => {
      if (pause && sql.includes("SET lease_id = ?, lease_until = ?")) { pause = false; notify(); await hold; }
    };
    const running = service().run(input);
    await claimed;
    assert.equal(apple.records.size, 0);
    await assert.rejects(service().run(input), hasCode("CONFLICT"));
    release();
    const result = await running;
    assert.equal(result.state, "completed");
    assert.equal([...apple.records.values()].filter(record => record.recordType === "Reminder").length, 1);
    assert.equal(apple.organization(input.workflowId).tags.length, 2);
  } finally { db.sqlite.close(); }
});

test("unverified schedules stop before their write while strict inputs exclude new compound recipes", async () => {
  const { db, apple, service, input } = await setup();
  try {
    const early = { ...input, schedule: { earlyReminder: { unit: "minutes" as const, count: 15 } } };
    const partial = await service().run(early); // No private early-reminder witness exists in this graph.
    assert.equal(partial.state, "blocked");
    assert.equal(partial.stages[0].status, "confirmed");
    assert.equal(partial.stages[1].failure, "UNSUPPORTED_FEATURE");
    assert.equal(apple.records.size, 1);
    assert.equal(apple.organization(input.workflowId).url, null);
    const credentialURL = new URL("https://synthetic.invalid");
    credentialURL.username = crypto.randomUUID(); credentialURL.password = crypto.randomUUID();
    for (const invalid of [
      { ...input, schedule: { recurrence: { frequency: "hourly", interval: 1 } } },
      { ...input, create: { ...input.create, allDay: false } },
      { ...input, schedule: { recurrence: { frequency: "daily", interval: 1 }, earlyReminder: { unit: "hours", count: 1 } } },
      { ...input, schedule: { locationAlarm: { proximity: "arriving" } } },
      { ...input, url: credentialURL.href },
      { ...input, tags: ["duplicate", "duplicate"] },
      { ...input, create: { ...input.create, idempotencyKey: crypto.randomUUID() } },
      { ...input, children: [] },
    ]) {
      assert.equal(CreateWorkflowInput.safeParse(invalid).success, false);
      await assert.rejects(service().run(invalid), hasCode("VALIDATION_ERROR"));
    }
    assert.equal(CreateWorkflowOutput.safeParse({ ...partial, raw: {} }).success, false);
  } finally { db.sqlite.close(); }

  const location = await setup();
  try {
    const place = { title: "Synthetic place", address: "Synthetic address", latitude: 51.5, longitude: -0.1 };
    const result = await location.service().run({ ...location.input,
      schedule: { locationAlarm: { place, proximity: "arriving", radiusMeters: 100 } } });
    assert.equal(result.state, "completed");
    assert.equal(normalizeReminder(location.apple.root(location.input.workflowId), owner).alarmIds?.length, 1);
    const trigger = [...location.apple.records.values()].find(record => record.recordType === "AlarmTrigger")!;
    assert.deepEqual(trigger.fields.Title, { type: "STRING", value: place.title, isEncrypted: true });
    assert.deepEqual(location.apple.organization(location.input.workflowId).tags.map(tag => tag.name), location.input.tags);
  } finally { location.db.sqlite.close(); }
});
