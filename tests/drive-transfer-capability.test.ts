import test from "node:test";
import assert from "node:assert/strict";
import { issueDriveTransfer, authorizeDriveTransfer, driveTransferRoute } from "../src/drive/transfer-capability.ts";
import { applicationRoute } from "../src/api/router.ts";
import { b64 } from "../src/crypto/bytes.ts";

function fixture() {
  const env = { APP_ORIGIN: "https://transfer.example.test", REMINDERS_OWNER_ID: "synthetic-owner", ENCRYPTION_KEY_ID: "synthetic",
    ENCRYPTION_KEYS_JSON: JSON.stringify({ synthetic: b64(crypto.getRandomValues(new Uint8Array(32))) }),
    DRIVE_TRANSFER_SITES_GATEWAY_TOKEN: crypto.randomUUID() };
  return { env, id: crypto.randomUUID(), hash: "a".repeat(64), scope: { account: "synthetic-account", generation: 4, permissionRevision: 7, expiresAt: Date.now() + 3_600_000 } };
}

test("transfer URLs have independent random identities; only matching encrypted headers authorize the exact operation", async () => {
  const f = fixture();
  const a = await issueDriveTransfer(f.env, f.env.REMINDERS_OWNER_ID, "upload", f.id, f.hash, f.scope, { size: 2 ** 31, sha256: f.hash });
  const b = await issueDriveTransfer(f.env, f.env.REMINDERS_OWNER_ID, "upload", f.id, f.hash, f.scope, { size: 2 ** 31, sha256: f.hash });
  assert.notEqual(a.url, b.url);
  assert.ok(!a.url.includes(f.id));
  assert.equal(new URL(a.url).search, "");
  assert.ok(!a.headers.Authorization.includes(f.scope.account));
  assert.equal(a.headers["OAI-Sites-Authorization"], `Bearer ${f.env.DRIVE_TRANSFER_SITES_GATEWAY_TOKEN}`);
  const url = a.url.replace("wss:", "https:"), route = driveTransferRoute(new URL(url).pathname)!;
  const claim = await authorizeDriveTransfer(new Request(url, { headers: a.headers }), f.env, route);
  assert.equal(claim.id, f.id); assert.equal(claim.inputHash, f.hash); assert.equal(claim.scope.permissionRevision, 7);
  assert.ok(claim.scope.expiresAt <= Date.now() + 30 * 60_000);
  await assert.rejects(authorizeDriveTransfer(new Request(url, { headers: b.headers }), f.env, route), { code: "FORBIDDEN" });
});

test("missing, guessed, tampered, wrong-method/origin/direction/account and expired capabilities fail closed", async () => {
  const f = fixture();
  const plan = await issueDriveTransfer(f.env, f.env.REMINDERS_OWNER_ID, "download", f.id, f.hash, f.scope, { size: 17 });
  const route = driveTransferRoute(new URL(plan.url).pathname)!;
  for (const headers of [{}, { Authorization: `Bearer ${crypto.randomUUID()}` }, { ...plan.headers, Authorization: plan.headers.Authorization.slice(0, -7) + "AAAAAAA" }] as Record<string, string>[]) {
    await assert.rejects(authorizeDriveTransfer(new Request(plan.url, { headers }), f.env, route), { code: "FORBIDDEN" });
  }
  for (const request of [new Request(plan.url, { method: "POST", headers: plan.headers }), new Request(plan.url + "?token=guess", { headers: plan.headers }),
    new Request(plan.url, { headers: { ...plan.headers, origin: "https://other.example.test" } }),
    new Request(plan.url, { headers: { ...plan.headers, "sec-fetch-site": "cross-site" } }),
    new Request(plan.url.replace("transfer.example.test", "other.example.test"), { headers: plan.headers })]) {
    await assert.rejects(authorizeDriveTransfer(request, f.env, route), { code: "FORBIDDEN" });
  }
  await assert.rejects(authorizeDriveTransfer(new Request(plan.url, { headers: plan.headers }), f.env, { ...route, kind: "upload" }), { code: "FORBIDDEN" });
  await assert.rejects(authorizeDriveTransfer(new Request(plan.url, { headers: plan.headers }), { ...f.env, REMINDERS_OWNER_ID: "other-owner" }, route), { code: "FORBIDDEN" });
  const clock = Date.now;
  try {
    Date.now = () => plan.expiresAt + 1;
    await assert.rejects(authorizeDriveTransfer(new Request(plan.url, { headers: plan.headers }), f.env, route), { code: "FORBIDDEN" });
  } finally { Date.now = clock; }
});

test("unguessable transfer IDs confer no identity or general API access, and failures cannot be indexed or cached", async () => {
  const f = fixture();
  const plan = await issueDriveTransfer(f.env, f.env.REMINDERS_OWNER_ID, "download", f.id, f.hash, f.scope, { size: 17 });
  for (const headers of [{}, { "oai-authenticated-user-id": f.env.REMINDERS_OWNER_ID }, { "OAI-Sites-Authorization": plan.headers["OAI-Sites-Authorization"] }] as Record<string, string>[]) {
    const response = (await applicationRoute(new Request(plan.url, { headers }), f.env))!;
    assert.equal(response.status, 403);
    assert.match(response.headers.get("x-robots-tag")!, /noindex.*nofollow/);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  }
  const response = (await applicationRoute(new Request(f.env.APP_ORIGIN + "/api/connection", { headers: plan.headers }), f.env))!;
  assert.equal(response.status, 401);
  assert.equal(driveTransferRoute("/api/drive/transfers/download/guess"), null);
});
