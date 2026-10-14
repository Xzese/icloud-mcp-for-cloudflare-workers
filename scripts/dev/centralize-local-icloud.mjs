// Explicit local operator migration. Copies encrypted SQLite snapshots only;
// original session stores are retained and no Apple requests are made.
import { mkdir, readdir, writeFile, chmod, rename, lstat, realpath, rm, rmdir } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { DatabaseSync, backup } from "node:sqlite";
import { createConnection } from "node:net";
import { localKeys, localStateDirectory, localWorktrees, localPort, lockLocalState, resolveLocalStateRedirect } from "./local-icloud-state.mjs";

const inspect = path => lstat(path).catch(error => { if (error.code === "ENOENT") return null; throw error; });
const archived = path => `${path}.before-centralize-${Date.now()}-${randomUUID().slice(0, 8)}`;
async function databaseFile(directory) {
  const files = (await readdir(join(directory, "d1/miniflare-D1DatabaseObject"))).filter(name => name.endsWith(".sqlite") && name !== "metadata.sqlite");
  if (files.length !== 1) throw new Error("Select a private store with exactly one existing local session database.");
  return files[0];
}
function sessionRow(database, owner) {
  return database.prepare("SELECT generation, version, state, envelope, transaction_id, transaction_expires_at, resume_expires_at FROM apple_session_state WHERE owner_id = ? AND account_id = 'apple-reminders'").get(owner);
}

export async function centralizeLocalState(source, target, worktrees = []) {
  source = await realpath(resolveLocalStateRedirect(source)); target = resolveLocalStateRedirect(target);
  const keys = await localKeys(source);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const targetBefore = await inspect(target);
  if (targetBefore) target = await realpath(target);
  const sameDirectory = source === target;
  const locks = [];
  let stage, backupDirectory = null, imported = false;
  const aliases = [];
  try {
    for (const directory of [...new Set([source, target])].sort()) locks.push(lockLocalState(directory));
    let reuse = sameDirectory;
    if (targetBefore && !reuse) {
      const existingKeys = await localKeys(target);
      const existingFile = await databaseFile(target);
      const existing = new DatabaseSync(join(target, "d1/miniflare-D1DatabaseObject", existingFile), { readOnly: true });
      let row;
      try { row = sessionRow(existing, existingKeys.owner); } finally { existing.close(); }
      if (row?.envelope && ["READY", "DEVICE_APPROVAL_PENDING"].includes(row.state)) {
        if (existingKeys.owner !== keys.owner || existingKeys.key !== keys.key) throw new Error("The shared store already has a different connected session. It was not replaced.");
        reuse = true; // Never roll a working shared store back to an older copy.
      }
    }
    if (!reuse) {
      const filename = await databaseFile(source);
      const input = new DatabaseSync(join(source, "d1/miniflare-D1DatabaseObject", filename), { readOnly: true });
      try {
        const before = sessionRow(input, keys.owner);
        if (!before?.envelope || !["READY", "DEVICE_APPROVAL_PENDING"].includes(before.state)) throw new Error("The selected store has no retained connected session. No replacement login was created.");
        if (before.transaction_id || before.transaction_expires_at > Date.now() || before.resume_expires_at > Date.now()) throw new Error("Stop and drain the selected Worker's operations before centralizing its session.");
        stage = target + ".import-" + randomUUID();
        const databaseDirectory = join(stage, "d1/miniflare-D1DatabaseObject");
        await mkdir(databaseDirectory, { recursive: true, mode: 0o700 });
        await chmod(stage, 0o700); await chmod(join(stage, "d1"), 0o700);
        await writeFile(join(stage, "keys.json"), JSON.stringify(keys), { mode: 0o600, flag: "wx" });
        await backup(input, join(databaseDirectory, filename));
        await chmod(join(databaseDirectory, filename), 0o600);
        const snapshot = new DatabaseSync(join(databaseDirectory, filename), { readOnly: true });
        let after;
        try { after = sessionRow(snapshot, keys.owner); } finally { snapshot.close(); }
        if (after?.envelope !== before.envelope || after.generation !== before.generation || after.version !== before.version) throw new Error("The selected state changed while copying. Nothing was installed.");
        const metadata = join(source, "d1/miniflare-D1DatabaseObject/metadata.sqlite");
        if (await inspect(metadata)) {
          const database = new DatabaseSync(metadata, { readOnly: true });
          try { await backup(database, join(databaseDirectory, "metadata.sqlite")); } finally { database.close(); }
          await chmod(join(databaseDirectory, "metadata.sqlite"), 0o600);
        }
        const currentKeys = await localKeys(source);
        if (currentKeys.owner !== keys.owner || currentKeys.key !== keys.key) throw new Error("The selected key configuration changed while copying. Nothing was installed.");
      } finally { input.close(); }
      if (targetBefore) { backupDirectory = archived(target); await rename(target, backupDirectory); }
      else await rmdir(target); // Empty directory created solely for its sibling lock.
      try { await rename(stage, target); stage = null; imported = true; }
      catch (error) { if (backupDirectory) await rename(backupDirectory, target); throw error; }
    }
    for (const checkout of worktrees) {
      const alias = join(checkout, ".sites-runtime/local-icloud");
      if (resolve(alias) === target) continue;
      const current = await inspect(alias);
      if (current && resolveLocalStateRedirect(alias) !== resolve(alias) && await realpath(resolveLocalStateRedirect(alias)) === target) continue;
      if (current && !current.isDirectory() && !current.isSymbolicLink()) throw new Error("A legacy local-state path is not a directory. It was preserved.");
      await mkdir(dirname(alias), { recursive: true, mode: 0o700 });
      const canonicalAlias = current ? await realpath(alias) : null;
      const lock = current && !locks.some(held => held.directory === canonicalAlias) ? lockLocalState(alias) : null;
      const previous = current ? archived(alias) : null;
      let created = false;
      try {
        if (previous) await rename(alias, previous);
        try {
          await mkdir(alias, { mode: 0o700 });
          created = true;
          // Old launchers do not understand redirect markers. An intentionally
          // credential-free keys file prevents them from creating a fresh login
          // or opening a newer retained session with an incompatible loader.
          await writeFile(join(alias, "keys.json"), JSON.stringify({ sharedStateVersion: 1, upgradeLocalLauncher: true }), { mode: 0o600, flag: "wx" });
          await writeFile(join(alias, "shared-state.json"), JSON.stringify({ version: 1, directory: target }), { mode: 0o600, flag: "wx" });
        }
        catch (error) { if (created) await rm(alias, { recursive: true, force: true }); if (previous) await rename(previous, alias); throw error; }
        aliases.push({ path: alias, backup: previous });
      } finally { lock?.release(); }
    }
    return { directory: target, imported, backup: backupDirectory, aliases, appleRequests: 0 };
  } finally {
    if (stage) await rm(stage, { recursive: true, force: true });
    for (const lock of locks.reverse()) lock.release();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args[0] !== "--from" || !args[1] || args.length > 3 || args.length === 3 && args[2] !== "--link-worktrees") throw new Error("Use session:local:centralize -- --from <existing-private-state> [--link-worktrees].");
  const root = resolve(new URL("../..", import.meta.url).pathname);
  // Old launchers predate the state lock. Refuse migration while the default
  // local Worker is listening; do not invoke an old session loader to check it.
  await new Promise((done, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port: localPort() });
    socket.once("connect", () => { socket.destroy(); reject(new Error("Stop the local Worker and drain its operations before centralizing state.")); });
    socket.once("error", error => { socket.destroy(); if (error.code === "ECONNREFUSED") done(); else reject(error); });
    socket.setTimeout(3000, () => { socket.destroy(); reject(new Error("Cannot confirm the old local Worker is stopped.")); });
  });
  const result = await centralizeLocalState(resolve(args[1]), localStateDirectory(root, {}), args[2] ? localWorktrees(root) : []);
  console.log(JSON.stringify({ ...result, credentialsAndOriginalStoresPreserved: true }));
}
