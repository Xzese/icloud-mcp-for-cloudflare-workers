import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JobSQLiteD1 } from "./helpers/sqlite-d1.ts";
import { AppError } from "../src/errors.ts";
import { Envelopes } from "../src/crypto/envelopes.ts";
import { b64 } from "../src/crypto/bytes.ts";
import { ConnectorFilterRepository } from "../src/persistence/connector-filters.ts";
import { ServiceSettingsRepository } from "../src/persistence/service-settings.ts";

class SQLiteD1 extends JobSQLiteD1 {
  constructor() {
    super();
    this.sqlite.exec(readFileSync(new URL("../migrations/0005_connector_filters.sql", import.meta.url), "utf8"));
  }
}

const owner = "synthetic-owner";
const encryption = () => new Envelopes("synthetic", { synthetic: b64(crypto.getRandomValues(new Uint8Array(32))) });
const repository = (db: SQLiteD1, who = owner, envelopes = encryption()) => new ConnectorFilterRepository({
  ...db.env(), REMINDERS_OWNER_ID: who, ENCRYPTION_KEY_ID: envelopes.active, ENCRYPTION_KEYS_JSON: JSON.stringify(envelopes.keys),
}, who, envelopes);
const definition = (sortBy: "due" | "title" = "due") => ({
  view: "upcoming" as const, timeZone: "Europe/London", upcomingDays: 14, sortBy, filters: { status: "open" as const },
});
const hasCode = (code: string) => (error: unknown) => error instanceof AppError && error.code === code;

function gate() {
  let entered!: () => void, release!: () => void;
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  return { reached, release, async wait() { entered(); await held; } };
}

test("connector filters are encrypted at rest and isolated by owner", async () => {
  const db = new SQLiteD1(), envelopes = encryption(), id = crypto.randomUUID();
  try {
    const first = repository(db, owner, envelopes), other = repository(db, "other-owner", envelopes);
    const created = await first.save({ filterId: id, name: "Upcoming work", definition: definition() });
    assert.equal(created.revision, 1);
    const stored = db.sqlite.prepare("SELECT envelope FROM connector_filters WHERE owner_id = ? AND filter_id = ?").get(owner, id) as { envelope: string };
    assert.ok(stored.envelope.includes("ciphertext"));
    assert.equal(stored.envelope.includes("Upcoming work"), false);
    assert.equal(stored.envelope.includes("Europe/London"), false);
    assert.deepEqual(await first.get(id), created);
    assert.deepEqual(await other.list(), []);
    await assert.rejects(other.get(id), hasCode("FORBIDDEN"));
    assert.equal((await first.list()).length, 1);
  } finally { db.sqlite.close(); }
});

test("save supports create and update replays while updates and deletes use exact revisions", async () => {
  const db = new SQLiteD1(), repo = repository(db), filterId = crypto.randomUUID();
  try {
    const input = { filterId, name: "Open items", definition: definition() };
    const created = await repo.save(input);
    assert.deepEqual(await repo.save(input), created, "create retry with identical payload is idempotent");
    assert.deepEqual(await repo.save({ ...input, filterId: filterId.toUpperCase() }), created, "UUID case cannot allocate a second definition");
    const update = { ...input, name: "Sorted items", definition: definition("title"), expectedRevision: created.revision };
    const updated = await repo.save(update);
    assert.equal(updated.revision, 2);
    assert.deepEqual(await repo.save(update), updated, "update retry succeeds only for its exact already committed payload");
    await assert.rejects(repo.save({ ...update, name: "Different", expectedRevision: created.revision }), hasCode("CONFLICT"));
    await assert.rejects(repo.delete({ filterId, expectedRevision: created.revision }), hasCode("CONFLICT"));
    assert.deepEqual(await repo.delete({ filterId, expectedRevision: updated.revision }), { filterId, deleted: true });
    await assert.rejects(repo.get(filterId), hasCode("FORBIDDEN"));
  } finally { db.sqlite.close(); }
});

test("the migration atomically caps each owner at 32 filters", async () => {
  const db = new SQLiteD1(), repo = repository(db);
  try {
    for (let index = 0; index < 32; index++)
      await repo.save({ filterId: crypto.randomUUID(), name: `Filter ${index}`, definition: definition() });
    await assert.rejects(repo.save({ filterId: crypto.randomUUID(), name: "Over limit", definition: definition() }), hasCode("CONFLICT"));
    assert.equal((await repo.list()).length, 32);
    const other = repository(db, "other-owner");
    assert.equal((await other.save({ filterId: crypto.randomUUID(), name: "Other owner", definition: definition() })).revision, 1);
  } finally { db.sqlite.close(); }
});

test("filter mutations atomically reject settings changes at the SQL boundary, including revision-zero defaults", async () => {
  for (const operation of ["create", "update", "delete"] as const) {
    const db = new SQLiteD1(), repo = repository(db), settings = new ServiceSettingsRepository(repo.env, owner), pause = gate();
    try {
      const input = { filterId: crypto.randomUUID(), name: "Original", definition: definition() };
      if (operation !== "create") await repo.save(input);
      if (operation === "update") await settings.save({ expectedRevision: 0, settings: (await settings.load()).settings });
      const before = db.sqlite.prepare("SELECT * FROM connector_filters").all();
      db.beforeStatement = async sql => {
        if (/^(INSERT INTO|UPDATE|DELETE FROM) connector_filters/.test(sql)) { db.beforeStatement = null; await pause.wait(); }
      };
      const running = operation === "delete" ? repo.delete({ filterId: input.filterId, expectedRevision: 1 })
        : repo.save(operation === "update" ? { ...input, name: "Updated", expectedRevision: 1 } : input);
      const rejected = assert.rejects(running, hasCode(operation === "update" ? "CONFLICT" : "FORBIDDEN"));
      await pause.reached;
      const current = await settings.load();
      await settings.save({ expectedRevision: current.revision, settings: operation === "update" ? current.settings
        : { ...current.settings, reminders: { ...current.settings.reminders, write: false } } });
      pause.release(); await rejected;
      assert.deepEqual(db.sqlite.prepare("SELECT * FROM connector_filters").all(), before, "The raced statement commits no filter change.");
    } finally { pause.release(); db.sqlite.close(); }
  }
});

test("filter encryption, read decryption and identical replays cannot release results across permission revisions", async () => {
  for (const operation of ["create", "get", "list", "replay"] as const) {
    const db = new SQLiteD1(), envelopes = encryption(), repo = repository(db, owner, envelopes), settings = new ServiceSettingsRepository(repo.env, owner), pause = gate();
    try {
      const input = { filterId: crypto.randomUUID(), name: "Original", definition: definition() };
      if (operation !== "create") await repo.save(input);
      const key = envelopes.key.bind(envelopes);
      envelopes.key = async id => { const result = await key(id); envelopes.key = key; await pause.wait(); return result; };
      const running = operation === "get" ? repo.get(input.filterId) : operation === "list" ? repo.list() : repo.save(input);
      const rejected = assert.rejects(running, hasCode("CONFLICT"));
      await pause.reached;
      const current = await settings.load();
      await settings.save({ expectedRevision: current.revision, settings: { ...current.settings, reminders: { enabled: false, read: false, write: false } } });
      await settings.save({ expectedRevision: current.revision + 1, settings: current.settings });
      pause.release(); await rejected;
      assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS count FROM connector_filters").get()?.count, operation === "create" ? 0 : 1);
    } finally { pause.release(); db.sqlite.close(); }
  }
});

test("missing service settings preserve bounded filter reads but refuse mutations", async () => {
  const db = new SQLiteD1(), repo = repository(db);
  try {
    const input = { filterId: crypto.randomUUID(), name: "Retained", definition: definition() };
    await repo.save(input);
    db.sqlite.exec("DROP TABLE owner_service_settings");
    assert.equal((await repo.get(input.filterId)).name, input.name);
    assert.equal((await repo.list()).length, 1);
    await assert.rejects(repo.save(input), hasCode("CONFIGURATION_REQUIRED"));
    await assert.rejects(repo.delete({ filterId: input.filterId, expectedRevision: 1 }), hasCode("CONFIGURATION_REQUIRED"));
  } finally { db.sqlite.close(); }
});
