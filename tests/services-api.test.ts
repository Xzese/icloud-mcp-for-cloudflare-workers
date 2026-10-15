import test from "node:test";
import assert from "node:assert/strict";
import { applicationRoute } from "../src/api/router.ts";
import { JobSQLiteD1 } from "./helpers/sqlite-d1.ts";
import { b64 } from "../src/crypto/bytes.ts";
import { DEFAULT_SERVICE_SETTINGS } from "../src/services/settings.ts";
import { AppError } from "../src/errors.ts";
import { AppleConnectionService } from "../src/auth/service.ts";
import { ConnectorFilterRepository } from "../src/persistence/connector-filters.ts";
import { CreateWorkflowService, createWorkflowAppleFacade } from "../src/reminders/create-workflow.ts";
import { listDuplicationAppleFacade } from "../src/reminders/list-duplication-apple.ts";

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
    assert.ok(!(await list()).includes("resolve_icloud_drive_folder_path"));
    assert.ok(!(await list()).includes("prepare_icloud_drive_upload"));
    assert.ok(!(await list()).includes("prepare_icloud_drive_download"));
    const newReadTools = ["get_reminder_view", "export_reminders", "get_reminder_filters", "run_reminder_filter", "inspect_reminder", "get_reminder_list_sections"];
    const newWriteTools = ["save_reminder_filter", "delete_reminder_filter", "create_reminder_workflow", "duplicate_reminder_list"];
    const initialTools = await list();
    const initialCatalog = (await request("/mcp", { jsonrpc: "2.0", id: 11, method: "tools/list", params: {} })).data.result.tools;
    const appearance = initialCatalog.find((tool: { name: string }) => tool.name === "update_reminder_list_appearance");
    assert.deepEqual(Object.keys(appearance.inputSchema.properties).sort(), ["colorPreset", "emoji", "expectedGeneration", "listId", "recordChangeTag"]);
    assert.equal(appearance.inputSchema.additionalProperties, false);
    assert.ok(appearance.inputSchema.required.includes("listId"));
    assert.ok(appearance.inputSchema.required.includes("recordChangeTag"));
    const invalidAppearance = await request("/mcp", { jsonrpc: "2.0", id: 12, method: "tools/call", params: {
      name: "update_reminder_list_appearance", arguments: { expectedGeneration: 0, listId: `List/${crypto.randomUUID().toUpperCase()}`, recordChangeTag: "synthetic-current" },
    } });
    assert.equal(invalidAppearance.data.result.isError, true);
    assert.equal(invalidAppearance.data.result.structuredContent.error_code, "VALIDATION_ERROR", "the service retains its at-least-one-change rule");


    assert.ok([...newReadTools, ...newWriteTools].every(name => initialTools.includes(name)));
    const apple = new AppleConnectionService(env, "test-owner"), filters = new ConnectorFilterRepository(env, "test-owner");
    const filterId = crypto.randomUUID();
    const filter = { filterId, name: "Synthetic view", definition: { view: "all" as const, timeZone: "UTC", sortBy: "title" as const, filters: { status: "open" as const } } };
    await filters.save(filter);
    const settings = { reminders: { enabled: false, read: false, write: false }, drive: { enabled: true, browse: true, contents: false, upload: true, organize: false } };
    assert.equal((await request("/api/settings", { expectedRevision: 0, settings })).status, 200);
    assert.equal((await request("/api/settings", { expectedRevision: 0, settings })).status, 409);
    const tools = await list();
    assert.ok(tools.includes("list_icloud_drive_items"));
    assert.ok(tools.includes("resolve_icloud_drive_folder_path"));
    assert.ok(tools.includes("upload_icloud_drive_file"));
    assert.ok(tools.includes("prepare_icloud_drive_upload"));
    assert.ok(!tools.includes("prepare_icloud_drive_download"));
    assert.ok(!tools.includes("get_reminders"));
    assert.ok(!tools.includes("read_icloud_drive_file"));
    assert.ok([...newReadTools, ...newWriteTools].every(name => !tools.includes(name)));
    for (const name of [...newReadTools, ...newWriteTools]) {
      const result = await request("/mcp", { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name, arguments: {} } });
      assert.ok(result.data.error || result.data.result?.isError, name);
    }
    const forbidden = (error: unknown) => error instanceof AppError && error.code === "FORBIDDEN";
    const listId = `List/${crypto.randomUUID().toUpperCase()}`, reminderId = `Reminder/${crypto.randomUUID().toUpperCase()}`;
    const collection = { ...filter.definition, referenceInstant: "2026-10-13T12:00:00Z" };
    await assert.rejects(apple.collectRemindersForMCP(collection, 0), forbidden);
    await assert.rejects(apple.readReminderListSectionsForMCP({ expectedGeneration: 0, listId }), forbidden);
    await assert.rejects(apple.readDuplicationList(0, listId), forbidden);
    await assert.rejects(filters.list(), forbidden);
    await assert.rejects(filters.get(filterId), forbidden);
    await assert.rejects(filters.save(filter), forbidden);
    await assert.rejects(filters.delete({ filterId, expectedRevision: 1 }), forbidden);
    const facade = createWorkflowAppleFacade(env, "test-owner", apple);
    await assert.rejects(facade.binding(), forbidden);
    await assert.rejects(new CreateWorkflowService(env, "test-owner", facade).run({}), forbidden);
    await assert.rejects(listDuplicationAppleFacade(env, "test-owner", apple), forbidden);
    assert.equal((await request("/api/reminders/inspect", { expectedGeneration: 0, listId, reminderId })).data.error.code, "FORBIDDEN");
    assert.equal((await request("/mcp", { jsonrpc: "2.0", id: 9, method: "tools/list", params: { padding: "x".repeat(70_000) } })).status, 413);
    const disabled = await request("/mcp", { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_reminders", arguments: {} } });
    assert.ok(disabled.data.error || disabled.data.result?.isError);
    assert.equal((await request("/api/drive/read", { itemId: "FILE::com.apple.CloudDocs::invented" })).data.error.code, "FORBIDDEN");
    const status = await request("/mcp", { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "connection_status", arguments: {} } });
    assert.equal(status.data.result?.isError, undefined, JSON.stringify(status.data));
    assert.equal(status.data.result.structuredContent.services.drive.ready, false);
    assert.equal(status.data.result.structuredContent.capabilities.standardSectionsRead, false);
    assert.ok([...newReadTools, ...newWriteTools].every(name => !status.data.result.structuredContent.mcpTools.includes(name)));
    const readOnlySettings = { ...settings, reminders: { enabled: true, read: true, write: false } };
    assert.equal((await request("/api/settings", { expectedRevision: 1, settings: readOnlySettings })).status, 200);
    const readOnlyTools = await list();
    assert.ok(newReadTools.every(name => readOnlyTools.includes(name)));
    assert.ok(newWriteTools.every(name => !readOnlyTools.includes(name)));
    assert.equal((await filters.get(filterId)).name, filter.name);
    await assert.rejects(filters.save(filter), forbidden);
    await assert.rejects(filters.delete({ filterId, expectedRevision: 1 }), forbidden);
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS count FROM apple_session_state").get()?.count, 0);
    assert.equal(sends, 0);
  } finally { globalThis.fetch = originalFetch; db.sqlite.close(); }
});
