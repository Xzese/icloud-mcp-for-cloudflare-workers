// Private development state only; never imported by an application bundle.
import { execFileSync } from "node:child_process";
import { mkdir, chmod, readFile, writeFile, realpath, readdir, stat } from "node:fs/promises";
import { mkdirSync, chmodSync, realpathSync, readFileSync } from "node:fs";
import { resolve, join, isAbsolute } from "node:path";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export function localWorktrees(root) {
  let output;
  try { output = execFileSync("git", ["worktree", "list", "--porcelain", "-z"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); }
  catch { throw new Error("Cannot locate the shared Git checkout. Set LOCAL_ICLOUD_STATE_DIR to an existing private state directory."); }
  const paths = output.split("\0").filter(value => value.startsWith("worktree ")).map(value => value.slice(9));
  if (!paths.length || paths.some(value => !isAbsolute(value))) throw new Error("Git returned an unsupported worktree layout.");
  return paths;
}

/** @param {string} root @param {{LOCAL_ICLOUD_STATE_DIR?: string}} environment */
export function localStateDirectory(root, environment = process.env) {
  const directory = environment.LOCAL_ICLOUD_STATE_DIR
    ? resolve(root, environment.LOCAL_ICLOUD_STATE_DIR)
    : join(localWorktrees(root)[0], ".sites-runtime/shared-local-icloud");
  return resolveLocalStateRedirect(directory);
}

export function resolveLocalStateRedirect(directory) {
  const seen = new Set();
  for (let hop = 0; hop < 8; hop++) {
    directory = resolve(directory);
    if (seen.has(directory)) throw new Error("The shared local-state redirect contains a loop.");
    seen.add(directory);
    let marker;
    try { marker = JSON.parse(readFileSync(join(directory, "shared-state.json"), "utf8")); }
    catch (error) { if (error.code === "ENOENT") return directory; throw new Error("The shared local-state redirect is malformed."); }
    if (marker?.version !== 1 || typeof marker.directory !== "string" || !isAbsolute(marker.directory)) throw new Error("The shared local-state redirect is invalid.");
    directory = marker.directory;
  }
  throw new Error("The shared local-state redirect exceeded its bound.");
}

/** @param {{LOCAL_ICLOUD_PORT?: string}} environment */
export function localPort(environment = process.env) {
  const port = Number(environment.LOCAL_ICLOUD_PORT ?? "5173");
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("LOCAL_ICLOUD_PORT must be an unprivileged TCP port.");
  return port;
}

export async function localKeys(directory) {
  directory = resolveLocalStateRedirect(directory);
  let keys;
  try { keys = JSON.parse(await readFile(join(directory, "keys.json"), "utf8")); }
  catch { throw new Error("The existing local keys are unavailable or malformed. No replacement login was created."); }
  if (!keys || typeof keys.owner !== "string" || !/^local-[a-f0-9]{32}$/.test(keys.owner) ||
      typeof keys.key !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(keys.key) || Buffer.from(keys.key, "base64").length !== 32) {
    throw new Error("Invalid local key configuration. No credentials were replaced.");
  }
  return keys;
}

export function lockLocalState(directory) {
  // A separate SQLite transaction supplies an OS-backed, cross-process lock.
  // Crashes release it automatically. Its sibling path survives state-directory
  // migration, and realpath makes legacy symlink aliases share the same lock.
  directory = resolveLocalStateRedirect(directory);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const canonical = realpathSync(directory);
  const filename = canonical + ".worker-lock.sqlite";
  const database = new DatabaseSync(filename);
  chmodSync(filename, 0o600);
  try { database.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE;"); }
  catch (error) {
    database.close();
    if (error.errcode === 5 || error.errcode === 6 || /database (?:table )?is locked/i.test(error.message)) {
      throw new Error("This local Apple session is already in use. Reuse its running Worker, or stop it before starting another checkout or migration.");
    }
    throw error;
  }
  let released = false;
  return { directory: canonical, release() {
    if (released) return;
    released = true;
    try { database.exec("ROLLBACK;"); } finally { database.close(); }
  } };
}

/** @param {string} root @param {{LOCAL_ICLOUD_STATE_DIR?: string}} environment */
export async function openLocalState(root, environment = process.env) {
  const requested = localStateDirectory(root, environment);
  if (environment.LOCAL_ICLOUD_STATE_DIR) await localKeys(requested);
  else {
    const exists = async filename => stat(filename).then(() => true).catch(error => { if (error.code === "ENOENT") return false; throw error; });
    if (!await exists(join(requested, "keys.json"))) {
      for (const checkout of localWorktrees(root)) {
        if (await exists(join(checkout, ".sites-runtime/local-icloud/keys.json"))) {
          throw new Error("Existing local Apple state was found. Run session:local:centralize with its private directory first; no replacement login was created.");
        }
      }
      const entries = await readdir(requested).catch(error => { if (error.code === "ENOENT") return []; throw error; });
      if (entries.length) throw new Error("The shared local store exists without its encryption keys. Its state was preserved; no replacement login was created.");
    }
  }
  await mkdir(requested, { recursive: true, mode: 0o700 });
  const directory = await realpath(requested);
  await chmod(directory, 0o700);
  const lock = lockLocalState(directory);
  try {
    const config = join(directory, "keys.json");
    try { await writeFile(config, JSON.stringify({ owner: `local-${randomBytes(16).toString("hex")}`, key: randomBytes(32).toString("base64") }), { flag: "wx", mode: 0o600 }); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
    await chmod(config, 0o600);
    return { directory, keys: await localKeys(directory), release: lock.release };
  } catch (error) { lock.release(); throw error; }
}
