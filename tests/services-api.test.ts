import test from "node:test";
import assert from "node:assert/strict";
import { applicationRoute } from "../src/api/router.ts";
import { JobSQLiteD1 } from "./helpers/sqlite-d1.ts";
import { b64 } from "../src/crypto/bytes.ts";
import { DEFAULT_SERVICE_SETTINGS } from "../src/services/settings.ts";

test("owner dashboard settings change MCP discovery and direct permission enforcement without Apple calls", async () => {
  const db = new JobSQLiteD1();
  const origin = "https://workspace.example";
  const env = { ...db.env(), LIVE_APPLE_CONNECTION_APPROVED: "controlled-device-v2", APPLE_CRYPTO_REVIEW_APPROVED: "device-proof-v2", APP_ORIGIN: origin, REMINDERS_OWNER_ID: "test-owner", ENCRYPTION_KEY_ID: "test", ENCRYPTION_KEYS_JSON: JSON.stringify({ test: b64(crypto.getRandomValues(new Uint8Array(32))) }) };
  const request = async (path: string, body?: unknown, user = "test-owner", requestOrigin = origin) => {
    const response = await applicationRoute(new Request(origin + path, {
      method: body === undefined ? "GET" : "POST", headers: { "oai-authenticated-user-id": user, origin: requestOrigin, "content-type": "application/json", accept: "application/json, text/event-stream" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), env);
    assert.ok(response);
    return { status: response.status, data: await response.json() as Record<string, any> }; // JSON-RPC has heterogeneous wire payloads.
  };
  let sends = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { sends++; throw new Error("Apple must not be contacted"); };
  try {
    assert.equal((await request("/api/settings", undefined, "another-owner")).status, 403);
    assert.equal((await request("/api/settings", { expectedRevision: 0, settings: DEFAULT_SERVICE_SETTINGS }, "test-owner", "https://other.example")).status, 403);
    const initial = await request("/api/settings");
    assert.deepEqual(initial.data.settings, DEFAULT_SERVICE_SETTINGS);
    const list = async () => (await request("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })).data.result.tools.map((tool: { name: string }) => tool.name) as string[];
    assert.ok((await list()).includes("get_reminders"));
    assert.ok(!(await list()).includes("list_icloud_drive_items"));
    const settings = { reminders: { enabled: false, read: false, write: false }, drive: { enabled: true, browse: true, contents: false, upload: true, organize: false } };
    assert.equal((await request("/api/settings", { expectedRevision: 0, settings })).status, 200);
    assert.equal((await request("/api/settings", { expectedRevision: 0, settings })).status, 409);
    const tools = await list();
    assert.ok(tools.includes("list_icloud_drive_items"));
    assert.ok(tools.includes("upload_icloud_drive_file"));
    assert.ok(!tools.includes("get_reminders"));
    assert.ok(!tools.includes("read_icloud_drive_file"));
    assert.equal((await request("/mcp", { jsonrpc: "2.0", id: 9, method: "tools/list", params: { padding: "x".repeat(70_000) } })).status, 413);
    const disabled = await request("/mcp", { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_reminders", arguments: {} } });
    assert.ok(disabled.data.error || disabled.data.result?.isError);
    assert.equal((await request("/api/drive/read", { itemId: "FILE::com.apple.CloudDocs::invented" })).data.error.code, "FORBIDDEN");
    const status = await request("/mcp", { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "connection_status", arguments: {} } });
    assert.equal(status.data.result?.isError, undefined, JSON.stringify(status.data));
    assert.equal(status.data.result.structuredContent.services.drive.ready, false);
    assert.equal(sends, 0);
  } finally { globalThis.fetch = originalFetch; db.sqlite.close(); }
});
