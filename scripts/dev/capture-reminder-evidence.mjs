import http from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

const origin = "http://127.0.0.1:5173";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const phases = ["initial", "before", "after", "completion-active", "completion-history", "next-before", "next-after"];
const reminderId = /^Reminder\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const usage = "Use seed|capture|compare|atomic-check --confirm-synthetic --case-id UUID; seed/capture/atomic-check require --list-name Test; capture requires --phase initial|before|after|completion-active|completion-history|next-before|next-after, with optional --reminder-id Reminder/UUID; compare requires --apple-app-confirmed and optionally --transition date|next-occurrence; atomic-check requires --confirm-version-guard-writes --dependency-type Alarm|AlarmTrigger|RecurrenceRule.";
const requireEvidence = (condition, message) => { if (!condition) throw new Error(message); };
export function parseEvidenceArgs(args) {
  const [command, ...options] = args;
  requireEvidence(["seed", "capture", "compare", "atomic-check"].includes(command), usage);
  const value = { command, confirmed: false, appleAppConfirmed: false };
  for (let index = 0; index < options.length; index++) {
    const option = options[index];
    if (option === "--confirm-synthetic" && !value.confirmed) value.confirmed = true;
    else if (option === "--apple-app-confirmed" && !value.appleAppConfirmed) value.appleAppConfirmed = true;
    else if (option === "--confirm-version-guard-writes" && value.confirmVersionGuardWrites === undefined) value.confirmVersionGuardWrites = true;
    else if (["--case-id", "--list-name", "--phase", "--reminder-id", "--transition", "--dependency-type"].includes(option)) {
      const key = { "--case-id": "caseId", "--list-name": "listName", "--phase": "phase", "--reminder-id": "reminderId", "--transition": "transition", "--dependency-type": "dependencyType" }[option];
      const next = options[++index];
      requireEvidence(value[key] === undefined && typeof next === "string" && !next.startsWith("--"), usage);
      value[key] = next;
    } else throw new Error(usage);
  }
  requireEvidence(value.confirmed && uuid.test(value.caseId ?? "") &&
    (command === "compare" ? value.appleAppConfirmed && !value.listName && !value.phase && !value.reminderId &&
      !value.confirmVersionGuardWrites && !value.dependencyType && (value.transition === undefined || ["date", "next-occurrence"].includes(value.transition)) :
      !value.appleAppConfirmed && value.transition === undefined && typeof value.listName === "string" && ["test", "mcp test"].includes(value.listName.toLowerCase()) &&
      (command === "atomic-check" ? value.confirmVersionGuardWrites === true && ["Alarm", "AlarmTrigger", "RecurrenceRule"].includes(value.dependencyType) &&
        value.phase === undefined && value.reminderId === undefined :
        !value.confirmVersionGuardWrites && value.dependencyType === undefined && (command === "capture" ?
          phases.includes(value.phase) && (value.reminderId === undefined || reminderId.test(value.reminderId)) :
          value.phase === undefined && value.reminderId === undefined))), usage);
  return { ...value, caseId: value.caseId.toLowerCase(), ...(value.reminderId ? { reminderId: value.reminderId } : {}),
    ...(value.transition ? { transition: value.transition } : {}), ...(value.dependencyType ? { dependencyType: value.dependencyType } : {}),
    ...(value.confirmVersionGuardWrites ? { confirmVersionGuardWrites: true } : {}) };
}

export function compareEvidence(before, after) {
  requireEvidence(before?.schemaVersion === 1 && after?.schemaVersion === 1 && before.caseId === after.caseId &&
    before.generation === after.generation && before.source === "live-apple-api" && after.source === "live-apple-api" &&
    before.explicitlyReferencedRecordsResolved === true && after.explicitlyReferencedRecordsResolved === true &&
    after.capturedAt > before.capturedAt && Array.isArray(before.records) && Array.isArray(after.records), "Before/after evidence must belong to the same case and unchanged session generation.");
  const old = new Map(before.records.map(record => [record.recordName, record]));
  const fresh = new Map(after.records.map(record => [record.recordName, record]));
  requireEvidence(old.size === before.records.length && fresh.size === after.records.length && old.size > 0 && fresh.size > 0, "Evidence has missing or duplicated identities.");
  requireEvidence([...old].some(([id, record]) => record.recordType === "Reminder" && fresh.get(id)?.recordType === "Reminder"), "Evidence has no stable synthetic reminder identity.");
  if (before.rootRecordName || after.rootRecordName) {
    requireEvidence(before.rootRecordName === after.rootRecordName && old.get(before.rootRecordName)?.recordType === "Reminder" &&
      fresh.get(after.rootRecordName)?.recordType === "Reminder", "Evidence changed its exact root identity; no implicit occurrence redirection is allowed.");
  }
  const canonical = value => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
    return value;
  };
  const changed = [];
  for (const [id, record] of fresh) {
    const previous = old.get(id);
    if (!previous) continue;
    const fields = [...new Set([...Object.keys(previous.fields), ...Object.keys(record.fields)])].sort().filter(field =>
      JSON.stringify(canonical(previous.fields[field])) !== JSON.stringify(canonical(record.fields[field])));
    if (fields.length || previous.recordChangeTag !== record.recordChangeTag) changed.push({ recordName: id, recordType: record.recordType, versionChanged: previous.recordChangeTag !== record.recordChangeTag, fields });
  }
  return { schemaVersion: 1, caseId: before.caseId, generation: before.generation, appleAppVerified: true, writableRecipeApproved: false,
    added: [...fresh.keys()].filter(id => !old.has(id)), removedOrUnlinked: [...old.keys()].filter(id => !fresh.has(id)), changed,
    beforeEdges: before.edges, afterEdges: after.edges,
    blockers: ["Review recurrence anchors, alarm semantics and nonce derivation; aliases establish equality, not their meaning.",
      "Establish commit-time version protection for unchanged dependencies and non-parent safety before enabling writes."] };
}

async function localClient() {
  const cookie = await new Promise((resolveCookie, reject) => {
    const request = http.get(origin, { headers: { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" } }, response => {
      response.resume(); response.on("end", () => {
        const value = response.headers["set-cookie"]?.find(item => item.startsWith("local-icloud="))?.split(";")[0];
        if (response.statusCode !== 200 || !value) reject(new Error("Open the authenticated local Worker first."));
        else resolveCookie(value);
      });
    });
    request.setTimeout(5000, () => request.destroy(new Error("Local Worker timed out.")));
    request.on("error", reject);
  });
  return async (path, body) => {
    const response = await fetch(origin + path, { headers: { cookie, ...(body ? { origin, "content-type": "application/json", accept: "application/json, text/event-stream" } : {}) },
      ...(body ? { method: "POST", body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(45_000) });
    const value = await response.json();
    if (!response.ok || value.result?.isError) {
      const error = value.error ?? value.result?.structuredContent?.error;
      throw new Error(`${error?.code ?? "EVIDENCE_READ_FAILED"}: ${error?.message ?? "The local evidence request failed; no automatic retry."}`);
    }
    return value;
  };
}

export async function runEvidence(options) {
  const directory = resolve(".sites-runtime/reminder-evidence", options.caseId);
  if (options.command === "compare") {
    requireEvidence(options.transition === undefined || ["date", "next-occurrence"].includes(options.transition), usage);
    const prefix = options.transition === "next-occurrence" ? "next-" : "";
    const before = JSON.parse(await readFile(join(directory, `${prefix}before.json`), "utf8"));
    const after = JSON.parse(await readFile(join(directory, `${prefix}after.json`), "utf8"));
    const report = compareEvidence(before, after);
    requireEvidence(report.caseId === options.caseId, "The evidence case does not match its directory.");
    await writeFile(join(directory, `${prefix}comparison.json`), JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    return { result: "compared", caseId: options.caseId, transition: options.transition ?? "date", changedRecords: report.changed.length, recipeApproved: false };
  }
  const call = await localClient();
  const status = await call("/api/connection");
  requireEvidence(status.state === "READY", "The retained Apple session must be READY; do not replace it.");
  const invoke = async (name, args) => (await call("/mcp", { jsonrpc: "2.0", id: randomUUID(), method: "tools/call", params: { name, arguments: args } })).result.structuredContent;
  const lists = await invoke("get_reminder_lists", { expectedGeneration: status.generation });
  const candidates = lists.records.filter(list => list.title === options.listName && !list.deleted && !list.isGroup);
  requireEvidence(lists.complete && candidates.length === 1, "Select exactly one available dedicated test list from a complete list read.");
  const listId = candidates[0].id, title = `MCP protocol ${options.caseId}`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (options.command === "seed") {
    // Persist the deterministic create key before dispatch; rerunning never allocates a replacement.
    const input = { listId, expectedGeneration: status.generation, idempotencyKey: options.caseId, title, notes: "Synthetic protocol evidence case. Keep until before/after capture is complete." };
    try { await writeFile(join(directory, "seed.json"), JSON.stringify({ caseId: options.caseId, generation: status.generation }) + "\n", { flag: "wx", mode: 0o600 }); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
    const retained = JSON.parse(await readFile(join(directory, "seed.json"), "utf8"));
    requireEvidence(retained.generation === status.generation && retained.caseId === options.caseId, "The synthetic seed belongs to a different retained session.");
    const result = await invoke("create_reminder", input);
    requireEvidence(result.record?.id === `Reminder/${options.caseId.toUpperCase()}` && result.record.title === title, "The synthetic create was not confirmed; reconcile this exact case ID without retrying new keys.");
    return { result: "seeded", caseId: options.caseId, title, next: "In Apple Reminders, configure this synthetic item's baseline recurrence/alarm before capturing before.json. Do not rename it." };
  }
  if (options.command === "atomic-check") {
    requireEvidence(options.confirmVersionGuardWrites === true && ["Alarm", "AlarmTrigger", "RecurrenceRule"].includes(options.dependencyType), usage);
    const retained = JSON.parse(await readFile(join(directory, "seed.json"), "utf8"));
    requireEvidence(retained.generation === status.generation && retained.caseId === options.caseId, "Use the retained synthetic case in the same session.");
    const input = { listId, expectedGeneration: status.generation, caseId: options.caseId, reminderId: `Reminder/${options.caseId.toUpperCase()}`,
      dependencyType: options.dependencyType, confirmVersionGuardWrites: true };
    // Exclusive reservation prevents automatically replaying a dispatched experiment.
    await writeFile(join(directory, `atomic-marker-${options.dependencyType}-intent.json`), JSON.stringify(input, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    const report = await call("/api/reminder-evidence/atomic-protection", input);
    requireEvidence(report.caseId === options.caseId && report.generation === status.generation && report.dependencyType === options.dependencyType &&
      report.validGuardAccepted === true && report.staleGuardRejected === true && report.groupFieldsAndVersionsUnchangedAfterRejection === true &&
      report.writableRecipeApproved === false, "The atomic experiment was not confirmed; stop without replaying it.");
    const afterStatus = await call("/api/connection");
    requireEvidence(afterStatus.generation === status.generation && afterStatus.expiresAt === status.expiresAt, "Atomic evidence changed the session generation or fixed expiry.");
    await writeFile(join(directory, `atomic-marker-${options.dependencyType}.json`), JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    return { result: "atomic-protection-verified", ...report };
  }
  requireEvidence(phases.includes(options.phase) && (options.reminderId === undefined || reminderId.test(options.reminderId)), usage);
  const snapshot = await call("/api/reminder-evidence/capture", { listId, expectedGeneration: status.generation, caseId: options.caseId, reminderId: options.reminderId ?? `Reminder/${options.caseId.toUpperCase()}` });
  requireEvidence(snapshot.caseId === options.caseId && snapshot.generation === status.generation && snapshot.writableGraphProven === false, "The evidence response does not match this controlled case.");
  const afterStatus = await call("/api/connection");
  requireEvidence(afterStatus.generation === status.generation && afterStatus.expiresAt === status.expiresAt, "Capture changed the session generation or fixed expiry.");
  await writeFile(join(directory, `${options.phase}.json`), JSON.stringify(snapshot, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  return { result: "captured", phase: options.phase, caseId: options.caseId, records: snapshot.records.length, writesPerformed: false, writableGraphProven: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await runEvidence(parseEvidenceArgs(process.argv.slice(2))))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
