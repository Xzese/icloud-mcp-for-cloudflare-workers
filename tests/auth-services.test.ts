import test from "node:test";
import assert from "node:assert/strict";
import { JobSQLiteD1 } from "./helpers/sqlite-d1.ts";
import { AppleSessionRepository, AppleSessionSchema, type AppleSession } from "../src/persistence/apple-sessions.ts";
import { AppleConnectionService, ControlledRead } from "../src/auth/service.ts";
import { AppleAuthHTTP } from "../src/auth/apple/http.ts";
import { AppleSessionRenewal, appleRequestBudget } from "../src/auth/apple/session-renewal.ts";
import { requireDriveConnection, requireRemindersConnection, requireServiceReady, sessionServices, validatedDriveServiceURL } from "../src/auth/apple/services.ts";
import { loginAssurance } from "../src/auth/apple/policy.ts";
import { freshPcsCheckpoint } from "../src/auth/apple/pcs.ts";
import { ServiceSettingsRepository } from "../src/persistence/service-settings.ts";
import { DEFAULT_SERVICE_SETTINGS } from "../src/services/settings.ts";
import { DriveOperationRepository } from "../src/persistence/drive-operations.ts";
import { Envelopes } from "../src/crypto/envelopes.ts";
import { b64 } from "../src/crypto/bytes.ts";
import { AppError } from "../src/errors.ts";
import { createWorkflowAppleFacade } from "../src/reminders/create-workflow.ts";
import { listDuplicationAppleFacade } from "../src/reminders/list-duplication-apple.ts";

const owner = "synthetic-services-owner";
const code = (value: string) => (error: unknown) => error instanceof AppError && error.code === value;
const common = () => ({ dsid: "123456789", clientId: "synthetic-services-client", clientBuildNumber: "2534Project66", clientMasteringNumber: "2534B22" });
const drive = () => ({ ...common(), driveURL: "https://p01-drivews.icloud.com", documentsURL: "https://p01-docws.icloud.com" });
const session = (): AppleSession => ({
  connection: { ...common(), cloudKitURL: "https://p01-ckdatabasews.icloud.com/database/1/com.apple.reminders/production/private", remindersZoneOwner: "synthetic-zone-owner" },
  auth: { clientId: common().clientId, headers: { "X-Apple-Session-Token": "synthetic-session-token" }, cookies: [
    { name: "X-APPLE-WEBAUTH-TOKEN", value: "synthetic-common-cookie", domain: "icloud.com", path: "/", hostOnly: false, secure: true, expiresAt: null },
  ] }, pcs: freshPcsCheckpoint(), login: loginAssurance(),
});
async function fixture(input = session(), state: "READY" | "DEVICE_APPROVAL_PENDING" = "READY") {
  const db = new JobSQLiteD1();
  const envelopes = new Envelopes("synthetic", { synthetic: b64(crypto.getRandomValues(new Uint8Array(32))) });
  const env = { ...db.env(), REMINDERS_OWNER_ID: owner, ENCRYPTION_KEY_ID: envelopes.active, ENCRYPTION_KEYS_JSON: JSON.stringify(envelopes.keys),
    LIVE_APPLE_CONNECTION_APPROVED: "controlled-device-v2", APPLE_CRYPTO_REVIEW_APPROVED: "device-proof-v2" };
  const repository = new AppleSessionRepository(env, owner);
  const fence = await repository.begin(0);
  await repository.commit(fence, input, state, state === "DEVICE_APPROVAL_PENDING" ? "approve-device-consent" : undefined);
  const settings = new ServiceSettingsRepository(env, owner);
  return { db, env, repository, settings, generation: fence.generation, service: new AppleConnectionService(env, owner) };
}
async function settingsWithDrive(f: Awaited<ReturnType<typeof fixture>>) {
  const settings = structuredClone(DEFAULT_SERVICE_SETTINGS);
  settings.drive = { enabled: true, browse: true, contents: true, upload: true, organize: true };
  return f.settings.save({ expectedRevision: (await f.settings.load()).revision, settings });
}

// Account discovery is tested through the actual setup decoder; malformed Drive
// endpoints never inherit CloudKit's broader path rules or unrelated host trust.
test("Drive-only account discovery and renewal accept no Reminders endpoint and reject malformed metadata URLs", async () => {
  const auth = session().auth;
  const accepted = { hsaTrustedBrowser: true, dsInfo: { dsid: common().dsid }, webservices: {
    drivews: { url: drive().driveURL }, docws: { url: drive().documentsURL },
  } };
  const http = AppleAuthHTTP.restore(auth, async () => Response.json(accepted));
  const result = await http.accountLogin();
  assert.equal(result.cloudKitURL, undefined);
  assert.deepEqual(result.drive, drive());
  assert.deepEqual(await AppleAuthHTTP.restore(auth, async () => Response.json(accepted)).validateSession(common().dsid), result);
  for (const address of ["http://p01-drivews.icloud.com", "https://p01-drivews.icloud.com:8443", "https://p01-drivews.icloud.com/anything",
    "https://p01-drivews.icloud.com?token=synthetic", "https://p01-drivews.icloud.com#fragment", "https://p01-drivews.icloud.com.evil.invalid",
    "https://p01-docws.icloud.com", "https://synthetic@p01-drivews.icloud.com", "https://www.icloud.com"]) {
    assert.throws(() => validatedDriveServiceURL(address, "drivews"), code("PROTOCOL_CHANGED"));
    await assert.rejects(AppleAuthHTTP.restore(auth, async () => Response.json({ ...accepted, webservices: { ...accepted.webservices, drivews: { url: address } } })).accountLogin(), code("PROTOCOL_CHANGED"));
  }
});

test("legacy encrypted sessions retain account, AAD, assurance and fences when adding service state", async () => {
  const original = session(), f = await fixture(original), nativeFetch = globalThis.fetch;
  try {
    const before = f.db.sqlite.prepare("SELECT * FROM apple_session_state").get();
    const saved = await f.repository.load();
    assert.deepEqual(saved.session, original);
    assert.deepEqual(f.db.sqlite.prepare("SELECT * FROM apple_session_state").get(), before, "Legacy load performs no rewrite or reset.");
    assert.equal(sessionServices(saved.session, saved.state).drive.state, "UNAVAILABLE");
    globalThis.fetch = async url => {
      assert.ok(String(url).includes("/validate"));
      return Response.json({ hsaTrustedBrowser: true, dsInfo: { dsid: original.connection.dsid }, webservices: {
        ckdatabasews: { url: "https://p02-ckdatabasews.icloud.com" }, drivews: { url: drive().driveURL }, docws: { url: drive().documentsURL },
      } });
    };
    const renewal = new AppleSessionRenewal({ ...f.env, APPLE_SESSION_RENEWAL_ENABLED: "saved-tokens-v1" }, f.repository);
    const renewed = await renewal.ensure(f.generation, appleRequestBudget(), true);
    assert.deepEqual(renewed.session.login, original.login);
    assert.deepEqual(renewed.session.auth, original.auth);
    assert.equal(renewed.fence.generation, saved.fence.generation);
    assert.equal(renewed.session.services?.reminders.state, "READY");
    assert.equal(renewed.session.services?.drive.state, "CONSENT_REQUIRED");
    const row = f.db.sqlite.prepare("SELECT account_id, generation, envelope FROM apple_session_state").get()!;
    assert.equal(row.account_id, "apple-reminders");
    const plaintext = await f.repository.envelopes.decrypt(JSON.parse(String(row.envelope)), { ownerId: owner, accountId: "apple-reminders", generation: f.generation, recordId: "apple-session", schemaVersion: 1 });
    assert.deepEqual(plaintext, renewed.session);
    for (const broken of [
      { ...renewed.session, services: { ...renewed.session.services, version: 2 } },
      { ...renewed.session, connection: { ...renewed.session.connection, cloudKitURL: undefined }, services: undefined },
      { ...renewed.session, services: { ...renewed.session.services, drive: { state: "READY", connection: { ...drive(), dsid: "999" } } } },
      { ...renewed.session, services: { ...renewed.session.services, drive: { state: "READY", connection: { ...drive(), driveURL: "https://p01-docws.icloud.com" } } } },
      { ...renewed.session, services: { ...renewed.session.services, futureService: { state: "READY" } } },
    ]) assert.equal(AppleSessionSchema.safeParse(broken).success, false);
    await assert.rejects(new AppleSessionRepository(f.env, "synthetic-other-owner").load(), code("NOT_CONNECTED"));
  } finally { globalThis.fetch = nativeFetch; f.db.sqlite.close(); }
});

test("Drive approval uses the common cookie jar and lease while Reminders is pending; local status never prompts", async () => {
  const original = session();
  original.services = { version: 1, reminders: { state: "DEVICE_APPROVAL_PENDING", pcs: original.pcs, action: "approve-device-consent" },
    drive: { state: "CONSENT_REQUIRED", connection: drive() } };
  const f = await fixture(original, "DEVICE_APPROVAL_PENDING"), nativeFetch = globalThis.fetch, nativeNow = Date.now;
  let now = nativeNow(), consented = false, pcsCalls = 0;
  Date.now = () => now;
  try {
    await settingsWithDrive(f);
    const requests: { path: string; body: unknown }[] = [];
    globalThis.fetch = async (url, init) => {
      const path = new URL(String(url)).pathname;
      requests.push({ path, body: init?.body ? JSON.parse(String(init.body)) : null });
      assert.match(new Headers(init?.headers).get("cookie") ?? "", /synthetic-common-cookie/);
      if (path.endsWith("requestWebAccessState")) return Response.json({ isICDRSDisabled: true, isDeviceConsentedForPCS: consented });
      if (path.endsWith("enableDeviceConsentForPCS")) return Response.json({ isDeviceConsentNotificationSent: true });
      assert.ok(path.endsWith("requestPCS"));
      assert.deepEqual(JSON.parse(String(init?.body)), { appName: "iclouddrive", derivedFromUserAction: pcsCalls !== 1 });
      if (pcsCalls++ === 0) return Response.json({ message: "Cookies not available yet on server." });
      return Response.json({ status: "success" }, { headers: { "set-cookie": "synthetic-drive-pcs=synthetic-pcs; Domain=icloud.com; Secure; Path=/" } });
    };
    const local = await f.service.status();
    assert.equal(local.accountConnected, true);
    assert.equal(local.services.reminders.ready, false);
    assert.equal(local.services.drive.ready, false);
    await f.service.loadDriveState(f.generation);
    assert.equal(requests.length, 0);
    const requested = await f.service.approveDrive(f.generation);
    assert.equal(requested.services.drive.state, "DEVICE_APPROVAL_PENDING");
    assert.equal(requested.services.drive.action, "approve-device-consent");
    await assert.rejects(f.service.approveDrive(f.generation), code("RATE_LIMITED"));
    assert.equal(requests.length, 2, "Checks before Apple's retry time send no request.");
    now += 5001; consented = true;
    const waiting = await f.service.approveDrive(f.generation);
    assert.equal(waiting.services.drive.action, "wait-for-drive-keys");
    now += 5001;
    const approved = await f.service.approveDrive(f.generation);
    assert.equal(approved.state, "DEVICE_APPROVAL_PENDING");
    assert.equal(approved.services.drive.ready, true);
    assert.equal(approved.services.reminders.ready, false);
    assert.equal(requests.length, 6);
    assert.equal(requests.filter(request => request.path.endsWith("enableDeviceConsentForPCS")).length, 1, "Checking the current attempt never sends another device prompt.");
    const saved = await f.repository.load();
    assert.deepEqual(saved.session.services?.reminders, original.services.reminders);
    assert.deepEqual(saved.session.login, original.login);
    assert.equal(saved.session.auth.cookies.length, 2);
    assert.deepEqual(requireDriveConnection(saved.session), drive());
    assert.throws(() => requireServiceReady(saved.session, saved.state, "reminders", saved.action), code("DEVICE_APPROVAL_PENDING"));
    const lease = await f.repository.claimRenewal(f.generation, saved.fence.version);
    await f.repository.assertAccountLease(lease);
    await assert.rejects(f.repository.assertWriteLease(lease), code("CONFLICT"));
    await f.repository.releaseResume(lease);
    await f.service.approveDrive(f.generation);
    await f.service.status();
    assert.equal(requests.length, 6, "READY and status calls never request keys again.");
    await f.service.approveDrive(f.generation, true);
    assert.equal(requests.length, 8, "Explicit restart requests fresh Drive PCS even when the saved state is READY.");
    assert.deepEqual((await f.repository.load()).session.services?.reminders, original.services.reminders);
    assert.deepEqual((await f.repository.load()).session.login, original.login);
  } finally { globalThis.fetch = nativeFetch; Date.now = nativeNow; f.db.sqlite.close(); }
});

test("enabling Reminders after Drive-only selection explicitly approves it from common READY without altering Drive errors", async () => {
  const original = session();
  original.pcs.expiresAt = Date.now() - 1;
  original.services = { version: 1, reminders: { state: "CONSENT_REQUIRED" }, drive: { state: "ERROR", connection: drive(), lastErrorCode: "FORBIDDEN" } };
  const f = await fixture(original), nativeFetch = globalThis.fetch;
  try {
    const paths: string[] = [];
    globalThis.fetch = async (url, init) => {
      const path = new URL(String(url)).pathname; paths.push(path);
      if (path.endsWith("requestWebAccessState")) return Response.json({ isICDRSDisabled: true, isDeviceConsentedForPCS: true });
      assert.ok(path.endsWith("requestPCS"));
      assert.equal(JSON.parse(String(init?.body)).appName, "reminders");
      return Response.json({ status: "success" });
    };
    assert.equal((await f.service.status()).services.reminders.ready, false);
    const before = f.db.sqlite.prepare("SELECT * FROM apple_session_state").get();
    const listId = `List/${crypto.randomUUID().toUpperCase()}`, reminderId = `Reminder/${crypto.randomUUID().toUpperCase()}`;
    await assert.rejects(createWorkflowAppleFacade(f.env, owner, f.service).binding(), code("DEVICE_APPROVAL_PENDING"));
    await assert.rejects(listDuplicationAppleFacade(f.env, owner, f.service), code("DEVICE_APPROVAL_PENDING"));
    await assert.rejects(f.service.readReminderListSectionsForMCP({ expectedGeneration: f.generation, listId }), code("DEVICE_APPROVAL_PENDING"));
    await assert.rejects(f.service.inspectReminder({ expectedGeneration: f.generation, listId, reminderId }), code("DEVICE_APPROVAL_PENDING"));
    await assert.rejects(f.service.collectRemindersForMCP({ view: "all", timeZone: "UTC", referenceInstant: "2026-10-13T12:00:00Z", sortBy: "title", filters: { status: "open" } }, f.generation), code("DEVICE_APPROVAL_PENDING"));
    assert.equal(paths.length, 0, "New Reminders workflows never request approval implicitly from a common READY account.");
    assert.deepEqual(f.db.sqlite.prepare("SELECT * FROM apple_session_state").get(), before);
    const approved = await f.service.approveReminders(f.generation);
    assert.equal(approved.services.reminders.ready, true);
    assert.equal(paths.length, 2);
    assert.deepEqual((await f.repository.load()).session.services?.drive, original.services.drive);
    await f.service.approveReminders(f.generation);
    assert.equal(paths.length, 2);
  } finally { globalThis.fetch = nativeFetch; f.db.sqlite.close(); }
});

test("renewal refreshes both endpoint sets, preserves independent consent errors, and consent loss does not prompt or disconnect another service", async () => {
  const original = session();
  original.services = { version: 1, reminders: { state: "READY" }, drive: { state: "ERROR", connection: drive(), lastErrorCode: "FORBIDDEN" } };
  const f = await fixture(original), nativeFetch = globalThis.fetch;
  try {
    let requests = 0;
    globalThis.fetch = async url => {
      requests++; assert.ok(String(url).includes("/validate"));
      return Response.json({ hsaTrustedBrowser: true, dsInfo: { dsid: common().dsid }, webservices: {
        ckdatabasews: { url: "https://p02-ckdatabasews.icloud.com" }, drivews: { url: "https://p03-drivews.icloud.com" }, docws: { url: "https://p04-docws.icloud.com" },
      } });
    };
    const renewal = new AppleSessionRenewal({ ...f.env, APPLE_SESSION_RENEWAL_ENABLED: "saved-tokens-v1" }, f.repository);
    const renewed = await renewal.ensure(f.generation, appleRequestBudget(), true);
    assert.match(requireRemindersConnection(renewed.session).cloudKitURL, /p02-/);
    assert.equal(requireDriveConnection(renewed.session).driveURL, "https://p03-drivews.icloud.com");
    assert.equal(requireDriveConnection(renewed.session).documentsURL, "https://p04-docws.icloud.com");
    assert.equal(renewed.session.services?.drive.state, "ERROR");
    assert.equal(renewed.session.services?.drive.lastErrorCode, "FORBIDDEN");
    await assert.rejects(renewal.requireServiceApproval(f.generation, appleRequestBudget(), "drive"), code("DEVICE_APPROVAL_PENDING"));
    const lost = await f.repository.load();
    assert.equal(lost.state, "READY");
    assert.equal(lost.session.services?.reminders.state, "READY");
    assert.equal(lost.session.services?.drive.state, "DEVICE_APPROVAL_PENDING");
    assert.deepEqual(lost.session.login, original.login);
    assert.equal(requests, 1);
  } finally { globalThis.fetch = nativeFetch; f.db.sqlite.close(); }
});

test("Reminders reads fail closed before dispatch and before release; continuations cannot survive permission revision changes", async () => {
  const original = session(), f = await fixture(original), nativeFetch = globalThis.fetch;
  const zoneID = { zoneName: "Reminders", ownerRecordName: original.connection.remindersZoneOwner };
  const list = { recordName: "List/SYNTHETIC", recordType: "List", zoneID, fields: { Name: { type: "STRING", value: "Synthetic list" } } };
  const read = (continuation?: string) => f.service.readForMCP(ControlledRead.parse({ action: "reminders", expectedGeneration: f.generation, listId: list.recordName, includeCompleted: false, continuation }));
  try {
    const duplication = await listDuplicationAppleFacade(f.env, owner, f.service);
    await duplication.assertCurrent(f.generation, original.connection.dsid);
    let requests = 0, disableAtQuery = false;
    globalThis.fetch = async url => {
      requests++;
      if (new URL(String(url)).pathname.endsWith("/records/lookup")) return Response.json({ records: [list] });
      if (disableAtQuery) {
        const previous = await f.settings.load();
        await f.settings.save({ expectedRevision: previous.revision, settings: { ...previous.settings, reminders: { ...previous.settings.reminders, read: false } } });
      }
      return Response.json({ records: [], continuationMarker: "synthetic-next-page" });
    };
    const first = await read();
    assert.equal(first.result.continuation, "synthetic-next-page");
    await f.settings.save({ expectedRevision: 0, settings: structuredClone(DEFAULT_SERVICE_SETTINGS) });
    await assert.rejects(duplication.assertCurrent(f.generation, original.connection.dsid), code("CONFLICT"));
    const before = requests;
    await assert.rejects(read("synthetic-next-page"), code("CONFLICT"));
    assert.equal(requests, before);
    disableAtQuery = true;
    await assert.rejects(read(), code("FORBIDDEN"));
    const after = requests;
    await assert.rejects(read(), code("FORBIDDEN"));
    assert.equal(requests, after, "Disabled reads send no Apple requests.");
    const status = await f.service.status();
    assert.equal(status.capabilities.liveRead, false);
    assert.equal(status.capabilities.create, true);
    // A storage error is never treated as a missing table or default permission.
    const nativePrepare = f.db.prepare.bind(f.db);
    f.db.prepare = (sql: string) => { if (sql.includes("owner_service_settings")) throw new Error("synthetic database failure"); return nativePrepare(sql); };
    await assert.rejects(read(), /synthetic database failure/);
    assert.equal(requests, after);
  } finally { globalThis.fetch = nativeFetch; f.db.sqlite.close(); }
});

test("disconnect and reconnect clear only older owner Drive records, and account leases cannot outlive disconnect", async () => {
  const f = await fixture();
  try {
    const operations = new DriveOperationRepository(f.env, owner);
    const scope = { account: "synthetic-account-scope", generation: f.generation, permissionRevision: 0, expiresAt: Date.now() + 60_000 };
    await operations.handle("download", { synthetic: true }, scope);
    await operations.create(crypto.randomUUID(), "create_folder", { name: "Synthetic" }, scope);
    await operations.handle("search", { synthetic: true }, { ...scope, generation: f.generation + 1 });
    const saved = await f.repository.load(), lease = await f.repository.claimRenewal(f.generation, saved.fence.version);
    await f.repository.assertAccountLease(lease);
    const disconnected = await f.service.disconnect();
    await assert.rejects(f.repository.assertAccountLease(lease), code("CONFLICT"));
    assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) AS n FROM drive_operations").get()!.n, 0);
    assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) AS n FROM drive_handles").get()!.n, 1, "A concurrent newer-generation handle is retained.");
    await f.repository.begin(disconnected.generation);
    assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) AS n FROM drive_handles").get()!.n, 0);
  } finally { f.db.sqlite.close(); }
});


test("revoking write access or changing its revision during the final session commit withholds a confirmed mutation result", async () => {
  for (const change of ["disable", "revision"] as const) {
    const f = await fixture(), nativeFetch = globalThis.fetch;
    const input = { expectedGeneration: f.generation, name: "Synthetic confirmed list", idempotencyKey: crypto.randomUUID() };
    let confirmations = 0, revoked = false;
    try {
      const before = await f.repository.load();
      globalThis.fetch = async (url, init) => {
        const path = new URL(String(url)).pathname;
        const body = JSON.parse(String(init?.body));
        if (path.endsWith("/records/lookup")) return Response.json({ records: body.records.map(({ recordName }: { recordName: string }) => ({ recordName, serverErrorCode: "NOT_FOUND" })) });
        assert.ok(path.endsWith("/records/modify"));
        confirmations++;
        return Response.json({ records: [{ ...body.operations[0].record, zoneID: body.zoneID, recordChangeTag: "synthetic-confirmed-version" }] });
      };
      f.db.afterStatement = async sql => {
        if (sql.startsWith("UPDATE apple_session_state SET version = version + 1, state = ?")) {
          f.db.afterStatement = null;
          assert.equal(confirmations, 1, "Revocation follows Apple's exact mutation confirmation.");
          const current = await f.settings.load();
          await f.settings.save({ expectedRevision: current.revision, settings: {
            ...current.settings, reminders: { ...current.settings.reminders, write: change !== "disable" },
          } });
          revoked = true;
        }
      };
      await assert.rejects(f.service.mutateList("create", input), code("WRITE_OUTCOME_UNKNOWN"));
      assert.equal(revoked, true);
      assert.equal(confirmations, 1, "The accepted mutation is never retried automatically.");
      const saved = await f.repository.load();
      assert.equal(saved.fence.generation, before.fence.generation);
      assert.equal(saved.fence.version, before.fence.version + 2, "The completed session commit remains durable.");
      assert.deepEqual(saved.session.login, before.session.login);
    } finally { globalThis.fetch = nativeFetch; f.db.sqlite.close(); }
  }
});
