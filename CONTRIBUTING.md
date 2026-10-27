# Contributing

Thank you for helping improve `icloud-reminders-mcp-server`.

## Development

Use Node.js 24 or later. Fork the repository, create a focused branch and install the locked dependencies:

```bash
npm run install:ci
node scripts/setup/create-local-env.mjs
npm run build
npm run db:setup:local
npm run dev
```

The local preview leaves live Apple login disabled. Tests use invented protocol fixtures. Do not
use a real Apple account in CI or add live credentials to fixtures. Run the opt-in live launcher
only on your own controlled account after reviewing its login and retention policy.

Keep real credentials and deployment identifiers out of commits. `wrangler.toml` and
`.openai/hosting.json` are public templates. Use ignored `wrangler.production.toml` for standalone
deployments; Sites registration supplies a new project's private identifier. Protect the D1 build
variable for repository builds. Generated configs, databases, diagnostics and encryption keys are
not source artifacts.

Before opening a pull request, run:

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm run test:worker
npm run test:local
npm run verify:artifact
npm run public-config:check
npm run build:check
```

The last command checks the standalone bundle without deploying it. Run `npm run build` again
before using the Sites/local live runner. Follow the README for each deployment's separate
identity and provisioning requirements.

`npm run lint` uses Oxlint with TypeScript 7. `.oxlintrc.json` carries the former Next.js,
React, accessibility and TypeScript rule severities, generated-file exclusions, and synthetic-test
and vendored-UI exceptions. Native rules handle most checks. The official Next.js plugin retains
relative-location assignment checks and route-aware HTML-link checks, so the dedicated Apple
credential document still uses full-page navigation. The React plugin retains deprecated-API
checks through Oxlint's JavaScript plugin bridge; ESLint is not run as a fallback. JSX usage is
handled by the native unused-variable rule, and React Compiler options use Oxlint's fixed defaults.
The lint toolchain tests exercise these checks with synthetic valid and invalid sources.

Run the CI-pinned Gitleaks version against the public history before pushing. For a checkout
with local orchestration/checkpoint refs, scan `HEAD` and the public remote refs rather than
those private refs: `gitleaks git . --log-opts='--remotes=origin HEAD' --redact=100 --no-banner`.
Use runtime-generated UUIDs for synthetic idempotency keys where possible, retaining each
key throughout its test. Any historical false-positive exception must identify the invented
value, exact file and rule; default secret detection stays enabled.

MCP tool names, schemas, annotations, continuations and structured outputs are public interfaces.
Changes should be intentional, documented and covered by representative behavioural tests.
Preserve generation fencing, encrypted owner-bound storage, request bounds and fail-closed
protocol handling. Create/edit changes must preserve the ready Apple session requirement, exact target lookups,
change-tag conflicts and uncertain-outcome recovery. Do not expand mutation scope or weaken
authentication incidentally. Use only synthetic write responses in CI; live validation requires
a dedicated test reminder and explicit operator opt-in.

Keep the current database definition in `schema.sql` and use native D1 prepared statements.
Local setup uses that file. Sites packages the immutable numbered SQL history from `migrations/`;
append a migration when changing an installed schema rather than rewriting an applied initializer.
If changing a schema already in use, document how operators upgrade their existing databases.

Keep application code under `src/`, including the dashboard in `src/app/` and shared UI/helpers
in `src/components/`, `src/hooks/` and `src/lib/`. `@/` resolves to `src/`. Build plugins belong in
`scripts/build/`; group operational scripts under `scripts/setup/`, `scripts/dev/`,
`scripts/deploy/` and `scripts/release/`. Shared tool helpers belong in `scripts/lib/`.
Keep behavioural tests in `tests/`, built Worker acceptance runners in `tests/integration/`,
and synthetic vectors and their generator in `tests/fixtures/`.

## Pull requests

Keep changes narrow, explain the user impact and describe the checks you ran. Add tests for
behaviour changes using synthetic inputs. Do not include reminder contents, account identifiers,
passwords, tokens, signed asset links, private screenshots or generated deployment configuration.
Report suspected vulnerabilities privately as described in SECURITY.md rather than a public issue.

The four required CI checks cover lint/types/unit tests, the Sites Worker and local transport,
the standalone Cloudflare Worker, and public configuration/full-history secret scanning.
They use synthetic inputs and require no Apple or deployment secrets. Keep each check passing
and resolve review conversations before merging. For contributor PRs, **Enable auto-merge** is
an explicit choice. Merged head branches are deleted automatically.

Dependabot combines weekly npm and GitHub Actions version updates, including major upgrades,
into one PR. Its workflow enables squash auto-merge for this repository's Dependabot PRs;
all four protected-branch checks must pass against an up-to-date branch, and conversations must
be resolved. Failed checks remain blocked. Keep the write-token workflow free of PR checkouts,
installs or scripts from PR branches. Security fixes are grouped separately per ecosystem and
use the same merge gates without waiting for the weekly version-update schedule.

The acceptance runners and local launcher use the explicitly declared Miniflare 4 API and
Undici dependencies. Keep Miniflare major upgrades in a reviewed migration rather than
implicitly inheriting Wrangler's internal version. Builds refresh dependency inventories and
third-party notices automatically from the lockfile and installed packages; include refreshed
snapshots in the dependency PR when updating packages. `npm run notices:generate` also refreshes
them without building. Generated notices do not require a separate PR.

Miniflare's temporary security overrides apply to dependency requirements that intersect
the affected Sharp `<0.35.5` and Undici `>=7.0.0 <7.30.1` ranges. They allow patched releases
within Sharp `0.35.x` and Undici `7.x`, with minimum versions `0.35.5` and `7.30.1`.
When an updated Miniflare requests a patched-only range or a newer major, that requirement
does not match the override and resolves normally. npm matches the original requirement's
range, so a broad range that still includes vulnerable versions remains overridden.

Dependabot continues to propose parent-package updates and security updates. It does not
reliably rewrite these nested overrides: a future fix outside the allowed ranges needs a
reviewed override change or a compatible parent update. Check failed Dependabot update jobs
as well as open PRs when an alert remains unresolved. Remove each workaround once all
Miniflare copies require safe versions without it. Regenerate the lockfile and verify every
installed Sharp and Undici copy, including Wrangler and Vite's nested dependencies, before
merging a dependency update. `npm ci` retains the reviewed lockfile versions until an update
changes the lockfile.

Preserve upstream attribution and license notices when changing protocol or vendored code.
Fixture regeneration is optional: the checked-in vectors in `tests/fixtures/` are sufficient to run CI. To regenerate,
install the pinned Python packages listed in provenance/sources.json, check out its pinned pyicloud
revision, and pass that checkout explicitly to `python3 tests/fixtures/generate.py <checkout>`.
Never substitute a live capture for an invented fixture.

By contributing, you agree that your contribution is licensed under the MIT License.
