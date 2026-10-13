import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { readFileSync } from "node:fs";
import { sessionServices } from "../src/auth/apple/services.ts";
import { AppleSessionRepository, RecurringIntentSchema, mergeSavedLists, type AppleSession } from "../src/persistence/apple-sessions.ts";
import { AppleConnectionService, ControlledRead, SearchReminderInput } from "../src/auth/service.ts";
import { AppError } from "../src/errors.ts";
import { omitField } from "../src/lib/omit-field.ts";
import { CookieJar } from "../src/transport/cookie-jar.ts";
import { Envelopes } from "../src/crypto/envelopes.ts";
import { LoginAssuranceSchema, loginAssurance, SESSION_RETENTION_MS } from "../src/auth/apple/policy.ts";
import { AppleSessionRenewal, appleRequestBudget, renewalCheckpoint } from "../src/auth/apple/session-renewal.ts";
import { encodeDocument } from "../src/reminders/crdt.ts";
import { buildCreateReminder } from "../src/reminders/writes.ts";
import { buildCreateList } from "../src/reminders/list-writes.ts";
import { encodeGroceryCorrections, encodeSectionMemberships, groceryCorrectionsChecksum, membershipsChecksum, SHOPPING_PROTOCOL_VERSION } from "../src/reminders/shopping-categories.ts";
import { b64 } from "../src/crypto/bytes.ts";

// Real SQLite executes repository SQL. This adapter models D1's transactional batch.
// The produced Worker is separately tested in workerd with real D1 bindings.
class SQLiteD1 {
  readonly sqlite = new DatabaseSync(":memory:");
  afterStatement: ((sql: string) => Promise<void>) | null = null;
  constructor() {
    this.sqlite.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  }
  withSession() { return this; }
  prepare(sql: string) {
    const source = this;
    function make(params: SQLInputValue[]) {
      return {
        bind(...values: SQLInputValue[]) { return make(values); },
        async first<T>() { const result = source.sqlite.prepare(sql).get(...params); if (source.afterStatement) await source.afterStatement(sql); return result as T ?? null; },
        async run() { const result = source.sqlite.prepare(sql).run(...params); if (source.afterStatement) await source.afterStatement(sql); return { success: true, meta: { changes: Number(result.changes) } }; },
      };
    }
    return make([]);
  }
  async batch(statements: { run(): Promise<unknown> }[]) {
    this.sqlite.exec("BEGIN");
    try { const results = []; for (const statement of statements) results.push(await statement.run()); this.sqlite.exec("COMMIT"); return results; }
    catch (error) { this.sqlite.exec("ROLLBACK"); throw error; }
  }
  env() { return { DB: this as unknown as D1Database }; }
}
const key = () => new Envelopes("synthetic", { synthetic: b64(crypto.getRandomValues(new Uint8Array(32))) });
const owner = "synthetic-owner";
const appleSession = (): AppleSession => ({
  login: loginAssurance(),
  auth: {
    clientId: "auth-session-123",
    headers: { "X-Apple-Session-Token": "header-session-secret" },
    cookies: [{ name: "X-APPLE-WEBAUTH-TOKEN", value: "cookie-session-secret", domain: "icloud.com", hostOnly: false, path: "/", secure: true, expiresAt: null }],
  },
  connection: { dsid: "123456789", clientId: "auth-session-123", clientBuildNumber: "2534Project66", clientMasteringNumber: "2534B22", cloudKitURL: "https://p123-ckdatabasews.icloud.com/database/1/com.apple.reminders/production/private" },
  pcs: { consentRequested: true, pcsAttempts: 1, consentChecks: 2, expiresAt: Date.now() + 300_000, nextAttemptAt: 0 },
});
const appleRepo = (db: SQLiteD1, who = owner, envelopes = key()) => new AppleSessionRepository({ ...db.env(), ENCRYPTION_KEY_ID: envelopes.active, ENCRYPTION_KEYS_JSON: JSON.stringify(envelopes.keys) }, who, envelopes);

const testEnv = (db: SQLiteD1, envelopes: Envelopes) => ({
  ...db.env(), REMINDERS_OWNER_ID: owner, ENCRYPTION_KEY_ID: envelopes.active, ENCRYPTION_KEYS_JSON: JSON.stringify(envelopes.keys),
  LIVE_APPLE_CONNECTION_APPROVED: "controlled-device-v2", APPLE_CRYPTO_REVIEW_APPROVED: "device-proof-v2",
  APPLE_SESSION_RETENTION_WRITES: "absolute-30d-v1", APPLE_SESSION_RENEWAL_ENABLED: "saved-tokens-v1",
});
async function fixedClock(run: (clock: { now: number }) => Promise<void>) {
  const nativeNow = Date.now;
  const clock = { now: Date.parse("2026-10-09T19:25:12.131Z") };
  Date.now = () => clock.now;
  try { await run(clock); } finally { Date.now = nativeNow; }
}
const acceptedAccount = (dsid = "123456789", host = "p123-ckdatabasews.icloud.com") => ({
  hsaTrustedBrowser: true, hsaChallengeRequired: false, termsUpdateNeeded: false,
  dsInfo: { dsid }, webservices: { ckdatabasews: { url: `https://${host}` } },
});
const hasCode = (code: string) => (error: unknown) => error instanceof AppError && error.code === code;
const syntheticMutableListFields = () => ({
  Name: { type: "STRING", value: "Synthetic list" }, Deleted: { type: "INT64", value: 0 }, IsGroup: { type: "INT64", value: 0 },
  ReminderIDs: { type: "STRING", value: "[]" },
  ResolutionTokenMap: { type: "STRING", value: JSON.stringify({ map: {
    reminderIDsMergeableOrdering: { counter: 1, modificationTime: 757_382_400, replicaID: "3e6cb834-5b1c-4ce6-8c39-00e752121111" },
  } }) },
});

test("legacy and retained assurance variants stay strict and separate authentication from retention", () => {
  const now = Date.parse("2026-10-09T19:25:12.131Z");
  const legacy = loginAssurance(now, false);
  const current = loginAssurance(now);
  assert.equal(legacy.expiresAt - now, 86_400_000);
  assert.equal(current.expiresAt - now, 2_592_000_000);
  assert.equal(current.policy, legacy.policy);
  for (const bad of [
    { ...legacy, expiresAt: current.expiresAt }, { ...current, expiresAt: legacy.expiresAt },
    { ...current, verifiedAt: Number.MAX_SAFE_INTEGER }, { ...current, factor: "password" },
    { ...current, consentPersistentSession: false }, { ...current, consentAppleTrust: "true" },
    { ...current, version: 4 }, { ...legacy, retentionSource: "owner-authorised-migration" },
    { ...current, previousExpiresAt: legacy.expiresAt },
  ]) assert.equal(LoginAssuranceSchema.safeParse(bad).success, false);
  assert.equal(new Date(current.expiresAt).toISOString(), "2026-11-08T19:25:12.131Z", "UTC arithmetic crosses the UK DST change without sliding.");
});

test("approved migration preserves all encrypted evidence, cursors and identities with zero Apple requests", async () => fixedClock(async clock => {
  const nativeFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => { requests++; throw new Error("Migration must not contact Apple."); };
  const db = new SQLiteD1(), envelopes = key(), repository = appleRepo(db, owner, envelopes);
  try {
    const original = appleSession(); original.login = loginAssurance(clock.now, false);
    original.auth.headers["X-Apple-TwoSV-Trust-Token"] = "synthetic-trust-token";
    original.savedLists = mergeSavedLists([], [{ id: "List/PRESERVED", title: "Synthetic list" }]);
    original.directListSnapshot = { updatedAt: clock.now };
    original.allOpenScan = { token: crypto.randomUUID(), expiresAt: clock.now + 600_000, listIds: ["List/PRESERVED"], lists: original.savedLists,
      index: 0, cursor: "synthetic-cursor", seen: [], listPages: 0, totalPages: 0, caughtUpAt: clock.now, source: "direct-cloudkit-query" };
    const setup = await repository.begin(0); await repository.commit(setup, original, "READY");
    const before = await repository.load();
    const beforeCipher = db.sqlite.prepare("SELECT envelope FROM apple_session_state").get()?.envelope;
    clock.now += 2 * 86_400_000;
    const approval = { migrationId: "synthetic-owner-approval", owner, account: "apple-reminders", generation: setup.generation };
    const env = { ...testEnv(db, envelopes), APPLE_SESSION_RETENTION_MIGRATION_JSON: JSON.stringify(approval) };
    const compatible = new AppleSessionRepository(env, owner);
    const migrated = await compatible.migrateOwnerSessionRetention();
    assert.equal(requests, 0);
    assert.equal(migrated.fence.generation, before.fence.generation);
    assert.equal(migrated.fence.version, before.fence.version + 1);
    assert.deepEqual(omitField(migrated.session, "login"), omitField(original, "login"));
    assert.equal(migrated.session.login.verifiedAt, original.login.verifiedAt);
    assert.equal(migrated.session.login.expiresAt, original.login.verifiedAt + 2_592_000_000);
    assert.equal(migrated.session.login.factor, original.login.factor);
    assert.ok(migrated.session.login.version === 3 && migrated.session.login.retentionSource === "owner-authorised-migration");
    assert.equal(migrated.session.login.previousExpiresAt, original.login.expiresAt);
    assert.equal(migrated.session.login.migratedAt, clock.now);
    assert.notEqual(db.sqlite.prepare("SELECT envelope FROM apple_session_state").get()?.envelope, beforeCipher);
    clock.now += 1000;
    assert.deepEqual(await compatible.migrateOwnerSessionRetention(), migrated);
    const restarted = new AppleSessionRepository(testEnv(db, envelopes), owner);
    assert.deepEqual(await restarted.load(), migrated, "Removing approval and restarting must not shorten the committed session.");
    for (let index = 0; index < 3; index++) assert.equal((await new AppleConnectionService(env, owner).status()).retentionDays, 30);
    assert.equal(requests, 0, "Status polling is local-only.");
    const snapshot = await new AppleConnectionService(env, owner).read(ControlledRead.parse({ action: "saved-lists", expectedGeneration: setup.generation }));
    assert.equal((snapshot.result as { records: unknown[] }).records.length, 1);
    assert.equal(requests, 0, "Dashboard snapshot polling must not perform renewal, even when a check is due.");
    await assert.rejects(new AppleConnectionService(env, owner).readAllOpenForMCP(setup.generation, original.allOpenScan.token), hasCode("RESTART_REQUIRED"));
    assert.equal((await restarted.load()).session.allOpenScan, undefined);
    assert.equal((await restarted.status()).state, "READY", "Expired pagination must not expire the migrated account.");
  } finally { globalThis.fetch = nativeFetch; db.sqlite.close(); }
}));

test("migration eligibility rejects unapproved, wrong-owner/generation, disconnected and hard-expired sessions", async () => fixedClock(async clock => {
  for (const variant of ["unapproved", "wrong-generation", "wrong-requester", "expired", "disconnected", "absent", "pending"] as const) {
    const db = new SQLiteD1(), envelopes = key(), repository = appleRepo(db, owner, envelopes), original = appleSession();
    original.login = loginAssurance(clock.now, false);
    const setup = await repository.begin(0);
    await repository.commit(setup, original, variant === "pending" ? "DEVICE_APPROVAL_PENDING" : "READY", variant === "pending" ? "approve-device-consent" : undefined);
    const approval = { migrationId: "synthetic-scope", owner, account: "apple-reminders", generation: variant === "wrong-generation" ? 99 : setup.generation };
    const env = { ...testEnv(db, envelopes), APPLE_SESSION_RETENTION_MIGRATION_JSON: variant === "unapproved" ? undefined : JSON.stringify(approval) };
    const compatible = new AppleSessionRepository(env, variant === "wrong-requester" ? "other-owner" : owner);
    if (variant === "disconnected") await repository.disconnect();
    if (variant === "absent") db.sqlite.prepare("UPDATE apple_session_state SET envelope = NULL").run();
    const savedTime = clock.now;
    if (variant === "expired") clock.now += SESSION_RETENTION_MS;
    try {
      if (["disconnected", "wrong-requester"].includes(variant)) await assert.rejects(compatible.load(), hasCode("NOT_CONNECTED"));
      else if (variant === "expired") await assert.rejects(compatible.load(), hasCode("AUTH_EXPIRED"));
      else if (variant === "absent") await assert.rejects(compatible.load(), hasCode("REAUTH_REQUIRED"));
      else {
        const saved = await compatible.load();
        assert.equal(saved.session.login.version, variant === "pending" ? 3 : 2);
        if (variant === "pending") assert.equal(saved.state, "DEVICE_APPROVAL_PENDING");
      }
      if (variant === "wrong-requester") assert.equal((await repository.load()).session.login.version, 2);
    } finally { clock.now = savedTime; db.sqlite.close(); }
  }
  const db = new SQLiteD1(), envelopes = key();
  for (const approval of ["not-json", JSON.stringify({ owner: "wrong" }), JSON.stringify({ migrationId: "bad", owner: "other", account: "apple-reminders", generation: 1 })]) {
    assert.throws(() => new AppleSessionRepository({ ...testEnv(db, envelopes), APPLE_SESSION_RETENTION_MIGRATION_JSON: approval }, owner), hasCode("CONFIGURATION_REQUIRED"));
  }
  db.sqlite.close();
}));

test("migration CAS serializes concurrent calls, defers active leases and cannot restore a disconnect", async () => fixedClock(async clock => {
  for (const race of ["parallel", "operation", "disconnect", "cookie-update"] as const) {
    const db = new SQLiteD1(), envelopes = key(), repository = appleRepo(db, owner, envelopes), original = appleSession();
    original.login = loginAssurance(clock.now, false);
    const setup = await repository.begin(0); await repository.commit(setup, original, "READY");
    const env = { ...testEnv(db, envelopes), APPLE_SESSION_RETENTION_MIGRATION_JSON: JSON.stringify({ migrationId: "race", owner, account: "apple-reminders", generation: setup.generation }) };
    const compatible = new AppleSessionRepository(env, owner);
    const before = await repository.load();
    if (race === "operation") {
      await repository.claimRead(before.fence.generation, before.fence.version);
      clock.now += 86_400_001;
      db.sqlite.prepare("UPDATE apple_session_state SET resume_expires_at = ?").run(clock.now + 30_000);
      await assert.rejects(compatible.status(), hasCode("CONFLICT"));
      assert.ok(db.sqlite.prepare("SELECT envelope FROM apple_session_state").get()?.envelope);
      db.sqlite.prepare("UPDATE apple_session_state SET resume_expires_at = ?").run(clock.now);
      assert.equal((await compatible.load()).session.login.version, 3);
      clock.now -= 86_400_001;
    } else if (race === "parallel") {
      const results = await Promise.allSettled([compatible.load(), new AppleSessionRepository(env, owner).load()]);
      assert.ok(results.some(result => result.status === "fulfilled"));
      assert.equal((await compatible.load()).fence.version, before.fence.version + 1);
    } else {
      const nativeEncrypt = compatible.envelopes.encrypt.bind(compatible.envelopes);
      compatible.envelopes.encrypt = async (...args: Parameters<Envelopes["encrypt"]>) => {
        const result = await nativeEncrypt(...args);
        if (race === "disconnect") await repository.disconnect();
        else db.sqlite.prepare("UPDATE apple_session_state SET version = version + 1").run();
        return result;
      };
      await assert.rejects(compatible.load(), hasCode("CONFLICT"));
      compatible.envelopes.encrypt = nativeEncrypt;
      if (race === "disconnect") {
        assert.equal((await compatible.status()).state, "DISCONNECTED");
        assert.equal(db.sqlite.prepare("SELECT envelope FROM apple_session_state").get()?.envelope, null);
      } else assert.deepEqual((await repository.load()).session, original);
    }
    db.sqlite.close();
  }
}));

test("ordinary commits cannot change migrated retention evidence, consent or account identity", async () => fixedClock(async clock => {
  const db = new SQLiteD1(), envelopes = key(), repository = appleRepo(db, owner, envelopes), original = appleSession();
  original.login = loginAssurance(clock.now, false);
  const setup = await repository.begin(0); await repository.commit(setup, original, "READY");
  const compatible = new AppleSessionRepository({ ...testEnv(db, envelopes), APPLE_SESSION_RETENTION_MIGRATION_JSON: JSON.stringify({ migrationId: "immutable", owner, account: "apple-reminders", generation: setup.generation }) }, owner);
  const saved = await compatible.load(), fence = await compatible.claimRead(saved.fence.generation, saved.fence.version);
  const login = saved.session.login;
  assert.ok(login.version === 3 && login.retentionSource === "owner-authorised-migration");
  for (const modified of [{ ...login, migratedAt: clock.now + 1 }, { ...login, migrationId: "another" }, loginAssurance(clock.now + 1)]) {
    await assert.rejects(compatible.commitResume(fence, { ...saved.session, login: modified }, "READY"), hasCode("VALIDATION_ERROR"));
  }
  await assert.rejects(compatible.commitResume(fence, { ...saved.session, connection: { ...saved.session.connection, dsid: "999" } }, "READY"), hasCode("VALIDATION_ERROR"));
  await compatible.commitResume(fence, saved.session, "READY");
  assert.deepEqual((await compatible.load()).session.login, login);
  db.sqlite.close();
}));

test("renewal reuses accepted credentials and exchanges saved tokens once without sliding retention", async () => fixedClock(async clock => {
  const nativeFetch = globalThis.fetch;
  const db = new SQLiteD1(), envelopes = key(), env = testEnv(db, envelopes), repository = new AppleSessionRepository(env, owner);
  const original = appleSession(); original.auth.headers["X-Apple-TwoSV-Trust-Token"] = "synthetic-trust";
  const setup = await repository.begin(0); await repository.commit(setup, original, "READY");
  const requests: { path: string; body: unknown; cookie: string | null }[] = [];
  let rejectValidation = false;
  globalThis.fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    requests.push({ path, body: JSON.parse(String(init?.body)), cookie: new Headers(init?.headers).get("cookie") });
    return new Response(JSON.stringify(acceptedAccount("123456789", "p42-ckdatabasews.icloud.com")), {
      status: path.endsWith("/validate") && rejectValidation ? 401 : 200,
      headers: { "content-type": "application/json", "set-cookie": "X-APPLE-WEBAUTH-TOKEN=synthetic-new; Domain=icloud.com; Path=/; Secure; Max-Age=3600", "X-Apple-Session-Token": "synthetic-updated" },
    });
  };
  try {
    const renewal = new AppleSessionRenewal(env, repository);
    await renewal.ensure(setup.generation, appleRequestBudget(), true);
    assert.deepEqual(requests.map(request => request.path), ["/setup/ws/1/validate"]);
    assert.equal(requests[0].body, null);
    const accepted = await repository.load();
    assert.equal(accepted.session.connection.cloudKitURL?.includes("p42-"), true);
    assert.equal(accepted.session.renewal?.lastValidatedAt, clock.now);
    assert.equal(accepted.session.renewal?.lastRenewedAt, null);
    assert.deepEqual(accepted.session.login, original.login);
    await renewal.ensure(setup.generation, appleRequestBudget()); assert.equal(requests.length, 1);
    clock.now += 6 * 60 * 60_000; rejectValidation = true;
    await renewal.ensure(setup.generation, appleRequestBudget());
    assert.deepEqual(requests.map(request => request.path), ["/setup/ws/1/validate", "/setup/ws/1/validate", "/setup/ws/1/accountLogin"]);
    assert.equal((requests[2].body as Record<string, unknown>).extended_login, true);
    assert.equal(Object.hasOwn(requests[2].body as object, "password"), false);
    const renewed = await repository.load();
    assert.deepEqual(renewed.session.login, original.login);
    assert.equal(renewed.session.auth.headers["X-Apple-Session-Token"], "synthetic-updated");
    assert.equal(renewed.session.renewal?.lastRenewedAt, clock.now);
    assert.equal(renewed.session.renewal?.lastAppleSuccessAt, null);
    assert.equal(renewed.session.auth.cookies.find(cookie => cookie.name === "X-APPLE-WEBAUTH-TOKEN")?.expiresAt, clock.now + 3_600_000);
  } finally { globalThis.fetch = nativeFetch; db.sqlite.close(); }
}));

test("renewal outcomes preserve non-revoked sessions, save cooldowns and stop account mismatch", async () => fixedClock(async clock => {
  const nativeFetch = globalThis.fetch;
  for (const scenario of ["revoked", "verification", "terms", "temporary", "rate", "protocol", "mismatch", "permission"] as const) {
    const db = new SQLiteD1(), envelopes = key(), env = testEnv(db, envelopes), repository = new AppleSessionRepository(env, owner);
    const original = appleSession(); original.auth.headers["X-Apple-TwoSV-Trust-Token"] = "synthetic-trust";
    const setup = await repository.begin(0); await repository.commit(setup, original, "READY");
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      const status = scenario === "revoked" ? 401 : scenario === "temporary" ? 503 : scenario === "rate" ? 429 : scenario === "permission" ? 403 : 200;
      const body = scenario === "verification" ? { ...acceptedAccount(), hsaChallengeRequired: true } : scenario === "terms" ? { ...acceptedAccount(), termsUpdateNeeded: true }
        : scenario === "protocol" ? { hsaTrustedBrowser: true } : scenario === "mismatch" ? acceptedAccount("999") : acceptedAccount();
      return new Response(JSON.stringify(body), { status, headers: scenario === "rate" ? { "retry-after": "7200" } : {} });
    };
    const code = scenario === "revoked" ? "REAUTH_REQUIRED" : scenario === "verification" ? "VERIFICATION_REQUIRED" : scenario === "terms" ? "TERMS_ACTION_REQUIRED"
      : scenario === "temporary" ? "UPSTREAM_UNAVAILABLE" : scenario === "rate" ? "RATE_LIMITED" : scenario === "permission" ? "FORBIDDEN" : "PROTOCOL_CHANGED";
    try {
      const renewal = new AppleSessionRenewal(env, repository);
      await assert.rejects(renewal.ensure(setup.generation, appleRequestBudget(), true), hasCode(code));
      assert.equal(calls, scenario === "revoked" ? 2 : 1);
      if (scenario === "revoked") {
        assert.equal((await repository.status()).state, "DISCONNECTED");
        assert.equal((await repository.status()).requiredAction, "apple-sign-in");
      } else {
        const saved = await repository.load();
        assert.deepEqual(saved.session.login, original.login);
        assert.deepEqual(saved.session.connection, original.connection);
        assert.equal(saved.session.renewal?.lastValidatedAt, null);
        assert.ok(saved.session.renewal?.nextRetryAt && saved.session.renewal.nextRetryAt > clock.now);
        if (scenario === "rate") assert.equal(saved.session.renewal?.nextRetryAt, clock.now + 7_200_000);
        await assert.rejects(renewal.ensure(setup.generation, appleRequestBudget(), true), AppError);
        assert.equal(calls, 1, "Persisted cooldown prevents another Worker from looping.");
        const status = await new AppleConnectionService(env, owner).status();
        assert.equal(status.capabilities.create, false);
        const publicStatus = JSON.stringify(status);
        for (const secret of ["synthetic-trust", "header-session-secret", "cookie-session-secret", "123456789", "auth-session-123"]) assert.equal(publicStatus.includes(secret), false);
      }
    } finally { globalThis.fetch = nativeFetch; db.sqlite.close(); }
  }
}));

test("missing recovery tokens preserve the record and stop further automatic checks", async () => fixedClock(async clock => {
  const nativeFetch = globalThis.fetch;
  const db = new SQLiteD1(), envelopes = key(), env = testEnv(db, envelopes), repository = new AppleSessionRepository(env, owner);
  const original = appleSession(); original.auth.headers = {};
  const setup = await repository.begin(0); await repository.commit(setup, original, "READY");
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response("{}", { status: 401 }); };
  try {
    await assert.rejects(new AppleSessionRenewal(env, repository).ensure(setup.generation, appleRequestBudget(), true), hasCode("REAUTH_REQUIRED"));
    const saved = await repository.load();
    assert.deepEqual(saved.session.login, original.login);
    assert.equal(saved.session.renewal?.requiredAction, "apple-sign-in");
    clock.now += 60_000;
    await assert.rejects(new AppleSessionRenewal(env, new AppleSessionRepository(env, owner)).ensure(setup.generation, appleRequestBudget()), hasCode("REAUTH_REQUIRED"));
    assert.equal(calls, 1);
    assert.equal((await repository.status()).state, "READY");
  } finally { globalThis.fetch = nativeFetch; db.sqlite.close(); }
}));

test("renewal releases its lease when the post-claim reload fails", async () => fixedClock(async () => {
  const db = new SQLiteD1(), envelopes = key(), env = testEnv(db, envelopes), repository = new AppleSessionRepository(env, owner);
  const setup = await repository.begin(0); await repository.commit(setup, appleSession(), "READY");
  const nativeLoad = repository.load.bind(repository);
  let loads = 0;
  repository.load = async () => {
    if (++loads === 3) throw new AppError("UPSTREAM_UNAVAILABLE", "Synthetic reload failure.", 503, true);
    return nativeLoad();
  };
  try {
    await assert.rejects(new AppleSessionRenewal(env, repository).ensure(setup.generation, appleRequestBudget(), true), hasCode("UPSTREAM_UNAVAILABLE"));
    assert.equal(db.sqlite.prepare("SELECT resume_id FROM apple_session_state").get()?.resume_id, null);
    assert.equal((await nativeLoad()).state, "READY");
  } finally { db.sqlite.close(); }
}));

test("renewal serialization and disconnect/expiry races fence token saves", async () => fixedClock(async clock => {
  const nativeFetch = globalThis.fetch;
  try {
    for (const race of ["parallel", "disconnect", "expiry"] as const) {
      const db = new SQLiteD1(), envelopes = key(), env = testEnv(db, envelopes), repository = new AppleSessionRepository(env, owner), original = appleSession();
      const setup = await repository.begin(0); await repository.commit(setup, original, "READY");
      const renewal = new AppleSessionRenewal(env, repository);
      let release!: () => void, arrived!: () => void;
      const wait = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { arrived = resolve; });
      let calls = 0;
      globalThis.fetch = async () => {
        calls++; arrived(); await wait;
        return new Response(JSON.stringify(acceptedAccount()));
      };
      const pending = renewal.ensure(setup.generation, appleRequestBudget(), true);
      await ready;
      if (race === "parallel") await assert.rejects(new AppleSessionRenewal(env, new AppleSessionRepository(env, owner)).ensure(setup.generation, appleRequestBudget(), true), hasCode("CONFLICT"));
      if (race === "disconnect") await repository.disconnect();
      if (race === "expiry") clock.now = original.login.expiresAt;
      release();
      if (race === "parallel") {
        await pending; assert.equal(calls, 1);
        assert.equal((await repository.load()).session.renewal?.lastValidatedAt, clock.now);
      } else {
        await assert.rejects(pending, AppError);
        assert.equal((await repository.status()).state, "DISCONNECTED");
        assert.equal(db.sqlite.prepare("SELECT envelope FROM apple_session_state").get()?.envelope, null);
      }
      if (race === "expiry") clock.now = original.login.verifiedAt;
      db.sqlite.close();
    }
  } finally { globalThis.fetch = nativeFetch; }
}));

test("recent authorised success suppresses proactive checks without claiming a full validation", async () => fixedClock(async clock => {
  const nativeFetch = globalThis.fetch;
  const db = new SQLiteD1(), envelopes = key(), env = testEnv(db, envelopes), repository = new AppleSessionRepository(env, owner);
  const session = appleSession();
  session.renewal = { ...renewalCheckpoint(), lastAppleSuccessAt: clock.now };
  const setup = await repository.begin(0); await repository.commit(setup, session, "READY");
  clock.now += 1000;
  globalThis.fetch = async () => { throw new Error("Recent Apple operation must avoid validation."); };
  try {
    const saved = await new AppleSessionRenewal(env, repository).ensure(setup.generation, appleRequestBudget());
    assert.equal(saved.session.renewal?.lastValidatedAt, null);
    assert.equal(saved.session.renewal?.lastAppleSuccessAt, clock.now - 1000);
    await assert.rejects(new AppleSessionRenewal(env, repository).ensure(setup.generation, { deadline: clock.now + 1000, recoveryUsed: false }, true), hasCode("UPSTREAM_UNAVAILABLE"));
    await assert.rejects(new AppleSessionRenewal(env, repository).ensure(setup.generation, { deadline: clock.now + 40_000, recoveryUsed: true }, true), hasCode("UPSTREAM_UNAVAILABLE"));
  } finally { globalThis.fetch = nativeFetch; db.sqlite.close(); }
}));

test("missing encryption keys and conflicting setup leases preserve the retained envelope", async () => fixedClock(async clock => {
  const db = new SQLiteD1(), envelopes = key(), repository = appleRepo(db, owner, envelopes), original = appleSession();
  original.login = loginAssurance(clock.now, false);
  const setup = await repository.begin(0); await repository.commit(setup, original, "READY");
  const approval = JSON.stringify({ migrationId: "no-delete", owner, account: "apple-reminders", generation: setup.generation });
  const env = { ...testEnv(db, envelopes), APPLE_SESSION_RETENTION_MIGRATION_JSON: approval };
  const before = db.sqlite.prepare("SELECT envelope FROM apple_session_state").get()?.envelope;
  const otherKeys = new Envelopes("replacement", { replacement: b64(crypto.getRandomValues(new Uint8Array(32))) });
  const missing = new AppleSessionRepository({ ...env, ENCRYPTION_KEY_ID: otherKeys.active, ENCRYPTION_KEYS_JSON: JSON.stringify(otherKeys.keys) }, owner);
  await assert.rejects(missing.load(), hasCode("CONFIGURATION_REQUIRED"));
  assert.equal(db.sqlite.prepare("SELECT envelope FROM apple_session_state").get()?.envelope, before);
  db.sqlite.prepare("UPDATE apple_session_state SET transaction_id = 'synthetic-active-setup', transaction_expires_at = ?").run(clock.now + 180_000);
  clock.now += 86_400_001;
  await assert.rejects(new AppleSessionRepository(env, owner).status(), hasCode("CONFLICT"));
  assert.equal(db.sqlite.prepare("SELECT envelope FROM apple_session_state").get()?.envelope, before);
  db.sqlite.close();
}));

test("an unresolved resource auth failure persists a cooldown instead of a later-instance recovery loop", async () => fixedClock(async clock => {
  const nativeFetch = globalThis.fetch;
  const db = new SQLiteD1(), envelopes = key(), env = testEnv(db, envelopes), repository = new AppleSessionRepository(env, owner), original = appleSession();
  original.connection.remindersZoneOwner = "__defaultOwner__";
  original.renewal = { ...renewalCheckpoint(), lastValidatedAt: clock.now };
  const setup = await repository.begin(0); await repository.commit(setup, original, "READY");
  let calls = 0;
  globalThis.fetch = async value => {
    calls++;
    return new URL(String(value)).pathname.endsWith("/validate") ? new Response(JSON.stringify(acceptedAccount())) : new Response("{}", { status: 401 });
  };
  try {
    await assert.rejects(new AppleConnectionService(env, owner).getCurrentLists(setup.generation), hasCode("REAUTH_REQUIRED"));
    assert.equal(calls, 3);
    const saved = await repository.load();
    assert.equal(saved.session.renewal?.requiredAction, "retry");
    assert.equal(saved.session.renewal?.nextRetryAt, clock.now + 30_000);
    await assert.rejects(new AppleConnectionService(env, owner).getCurrentLists(setup.generation), hasCode("UPSTREAM_UNAVAILABLE"));
    assert.equal(calls, 3); assert.deepEqual(saved.session.login, original.login);
  } finally { globalThis.fetch = nativeFetch; db.sqlite.close(); }
}));

test("read-only recovery rebuilds the client and mutation preparation retries only before dispatch", async () => fixedClock(async clock => {
  const nativeFetch = globalThis.fetch;
  try {
    for (const operation of ["read", "create"] as const) {
      const db = new SQLiteD1(), envelopes = key(), env = testEnv(db, envelopes), repository = new AppleSessionRepository(env, owner), original = appleSession();
      original.auth.headers["X-Apple-TwoSV-Trust-Token"] = "synthetic-trust";
      original.connection.remindersZoneOwner = "__defaultOwner__";
      original.renewal = { ...renewalCheckpoint(), lastValidatedAt: clock.now };
      const setup = await repository.begin(0); await repository.commit(setup, original, "READY");
      const requests: { host: string; path: string }[] = [];
      let lookups = 0, dispatches = 0;
      globalThis.fetch = async (value, init) => {
        const url = new URL(String(value));
        requests.push({ host: url.hostname, path: url.pathname });
        if (url.pathname.endsWith("/validate")) return new Response("{}", { status: 401 });
        if (url.pathname.endsWith("/accountLogin")) return new Response(JSON.stringify(acceptedAccount("123456789", "p42-ckdatabasews.icloud.com")));
        if (url.pathname.endsWith("/records/lookup")) {
          if (++lookups === 1) return new Response("{}", { status: 401 });
          assert.equal(url.hostname, "p42-ckdatabasews.icloud.com", "Recovery must not retain the old service endpoint.");
          const payload = JSON.parse(String(init?.body));
          return new Response(JSON.stringify({ records: payload.records.map((record: { recordName: string }) => record.recordName.startsWith("List/")
            ? { recordName: record.recordName, recordType: "List", recordChangeTag: "synthetic-list-version", fields: syntheticMutableListFields() }
            : { recordName: record.recordName, serverErrorCode: "NOT_FOUND" }) }));
        }
        if (url.pathname.endsWith("/records/modify")) { dispatches++; return new Response("{}", { status: 503 }); }
        assert.ok(url.pathname.endsWith("/records/query"));
        return new Response('{"records":[]}');
      };
      const service = new AppleConnectionService(env, owner);
      if (operation === "read") assert.equal((await service.readForMCP(ControlledRead.parse({ action: "reminders", listId: "List/SAFE", includeCompleted: false, expectedGeneration: setup.generation }))).result.complete, true);
      else await assert.rejects(service.mutate({ action: "create", expectedGeneration: setup.generation, listId: "List/SAFE", title: "Synthetic reminder", idempotencyKey: "11111111-1111-4111-8111-111111111111" }), hasCode("WRITE_OUTCOME_UNKNOWN"));
      assert.equal(lookups, 2, "Exact preparation is repeated against fresh credentials.");
      assert.equal(dispatches, operation === "read" ? 0 : 1, "A submitted mutation must never be replayed.");
      assert.equal(requests.filter(request => request.path.endsWith("/accountLogin")).length, 1);
      assert.deepEqual((await repository.load()).session.login, original.login);
      db.sqlite.close();
    }
  } finally { globalThis.fetch = nativeFetch; }
}));

test("authentication rejection after dispatch never starts recovery or repeats a mutation", async () => fixedClock(async clock => {
  const nativeFetch = globalThis.fetch;
  const db = new SQLiteD1(), envelopes = key(), env = testEnv(db, envelopes), repository = new AppleSessionRepository(env, owner), original = appleSession();
  original.connection.remindersZoneOwner = "__defaultOwner__";
  original.renewal = { ...renewalCheckpoint(), lastValidatedAt: clock.now };
  const setup = await repository.begin(0); await repository.commit(setup, original, "READY");
  let dispatches = 0, setupRequests = 0;
  globalThis.fetch = async (value, init) => {
    const url = new URL(String(value));
    if (url.hostname === "setup.icloud.com") { setupRequests++; throw new Error("A dispatched write cannot enter recovery."); }
    if (url.pathname.endsWith("/records/modify")) { dispatches++; return new Response("{}", { status: 401 }); }
    const payload = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ records: payload.records.map((record: { recordName: string }) => record.recordName.startsWith("List/")
      ? { recordName: record.recordName, recordType: "List", recordChangeTag: "synthetic-list-version", fields: syntheticMutableListFields() } : { recordName: record.recordName, serverErrorCode: "NOT_FOUND" }) }));
  };
  try {
    await assert.rejects(new AppleConnectionService(env, owner).mutate({ action: "create", expectedGeneration: setup.generation, listId: "List/SAFE", title: "Synthetic reminder", idempotencyKey: "11111111-1111-4111-8111-111111111111" }), AppError);
    assert.equal(dispatches, 1); assert.equal(setupRequests, 0);
    assert.equal((await repository.status()).state, "READY");
  } finally { globalThis.fetch = nativeFetch; db.sqlite.close(); }
}));

test("cursor recovery never replays an acknowledged all-open callback", async () => fixedClock(async clock => {
  const nativeFetch = globalThis.fetch;
  const db = new SQLiteD1(), envelopes = key(), env = testEnv(db, envelopes), repository = new AppleSessionRepository(env, owner), original = appleSession();
  original.auth.headers["X-Apple-TwoSV-Trust-Token"] = "synthetic-trust";
  original.connection.remindersZoneOwner = "__defaultOwner__";
  original.renewal = { ...renewalCheckpoint(), lastValidatedAt: clock.now };
  const setup = await repository.begin(0); await repository.commit(setup, original, "READY");
  let queries = 0;
  globalThis.fetch = async (value, init) => {
    const url = new URL(String(value));
    if (url.pathname.endsWith("/validate")) return new Response("{}", { status: 401 });
    if (url.pathname.endsWith("/accountLogin")) return new Response(JSON.stringify(acceptedAccount()));
    const body = JSON.parse(String(init?.body));
    if (body.query.recordType === "Lists") return new Response('{"records":[{"recordName":"List/SAFE","recordType":"List","fields":{}}]}');
    queries++; return new Response("{}", { status: 401 });
  };
  try {
    await assert.rejects(new AppleConnectionService(env, owner).readAllOpenForMCP(setup.generation), hasCode("RESTART_REQUIRED"));
    const saved = await repository.load();
    assert.equal(queries, 1); assert.ok(saved.session.allOpenScan?.token);
    assert.equal(saved.session.allOpenScan?.index, 0); assert.equal(saved.session.allOpenScan?.cursor, null);
    assert.deepEqual(saved.session.login, original.login);
  } finally { globalThis.fetch = nativeFetch; db.sqlite.close(); }
}));

test("PCS expiry and explicit web-access approval do not revoke an otherwise valid account", async () => fixedClock(async clock => {
  const nativeFetch = globalThis.fetch;
  const db = new SQLiteD1(), envelopes = key(), env = testEnv(db, envelopes), repository = new AppleSessionRepository(env, owner), original = appleSession();
  original.connection.remindersZoneOwner = "__defaultOwner__";
  original.renewal = { ...renewalCheckpoint(), lastValidatedAt: clock.now };
  original.pcs.expiresAt = clock.now - 1;
  const setup = await repository.begin(0); await repository.commit(setup, original, "READY");
  let prompts = 0;
  globalThis.fetch = async value => {
    const path = new URL(String(value)).pathname;
    if (path.endsWith("/records/query")) return new Response('{"records":[]}');
    if (path.endsWith("/records/lookup")) return new Response('{"serverErrorCode":"PCS_REQUIRED"}', { status: 403 });
    if (path.endsWith("/requestWebAccessState")) return new Response('{"isICDRSDisabled":true,"isDeviceConsentedForPCS":false}');
    if (path.endsWith("/enableDeviceConsentForPCS")) { prompts++; return new Response('{"isDeviceConsentNotificationSent":true}'); }
    throw new Error("Unexpected PCS test endpoint.");
  };
  try {
    const service = new AppleConnectionService(env, owner);
    assert.equal((await service.getCurrentLists(setup.generation)).result.complete, true);
    assert.deepEqual((await repository.load()).session.login, original.login);
    await assert.rejects(service.readForMCP(ControlledRead.parse({ action: "reminders", listId: "List/SAFE", expectedGeneration: setup.generation, includeCompleted: false })), hasCode("DEVICE_APPROVAL_PENDING"));
    assert.equal((await repository.status()).state, "DEVICE_APPROVAL_PENDING");
    assert.equal(prompts, 0, "Permission handling and status must never send a device prompt.");
    clock.now += 600_001;
    await assert.rejects(service.resume(setup.generation), hasCode("RESTART_REQUIRED"));
    assert.equal(prompts, 0);
    await service.resume(setup.generation, true); assert.equal(prompts, 1);
    assert.deepEqual((await repository.load()).session.login, original.login);
  } finally { globalThis.fetch = nativeFetch; db.sqlite.close(); }
}));

async function injectPreviousSession(db: SQLiteD1, repository: AppleSessionRepository, obsolete: Record<string, unknown>) {
  const saved = await repository.load();
  const context = { ownerId: owner, accountId: "apple-reminders", generation: saved.fence.generation, recordId: "apple-session", schemaVersion: 1 as const };
  const envelope = await repository.envelopes.encrypt({ ...saved.session, ...obsolete }, context);
  db.sqlite.prepare("UPDATE apple_session_state SET envelope = ? WHERE owner_id = ?").run(JSON.stringify(envelope), owner);
}

test("key-ring configuration is checked before any persistence can begin", () => {
  for (const ring of [null, [], [b64(new Uint8Array(32))], { key: 42 }, { key: "wrong" }, {}]) {
    assert.throws(() => new Envelopes("key", ring as unknown as Record<string, string>), (error: unknown) => !!error && typeof error === "object" && "code" in error && error.code === "CONFIGURATION_REQUIRED");
  }
});

test("Apple sessions are encrypted, owner-scoped, and restore the cookie jar", async () => {
  const db = new SQLiteD1(); const repository = appleRepo(db);
  const setup = await repository.begin(0);
  const unknownMetadata = { retentionDays: null, retentionSource: null, lastValidatedAt: null, lastAppleSuccessAt: null, lastRenewedAt: null, nextRetryAt: null, requiredAction: null };
  assert.deepEqual(await repository.status(), { generation: 1, version: 1, state: "CONNECTING", action: null, nextAttemptAt: 0, transportReady: false, services: null, accountAuthenticated: false, liveReadValidated: false, expiresAt: null, ...unknownMetadata });
  const session = appleSession();
  session.savedLists = mergeSavedLists([], [{ id: "List/SAVED-PRIVATE-ID", title: "Private saved list" }]);
  session.directListSnapshot = { updatedAt: Date.now() };
  await repository.commit(setup, session, "READY");
  const row = db.sqlite.prepare("SELECT * FROM apple_session_state WHERE owner_id = ? AND account_id = ?").get(owner, "apple-reminders") as Record<string, unknown>;
  const stored = JSON.stringify(row);
  for (const secret of ["header-session-secret", "cookie-session-secret", "123456789", "auth-session-123", "List/SAVED-PRIVATE-ID", "Private saved list", "PRIVATE-CATALOGUE-TOKEN", "a".repeat(64)]) assert.equal(stored.includes(secret), false);
  assert.equal(typeof row.envelope, "string");
  const loaded = await repository.load();
  assert.deepEqual(loaded.session, session);
  const restoredCookies = new CookieJar(loaded.session.auth.cookies);
  assert.match(restoredCookies.header(new URL("https://setup.icloud.com/setup/ws/1/accountLogin")) ?? "", /X-APPLE-WEBAUTH-TOKEN=cookie-session-secret/);
  assert.deepEqual(await repository.status(), { generation: 1, version: 2, state: "READY", action: null, nextAttemptAt: 0, transportReady: true, services: sessionServices(session, "READY"), accountAuthenticated: true, liveReadValidated: false, expiresAt: session.login.expiresAt, ...unknownMetadata, retentionDays: 30, retentionSource: "interactive-consent" });

  const other = appleRepo(db, "other-owner", repository.envelopes);
  assert.equal((await other.status()).state, "DISCONNECTED");
  await assert.rejects(other.load());
  await other.disconnect();
  assert.equal((await repository.status()).state, "READY");
  const restarted = appleRepo(db, owner, repository.envelopes);
  assert.deepEqual((await restarted.load()).session.savedLists, session.savedLists);
  assert.deepEqual((await restarted.load()).session.directListSnapshot, session.directListSnapshot);
  const removed = mergeSavedLists(session.savedLists, [{ id: "List/SAVED-PRIVATE-ID", deleted: true }]);
  const fence = await restarted.claimRead(loaded.fence.generation, loaded.fence.version);
  await restarted.commitResume(fence, { ...session, savedLists: removed }, "READY");
  assert.equal((await restarted.load()).session.savedLists?.[0].deleted, true);
  await restarted.disconnect();
  const next = await restarted.begin((await restarted.status()).generation);
  await restarted.commit(next, appleSession(), "READY");
  assert.equal((await restarted.load()).session.savedLists, undefined);
  assert.equal((await restarted.load()).session.directListSnapshot, undefined);
});

test("existing encrypted sessions discard retired catalogue state without disconnecting", async () => {
  const db = new SQLiteD1(), repository = appleRepo(db), session = appleSession();
  session.savedLists = mergeSavedLists([], [{ id: "List/CURRENT", title: "Current snapshot" }]);
  session.directListSnapshot = { updatedAt: Date.now() };
  const setup = await repository.begin(0); await repository.commit(setup, session, "READY");
  await injectPreviousSession(db, repository, {
    diagnosticCatalogue: { token: "retired-diagnostic" }, catalogueSync: { token: "expired-history", pending: true },
    catalogueAuto: { lastErrorCode: "RESTART_REQUIRED", pausedForError: true }, legacySavedLists: [{ id: "List/OLD" }],
    allOpenScan: { token: crypto.randomUUID(), source: "legacy-catalogue" },
  });
  const loaded = await repository.load();
  assert.deepEqual(loaded.session, session);
  assert.equal((await repository.status()).state, "READY");
  const fence = await repository.claimRead(loaded.fence.generation, loaded.fence.version);
  await repository.commitResume(fence, loaded.session, "READY");
  const encrypted = db.sqlite.prepare("SELECT envelope FROM apple_session_state WHERE owner_id = ?").get(owner)?.envelope;
  const decoded = await repository.envelopes.decrypt<Record<string, unknown>>(JSON.parse(String(encrypted)), { ownerId: owner, accountId: "apple-reminders", generation: setup.generation, recordId: "apple-session", schemaVersion: 1 });
  assert.deepEqual(decoded, session);
  for (const action of ["sync-catalogue", "catalogue-auto", "lists", "probe-other-zones"]) assert.equal(ControlledRead.safeParse({ action, expectedGeneration: setup.generation }).success, false);
  db.sqlite.close();
});

test("copy intent checkpoint retains only bound hashes through lease release and rejects stale or changed identity", async () => {
  const db = new SQLiteD1(), repository = appleRepo(db), session = appleSession();
  const setup = await repository.begin(0); await repository.commit(setup, session, "READY");
  const saved = await repository.load(), fence = await repository.claimRead(saved.fence.generation, saved.fence.version);
  const intent = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", requestFingerprint: "a".repeat(64), contentFingerprint: "b".repeat(64) };
  assert.deepEqual(await repository.checkpointCopyIntent(fence, intent), [intent]);
  await repository.assertWriteLease(fence);
  assert.equal((await repository.load()).fence.version, fence.version);
  await assert.rejects(repository.checkpointCopyIntent(fence, { ...intent, requestFingerprint: "c".repeat(64) }), hasCode("CONFLICT"));
  const identities = (await import("../src/reminders/recurring-lifecycle.ts")).recurringIdentities();
  const occurrence = { requestFingerprint: "d".repeat(64), sourceFingerprint: "e".repeat(64), timestamp: Date.now(), phase: "prepared" as const, ids: identities,
    expected: ["Reminder", "Reminder", "List", "RecurrenceRule"].map((type, index) => ({ id: `${type}/${index}`, type: type as "Reminder" | "List" | "RecurrenceRule", hash: "f".repeat(64) })), retired: [] };
  const terminal = { ...occurrence, mode: "final" as const, ids: { replicas: identities.replicas }, expected: occurrence.expected.filter((_, index) => index !== 1) };
  assert.equal(RecurringIntentSchema.safeParse(terminal).success, true);
  assert.equal(RecurringIntentSchema.safeParse({ ...terminal, mode: "reopen" }).success, true);
  assert.equal(RecurringIntentSchema.safeParse({ ...terminal, mode: undefined }).success, false);
  assert.equal(RecurringIntentSchema.safeParse({ ...terminal, ids: identities }).success, false);
  assert.equal(RecurringIntentSchema.safeParse({ ...terminal, expected: occurrence.expected.slice(0, 3) }).success, false);
  assert.deepEqual(RecurringIntentSchema.parse(occurrence), occurrence, "Omitting calendar zone leaves the legacy serialized intent unchanged.");
  assert.equal(RecurringIntentSchema.safeParse({ ...terminal, recurrenceCalendarTimeZone: "Europe/London" }).success, true);
  assert.equal(RecurringIntentSchema.safeParse({ ...terminal, recurrenceCalendarTimeZone: "+01:00" }).success, false);
  const pairedTerminal = { ...terminal, intrinsicParentGuards: true as const, expected: [...terminal.expected,
    { id: "Alarm/RETAINED", type: "Alarm" as const, hash: "a".repeat(64) }, { id: "AlarmTrigger/RETAINED", type: "AlarmTrigger" as const, hash: "b".repeat(64) }] };
  assert.equal(RecurringIntentSchema.safeParse(pairedTerminal).success, true);
  assert.equal(RecurringIntentSchema.safeParse({ ...pairedTerminal, mode: "reopen" }).success, true);
  assert.equal(RecurringIntentSchema.safeParse({ ...pairedTerminal, intrinsicParentGuards: undefined }).success, false);
  assert.equal(RecurringIntentSchema.safeParse({ ...pairedTerminal, expected: pairedTerminal.expected.slice(0, 4) }).success, false);
  assert.equal(RecurringIntentSchema.safeParse({ ...pairedTerminal, recurrenceCalendarTimeZone: "Europe/London" }).success, false);
  assert.deepEqual(RecurringIntentSchema.parse(terminal), terminal, "Legacy terminal intents retain their byte-compatible shape.");
  const deletion = { ...pairedTerminal, mode: undefined, operation: "delete" as const, recurringDeletionScope: "all_future" as const };
  assert.equal(RecurringIntentSchema.safeParse(deletion).success, true);
  assert.equal(RecurringIntentSchema.safeParse({ ...deletion, recurringDeletionScope: undefined }).success, false);
  assert.equal(RecurringIntentSchema.safeParse({ ...deletion, operation: undefined }).success, false);
  assert.equal(RecurringIntentSchema.safeParse({ ...deletion, mode: "final" }).success, false);
  const deleteOccurrence = { ...deletion, recurringDeletionScope: "occurrence" as const, ids: { replicas: identities.replicas, activeAlarm: identities.activeAlarm, activeTrigger: identities.activeTrigger },
    expected: [...terminal.expected, { id: `Alarm/${identities.activeAlarm}`, type: "Alarm" as const, hash: "a".repeat(64) }, { id: `AlarmTrigger/${identities.activeTrigger}`, type: "AlarmTrigger" as const, hash: "b".repeat(64) }], retired: ["Alarm/OLD", "AlarmTrigger/OLD"] };
  assert.equal(RecurringIntentSchema.safeParse(deleteOccurrence).success, true);
  assert.equal(RecurringIntentSchema.safeParse({ ...deleteOccurrence, ids: identities }).success, false);
  assert.equal(RecurringIntentSchema.safeParse({ ...deleteOccurrence, retired: [] }).success, false);
  await repository.checkpointRecurringIntent(fence, { ...deleteOccurrence, requestFingerprint: "4".repeat(64) });
  await assert.rejects(repository.checkpointRecurringIntent(fence, { ...deleteOccurrence, requestFingerprint: "4".repeat(64), recurringDeletionScope: "all_future" }), hasCode("CONFLICT"));
  const dailyDeletion = { ...deletion, recurringDeletionRecipe: "all_day_daily" as const, expected: terminal.expected };
  assert.equal(RecurringIntentSchema.safeParse(dailyDeletion).success, true);
  assert.equal(RecurringIntentSchema.safeParse({ ...dailyDeletion, recurringDeletionScope: "occurrence" }).success, true);
  assert.equal(RecurringIntentSchema.safeParse({ ...dailyDeletion, recurringDeletionRecipe: undefined }).success, false);
  assert.equal(RecurringIntentSchema.safeParse({ ...dailyDeletion, ids: deleteOccurrence.ids }).success, false);
  assert.equal(RecurringIntentSchema.safeParse({ ...dailyDeletion, retired: ["Alarm/OLD"] }).success, false);
  assert.equal(RecurringIntentSchema.safeParse({ ...dailyDeletion, operation: undefined }).success, false);
  await repository.checkpointRecurringIntent(fence, { ...dailyDeletion, requestFingerprint: "5".repeat(64) });
  await assert.rejects(repository.checkpointRecurringIntent(fence, { ...dailyDeletion, requestFingerprint: "5".repeat(64), recurringDeletionRecipe: undefined }), hasCode("CONFLICT"));
  assert.deepEqual(RecurringIntentSchema.parse(dailyDeletion), dailyDeletion, "No-end daily deletion intents retain their serialized shape.");
  const endedDeletion = { ...dailyDeletion, recurringDeletionRecipe: "all_day_daily_ended" as const, recurringDeletionTerminal: true as const, recurrenceCalendarTimeZone: "Europe/London" };
  assert.equal(RecurringIntentSchema.safeParse(endedDeletion).success, true);
  assert.equal(RecurringIntentSchema.safeParse({ ...endedDeletion, recurringDeletionScope: "occurrence" }).success, true);
  assert.equal(RecurringIntentSchema.safeParse({ ...endedDeletion, recurringDeletionScope: "occurrence", recurringDeletionTerminal: undefined }).success, true);
  assert.equal(RecurringIntentSchema.safeParse({ ...endedDeletion, recurringDeletionTerminal: undefined }).success, false);
  assert.equal(RecurringIntentSchema.safeParse({ ...dailyDeletion, recurringDeletionTerminal: true }).success, false);
  assert.equal(RecurringIntentSchema.safeParse({ ...dailyDeletion, recurrenceCalendarTimeZone: "Europe/London" }).success, false);
  assert.equal(RecurringIntentSchema.safeParse({ ...terminal, recurringDeletionTerminal: true }).success, false);
  const endedPrepared = RecurringIntentSchema.parse({ ...endedDeletion, requestFingerprint: "6".repeat(64) });
  await repository.checkpointRecurringIntent(fence, endedPrepared);
  await repository.checkpointRecurringIntent(fence, { ...endedPrepared, phase: "dispatched" });
  await repository.checkpointRecurringIntent(fence, { ...endedPrepared, phase: "confirmed" });
  for (const change of [{ recurrenceCalendarTimeZone: "UTC" }, { recurringDeletionScope: "occurrence" as const }, { recurringDeletionTerminal: undefined }])
    await assert.rejects(repository.checkpointRecurringIntent(fence, { ...endedDeletion, requestFingerprint: "6".repeat(64), ...change }), hasCode("CONFLICT"));
  const endedWeeklyDelete = RecurringIntentSchema.parse({ ...deletion, recurringDeletionRecipe: "timed_weekly_ended", recurringDeletionTerminal: true });
  assert.equal(RecurringIntentSchema.safeParse({ ...endedWeeklyDelete, recurringDeletionScope: "occurrence" }).success, true);
  assert.equal(RecurringIntentSchema.safeParse({ ...endedWeeklyDelete, recurringDeletionTerminal: undefined }).success, false);
  assert.equal(RecurringIntentSchema.safeParse({ ...endedWeeklyDelete, recurringDeletionScope: "occurrence", ids: deleteOccurrence.ids }).success, false);
  assert.equal(RecurringIntentSchema.safeParse({ ...endedWeeklyDelete, recurrenceCalendarTimeZone: "Europe/London" }).success, false);
  assert.equal(RecurringIntentSchema.safeParse({ ...deleteOccurrence, recurringDeletionRecipe: "timed_weekly_ended" }).success, true);
  assert.deepEqual(RecurringIntentSchema.parse(deletion), deletion, "Legacy no-end weekly deletion retains its serialized shape.");
  const endedWeeklyPrepared = { ...endedWeeklyDelete, requestFingerprint: "7".repeat(64) };
  await repository.checkpointRecurringIntent(fence, endedWeeklyPrepared);
  await repository.checkpointRecurringIntent(fence, { ...endedWeeklyPrepared, phase: "dispatched" });
  await repository.checkpointRecurringIntent(fence, { ...endedWeeklyPrepared, phase: "confirmed" });
  for (const change of [{ recurringDeletionRecipe: undefined }, { recurringDeletionTerminal: undefined }, { sourceFingerprint: "9".repeat(64) }])
    await assert.rejects(repository.checkpointRecurringIntent(fence, { ...endedWeeklyPrepared, ...change }), hasCode("CONFLICT"));
  const monthlyDeletion = RecurringIntentSchema.parse({ ...dailyDeletion, recurringDeletionRecipe: "all_day_last_day_monthly", requestFingerprint: "8".repeat(64) });
  assert.equal(RecurringIntentSchema.safeParse({ ...monthlyDeletion, recurringDeletionScope: "occurrence" }).success, true);
  for (const change of [{ recurringDeletionTerminal: true }, { recurrenceCalendarTimeZone: "UTC" }, { ids: deleteOccurrence.ids }, { retired: ["Alarm/OLD"] }, { expected: deletion.expected }])
    assert.equal(RecurringIntentSchema.safeParse({ ...monthlyDeletion, ...change }).success, false);
  await repository.checkpointRecurringIntent(fence, monthlyDeletion);
  await repository.checkpointRecurringIntent(fence, { ...monthlyDeletion, phase: "dispatched" });
  await repository.checkpointRecurringIntent(fence, { ...monthlyDeletion, phase: "confirmed" });
  await assert.rejects(repository.checkpointRecurringIntent(fence, { ...monthlyDeletion, recurringDeletionRecipe: "all_day_daily" }), hasCode("CONFLICT"));
  await repository.checkpointRecurringIntent(fence, occurrence);
  const dispatched = { ...occurrence, phase: "dispatched" as const };
  await repository.checkpointRecurringIntent(fence, dispatched);
  await assert.rejects(repository.checkpointRecurringIntent(fence, occurrence), hasCode("CONFLICT"));
  await assert.rejects(repository.checkpointRecurringIntent(fence, { ...dispatched, ids: { ...identities, history: crypto.randomUUID() } }), hasCode("CONFLICT"));
  await assert.rejects(repository.checkpointRecurringIntent(fence, { ...dispatched, recurrenceCalendarTimeZone: "Europe/London" }), hasCode("CONFLICT"));
  const confirmed = { ...dispatched, phase: "confirmed" as const };
  await repository.checkpointRecurringIntent(fence, confirmed);
  await repository.releaseResume(fence);
  const restarted = appleRepo(db, owner, repository.envelopes);
  assert.deepEqual((await restarted.load()).session.copyIntents, [intent]);
  assert.deepEqual((await restarted.load()).session.recurringIntents?.filter(item => item.requestFingerprint === confirmed.requestFingerprint), [confirmed]);
  assert.equal((await restarted.load()).session.recurringIntents?.find(item => item.operation === "delete")?.recurringDeletionScope, "occurrence");
  assert.deepEqual((await restarted.load()).session.login, session.login);
  await assert.rejects(restarted.checkpointCopyIntent(fence, { ...intent, id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }), hasCode("CONFLICT"));
  const fullSaved = await restarted.load(), fullFence = await restarted.claimRead(fullSaved.fence.generation, fullSaved.fence.version);
  const cache = Array.from({ length: 256 }, (_, index) => ({ ...occurrence, requestFingerprint: index.toString(16).padStart(64, "0"),
    phase: index === 0 ? "confirmed" as const : "dispatched" as const, ids: { ...identities, history: crypto.randomUUID() }, timestamp: occurrence.timestamp + index }));
  await restarted.commitResume(fullFence, { ...fullSaved.session, recurringIntents: cache }, "READY");
  const capped = await restarted.load(), capFence = await restarted.claimRead(capped.fence.generation, capped.fence.version);
  const retained = await restarted.checkpointRecurringIntent(capFence, occurrence);
  assert.equal(retained.length, 256); assert.equal(retained.some(item => item.requestFingerprint === cache[0].requestFingerprint), false);
  assert.ok(retained.some(item => item.requestFingerprint === cache[1].requestFingerprint));
  await assert.rejects(restarted.checkpointRecurringIntent(capFence, { ...occurrence, requestFingerprint: "9".repeat(64) }), hasCode("UNSUPPORTED_FEATURE"));
  await restarted.releaseResume(capFence);
  await restarted.disconnect();
  const next = await restarted.begin((await restarted.status()).generation); await restarted.commit(next, appleSession(), "READY");
  assert.equal((await restarted.load()).session.copyIntents, undefined);
  db.sqlite.close();
});

test("recurring prepared requests survive local dispatch gates and cannot resume past the retained next occurrence", async () => fixedClock(async clock => {
  const nativeFetch = globalThis.fetch;
  try {
    for (const mode of ["budget", "lease", "overdue"] as const) {
      const db = new SQLiteD1(), envelopes = key(), env = { ...testEnv(db, envelopes), APPLE_SESSION_RENEWAL_ENABLED: "disabled" }, repository = new AppleSessionRepository(env, owner);
      const session = appleSession(); session.connection.remindersZoneOwner = "__defaultOwner__";
      const setup = await repository.begin(0); await repository.commit(setup, session, "READY");
      const listId = "List/PREPARED", reminderId = "Reminder/11111111-1111-4111-8111-111111111111", ruleId = "RecurrenceRule/PREPARED";
      const zoneID = { zoneName: "Reminders", ownerRecordName: "__defaultOwner__" };
      const root = { ...buildCreateReminder({ listId, idempotencyKey: "11111111-1111-4111-8111-111111111111", title: "Prepared recurring occurrence", notes: "", priority: 0, flagged: false, allDay: false,
        dueDate: "2026-10-10T00:00:00.000Z" }), recordChangeTag: "active-before", zoneID };
      root.fields.AllDay = { type: "INT64", value: 1 };
      root.fields.RecurrenceRuleIDs = { type: "STRING_LIST", value: [ruleId] };
      const records = new Map<string, unknown>([[reminderId, root], [listId, { recordName: listId, recordType: "List", recordChangeTag: "list-before", zoneID, fields: {
        Name: { type: "STRING", value: "Prepared" }, Deleted: { type: "INT64", value: 0 }, IsGroup: { type: "INT64", value: 0 },
        ReminderIDs: { type: "STRING", value: JSON.stringify([reminderId]) }, ResolutionTokenMap: { type: "STRING", value: JSON.stringify({ map: {} }) },
      } }], [ruleId, { recordName: ruleId, recordType: "RecurrenceRule", recordChangeTag: "rule-before", zoneID, fields: {
        Frequency: { type: "INT64", value: 0 }, Interval: { type: "INT64", value: 1 }, OccurrenceCount: { type: "INT64", value: 0 }, FirstDayOfTheWeek: { type: "INT64", value: 0 },
        Imported: { type: "INT64", value: 0 }, Deleted: { type: "INT64", value: 0 }, Reminder: { type: "REFERENCE", value: { recordName: reminderId, action: "VALIDATE" } },
      } }]]);
      let dispatches = 0;
      globalThis.fetch = async (value, init) => {
        const url = new URL(String(value)), payload = JSON.parse(String(init?.body));
        if (url.pathname.endsWith("/records/modify")) { dispatches++; return new Response("{}", { status: 503 }); }
        return Response.json({ records: url.pathname.endsWith("/records/query") ? [root] : payload.records.map((item: { recordName: string }) => records.get(item.recordName) ?? { recordName: item.recordName, serverErrorCode: "NOT_FOUND" }) });
      };
      db.afterStatement = async sql => {
        if (!sql.startsWith("UPDATE apple_session_state SET envelope = ?")) return;
        db.afterStatement = null;
        if (mode === "lease") db.sqlite.prepare("UPDATE apple_session_state SET resume_id = ?").run("synthetic-replaced-lease");
        else clock.now += 32_000;
      };
      const args = { action: "complete" as const, expectedGeneration: setup.generation, listId, reminderId, recordChangeTag: "active-before" };
      await assert.rejects(new AppleConnectionService(env, owner).mutate(args), hasCode("CONFLICT"));
      const prepared = (await repository.load()).session.recurringIntents!;
      assert.equal(prepared.length, 1); assert.equal(prepared[0].phase, "prepared"); assert.equal(dispatches, 0);
      db.sqlite.prepare("UPDATE apple_session_state SET resume_id = NULL, resume_expires_at = NULL").run();
      if (mode === "overdue") clock.now = Date.parse("2026-10-11T00:00:00Z") + 1;
      await assert.rejects(new AppleConnectionService(env, owner).mutate(args), hasCode(mode === "overdue" ? "UNSUPPORTED_FEATURE" : "WRITE_OUTCOME_UNKNOWN"));
      const retained = (await repository.load()).session.recurringIntents!;
      assert.deepEqual(retained[0].ids, prepared[0].ids);
      assert.equal(retained[0].phase, mode === "overdue" ? "prepared" : "dispatched");
      assert.equal(dispatches, mode === "overdue" ? 0 : 1);
      db.sqlite.close(); clock.now = Date.parse("2026-10-09T19:25:12.131Z");
    }
  } finally { globalThis.fetch = nativeFetch; }
}));

test("Apple setup and disconnect fences reject stale commits and cancellation clears only its own commit", async () => {
  const db = new SQLiteD1(); const repository = appleRepo(db);
  const stale = await repository.begin(0);
  const current = await repository.begin(stale.generation);
  await assert.rejects(repository.commit(stale, appleSession(), "READY"));
  await repository.commit(current, appleSession(), "READY");
  assert.equal(await repository.abandon(current), true);
  assert.equal((await repository.status()).state, "DISCONNECTED");
  assert.equal((await repository.status()).generation, current.generation + 1);

  const cancelled = await repository.begin(current.generation + 1);
  await repository.disconnect();
  await assert.rejects(repository.commit(cancelled, appleSession(), "READY"));
  assert.equal((await repository.status()).state, "DISCONNECTED");

  const expired = await repository.begin((await repository.status()).generation);
  db.sqlite.prepare("UPDATE apple_session_state SET transaction_expires_at = ? WHERE owner_id = ?").run(Date.now() - 1, owner);
  assert.equal((await repository.status()).state, "DISCONNECTED");
  await assert.rejects(repository.commit(expired, appleSession(), "READY"));
});

test("PCS resume leases serialize and stale resume commits are fenced", async () => {
  const db = new SQLiteD1(); const repository = appleRepo(db);
  const setup = await repository.begin(0);
  await repository.commit(setup, appleSession(), "DEVICE_APPROVAL_PENDING", "approve-device-consent");
  const saved = await repository.status();
  const resume = await repository.claimResume(saved.generation, saved.version);
  await assert.rejects(repository.claimResume(saved.generation, saved.version));
  assert.equal(await repository.releaseResume(resume), true);
  await assert.rejects(repository.commitResume(resume, appleSession(), "READY"));
  const next = await repository.status();
  const renewed = await repository.claimResume(next.generation, next.version);
  await repository.commitResume(renewed, (await repository.load()).session, "READY");
  assert.equal((await repository.status()).state, "READY");
});

test("ready reads claim the same short lease before committing refreshed cookies", async () => {
  const db = new SQLiteD1(); const repository = appleRepo(db);
  const setup = await repository.begin(0);
  await repository.commit(setup, appleSession(), "READY");
  const saved = await repository.status();
  const read = await repository.claimRead(saved.generation, saved.version);
  const restored = await repository.load();
  assert.equal(restored.fence.version, read.version);
  await assert.rejects(repository.claimRead(saved.generation, read.version));
  await repository.commitResume(read, restored.session, "READY");
  assert.equal((await repository.status()).version, read.version + 1);
});

test("session restoration follows bounded same-generation progress without adopting a replacement account", async () => {
  const db = new SQLiteD1(); const repository = appleRepo(db);
  const session = appleSession(); const setup = await repository.begin(0); await repository.commit(setup, session, "READY");
  const advanced = { ...session, savedLists: mergeSavedLists([], [{ id: "List/A", title: "A" }, { id: "List/B", title: "B" }, { id: "List/C", title: "C" }]) };
  const advance = async () => { db.afterStatement = null; const saved = await repository.load(); const lease = await repository.claimRead(saved.fence.generation, saved.fence.version); await repository.commitResume(lease, advanced, "READY"); };
  try {
    db.afterStatement = async sql => { if (sql.startsWith("SELECT generation, version") && sql.includes("envelope")) await advance(); };
    const restored = await repository.load(); assert.equal(restored.session.savedLists?.length, 3);
    db.afterStatement = async sql => { if (sql.startsWith("SELECT generation, version") && !sql.includes("envelope")) await advance(); };
    const status = await repository.status(); assert.equal(status.state, "READY"); assert.equal(status.version, (await repository.load()).fence.version);
    let attempts = 0;
    db.afterStatement = async sql => { if (sql.startsWith("SELECT generation, version") && sql.includes("envelope")) { attempts++; db.sqlite.prepare("UPDATE apple_session_state SET version = version + 1 WHERE owner_id = ?").run(owner); } };
    await assert.rejects(repository.load(), (error: unknown) => error instanceof AppError && error.code === "CONFLICT" && error.retryable);
    assert.equal(attempts, 3); db.afterStatement = null;
    db.afterStatement = async sql => {
      if (!sql.startsWith("SELECT generation, version") || !sql.includes("envelope")) return;
      db.afterStatement = null; await repository.disconnect(); const next = await repository.begin((await repository.status()).generation); await repository.commit(next, appleSession(), "READY");
    };
    await assert.rejects(repository.load(), (error: unknown) => error instanceof AppError && error.code === "CONFLICT");
    assert.equal((await repository.status()).state, "READY"); assert.notEqual((await repository.load()).fence.generation, setup.generation);
  } finally { db.afterStatement = null; db.sqlite.close(); }
});

test("tampered ciphertext fails closed and an invalid decrypted snapshot is invalidated", async () => {
  const db = new SQLiteD1(); const envelopes = key(); const repository = appleRepo(db, owner, envelopes);
  const setup = await repository.begin(0);
  await repository.commit(setup, appleSession(), "READY");
  const row = db.sqlite.prepare("SELECT generation FROM apple_session_state WHERE owner_id = ?").get(owner) as { generation: number };
  const context = { ownerId: owner, accountId: "apple-reminders", generation: row.generation, recordId: "apple-session", schemaVersion: 1 as const };
  const saved = db.sqlite.prepare("SELECT envelope FROM apple_session_state WHERE owner_id = ?").get(owner) as { envelope: string };
  const envelope = JSON.parse(saved.envelope) as { ciphertext: string };
  envelope.ciphertext = `${envelope.ciphertext.slice(0, -2)}AA`;
  db.sqlite.prepare("UPDATE apple_session_state SET envelope = ? WHERE owner_id = ?").run(JSON.stringify(envelope), owner);
  await assert.rejects(repository.load());

  const afterTamper = await repository.status();
  assert.equal(afterTamper.state, "DISCONNECTED");
  const next = await repository.begin(afterTamper.generation);
  await repository.commit(next, appleSession(), "READY");
  const second = await repository.status();
  const invalidContext = { ...context, generation: second.generation };
  const invalidSnapshot = await envelopes.encrypt({ ...appleSession(), unexpectedProof: "must-not-persist" }, invalidContext);
  db.sqlite.prepare("UPDATE apple_session_state SET envelope = ? WHERE owner_id = ?").run(JSON.stringify(invalidSnapshot), owner);
  await assert.rejects(repository.load());
  assert.equal((await repository.status()).state, "DISCONNECTED");
  const invalidated = db.sqlite.prepare("SELECT envelope FROM apple_session_state WHERE owner_id = ?").get(owner) as { envelope: string | null };
  assert.equal(invalidated.envelope, null);
});


test("absolute login expiry invalidates old policy sessions and cannot slide during operations", async () => {
  const db = new SQLiteD1(), repository = appleRepo(db), session = appleSession();
  session.login = loginAssurance(Date.now() - 10_000);
  const setup = await repository.begin(0); await repository.commit(setup, session, "READY");
  const saved = await repository.status(), read = await repository.claimRead(saved.generation, saved.version);
  await assert.rejects(repository.commitResume(read, { ...session, login: loginAssurance() }, "READY"), (e: any) => e.code === "VALIDATION_ERROR");
  await repository.commitResume(read, session, "READY");
  assert.equal((await repository.status()).expiresAt, session.login.expiresAt);
  const context = { ownerId: owner, accountId: "apple-reminders", generation: saved.generation, recordId: "apple-session", schemaVersion: 1 as const };
  const expired = await repository.envelopes.encrypt({ ...session, login: loginAssurance(Date.now() - SESSION_RETENTION_MS - 1) }, context);
  db.sqlite.prepare("UPDATE apple_session_state SET envelope = ? WHERE owner_id = ?").run(JSON.stringify(expired), owner);
  assert.equal((await repository.status()).state, "DISCONNECTED");
  assert.equal(db.sqlite.prepare("SELECT envelope FROM apple_session_state WHERE owner_id = ?").get(owner)?.envelope, null);
  const next = await repository.begin((await repository.status()).generation); await repository.commit(next, appleSession(), "READY");
  const legacy = omitField(appleSession(), "login");
  const old = await repository.envelopes.encrypt(legacy, { ...context, generation: next.generation });
  db.sqlite.prepare("UPDATE apple_session_state SET envelope = ? WHERE owner_id = ?").run(JSON.stringify(old), owner);
  await assert.rejects(repository.load(), (e: any) => e.code === "REAUTH_REQUIRED");
});

test("an operation crossing expiry during encryption or the final SQL cannot return success", async () => {
  for (const boundary of ["encryption", "final-sql"]) {
    const db = new SQLiteD1(), repository = appleRepo(db), session = appleSession();
    const setup = await repository.begin(0); await repository.commit(setup, session, "READY");
    const status = await repository.status(), fence = await repository.claimRead(status.generation, status.version);
    const nativeNow = Date.now, nativeEncrypt = repository.envelopes.encrypt.bind(repository.envelopes);
    if (boundary === "encryption") repository.envelopes.encrypt = async (...args: Parameters<Envelopes["encrypt"]>) => { const result = await nativeEncrypt(...args); Date.now = () => session.login.expiresAt; return result; };
    else db.afterStatement = async sql => { if (sql.startsWith("UPDATE apple_session_state SET version = version + 1, state = ?")) Date.now = () => session.login.expiresAt; };
    try { await assert.rejects(repository.commitResume(fence, session, "READY"), (e: any) => e.code === "AUTH_EXPIRED"); assert.equal((await repository.status()).state, "DISCONNECTED"); assert.equal(db.sqlite.prepare("SELECT envelope FROM apple_session_state WHERE owner_id = ?").get(owner)?.envelope, null); }
    finally { Date.now = nativeNow; }
  }
});


test("all-open reads cover selectable lists, resume live pages without skips, and fence encrypted continuations", async () => {
  const originalFetch = globalThis.fetch; const originalNow = Date.now;
  let now = originalNow(); Date.now = () => now;
  const db = new SQLiteD1(); const repository = appleRepo(db);
  const session = appleSession(); session.connection.remindersZoneOwner = "__defaultOwner__";
  session.savedLists = mergeSavedLists([], [{ id: "List/A", title: "A" }, { id: "List/B", title: "B" }, { id: "List/C", title: "C" }, { id: "List/DELETED", deleted: true }, { id: "List/GROUP", isGroup: true }]);
  const setup = await repository.begin(0); await repository.commit(setup, session, "READY");
  const env = { ...db.env(), REMINDERS_OWNER_ID: owner, ENCRYPTION_KEY_ID: repository.envelopes.active, ENCRYPTION_KEYS_JSON: JSON.stringify(repository.envelopes.keys), LIVE_APPLE_CONNECTION_APPROVED: "controlled-device-v2", APPLE_CRYPTO_REVIEW_APPROVED: "device-proof-v2" };
  const service = () => new AppleConnectionService(env, owner);
  const discovery = { records: [
    ...["A", "B", "C"].map(id => ({ recordName: `List/${id}`, recordType: "List", fields: { Name: { type: "STRING", value: id } } })),
    { recordName: "List/DELETED", deleted: true },
    { recordName: "List/GROUP", recordType: "List", fields: { IsGroup: { type: "INT64", value: 1 } } },
  ] };
  const reminder = (id: string, listId: string, extra: Record<string, unknown> = {}) => ({ recordName: `Reminder/${id}`, recordType: "Reminder", fields: { List: { type: "REFERENCE", value: { recordName: listId } }, Completed: { type: "INT64", value: 0 }, ...extra } });
  const replies: { status?: number; body: unknown; headers?: Record<string, string>; after?: () => Promise<void> }[] = [];
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  globalThis.fetch = async (input, init) => {
    requests.push({ path: new URL(String(input)).pathname, body: JSON.parse(String(init?.body)) });
    const next = replies.shift(); assert.ok(next, "Unexpected all-open request"); if (next.after) await next.after();
    return new Response(JSON.stringify(next.body), { status: next.status ?? 200, headers: next.headers });
  };
  try {
    replies.push({ body: discovery });
    for (let page = 1; page <= 20; page++) replies.push({ body: { records: [reminder(`A-${page}`, "List/A"), ...(page === 1 ? [reminder("COMPLETED", "List/A", { Completed: { type: "INT64", value: 1 } }), reminder("DELETED", "List/A", { Deleted: { type: "INT64", value: 1 } }), { recordName: "Reminder/TOMBSTONE", deleted: true }] : [])], continuationMarker: `A-page-${page}` } });
    const partial = await service().readAllOpenForMCP(setup.generation);
    assert.equal(partial.result.complete, false); assert.equal(partial.result.records.length, 20); assert.equal(partial.result.progress.pagesRead, 20); assert.equal(partial.result.progress.listsTotal, 3); assert.equal(partial.result.progress.listsCompleted, 0);
    assert.deepEqual(partial.result.lists.map(list => list.id), ["List/A", "List/B", "List/C"]);
    const token = partial.result.continuation!; const saved = (await repository.load()).session;
    assert.equal(saved.allOpenScan?.cursor, "A-page-20"); assert.equal(JSON.stringify(saved).includes("Reminder/A-20"), false);
    const encrypted = String(db.sqlite.prepare("SELECT envelope FROM apple_session_state WHERE owner_id = ?").get(owner)?.envelope);
    assert.equal(encrypted.includes(token), false); assert.equal(encrypted.includes("A-page-20"), false);
    const requestsBeforeMismatch = requests.length;
    await assert.rejects(service().readAllOpenForMCP(setup.generation - 1, token), (error: unknown) => error instanceof AppError && error.code === "CONFLICT");
    const other = appleRepo(db, "other-all-open-owner", repository.envelopes); const otherSetup = await other.begin(0); await other.commit(otherSetup, session, "READY");
    await assert.rejects(new AppleConnectionService(env, "other-all-open-owner").readAllOpenForMCP(otherSetup.generation, token), (error: unknown) => error instanceof AppError && error.code === "CONFLICT");
    assert.equal(requests.length, requestsBeforeMismatch);
    replies.push({ body: { records: [reminder("A-LAST", "List/A")] } }, { body: { records: [reminder("B", "List/B")] } }, { body: { records: [reminder("C-FIRST", "List/C")], continuationMarker: "C-page-1" } }, { body: { records: [reminder("C-LAST", "List/C")] } });
    const resumed = await service().readAllOpenForMCP(setup.generation, token);
    assert.equal(resumed.result.complete, true); assert.equal(resumed.result.continuation, null); assert.equal(resumed.result.records.length, 4); assert.equal(resumed.result.progress.listsCompleted, 3);
    assert.equal(requests[requestsBeforeMismatch].body.continuationMarker, "A-page-20"); assert.equal((await repository.load()).session.allOpenScan, undefined);
    assert.ok(requests.slice(requestsBeforeMismatch).every(request => request.path.endsWith("/records/query")));
    for (const request of requests.filter(request => (request.body.query as { recordType?: string } | undefined)?.recordType === "reminderList")) {
      const query = request.body.query as { filterBy: { fieldName: string; fieldValue: { value: number } }[] };
      assert.equal(query.filterBy.find(filter => filter.fieldName === "includeCompleted")?.fieldValue.value, 0);
    }
    await assert.rejects(service().readAllOpenForMCP(setup.generation, token), (error: unknown) => error instanceof AppError && error.code === "CONFLICT");
    // A page that does not fit must be fetched again from the same cursor.
    const largeText = "x".repeat(64_000); const document = encodeDocument(largeText);
    const largePage = (prefix: string) => Array.from({ length: 6 }, (_, index) => reminder(`${prefix}-${index}`, "List/A", { TitleDocument: { type: "ENCRYPTED_BYTES", value: document }, NotesDocument: { type: "ENCRYPTED_BYTES", value: document } }));
    replies.push({ body: discovery }, { body: { records: largePage("LARGE-FIRST"), continuationMarker: "large-next" } }, { body: { records: largePage("LARGE-NEXT") } });
    const byteLimited = await service().readAllOpenForMCP(setup.generation);
    assert.equal(byteLimited.result.complete, false); assert.equal(byteLimited.result.pendingReason, "response-limit"); assert.equal(byteLimited.result.records.length, 6);
    assert.ok(new TextEncoder().encode(JSON.stringify(byteLimited)).length <= 1_048_576);
    assert.equal((await repository.load()).session.allOpenScan?.cursor, "large-next");
    assert.equal((await repository.load()).session.allOpenScan?.totalPages, 1);
    replies.push({ body: { records: largePage("LARGE-NEXT") } }, { body: { records: [reminder("BYTE-B", "List/B")] } }, { body: { records: [reminder("BYTE-C", "List/C")] } });
    const byteResumed = await service().readAllOpenForMCP(setup.generation, byteLimited.result.continuation);
    assert.equal(byteResumed.result.complete, true); assert.equal(byteResumed.result.records.length, 8);
    assert.equal(requests.at(-3)!.body.continuationMarker, "large-next");
    // Recoverable failures expose the current token without losing records or
    // acknowledging the failed page, including a failed first resume query.
    replies.push({ body: discovery }, { body: { records: [reminder("TRANSIENT-FIRST", "List/A")], continuationMarker: "transient-next" } }, { status: 503, body: {} });
    const transient = await service().readAllOpenForMCP(setup.generation);
    assert.equal(transient.result.complete, false); assert.equal(transient.result.records.length, 1); assert.equal(transient.result.pendingReason, "read_error");
    assert.deepEqual(transient.result.errors, [{ code: "UPSTREAM_UNAVAILABLE", retryable: true }]);
    assert.equal((await repository.load()).session.allOpenScan?.cursor, "transient-next");
    replies.push({ status: 503, body: {} });
    const failedResume = await service().readAllOpenForMCP(setup.generation, transient.result.continuation);
    assert.equal(failedResume.result.complete, false); assert.equal(failedResume.result.records.length, 0); assert.equal(failedResume.result.errors[0].code, "UPSTREAM_UNAVAILABLE");
    assert.notEqual(failedResume.result.continuation, transient.result.continuation);
    assert.equal((await repository.load()).session.allOpenScan?.cursor, "transient-next");
    assert.equal((await repository.load()).session.allOpenScan?.totalPages, 1);
    await assert.rejects(service().readAllOpenForMCP(setup.generation, transient.result.continuation), (error: unknown) => error instanceof AppError && error.code === "CONFLICT");
    replies.push({ body: { records: [reminder("TRANSIENT-LAST", "List/A")] } }, { body: { records: [reminder("TRANSIENT-B", "List/B")] } }, { body: { records: [reminder("TRANSIENT-C", "List/C")] } });
    const recovered = await service().readAllOpenForMCP(setup.generation, failedResume.result.continuation);
    assert.equal(recovered.result.complete, true); assert.equal(recovered.result.records.length, 3);
    assert.equal(requests.at(-3)!.body.continuationMarker, "transient-next");
    replies.push({ body: discovery }, { body: { records: [reminder("SAFE-ON-ERRORED-PAGE", "List/A"), { recordName: "Reminder/ERRORED", serverErrorCode: "CONFLICT" }], continuationMarker: "unacknowledged-marker" } });
    const recordFailure = await service().readAllOpenForMCP(setup.generation);
    assert.equal(recordFailure.result.complete, false); assert.equal(recordFailure.result.pendingReason, "record_errors"); assert.equal(recordFailure.result.records.length, 0);
    assert.deepEqual(recordFailure.result.recordErrors, [{ id: "Reminder/ERRORED", code: "CONFLICT" }]);
    assert.equal((await repository.load()).session.allOpenScan?.cursor, null); assert.equal((await repository.load()).session.allOpenScan?.totalPages, 0);
    replies.push({ body: { records: [reminder("SAFE-ON-ERRORED-PAGE", "List/A")] } }, { body: { records: [] } }, { body: { records: [] } });
    const recordRecovered = await service().readAllOpenForMCP(setup.generation, recordFailure.result.continuation);
    assert.equal(recordRecovered.result.complete, true); assert.equal(recordRecovered.result.records.length, 1);
    replies.push({ body: discovery }, { status: 429, body: {}, headers: { "retry-after": "30" } });
    const throttled = await service().readAllOpenForMCP(setup.generation);
    assert.equal(throttled.result.complete, false); assert.equal(throttled.result.records.length, 0);
    assert.deepEqual(throttled.result.errors, [{ code: "RATE_LIMITED", retryable: true, retryAfterSeconds: 30 }]);
    now += 30_000;
    replies.push({ body: { records: [reminder("RATE-RECOVERED", "List/A")] } }, { body: { records: [] } }, { body: { records: [] } });
    assert.equal((await service().readAllOpenForMCP(setup.generation, throttled.result.continuation)).result.complete, true);
    // Expiry discards progress rather than reusing an old list/query snapshot.
    replies.push({ body: discovery }, { body: { records: [reminder("EXPIRING", "List/A")], continuationMarker: "expiry-next" }, after: async () => { now += 20_000; } });
    const expiring = await service().readAllOpenForMCP(setup.generation); assert.equal(expiring.result.complete, false);
    now += 600_000; const beforeExpiry = requests.length;
    await assert.rejects(service().readAllOpenForMCP(setup.generation, expiring.result.continuation), (error: unknown) => error instanceof AppError && error.code === "RESTART_REQUIRED");
    assert.equal(requests.length, beforeExpiry); assert.equal((await repository.load()).session.allOpenScan, undefined);
    replies.push({ body: discovery }, { status: 401, body: {} });
    await assert.rejects(service().readAllOpenForMCP(setup.generation), (error: unknown) => error instanceof AppError && error.code === "REAUTH_REQUIRED");
    assert.equal((await repository.status()).state, "READY", "A CloudKit rejection alone is not confirmed account revocation.");
    const nextSetup = await repository.begin((await repository.status()).generation); await repository.commit(nextSetup, { ...session, login: loginAssurance() }, "READY");
    assert.equal((await repository.load()).session.allOpenScan, undefined);
    replies.push({ body: discovery }, { body: { records: [reminder("LATE", "List/A")] }, after: async () => { await repository.disconnect(); } });
    await assert.rejects(service().readAllOpenForMCP(nextSetup.generation), (error: unknown) => error instanceof AppError && ["NOT_CONNECTED", "CONFLICT"].includes(error.code));
    assert.equal((await repository.status()).state, "DISCONNECTED");
  } finally { globalThis.fetch = originalFetch; Date.now = originalNow; db.sqlite.close(); }
});

test("direct list snapshots replace only after complete discovery and preserve failed refreshes", async () => {
  const originalFetch = globalThis.fetch;
  const db = new SQLiteD1(), repository = appleRepo(db), session = appleSession();
  session.savedLists = mergeSavedLists([], [{ id: "List/OLD", title: "Previous snapshot" }]);
  const setup = await repository.begin(0); await repository.commit(setup, session, "READY");
  const env = { ...db.env(), REMINDERS_OWNER_ID: owner, ENCRYPTION_KEY_ID: repository.envelopes.active, ENCRYPTION_KEYS_JSON: JSON.stringify(repository.envelopes.keys), LIVE_APPLE_CONNECTION_APPROVED: "controlled-device-v2", APPLE_CRYPTO_REVIEW_APPROVED: "device-proof-v2" };
  const service = () => new AppleConnectionService(env, owner);
  const zoneID = { zoneName: "Reminders", ownerRecordName: "synthetic-direct-owner" };
  const list = (id: string, title: string, extra = {}) => ({ recordName: id, recordType: "List", zoneID, fields: { Name: { type: "STRING", value: title }, Count: { type: "INT64", value: 0 }, ...extra } });
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  const replies: { body: unknown; status?: number; after?: () => Promise<void> }[] = [];
  globalThis.fetch = async (input, init) => {
    requests.push({ path: new URL(String(input)).pathname, body: JSON.parse(String(init?.body)) });
    const next = replies.shift(); assert.ok(next, "Unexpected direct discovery request");
    if (next.after) await next.after();
    return new Response(JSON.stringify(next.body), { status: next.status ?? 200 });
  };
  try {
    replies.push({ body: { zones: [{ zoneID }] } }, { body: { records: [list("List/EMPTY", "Empty list"), list("List/GROUP", "Group", { IsGroup: { type: "INT64", value: 1 } })], continuationMarker: "direct-next" } }, { body: { records: [{ ...list("List/DELETED", "Removed", { Deleted: { type: "INT64", value: 1 } }), deleted: false }, list("List/NEW", "Current name")] } });
    const first = await service().getCurrentLists(setup.generation);
    assert.equal(first.result.complete, true); assert.equal(first.result.source, "direct-cloudkit-query"); assert.equal(first.result.freshness.mode, "live");
    assert.equal(first.result.records.find(item => item.id === "List/DELETED")?.deleted, true); assert.equal(first.result.records.length, 4); assert.equal(first.result.records[0].count, 0);
    const snapshot = (await repository.load()).session;
    assert.equal(snapshot.savedLists?.some(item => item.id === "List/OLD"), false);
    assert.ok(requests.every(request => !request.path.endsWith("/changes/zone")));
    const count = requests.length;
    await service().read(ControlledRead.parse({ action: "saved-lists", expectedGeneration: setup.generation }));
    assert.equal(requests.length, count, "Dashboard polling must be display-only");
    // Record failures and HTTP errors never erase the last complete snapshot.
    for (const reply of [{ body: { records: [{ recordName: "List/NEW", serverErrorCode: "BAD_REQUEST" }] } }, { body: {}, status: 503 }, { body: {}, status: 403 }]) {
      replies.push(reply); await assert.rejects(service().getCurrentLists(setup.generation), AppError);
      assert.deepEqual((await repository.load()).session.savedLists, snapshot.savedLists);
    }
    // Refresh reflects renames/removals and a genuinely empty collection.
    replies.push({ body: { records: [list("List/NEW", "Renamed")] } }); await service().getCurrentLists(setup.generation);
    assert.deepEqual((await repository.load()).session.savedLists?.map(item => item.title), ["Renamed"]);
    replies.push({ body: { records: [] } }); assert.equal((await service().getCurrentLists(setup.generation)).result.records.length, 0);
    assert.deepEqual((await repository.load()).session.savedLists, []);
    // A failed encrypted commit cannot publish new summaries or corrupt saved ones.
    const encrypt = Envelopes.prototype.encrypt;
    replies.push({ body: { records: [list("List/NEW", "Must not be saved")] } });
    Envelopes.prototype.encrypt = async () => { throw new Error("synthetic encryption failure"); };
    try { await assert.rejects(service().getCurrentLists(setup.generation)); }
    finally { Envelopes.prototype.encrypt = encrypt; }
    assert.deepEqual((await repository.load()).session.savedLists, []);
    replies.push({ body: { records: [list("List/NEW", "Never committed")] }, after: async () => { await repository.disconnect(); } });
    await assert.rejects(service().getCurrentLists(setup.generation), (e: unknown) => e instanceof AppError && ["NOT_CONNECTED", "CONFLICT"].includes(e.code));
    assert.equal((await repository.status()).state, "DISCONNECTED"); assert.equal(replies.length, 0);
  } finally { globalThis.fetch = originalFetch; db.sqlite.close(); }
});

test("known-list reads authorize live without any historical checkpoint and fence failures", async () => {
  const originalFetch = globalThis.fetch, originalNow = Date.now;
  const db = new SQLiteD1(), repository = appleRepo(db), session = appleSession();
  const setup = await repository.begin(0); await repository.commit(setup, session, "READY");
  const env = { ...db.env(), ENCRYPTION_KEY_ID: repository.envelopes.active, ENCRYPTION_KEYS_JSON: JSON.stringify(repository.envelopes.keys), LIVE_APPLE_CONNECTION_APPROVED: "controlled-device-v2", APPLE_CRYPTO_REVIEW_APPROVED: "device-proof-v2" };
  const service = () => new AppleConnectionService(env, owner);
  const input = (includeCompleted = false, continuation: string | null = null) => ControlledRead.parse({ action: "reminders", expectedGeneration: setup.generation, listId: "List/KNOWN", includeCompleted, continuation });
  const zoneID = { zoneName: "Reminders", ownerRecordName: "synthetic-known-owner" };
  const list = { recordName: "List/KNOWN", recordType: "List", zoneID, fields: { Name: { type: "STRING", value: "Current authorized list" } } };
  const reminder = (id: string, completed: number, listId = "List/KNOWN") => ({ recordName: id, recordType: "Reminder", zoneID, fields: { List: { type: "REFERENCE", value: { recordName: listId, action: "VALIDATE", zoneID } }, Completed: { type: "INT64", value: completed } } });
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  const replies: { body: unknown; status?: number; headers?: Record<string, string>; after?: () => Promise<void> }[] = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ path: new URL(String(url)).pathname, body: JSON.parse(String(init?.body)) });
    const reply = replies.shift(); assert.ok(reply, "Unexpected known-list request");
    if (reply.after) await reply.after();
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200, headers: reply.headers });
  };
  try {
    replies.push({ body: { zones: [{ zoneID }] } }, { body: { records: [list] } }, { body: { records: [reminder("Reminder/OPEN", 0), reminder("Reminder/CLOSED", 1), { recordName: "Alarm/A", recordType: "Alarm", zoneID, fields: {} }], continuationMarker: "known-next" } });
    const first = await service().readForMCP(input());
    assert.deepEqual((first.result.records as { id: string }[]).map(item => item.id), ["Reminder/OPEN"]); assert.equal(first.result.continuation, "known-next");
    assert.equal((await repository.load()).session.directListSnapshot, undefined);
    await injectPreviousSession(db, repository, { catalogueSync: { token: "expired-checkpoint", initialComplete: false, pending: true }, catalogueAuto: { lastErrorCode: "RESTART_REQUIRED", pausedForError: true } });
    await assert.rejects(service().readForMCP(input(true, "known-next")), hasCode("CONFLICT"));
    replies.push({ body: { records: [list] } }, { body: { records: [reminder("Reminder/OPEN-LATER", 0)] } });
    const second = await service().readForMCP(input(false, "known-next"));
    assert.equal((second.result.records as { completed: boolean }[])[0].completed, false);
    assert.equal(requests.at(-1)!.body.continuationMarker, "known-next");
    assert.ok(requests.every(request => !request.path.endsWith("/changes/zone")));
    for (const invalid of ["List/A/B", "List/ bad", "List/a\n", "Reminder/A"]) assert.equal(ControlledRead.safeParse({ ...input(), listId: invalid }).success, false);
    for (const bad of [{ ...list, deleted: true }, { ...list, fields: { IsGroup: { type: "INT64", value: 1 } } }, { recordName: list.recordName, serverErrorCode: "NOT_FOUND" }, { ...list, zoneID: { ...zoneID, ownerRecordName: "other-owner" } }]) {
      const before = requests.length; replies.push({ body: { records: [bad] } });
      await assert.rejects(service().readForMCP(input()), AppError); assert.equal(requests.length, before + 1);
    }
    for (const reply of [{ status: 403, body: {} }, { status: 429, headers: { "retry-after": "9" }, body: {} }, { status: 503, body: {} }, { body: { records: [{}] } }]) {
      replies.push(reply); await assert.rejects(service().readForMCP(input()), AppError);
    }
    replies.push({ body: { records: [list] } }, { body: { records: [reminder("Reminder/OTHER", 0, "List/OTHER")] } });
    await assert.rejects(service().readForMCP(input()), (e: unknown) => e instanceof AppError && e.code === "PROTOCOL_CHANGED");
    replies.push({ body: { records: [list] } }, { body: { records: [] }, after: async () => { Date.now = () => session.login.expiresAt; } });
    await assert.rejects(service().readForMCP(input()), (e: unknown) => e instanceof AppError && e.code === "AUTH_EXPIRED"); Date.now = originalNow;
    assert.equal((await repository.status()).state, "DISCONNECTED"); assert.equal(replies.length, 0);
  } finally { globalThis.fetch = originalFetch; Date.now = originalNow; db.sqlite.close(); }
});

test("direct all-open resumes its original list selection without rediscovery after a refresh", async () => {
  const originalFetch = globalThis.fetch, originalNow = Date.now;
  let now = originalNow(); Date.now = () => now;
  const db = new SQLiteD1(), repository = appleRepo(db), session = appleSession();
  session.connection.remindersZoneOwner = "__defaultOwner__";
  const setup = await repository.begin(0); await repository.commit(setup, session, "READY");
  const env = { ...db.env(), ENCRYPTION_KEY_ID: repository.envelopes.active, ENCRYPTION_KEYS_JSON: JSON.stringify(repository.envelopes.keys), LIVE_APPLE_CONNECTION_APPROVED: "controlled-device-v2", APPLE_CRYPTO_REVIEW_APPROVED: "device-proof-v2" };
  const service = () => new AppleConnectionService(env, owner);
  const list = (id: string, extra = {}) => ({ recordName: id, recordType: "List", fields: { Name: { type: "STRING", value: id.slice(5) }, ...extra } });
  const reminder = (id: string, listId: string) => ({ recordName: id, recordType: "Reminder", fields: { List: { type: "REFERENCE", value: { recordName: listId, action: "VALIDATE" } }, Completed: { type: "INT64", value: 0 } } });
  const requests: Record<string, unknown>[] = [];
  const replies: { body: unknown; after?: () => void }[] = [];
  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(String(init?.body))); const next = replies.shift(); assert.ok(next, "Unexpected direct all-open request"); next.after?.();
    return new Response(JSON.stringify(next.body));
  };
  try {
    replies.push({ body: { records: [list("List/A"), list("List/EMPTY"), list("List/GROUP", { IsGroup: { type: "INT64", value: 1 } }), list("List/DELETED", { Deleted: { type: "INT64", value: 1 } })] } }, { body: { records: [reminder("Reminder/A1", "List/A")], continuationMarker: "a-next" }, after: () => { now += 20_000; } });
    const first = await service().readAllOpenForMCP(setup.generation);
    assert.equal(first.result.complete, false); assert.equal(first.result.pendingReason, "deadline"); assert.equal(first.result.progress.listsTotal, 2);
    assert.equal(first.result.source, "direct-cloudkit-query"); assert.deepEqual(first.result.records.map(item => item.id), ["Reminder/A1"]);
    const token = first.result.continuation!;
    // Another complete retrieval removes A from the dashboard snapshot, but
    // cannot skip its outstanding all-open page or change this operation's lists.
    replies.push({ body: { records: [list("List/NEW")] } }); await service().getCurrentLists(setup.generation);
    assert.equal((await repository.load()).session.savedLists?.[0].id, "List/NEW");
    const beforeResume = requests.length;
    replies.push({ body: { records: [reminder("Reminder/A2", "List/A")] } }, { body: { records: [] } });
    const resumed = await service().readAllOpenForMCP(setup.generation, token);
    assert.equal(resumed.result.complete, true); assert.deepEqual(resumed.result.records.map(item => item.id), ["Reminder/A2"]);
    assert.deepEqual(resumed.result.lists.map(item => item.id), ["List/A", "List/EMPTY"]);
    assert.equal(requests[beforeResume].continuationMarker, "a-next");
    assert.ok(requests.slice(beforeResume).every(body => (body.query as { recordType: string }).recordType === "reminderList"));
    const beforeReplay = requests.length;
    await assert.rejects(service().readAllOpenForMCP(setup.generation, token), (e: unknown) => e instanceof AppError && e.code === "CONFLICT"); assert.equal(requests.length, beforeReplay);
    replies.push({ body: { records: [list("List/A")] } }, { body: { records: [], continuationMarker: "other-next" }, after: () => { now += 20_000; } });
    const pending = await service().readAllOpenForMCP(setup.generation);
    await repository.disconnect(); const nextSetup = await repository.begin((await repository.status()).generation); await repository.commit(nextSetup, appleSession(), "READY");
    await assert.rejects(service().readAllOpenForMCP(nextSetup.generation, pending.result.continuation), (e: unknown) => e instanceof AppError && e.code === "CONFLICT");
    assert.equal((await repository.load()).session.allOpenScan, undefined); assert.equal(replies.length, 0);
  } finally { globalThis.fetch = originalFetch; Date.now = originalNow; db.sqlite.close(); }
});

test("search resumes filtered pages honestly, binds filters and account scope, and rejects cycling Apple cursors", async () => fixedClock(async clock => {
  const originalFetch = globalThis.fetch, originalNow = Date.now;
  const db = new SQLiteD1(), envelopes = key(), repository = appleRepo(db, owner, envelopes), session = appleSession();
  session.connection.remindersZoneOwner = "__defaultOwner__";
  const setup = await repository.begin(0); await repository.commit(setup, session, "READY");
  const env = { ...testEnv(db, envelopes) };
  const service = () => new AppleConnectionService(env, owner);
  const list = (id: string) => ({ recordName: id, recordType: "List", fields: { Name: { type: "STRING", value: id.slice(5) }, IsGroup: { type: "INT64", value: 0 }, Deleted: { type: "INT64", value: 0 } } });
  const reminder = (id: string, listId: string, title: string, completed = 0, extra: { notes?: string; flagged?: boolean; priority?: number; dueDate?: string; hashtagIds?: string[]; attachmentIds?: string[] } = {}) => {
    const fields: Record<string, unknown> = {
      List: { type: "REFERENCE", value: { recordName: listId, action: "VALIDATE" } },
      TitleDocument: { type: "ENCRYPTED_BYTES", value: encodeDocument(title) },
      Completed: { type: "INT64", value: completed },
      Deleted: { type: "INT64", value: 0 },
    };
    if (extra.notes !== undefined) fields.NotesDocument = { type: "ENCRYPTED_BYTES", value: encodeDocument(extra.notes) };
    if (extra.flagged !== undefined) fields.Flagged = { type: "INT64", value: Number(extra.flagged) };
    if (extra.priority !== undefined) fields.Priority = { type: "INT64", value: extra.priority };
    if (extra.dueDate !== undefined) fields.DueDate = { type: "TIMESTAMP", value: Date.parse(extra.dueDate) };
    if (extra.hashtagIds !== undefined) fields.HashtagIDs = { type: "STRING_LIST", value: extra.hashtagIds };
    if (extra.attachmentIds !== undefined) fields.AttachmentIDs = { type: "STRING_LIST", value: extra.attachmentIds };
    return { recordName: id, recordType: "Reminder", recordChangeTag: `version-${id}`, fields };
  };
  const pendingPages: { listId: string; cursor?: string; includeCompleted: number; reply: unknown }[] = [
    { listId: "List/A", includeCompleted: 0, reply: { records: [reminder("Reminder/A-OTHER", "List/A", "unrelated")], continuationMarker: "native-a-next" } },
    { listId: "List/A", cursor: "native-a-next", includeCompleted: 0, reply: { records: [reminder("Reminder/A-LATER", "List/A", "Target appears later")] } },
    { listId: "List/A", includeCompleted: 0, reply: { records: [], continuationMarker: "native-expire-next" } },
    { listId: "List/B", includeCompleted: 1, reply: { records: [
      reminder("Reminder/B-OPEN", "List/B", "target open", 0, { flagged: true, priority: 5, dueDate: "2026-10-10T12:00:00.000Z" }),
      reminder("Reminder/B-DONE", "List/B", "completed work", 1, { notes: "Needle appears only in notes", flagged: true, priority: 5, dueDate: "2026-10-10T12:00:00.000Z" }),
      reminder("Reminder/B-UNFLAGGED", "List/B", "Needle unflagged", 1, { flagged: false, priority: 5, dueDate: "2026-10-10T12:00:00.000Z" }),
      reminder("Reminder/B-WRONG-PRIORITY", "List/B", "Needle wrong priority", 1, { flagged: true, priority: 9, dueDate: "2026-10-10T12:00:00.000Z" }),
      reminder("Reminder/B-OUTSIDE-DUE", "List/B", "Needle later", 1, { flagged: true, priority: 5, dueDate: "2026-10-11T00:00:00.000Z" }),
    ] } },
    { listId: "List/A", includeCompleted: 0, reply: { records: [], continuationMarker: "cycle-marker" } },
    { listId: "List/A", cursor: "cycle-marker", includeCompleted: 0, reply: { records: [], continuationMarker: "cycle-marker" } },
  ];
  const relatedRecords = new Map<string, Record<string, unknown>>();
  const zoneID = { zoneName: "Reminders", zoneType: "REGULAR_CUSTOM_ZONE", ownerRecordName: "__defaultOwner__" };
  const relationshipIds = {
    workA: "00000000-0000-4000-8000-000000000001", homeA: "00000000-0000-4000-8000-000000000002",
    urlA: "00000000-0000-4000-8000-000000000003", workB: "00000000-0000-4000-8000-000000000004",
    image: "00000000-0000-4000-8000-000000000005", homeDone: "00000000-0000-4000-8000-000000000006",
    urlDone: "00000000-0000-4000-8000-000000000007", missing: "00000000-0000-4000-8000-000000000008",
    ambiguousUrl: "00000000-0000-4000-8000-000000000009", unclassifiedUrl: "00000000-0000-4000-8000-00000000000a",
    unclassifiedAttachment: "00000000-0000-4000-8000-00000000000b",
  };
  const related = (recordName: string, recordType: "Hashtag" | "Attachment", reminderId: string, fields: Record<string, unknown>) =>
    relatedRecords.set(recordName, { recordName, recordType, recordChangeTag: `version-${recordName}`, zoneID, fields: {
      ...fields, Deleted: { type: "INT64", value: 0 }, Imported: { type: "INT64", value: 0 },
      Reminder: { type: "REFERENCE", value: { recordName: reminderId, action: "VALIDATE" } },
    } });
  const tag = (id: string, reminderId: string, name: string) => related(`Hashtag/${id}`, "Hashtag", reminderId, {
    Name: { type: "STRING", value: name, isEncrypted: true }, Type: { type: "INT64", value: 0 },
  });
  const url = (id: string, reminderId: string, value: string) => related(`Attachment/${id}`, "Attachment", reminderId, {
    Type: { type: "STRING", value: "URL" }, UTI: { type: "STRING", value: "public.url" },
    URL: { type: "STRING", value, isEncrypted: true },
  });
  const image = (id: string, reminderId: string) => related(`Attachment/${id}`, "Attachment", reminderId, {
    Type: { type: "STRING", value: "Image" }, UTI: { type: "STRING", value: "public.jpeg" },
  });
  const filteredAll = reminder("Reminder/FILTER-ALL", "List/A", "ordinary title", 0, { notes: "ordinary notes", hashtagIds: [relationshipIds.workA, relationshipIds.homeA], attachmentIds: [relationshipIds.urlA] });
  const filteredWork = reminder("Reminder/FILTER-WORK", "List/A", "ordinary title", 0, { hashtagIds: [relationshipIds.workB] });
  const filteredNone = reminder("Reminder/FILTER-UNTAGGED", "List/A", "https://example.test/Path", 0, {
    notes: "https://example.test/Path", hashtagIds: [], attachmentIds: [relationshipIds.image],
  });
  const filteredDone = Object.assign(reminder("Reminder/FILTER-DONE", "List/A", "completed", 1, { hashtagIds: [relationshipIds.homeDone], attachmentIds: [relationshipIds.urlDone] }), {
    created: { timestamp: Date.parse("2024-10-01T00:00:00.000Z") }, modified: { timestamp: Date.parse("2024-10-02T00:00:00.000Z") },
  });
  filteredDone.fields.CompletionDate = { type: "TIMESTAMP", value: Date.parse("2024-10-03T12:00:00.000Z") };
  filteredDone.fields.DueDate = { type: "TIMESTAMP", value: Date.parse("2024-10-03T12:00:00.000Z") };
  filteredDone.fields.StartDate = { type: "TIMESTAMP", value: Date.parse("2024-10-03T10:00:00.000Z") };
  filteredDone.fields.Flagged = { type: "INT64", value: 1 };
  filteredDone.fields.Priority = { type: "INT64", value: 5 };
  tag(relationshipIds.workA, filteredAll.recordName, "work"); tag(relationshipIds.homeA, filteredAll.recordName, "home"); url(relationshipIds.urlA, filteredAll.recordName, "https://example.test/Path");
  tag(relationshipIds.workB, filteredWork.recordName, "work"); image(relationshipIds.image, filteredNone.recordName);
  tag(relationshipIds.homeDone, filteredDone.recordName, "home"); url(relationshipIds.urlDone, filteredDone.recordName, "https://other.test/done");
  const requests: { path: string; body: Record<string, any> }[] = [];
  const searchDesiredKeys = ["List", "ParentReminder", "TitleDocument", "NotesDocument", "Completed", "CompletionDate", "DueDate", "StartDate", "Priority", "Flagged", "AllDay", "Deleted", "TimeZone", "AlarmIDs", "AttachmentIDs", "HashtagIDs", "RecurrenceRuleIDs"];
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input)).pathname, body = JSON.parse(String(init?.body));
    requests.push({ path, body });
    if (path.endsWith("/records/lookup")) {
      const ids = body.records.map((record: { recordName: string }) => record.recordName);
      return new Response(JSON.stringify({ records: ids.map((id: string) => relatedRecords.get(id) ??
        (id.startsWith("Hashtag/") || id.startsWith("Attachment/") ? { recordName: id, serverErrorCode: "NOT_FOUND" } : list(id))) }));
    }
    assert.ok(path.endsWith("/records/query"));
    if (body.query.recordType === "Lists") return new Response(JSON.stringify({ records: [list("List/A"), list("List/B")] }));
    assert.equal(body.query.recordType, "reminderList");
    const listId = body.query.filterBy.find((filter: any) => filter.fieldName === "List").fieldValue.value.recordName;
    const includeCompleted = body.query.filterBy.find((filter: any) => filter.fieldName === "includeCompleted").fieldValue.value;
    const page = pendingPages.shift(); assert.ok(page, "Unexpected search reminder query");
    assert.equal(listId, page.listId); assert.equal(includeCompleted, page.includeCompleted); assert.equal(body.continuationMarker, page.cursor);
    assert.deepEqual(body.desiredKeys, searchDesiredKeys, "The search path requests only its proven normalized reminder fields.");
    const reply = structuredClone(page.reply) as { records?: Record<string, unknown>[]; [key: string]: unknown };
    const requested = new Set(searchDesiredKeys);
    reply.records = reply.records?.map(record => record.recordType === "Reminder" ? {
      ...record, fields: Object.fromEntries(Object.entries(record.fields as Record<string, unknown>).filter(([name]) => requested.has(name))),
    } : record);
    return new Response(JSON.stringify(reply));
  };
  try {
    const first = await service().searchRemindersForMCP({ expectedGeneration: setup.generation, text: "target" });
    assert.deepEqual(first.result.records, []); assert.equal(first.result.complete, false); assert.ok(first.result.continuation);
    assert.equal(first.result.progress.currentListId, "List/A"); assert.equal(first.result.consistency, "live-pages-not-snapshot");
    const saved = (await repository.load()).session.searchScan;
    assert.equal(saved?.cursor, "native-a-next"); assert.deepEqual(saved?.listIds, ["List/A", "List/B"]);
    assert.equal(JSON.stringify(saved).includes("A-OTHER"), false);
    const envelope = String(db.sqlite.prepare("SELECT envelope FROM apple_session_state WHERE owner_id = ?").get(owner)?.envelope);
    assert.equal(envelope.includes("native-a-next"), false); assert.equal(envelope.includes("A-OTHER"), false);

    const beforeMismatch = requests.length;
    await assert.rejects(service().searchRemindersForMCP({ expectedGeneration: setup.generation, text: "other", continuation: first.result.continuation }), hasCode("CONFLICT"));
    assert.equal(requests.length, beforeMismatch, "A changed filter is rejected before Apple is queried.");
    const later = await service().searchRemindersForMCP({ expectedGeneration: setup.generation, text: "target", continuation: first.result.continuation });
    assert.deepEqual(later.result.records.map(record => record.id), ["Reminder/A-LATER"]);
    assert.equal(later.result.complete, false, "The other selected list still has a page to scan.");
    assert.equal(requests.at(-1)!.body.continuationMarker, "native-a-next");

    const expiring = await service().searchRemindersForMCP({ expectedGeneration: setup.generation, text: "expired", listId: "List/A" });
    assert.equal(expiring.result.complete, false);
    clock.now += 600_001;
    await assert.rejects(service().searchRemindersForMCP({ expectedGeneration: setup.generation, text: "expired", listId: "List/A", continuation: expiring.result.continuation }), hasCode("RESTART_REQUIRED"));
    assert.equal((await repository.load()).session.searchScan, undefined);
    clock.now -= 600_001;

    const completed = await service().searchRemindersForMCP({ expectedGeneration: setup.generation, text: "needle", status: "completed", flagged: true, priority: 5,
      dueFrom: "2026-10-10T00:00:00.000Z", dueTo: "2026-10-10T23:59:59.999Z", listId: "List/B" });
    assert.deepEqual(completed.result.records.map(record => record.id), ["Reminder/B-DONE"]);
    assert.equal(completed.result.complete, true); assert.equal(requests.at(-1)!.body.query.filterBy.find((filter: any) => filter.fieldName === "List").fieldValue.value.recordName, "List/B");
    assert.equal(requests.at(-1)!.body.query.filterBy.find((filter: any) => filter.fieldName === "includeCompleted").fieldValue.value, 1);

    const cycling = await service().searchRemindersForMCP({ expectedGeneration: setup.generation, text: "cycle", listId: "List/A" });
    await assert.rejects(service().searchRemindersForMCP({ expectedGeneration: setup.generation, text: "cycle", listId: "List/A", continuation: cycling.result.continuation }), (error: unknown) => error instanceof AppError && error.code === "PROTOCOL_CHANGED");
    assert.equal((await repository.load()).session.searchScan, undefined, "A cycling native continuation retires the unusable search token.");
    assert.equal(pendingPages.length, 0);

    const enqueue = (records: unknown[], options: { completed?: boolean; continuation?: string; cursor?: string } = {}) => pendingPages.push({
      listId: "List/A", includeCompleted: options.completed === false ? 0 : 1,
      ...(options.cursor ? { cursor: options.cursor } : {}),
      reply: { records, ...(options.continuation ? { continuationMarker: options.continuation } : {}) },
    });
    enqueue([filteredAll, filteredWork, filteredNone]);
    const allTags = await service().searchRemindersForMCP({ expectedGeneration: setup.generation, listId: "List/A", status: "all", tags: ["work", "home"] });
    assert.deepEqual(allTags.result.records.map(record => record.id), ["Reminder/FILTER-ALL"], "Omitted tagMatch requires every exact name.");
    assert.ok(!JSON.stringify(allTags.result).includes("https://example.test/Path") && !JSON.stringify(allTags.result).includes("work"));
    assert.deepEqual(requests.filter(request => request.path.endsWith("/records/lookup")).at(-1)?.body.records.map((item: { recordName: string }) => item.recordName),
      [`Hashtag/${relationshipIds.workA}`, `Hashtag/${relationshipIds.homeA}`, `Hashtag/${relationshipIds.workB}`], "Tag-only search hydrates candidate tags but does not fetch attachments.");

    enqueue([filteredAll, filteredWork, filteredNone]);
    const anyTags = await service().searchRemindersForMCP({ expectedGeneration: setup.generation, listId: "List/A", status: "all", tags: ["work", "home"], tagMatch: "any" });
    assert.deepEqual(anyTags.result.records.map(record => record.id), ["Reminder/FILTER-ALL", "Reminder/FILTER-WORK"]);

    enqueue([filteredAll, filteredWork, filteredNone]);
    const untagged = await service().searchRemindersForMCP({ expectedGeneration: setup.generation, listId: "List/A", status: "all", hasTags: false });
    assert.deepEqual(untagged.result.records.map(record => record.id), ["Reminder/FILTER-UNTAGGED"]);

    enqueue([filteredAll, filteredWork, filteredNone]);
    const urlText = await service().searchRemindersForMCP({ expectedGeneration: setup.generation, listId: "List/A", status: "all", urlText: "EXAMPLE.TEST/path" });
    assert.deepEqual(urlText.result.records.map(record => record.id), ["Reminder/FILTER-ALL"], "URL substring is case-insensitive and comes only from the native URL attachment.");
    assert.deepEqual(requests.filter(request => request.path.endsWith("/records/lookup")).at(-1)?.body.records.map((item: { recordName: string }) => item.recordName),
      [`Attachment/${relationshipIds.urlA}`, `Attachment/${relationshipIds.image}`], "URL-only search does not fetch hashtags and treats other attachments as opaque.");

    enqueue([filteredAll, filteredWork, filteredNone]);
    const withoutURL = await service().searchRemindersForMCP({ expectedGeneration: setup.generation, listId: "List/A", status: "all", hasUrl: false });
    assert.deepEqual(withoutURL.result.records.map(record => record.id), ["Reminder/FILTER-WORK", "Reminder/FILTER-UNTAGGED"]);

    enqueue([filteredDone], { completed: true });
    const combinedDone = await service().searchRemindersForMCP({ expectedGeneration: setup.generation, listId: "List/A", status: "completed", tags: ["home"], hasUrl: true });
    assert.deepEqual(combinedDone.result.records.map(record => record.id), ["Reminder/FILTER-DONE"]);
    assert.equal(combinedDone.result.records[0].completedDate, "2024-10-03T12:00:00.000Z");
    assert.equal(combinedDone.result.records[0].dueDate, "2024-10-03T12:00:00.000Z");
    assert.equal(combinedDone.result.records[0].created, "2024-10-01T00:00:00.000Z");
    assert.equal(combinedDone.result.records[0].modified, "2024-10-02T00:00:00.000Z");

    enqueue([filteredAll], { continuation: "search-hydration-next" });
    const hydrationFirst = await service().searchRemindersForMCP({ expectedGeneration: setup.generation, listId: "List/A", status: "all", tags: ["work"] });
    const hydrationToken = hydrationFirst.result.continuation!;
    const beforeChangedHydration = requests.length;
    await assert.rejects(service().searchRemindersForMCP({ expectedGeneration: setup.generation, listId: "List/A", status: "all", tags: ["home"], continuation: hydrationToken }), hasCode("CONFLICT"));
    assert.equal(requests.length, beforeChangedHydration, "Changed hydration filters are rejected before another Apple query.");
    enqueue([filteredWork], { cursor: "search-hydration-next" });
    const hydrationLater = await service().searchRemindersForMCP({ expectedGeneration: setup.generation, listId: "List/A", status: "all", tags: ["work"], continuation: hydrationToken });
    assert.deepEqual(hydrationLater.result.records.map(record => record.id), ["Reminder/FILTER-WORK"]);

    enqueue([], { continuation: "search-related-error-next" });
    const relatedErrorFirst = await service().searchRemindersForMCP({ expectedGeneration: setup.generation, listId: "List/A", status: "all", tags: ["missing"] });
    const relatedErrorToken = relatedErrorFirst.result.continuation!;
    const missingTag = reminder("Reminder/MISSING-TAG", "List/A", "no relation", 0, { hashtagIds: [relationshipIds.missing] });
    enqueue([missingTag], { cursor: "search-related-error-next" });
    await assert.rejects(service().searchRemindersForMCP({ expectedGeneration: setup.generation, listId: "List/A", status: "all", tags: ["missing"], continuation: relatedErrorToken }), hasCode("CONFLICT"));
    assert.equal((await repository.load()).session.searchScan?.token, relatedErrorToken, "A missing relationship leaves the prior cursor available.");

    const unclassifiedURLRoot = reminder("Reminder/UNCLASSIFIED-URL", "List/A", "url classification", 0, { attachmentIds: [relationshipIds.unclassifiedUrl] });
    const unclassifiedURLFields = { URL: { type: "STRING", value: "https://example.test/unclassified", isEncrypted: true } };
    related(`Attachment/${relationshipIds.unclassifiedUrl}`, "Attachment", unclassifiedURLRoot.recordName, unclassifiedURLFields);
    enqueue([], { continuation: "search-unclassified-url-next" });
    const unclassifiedURLFirst = await service().searchRemindersForMCP({ expectedGeneration: setup.generation, listId: "List/A", status: "all", urlText: "example.test/unclassified" });
    const unclassifiedURLToken = unclassifiedURLFirst.result.continuation!;
    enqueue([unclassifiedURLRoot], { cursor: "search-unclassified-url-next" });
    await assert.rejects(service().searchRemindersForMCP({ expectedGeneration: setup.generation, listId: "List/A", status: "all", urlText: "example.test/unclassified", continuation: unclassifiedURLToken }), hasCode("UNSUPPORTED_FEATURE"));
    assert.equal((await repository.load()).session.searchScan?.token, unclassifiedURLToken, "Missing URL classification leaves the prior continuation available.");
    related(`Attachment/${relationshipIds.unclassifiedUrl}`, "Attachment", unclassifiedURLRoot.recordName, {
      ...unclassifiedURLFields, Type: { type: "STRING", value: "URL" }, UTI: { type: "STRING", value: "public.url" },
    });
    enqueue([unclassifiedURLRoot], { cursor: "search-unclassified-url-next" });
    const classifiedURLRetry = await service().searchRemindersForMCP({ expectedGeneration: setup.generation, listId: "List/A", status: "all", urlText: "example.test/unclassified", continuation: unclassifiedURLToken });
    assert.deepEqual(classifiedURLRetry.result.records.map(record => record.id), [unclassifiedURLRoot.recordName], "Repairing classification lets the same token return the URL match.");

    const ambiguousRoot = reminder("Reminder/AMBIGUOUS-URL", "List/A", "url classification", 0,
      { attachmentIds: [relationshipIds.ambiguousUrl, relationshipIds.unclassifiedAttachment] });
    related(`Attachment/${relationshipIds.ambiguousUrl}`, "Attachment", ambiguousRoot.recordName, {
      Type: { type: "STRING", value: "Image" }, UTI: { type: "STRING", value: "public.jpeg" },
      URL: { type: "STRING", value: "https://example.test/hidden", isEncrypted: true },
    });
    related(`Attachment/${relationshipIds.unclassifiedAttachment}`, "Attachment", ambiguousRoot.recordName, {});
    enqueue([], { continuation: "search-ambiguous-url-next" });
    const ambiguousFirst = await service().searchRemindersForMCP({ expectedGeneration: setup.generation, listId: "List/A", status: "all", hasUrl: false });
    const ambiguousToken = ambiguousFirst.result.continuation!;
    enqueue([ambiguousRoot], { cursor: "search-ambiguous-url-next" });
    await assert.rejects(service().searchRemindersForMCP({ expectedGeneration: setup.generation, listId: "List/A", status: "all", hasUrl: false, continuation: ambiguousToken }), hasCode("UNSUPPORTED_FEATURE"));
    assert.equal((await repository.load()).session.searchScan?.token, ambiguousToken, "A non-URL classification with an encrypted URL field leaves the prior cursor available.");
    related(`Attachment/${relationshipIds.ambiguousUrl}`, "Attachment", ambiguousRoot.recordName, {
      Type: { type: "STRING", value: "Image" }, UTI: { type: "STRING", value: "public.jpeg" },
    });
    enqueue([ambiguousRoot], { cursor: "search-ambiguous-url-next" });
    await assert.rejects(service().searchRemindersForMCP({ expectedGeneration: setup.generation, listId: "List/A", status: "all", hasUrl: false, continuation: ambiguousToken }), hasCode("UNSUPPORTED_FEATURE"));
    related(`Attachment/${relationshipIds.unclassifiedAttachment}`, "Attachment", ambiguousRoot.recordName, {
      Type: { type: "STRING", value: "Image" }, UTI: { type: "STRING", value: "public.png" },
    });
    enqueue([ambiguousRoot], { cursor: "search-ambiguous-url-next" });
    const nonURLRetry = await service().searchRemindersForMCP({ expectedGeneration: setup.generation, listId: "List/A", status: "all", hasUrl: false, continuation: ambiguousToken });
    assert.deepEqual(nonURLRetry.result.records.map(record => record.id), [ambiguousRoot.recordName], "Observed JPEG and PNG classifications prove absence of a URL.");

    for (const invalid of [
      { tagMatch: "all" as const }, { tags: ["work"], hasTags: false }, { urlText: "path", hasUrl: false }, { urlText: " \t " },
      { tags: ["work", "work"] }, { tags: Array.from({ length: 17 }, (_, index) => `tag${index}`) },
    ]) assert.throws(() => SearchReminderInput.parse({ expectedGeneration: setup.generation, listId: "List/A", ...invalid }));
  } finally { globalThis.fetch = originalFetch; Date.now = originalNow; db.sqlite.close(); }
}));

test("Shopping category read and move bind cursor scope and confirm native asset receipts without zone fields", async () => fixedClock(async clock => {
  const originalFetch = globalThis.fetch;
  const db = new SQLiteD1(), envelopes = key(), env = testEnv(db, envelopes), repository = new AppleSessionRepository(env, owner, envelopes);
  const session = appleSession();
  const ownedZone = { zoneName: "Reminders", zoneType: "REGULAR_CUSTOM_ZONE", ownerRecordName: "_synthetic-shopping-owner" };
  session.connection.remindersZoneOwner = ownedZone.ownerRecordName;
  session.renewal = { ...renewalCheckpoint(), lastValidatedAt: clock.now };
  const setup = await repository.begin(0); await repository.commit(setup, session, "READY");
  const service = () => new AppleConnectionService(env, owner);

  const createdList = buildCreateList({ name: "Synthetic groceries", idempotencyKey: crypto.randomUUID() }, clock.now - 30_000);
  const listId = createdList.recordName;
  const rootWrite = buildCreateReminder({ listId, idempotencyKey: crypto.randomUUID(), title: "Whole Milk", notes: "Keep chilled", priority: 0, flagged: false, allDay: false }, clock.now - 20_000);
  const reminderId = rootWrite.recordName, reminderUUID = reminderId.slice("Reminder/".length);
  const otherReminderId = `Reminder/${crypto.randomUUID().toUpperCase()}`;
  const previousCategoryId = `ListSection/${crypto.randomUUID().toUpperCase()}`;
  const destinationCategoryId = `ListSection/${crypto.randomUUID().toUpperCase()}`;
  const unrelatedListId = `List/${crypto.randomUUID().toUpperCase()}`;
  const unrelatedCategoryId = `ListSection/${crypto.randomUUID().toUpperCase()}`;
  const nativeZoneRef = { recordName: listId, zoneID: ownedZone };
  const memberships = { minimumSupportedVersion: SHOPPING_PROTOCOL_VERSION, memberships: [
    { memberID: reminderUUID, groupID: previousCategoryId.slice("ListSection/".length), modifiedOn: 757_382_400 },
    { memberID: otherReminderId.slice("Reminder/".length), groupID: previousCategoryId.slice("ListSection/".length), modifiedOn: 757_382_401 },
  ] };
  const corrections = { lastResetDate: null, memberships: {
    "coffee beans": { identifier: previousCategoryId.slice("ListSection/".length), modifiedOn: 757_382_399 },
    "whole milk": { identifier: previousCategoryId.slice("ListSection/".length), modifiedOn: 757_382_401 },
  } };
  const membershipBytes = encodeSectionMemberships(memberships);
  const correctionBytes = encodeGroceryCorrections(corrections);
  const membershipAssetURL = "https://cvws.icloud-content.com/B/synthetic-current-memberships";
  const correctionAssetURL = "https://cvws.icloud-content.com/B/synthetic-current-corrections";
  const assetContents = new Map<string, Uint8Array>([[membershipAssetURL, membershipBytes], [correctionAssetURL, correctionBytes]]);
  const assetReference = (fileChecksum: string, bytes: Uint8Array, downloadURL: string) => ({ type: "ASSETID", value: {
    fileChecksum, wrappingKey: `synthetic-${fileChecksum}-key`, referenceChecksum: `synthetic-${fileChecksum}-reference`,
    size: bytes.byteLength, downloadURL,
  } });
  const currentList: Record<string, any> = {
    ...createdList, recordChangeTag: "synthetic-list-version-1", zoneID: ownedZone, fields: {
      ...createdList.fields,
      ShouldCategorizeGroceryItems: { ...createdList.fields.ShouldCategorizeGroceryItems, value: 1 },
      ReminderIDs: { type: "STRING", value: JSON.stringify([reminderId, otherReminderId]) },
      MembershipsOfRemindersInSectionsAsData: assetReference("synthetic-memberships-v1", membershipBytes, membershipAssetURL),
      MembershipsOfRemindersInSectionsChecksum: { type: "STRING", value: await membershipsChecksum(memberships), isEncrypted: true },
      GroceryLocalCorrectionsAsData: assetReference("synthetic-corrections-v1", correctionBytes, correctionAssetURL),
      GroceryLocalCorrectionsChecksum: { type: "STRING", value: await groceryCorrectionsChecksum(corrections), isEncrypted: true },
      SyntheticFutureListField: { type: "STRING", value: "preserve-this-list-field" },
    },
  };
  const rootRecord: Record<string, any> = {
    recordName: reminderId, recordType: "Reminder", recordChangeTag: "synthetic-reminder-version-1", zoneID: ownedZone,
    parent: structuredClone(nativeZoneRef), created: { timestamp: clock.now - 20_000 }, modified: { timestamp: clock.now - 20_000 },
    fields: structuredClone(rootWrite.fields),
  };
  const section = (recordName: string, parentListId: string, title: string, tag: string) => ({
    recordName, recordType: "ListSection", recordChangeTag: tag, zoneID: ownedZone,
    parent: { recordName: parentListId, zoneID: ownedZone },
    fields: {
      List: { type: "REFERENCE", value: { recordName: parentListId, action: "VALIDATE" } },
      DisplayName: { type: "STRING", value: title }, CanonicalName: { type: "STRING", value: title.toLowerCase() },
      Deleted: { type: "INT64", value: 0 },
    },
  });
  const previousCategory = section(previousCategoryId, listId, "Pantry", "synthetic-section-version-1");
  const destinationCategory = section(destinationCategoryId, listId, "Dairy", "synthetic-section-version-1");
  const unrelatedCategory = section(unrelatedCategoryId, unrelatedListId, "Other list section", "synthetic-section-version-1");
  const records = new Map<string, Record<string, any>>([
    [listId, currentList], [reminderId, rootRecord], [previousCategoryId, previousCategory], [destinationCategoryId, destinationCategory],
    [otherReminderId, { ...rootRecord, recordName: otherReminderId }],
  ]);
  const uploadedBytes = new Map<string, Uint8Array>();
  const uploadReceipts = new Map<string, Record<string, unknown>>();
  const requests: { host: string; path: string; method: string; body?: Record<string, any> }[] = [];
  let modifyCount = 0;

  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input)), method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, any> : undefined;
    requests.push({ host: url.hostname, path: url.pathname, method, ...(body ? { body } : {}) });
    if (url.hostname === "cvws.icloud-content.com") {
      const bytes = assetContents.get(url.href);
      assert.ok(bytes, "Only previously observed or uploaded synthetic Shopping assets are downloaded.");
      const responseBody = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(responseBody).set(bytes);
      return new Response(responseBody, { status: 200 });
    }
    if (url.hostname === "cws.icloud-content.com" && url.pathname.endsWith("/singleFileUpload")) {
      assert.equal(method, "POST");
      const field = url.searchParams.get("field"); assert.ok(field);
      assert.ok(init?.body instanceof ArrayBuffer);
      const bytes = new Uint8Array(init.body);
      uploadedBytes.set(field, bytes);
      const receipt = {
        referenceChecksum: `synthetic-upload-reference-${field}`,
        size: bytes.byteLength,
        fileChecksum: `synthetic-upload-file-${field}`,
        wrappingKey: `synthetic-upload-key-${field}`,
        receipt: `synthetic-upload-receipt-${field}`,
      };
      uploadReceipts.set(field, receipt);
      return new Response(JSON.stringify({ singleFile: receipt }), { status: 200 });
    }
    assert.equal(url.hostname, "p123-ckdatabasews.icloud.com");
    assert.equal(method, "POST");
    assert.ok(body);
    if (url.pathname.endsWith("/records/lookup")) {
      return new Response(JSON.stringify({ records: body.records.map((item: { recordName: string }) => {
        const found = records.get(item.recordName);
        assert.ok(found, "Every exact synthetic lookup is backed by the fixture map.");
        return structuredClone(found);
      }) }));
    }
    if (url.pathname.endsWith("/changes/zone")) {
      return new Response(JSON.stringify({ zones: [{ zoneID: ownedZone, records: [destinationCategory, unrelatedCategory],
        moreComing: true, syncToken: "synthetic-native-category-cursor" }] }));
    }
    if (url.pathname.endsWith("/records/query")) {
      assert.equal(body.query.recordType, "reminderList", "The mutation checks the selected List for children before dispatch.");
      return new Response(JSON.stringify({ records: [] }));
    }
    if (url.pathname.endsWith("/assets/upload")) {
      const tokens = body.tokens as { recordName: string; fieldName: string }[];
      return new Response(JSON.stringify({ tokens: tokens.map((token, index) => ({
        recordName: token.recordName, fieldName: token.fieldName,
        url: `https://cws.icloud-content.com/${710_000 + index}/singleFileUpload?field=${encodeURIComponent(token.fieldName)}`,
      })) }));
    }
    if (url.pathname.endsWith("/records/modify")) {
      modifyCount++;
      assert.equal(body.atomic, true);
      assert.equal(body.operations.length, 3, "The root and List update with the destination category version guard atomically.");
      const confirmed = body.operations.map((operation: { record: { recordName: string; recordType: string; fields: Record<string, any> } }) => {
        const before = records.get(operation.record.recordName);
        assert.ok(before);
        const next: Record<string, any> = {
          ...structuredClone(before),
          recordChangeTag: `${before.recordChangeTag}-confirmed`,
          fields: { ...structuredClone(before.fields), ...structuredClone(operation.record.fields) },
        };
        if (operation.record.recordType === "List") {
          for (const field of ["MembershipsOfRemindersInSectionsAsData", "GroceryLocalCorrectionsAsData"]) {
            const tokenField = (operation.record.fields[field].value as Record<string, unknown>);
            const fieldName = field as string;
            const receipt = uploadReceipts.get(fieldName);
            const data = uploadedBytes.get(fieldName);
            assert.ok(receipt && data);
            const nextURL = `https://cvws.icloud-content.com/B/synthetic-uploaded-${fieldName}`;
            assetContents.set(nextURL, data);
            next.fields[field] = { type: "ASSETID", value: {
              fileChecksum: tokenField.fileChecksum, wrappingKey: tokenField.wrappingKey,
              referenceChecksum: tokenField.referenceChecksum, size: tokenField.size, downloadURL: nextURL,
            } };
          }
        }
        records.set(operation.record.recordName, next);
        const responseRecord = structuredClone(next);
        delete responseRecord.zoneID;
        return responseRecord;
      });
      return new Response(JSON.stringify({ records: confirmed }), { status: 200 });
    }
    throw new Error(`Unexpected synthetic Apple route ${url.pathname}`);
  };

  try {
    const read = await service().readShoppingCategoriesForMCP({ expectedGeneration: setup.generation, listId, limit: 10 });
    assert.equal(read.complete, false);
    assert.ok(read.continuation);
    assert.deepEqual(read.categories.map(category => category.categoryId).sort(), [destinationCategoryId, previousCategoryId].sort());
    assert.ok(!read.categories.some(category => category.categoryId === unrelatedCategoryId), "A category from another owned List stays out of this catalogue.");
    assert.deepEqual(read.memberships, [
      { reminderId, categoryId: previousCategoryId },
      { reminderId: otherReminderId, categoryId: previousCategoryId },
    ]);
    const cursor = read.continuation!;
    const requestsBeforeScopeChecks = requests.length;
    await assert.rejects(service().readShoppingCategoriesForMCP({ expectedGeneration: setup.generation, listId: unrelatedListId, continuation: cursor }), hasCode("CONFLICT"));
    await assert.rejects(new AppleConnectionService(env, "synthetic-other-owner").readShoppingCategoriesForMCP({ expectedGeneration: setup.generation, listId, continuation: cursor }), AppError);
    assert.equal(requests.length, requestsBeforeScopeChecks, "Wrong List and owner-scoped cursor use fail before Apple is contacted.");

    const beforeSession = await repository.load();
    const mutation = await service().setShoppingCategory({
      expectedGeneration: setup.generation, listId, reminderId, recordChangeTag: rootRecord.recordChangeTag,
      listRecordChangeTag: read.listRecordChangeTag, categoryId: destinationCategoryId,
      categoryRecordChangeTag: read.categories.find(category => category.categoryId === destinationCategoryId)!.recordChangeTag,
    });
    assert.equal(mutation.operation, "set_category");
    assert.equal(mutation.category.categoryId, destinationCategoryId);
    assert.equal(mutation.category.name, "Dairy");
    assert.equal(mutation.record.title, "Whole Milk");
    assert.equal(mutation.record.notes, "Keep chilled");
    assert.equal(modifyCount, 1, "The write is dispatched and confirmed once even though receipts omit zoneID.");
    assert.equal(requests.filter(request => request.host === "cws.icloud-content.com" && request.method === "POST").length, 2);
    const saved = await repository.load();
    assert.equal(saved.fence.generation, beforeSession.fence.generation);
    assert.equal(saved.session.login.expiresAt, beforeSession.session.login.expiresAt);
    assert.equal(saved.session.categoryScan, undefined, "A successful move invalidates the earlier category cursor.");
    const savedList = records.get(listId)!;
    assert.equal((savedList.fields.ReminderIDs as { value: string }).value, JSON.stringify([otherReminderId, reminderId]));
    assert.deepEqual((savedList.fields.SyntheticFutureListField as { value: string }).value, "preserve-this-list-field");
    assert.equal((savedList.fields.MembershipsOfRemindersInSectionsChecksum as { isEncrypted: boolean }).isEncrypted, true);
    assert.equal((savedList.fields.GroceryLocalCorrectionsChecksum as { isEncrypted: boolean }).isEncrypted, true);
    assert.equal((JSON.parse(new TextDecoder().decode(assetContents.get(`https://cvws.icloud-content.com/B/synthetic-uploaded-MembershipsOfRemindersInSectionsAsData`)!)) as { memberships: { memberID: string; groupID: string }[] }).memberships.find(entry => entry.memberID === reminderUUID)?.groupID,
      destinationCategoryId.slice("ListSection/".length));
    assert.equal((JSON.parse(new TextDecoder().decode(assetContents.get(`https://cvws.icloud-content.com/B/synthetic-uploaded-GroceryLocalCorrectionsAsData`)!)) as { memberships: Record<string, { identifier: string }> }).memberships["whole milk"].identifier,
      destinationCategoryId.slice("ListSection/".length));

    const requestCountAfterMove = requests.length;
    await assert.rejects(service().readShoppingCategoriesForMCP({ expectedGeneration: setup.generation, listId, continuation: cursor }), hasCode("CONFLICT"));
    assert.equal(requests.length, requestCountAfterMove, "The consumed category cursor cannot resume after mutation.");
    await assert.rejects(service().setShoppingCategory({
      expectedGeneration: setup.generation, listId, reminderId, recordChangeTag: rootRecord.recordChangeTag,
      listRecordChangeTag: read.listRecordChangeTag, categoryId: destinationCategoryId,
      categoryRecordChangeTag: read.categories.find(category => category.categoryId === destinationCategoryId)!.recordChangeTag,
    }), hasCode("CONFLICT"));
    assert.equal(modifyCount, 1, "A stale List tag cannot start a second write.");
  } finally { globalThis.fetch = originalFetch; db.sqlite.close(); }
}));
