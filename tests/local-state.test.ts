import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, realpath, lstat, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes, randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import filesystem from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { localStateDirectory, localKeys, openLocalState, lockLocalState, resolveLocalStateRedirect } from "../scripts/dev/local-icloud-state.mjs";
import { centralizeLocalState } from "../scripts/dev/centralize-local-icloud.mjs";

async function temporary(t: { after: (fn: () => Promise<unknown>) => void }) {
  const path = await realpath(await mkdtemp(join(tmpdir(), "icloud-shared-state-")));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}
function git(directory: string, ...args: string[]) {
  return execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid", ...args], { cwd: directory, stdio: ["ignore", "pipe", "pipe"] });
}

test("linked Git worktrees resolve and initialize one shared key store, with explicit isolation available", async t => {
  const temp = await temporary(t), main = join(temp, "main checkout"), branch = join(temp, "linked checkout");
  await mkdir(main); git(main, "init"); await writeFile(join(main, "README.md"), "synthetic\n");
  git(main, "add", "README.md"); git(main, "commit", "-m", "Synthetic source"); git(main, "worktree", "add", "--detach", branch, "HEAD");
  const state = join(main, ".sites-runtime/shared-local-icloud");
  assert.equal(localStateDirectory(main, {}), state);
  assert.equal(localStateDirectory(branch, {}), state);
  const legacy = join(branch, ".sites-runtime/local-icloud");
  await mkdir(legacy, { recursive: true });
  await writeFile(join(legacy, "keys.json"), "{}");
  await assert.rejects(openLocalState(main, {}), /Existing local Apple state was found/);
  await assert.rejects(lstat(state), { code: "ENOENT" });
  await rm(legacy, { recursive: true });
  const first = await openLocalState(branch, {});
  const keys = first.keys; first.release();
  const second = await openLocalState(main, {});
  assert.deepEqual(second.keys, keys); second.release();
  const missing = join(temp, "isolated");
  assert.equal(localStateDirectory(branch, { LOCAL_ICLOUD_STATE_DIR: missing }), missing);
  await assert.rejects(openLocalState(branch, { LOCAL_ICLOUD_STATE_DIR: missing }), /No replacement login/);
  await assert.rejects(lstat(missing), { code: "ENOENT" });
});

test("shared-state locks cover symlink aliases and are released on process failure", async t => {
  const temp = await temporary(t), state = join(temp, "state"), alias = join(temp, "alias");
  const lock = lockLocalState(state);
  await symlink(state, alias, "dir");
  assert.throws(() => lockLocalState(alias), /already in use/);
  lock.release(); lock.release();
  const stateModule = new URL("../scripts/dev/local-icloud-state.mjs", import.meta.url).href;
  const child = spawn(process.execPath, ["--input-type=module", "-e", `import {lockLocalState} from ${JSON.stringify(stateModule)}; const held=lockLocalState(process.argv[1]); process.on('exit',held.release); process.stdout.write('ready'); setInterval(()=>{},1000);`, state], { stdio: ["ignore", "pipe", "pipe"] });
  try {
    await once(child.stdout!, "data");
    assert.throws(() => lockLocalState(state), /already in use/);
    const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
    const restored = lockLocalState(alias); restored.release();
  } finally { child.kill(); }
});

test("startup uses the locked store when centralization installs a redirect during initialization", async t => {
  const temp = await temporary(t), legacy = join(temp, "legacy"), shared = join(temp, "shared");
  await mkdir(legacy); await mkdir(shared);
  const keys = () => ({ owner: `local-${Buffer.from(randomBytes(16)).toString("hex")}`, key: Buffer.from(randomBytes(32)).toString("base64") });
  const original = keys(), selected = keys();
  await writeFile(join(legacy, "keys.json"), JSON.stringify(original));
  await writeFile(join(shared, "keys.json"), JSON.stringify(selected));
  const chmod = filesystem.chmod;
  filesystem.chmod = async (path, mode) => {
    await chmod(path, mode);
    if (path === legacy) {
      await writeFile(join(legacy, "keys.json"), JSON.stringify({ sharedStateVersion: 1, upgradeLocalLauncher: true }));
      await writeFile(join(legacy, "shared-state.json"), JSON.stringify({ version: 1, directory: shared }));
    }
  };
  syncBuiltinESMExports();
  let opened: Awaited<ReturnType<typeof openLocalState>> | undefined;
  try {
    opened = await openLocalState(temp, { LOCAL_ICLOUD_STATE_DIR: legacy });
    assert.equal(opened.directory, shared);
    assert.deepEqual(opened.keys, selected);
    assert.throws(() => lockLocalState(shared), /already in use/);
  } finally {
    opened?.release(); filesystem.chmod = chmod; syncBuiltinESMExports();
  }
});

test("malformed or looping legacy redirects cannot create replacement credentials", async t => {
  const temp = await temporary(t), first = join(temp, "first"), second = join(temp, "second");
  await mkdir(first); await mkdir(second);
  await writeFile(join(first, "shared-state.json"), JSON.stringify({ version: 1, directory: second }));
  await writeFile(join(second, "shared-state.json"), JSON.stringify({ version: 1, directory: first }));
  await assert.rejects(openLocalState(temp, { LOCAL_ICLOUD_STATE_DIR: first }), /redirect contains a loop/);
  await writeFile(join(first, "shared-state.json"), JSON.stringify({ version: 1, directory: "relative" }));
  await assert.rejects(openLocalState(temp, { LOCAL_ICLOUD_STATE_DIR: first }), /redirect is invalid/);
  await assert.rejects(lstat(join(first, "keys.json")), { code: "ENOENT" });
});

async function store(directory: string, state = "READY") {
  const owner = `local-${Buffer.from(randomBytes(16)).toString("hex")}`, key = Buffer.from(randomBytes(32)).toString("base64");
  await mkdir(join(directory, "d1/miniflare-D1DatabaseObject"), { recursive: true, mode: 0o700 });
  await writeFile(join(directory, "keys.json"), JSON.stringify({ owner, key }), { mode: 0o600 });
  const file = join(directory, "d1/miniflare-D1DatabaseObject/synthetic.sqlite");
  const database = new DatabaseSync(file);
  database.exec("PRAGMA journal_mode=WAL; CREATE TABLE apple_session_state(owner_id TEXT, account_id TEXT, state TEXT, generation INTEGER, version INTEGER, envelope TEXT, transaction_id TEXT, transaction_expires_at INTEGER, resume_expires_at INTEGER);");
  const envelope = state === "READY" ? JSON.stringify({ ciphertext: `synthetic-${randomUUID()}` }) : null;
  database.prepare("INSERT INTO apple_session_state VALUES (?, 'apple-reminders', ?, 3, 7, ?, NULL, NULL, NULL)").run(owner, state, envelope);
  return { database, owner, key, envelope, file };
}

test("centralization snapshots WAL state, preserves previous stores and links legacy worktree defaults", async t => {
  const temp = await temporary(t), main = join(temp, "main"), linked = join(temp, "linked"), fresh = join(temp, "fresh");
  const source = join(linked, ".sites-runtime/local-icloud"), target = join(main, ".sites-runtime/shared-local-icloud");
  const selected = await store(source), previous = await store(target, "DISCONNECTED");
  const oldKeys = await readFile(join(target, "keys.json"), "utf8"); previous.database.close();
  try {
    const result = await centralizeLocalState(source, target, [main, linked, fresh]);
    assert.equal(result.imported, true); assert.equal(result.appleRequests, 0);
    assert.equal(await readFile(join(result.backup!, "keys.json"), "utf8"), oldKeys);
    assert.deepEqual(await localKeys(target), { owner: selected.owner, key: selected.key });
    const imported = new DatabaseSync(join(target, "d1/miniflare-D1DatabaseObject/synthetic.sqlite"), { readOnly: true });
    assert.equal(imported.prepare("SELECT envelope FROM apple_session_state").get()!.envelope, selected.envelope); imported.close();
    assert.equal(selected.database.prepare("SELECT envelope FROM apple_session_state").get()!.envelope, selected.envelope);
    assert.equal(resolveLocalStateRedirect(source), await realpath(target));
    assert.equal(resolveLocalStateRedirect(join(fresh, ".sites-runtime/local-icloud")), await realpath(target));
    assert.deepEqual(await localKeys(source), { owner: selected.owner, key: selected.key });
    const legacyKeys = JSON.parse(await readFile(join(source, "keys.json"), "utf8"));
    assert.equal(legacyKeys.owner, undefined); assert.equal(legacyKeys.key, undefined);
    assert.equal(/^local-[a-f0-9]{32}$/.test(legacyKeys.owner), false, "Older launchers fail their key guard before accessing the retained session.");
    const redirected = await openLocalState(linked, { LOCAL_ICLOUD_STATE_DIR: source });
    assert.equal(redirected.directory, await realpath(target));
    assert.deepEqual(redirected.keys, { owner: selected.owner, key: selected.key }); redirected.release();
    assert.ok(result.aliases.find(alias => alias.path === source)?.backup);
    const repeated = await centralizeLocalState(source, target, [main, linked, fresh]);
    assert.equal(repeated.imported, false); assert.equal(repeated.backup, null); assert.equal(repeated.aliases.length, 0);
  } finally { selected.database.close(); }
});

test("centralization refuses active stores and a different connected target without overwriting keys", async t => {
  const temp = await temporary(t), source = join(temp, "source"), target = join(temp, "target");
  const selected = await store(source), existing = await store(target);
  selected.database.close(); existing.database.close();
  const before = await readFile(join(target, "keys.json"), "utf8");
  const held = lockLocalState(target);
  await assert.rejects(centralizeLocalState(source, target), /already in use/);
  held.release();
  await assert.rejects(centralizeLocalState(source, target), /different connected session/);
  assert.equal(await readFile(join(target, "keys.json"), "utf8"), before);
  const lock = lockLocalState(source); lock.release();
});
