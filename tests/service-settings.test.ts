import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { readFileSync } from "node:fs";
import { AppError } from "../src/errors.ts";
import { ServiceSettingsRepository } from "../src/persistence/service-settings.ts";
import { DEFAULT_SERVICE_SETTINGS, isServicePermissionEnabled, requireServicePermission, ServiceSettingsSchema } from "../src/services/settings.ts";

class SQLiteD1 {
  readonly sqlite = new DatabaseSync(":memory:");
  sessionCalls: string[] = [];
  failure: Error | null = null;
  withSession(consistency: string) { this.sessionCalls.push(consistency); return this; }
  prepare(sql: string) {
    const source = this;
    const make = (params: SQLInputValue[]) => ({
      bind(...values: SQLInputValue[]) { return make(values); },
      async first<T>() {
        if (source.failure) throw source.failure;
        return source.sqlite.prepare(sql).get(...params) as T ?? null;
      },
      async run() {
        if (source.failure) throw source.failure;
        const result = source.sqlite.prepare(sql).run(...params);
        return { success: true, meta: { changes: Number(result.changes) } };
      },
    });
    return make([]);
  }
  applyMigration() { this.sqlite.exec(readFileSync(new URL("../migrations/0002_service_settings.sql", import.meta.url), "utf8")); }
  env() { return { DB: this as unknown as D1Database }; }
}

const repo = (db: SQLiteD1, owner = "owner-a") => new ServiceSettingsRepository(db.env(), owner);
const appCode = (code: string) => (error: unknown) => error instanceof AppError && error.code === code;
const driveOnlyBrowse = { reminders: { enabled: false, read: false, write: false }, drive: { enabled: true, browse: true, contents: false, upload: false, organize: false } };

test("settings schema is strict, preserves defaults, and enforces Drive browse dependencies", () => {
  assert.deepEqual(ServiceSettingsSchema.parse(DEFAULT_SERVICE_SETTINGS), {
    reminders: { enabled: true, read: true, write: true },
    drive: { enabled: false, browse: false, contents: false, upload: false, organize: false },
  });
  assert.equal(ServiceSettingsSchema.safeParse({ ...DEFAULT_SERVICE_SETTINGS, extra: true }).success, false);
  for (const operation of ["contents", "upload", "organize"] as const) {
    assert.equal(ServiceSettingsSchema.safeParse({ ...driveOnlyBrowse, drive: { ...driveOnlyBrowse.drive, browse: false, [operation]: true } }).success, false);
  }
  assert.equal(ServiceSettingsSchema.safeParse({ ...driveOnlyBrowse, drive: { ...driveOnlyBrowse.drive, enabled: false, browse: false, upload: true } }).success, true);
});

test("permission checks require the service and operation, including Drive browse prerequisite", async () => {
  assert.equal(isServicePermissionEnabled(DEFAULT_SERVICE_SETTINGS, "reminders.read"), true);
  assert.equal(isServicePermissionEnabled(DEFAULT_SERVICE_SETTINGS, "reminders.write"), true);
  assert.equal(isServicePermissionEnabled(DEFAULT_SERVICE_SETTINGS, "drive.browse"), false);
  assert.equal(isServicePermissionEnabled(driveOnlyBrowse, "drive.browse"), true);
  assert.equal(isServicePermissionEnabled(driveOnlyBrowse, "drive.upload"), false);
  assert.throws(() => requireServicePermission(DEFAULT_SERVICE_SETTINGS, "drive.contents"), appCode("FORBIDDEN"));
  requireServicePermission(driveOnlyBrowse, "drive.browse");
});

test("missing table preserves legacy defaults but refuses writes; installed table starts at revision zero", async () => {
  const db = new SQLiteD1();
  try {
    assert.deepEqual(await repo(db).load(), { revision: 0, settings: DEFAULT_SERVICE_SETTINGS, available: false });
    await assert.rejects(repo(db).save({ expectedRevision: 0, settings: DEFAULT_SERVICE_SETTINGS }), appCode("CONFIGURATION_REQUIRED"));
    db.applyMigration();
    assert.deepEqual(await repo(db).load(), { revision: 0, settings: DEFAULT_SERVICE_SETTINGS, available: true });
    assert.ok(db.sessionCalls.every(value => value === "first-primary"));
  } finally { db.sqlite.close(); }
});

test("revision compare-and-swap commits first save, updates once, and rejects stale tabs", async () => {
  const db = new SQLiteD1(); db.applyMigration();
  try {
    const saved = await repo(db).save({ expectedRevision: 0, settings: driveOnlyBrowse });
    assert.deepEqual(saved, { revision: 1, settings: driveOnlyBrowse, available: true });
    const next = { ...driveOnlyBrowse, drive: { ...driveOnlyBrowse.drive, upload: true } };
    assert.deepEqual(await repo(db).save({ expectedRevision: 1, settings: next }), { revision: 2, settings: next, available: true });
    await assert.rejects(repo(db).save({ expectedRevision: 1, settings: driveOnlyBrowse }), appCode("CONFLICT"));
    assert.deepEqual(await repo(db).load(), { revision: 2, settings: next, available: true });
  } finally { db.sqlite.close(); }
});

test("settings are isolated by owner and invalid stored data or database failures fail closed", async () => {
  const db = new SQLiteD1(); db.applyMigration();
  try {
    await repo(db, "owner-a").save({ expectedRevision: 0, settings: driveOnlyBrowse });
    assert.deepEqual(await repo(db, "owner-b").load(), { revision: 0, settings: DEFAULT_SERVICE_SETTINGS, available: true });
    db.sqlite.prepare("INSERT INTO owner_service_settings (owner_id, revision, settings_json, updated_at) VALUES (?, ?, ?, ?)").run("broken-json", 1, "{", 1);
    db.sqlite.prepare("INSERT INTO owner_service_settings (owner_id, revision, settings_json, updated_at) VALUES (?, ?, ?, ?)").run("bad-settings", 1, JSON.stringify({ ...driveOnlyBrowse, extra: true }), 1);
    await assert.rejects(repo(db, "broken-json").load(), appCode("CONFIGURATION_REQUIRED"));
    await assert.rejects(repo(db, "bad-settings").load(), appCode("CONFIGURATION_REQUIRED"));
    db.failure = new Error("synthetic database outage");
    await assert.rejects(repo(db).load(), /synthetic database outage/);
  } finally { db.sqlite.close(); }
});
