import { readFile, readdir, stat, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const root = process.cwd();
async function files(directory) {
  const out = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, item.name);
    if (item.isDirectory()) out.push(...await files(absolute));
    else if (item.isFile()) out.push(absolute);
    else throw new Error('Artifact contains a non-regular file.');
  }
  return out;
}
const secrets = [];
try {
  const local = await readFile(path.join(root, '.dev.vars'), 'utf8');
  const line = local.split('\n').find(x => x.startsWith('ENCRYPTION_KEYS_JSON='));
  if (line) {
    let value = line.slice(line.indexOf('=') + 1).trim();
    if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
    for (const key of Object.values(JSON.parse(value))) if (typeof key === 'string' && key.length >= 40) secrets.push(key);
  }
} catch (error) { if (error.code !== 'ENOENT') throw new Error('Cannot safely inspect local key configuration.'); }
const entries = [];
for (const absolute of (await files(path.join(root, 'dist'))).sort()) {
  const relative = path.relative(root, absolute).replaceAll(path.sep, '/');
  if (/(?:^|\/)(?:\.dev\.vars|\.env|node_modules|\.sites-runtime|\.wrangler)(?:\.|\/|$)/.test(relative)) throw new Error(`Excluded file in artifact: ${relative}`);
  const bytes = await readFile(absolute);
  const value = bytes.toString('utf8');
  if (secrets.some(key => value.includes(key))) throw new Error(`Local encryption key found in artifact: ${relative}`);
  if (relative.startsWith('dist/client/') && /synthetic-only-password|synthetic-device-code|ENCRYPTION_KEYS_JSON|local_seedy/.test(value)) throw new Error(`Server-only content in public asset: ${relative}`);
  entries.push({ path: relative, bytes: (await stat(absolute)).size, sha256: createHash('sha256').update(bytes).digest('hex') });
}
const config = JSON.parse(await readFile(path.join(root, 'dist/server/wrangler.json'), 'utf8'));
if (!config.d1_databases?.some(x => x.binding === 'DB') || !config.compatibility_flags?.includes('nodejs_compat')) throw new Error('Required runtime contract is missing.');
const hosting = JSON.parse(await readFile(path.join(root, '.openai/hosting.json'), 'utf8'));
if (hosting.d1 !== 'DB' || !hosting.capabilities?.includes('mcp')) throw new Error('Required Sites capabilities are missing.');
const schema = await readFile(path.join(root, 'schema.sql'), 'utf8');
const migration = await readFile(path.join(root, 'migrations/0001_reminder_jobs.sql'), 'utf8');
if (!schema.includes(migration.slice(migration.indexOf('CREATE TABLE')).trim())) throw new Error('Fresh-install and additive job schemas differ.');
const migrations = (await readdir(path.join(root, 'migrations'))).filter(file => /^\d{4}_[a-z0-9_]+\.sql$/.test(file)).sort();
if (JSON.stringify((await readdir(path.join(root, 'dist/.openai/drizzle'))).sort()) !== JSON.stringify(migrations)) throw new Error('Packaged Sites migration history is incomplete.');
for (const file of migrations) {
  if (await readFile(path.join(root, 'dist/.openai/drizzle', file), 'utf8') !== await readFile(path.join(root, 'migrations', file), 'utf8')) throw new Error(`Packaged migration differs from canonical source: ${file}`);
}
await mkdir(path.join(root, 'docs'), { recursive: true });
await writeFile(path.join(root, 'docs/artifact-manifest.json'), JSON.stringify({
  kind: 'local-production-build', compatibilityDate: config.compatibility_date,
  entrypoint: 'dist/server/index.js', sitesCapabilities: hosting.capabilities,
  appleConnectionImplemented: true, liveAppleValidated: false, liveFlagsConfiguredByBuild: false, schemaVersion: 4, jobExecutionMode: 'request-driven', linkedSchedulingEnabled: false, bulkDeletionEnabled: false, loginPolicy: 'device-only-v2', supportedLoginAssuranceVersions: [2, 3], retentionPolicy: 'absolute-30d-v1', maxLocalSessionLifetimeMs: 2_592_000_000, checks: ['local-key-exclusion', 'public-asset-boundary', 'binding-contract', 'additive-job-schema-parity'], files: entries,
}, null, 2) + '\n');
console.log(JSON.stringify({ result: 'passed', files: entries.length, bytes: entries.reduce((sum, x) => sum + x.bytes, 0), manifest: 'docs/artifact-manifest.json', deployed: false }));
