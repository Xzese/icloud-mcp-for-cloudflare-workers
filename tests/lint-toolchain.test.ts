import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const linter = path.join(root, "node_modules/oxlint/bin/oxlint");

function lint(source: string, parent = "src", filename = "example.tsx") {
  const directory = mkdtempSync(path.join(tmpdir(), "reminders-lint-check-"));
  try {
    // Keep transient canaries outside public source directories: the source
    // packaging tests enumerate and copy those directories concurrently.
    copyFileSync(path.join(root, ".oxlintrc.json"), path.join(directory, ".oxlintrc.json"));
    symlinkSync(path.join(root, "node_modules"), path.join(directory, "node_modules"), "junction");
    mkdirSync(path.join(directory, "src/app"), { recursive: true });
    writeFileSync(path.join(directory, "src/app/page.tsx"), "export default function Page() { return <main />; }");
    mkdirSync(path.join(directory, parent), { recursive: true });
    const file = path.join(directory, parent, filename);
    writeFileSync(file, source);
    const result = spawnSync(process.execPath, [linter, "--no-ignore", "--deny-warnings", "--format=json", file], {
      cwd: directory, encoding: "utf8", timeout: 30_000,
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    const diagnostics = (JSON.parse(result.stdout) as { diagnostics: { code: string }[] }).diagnostics;
    return { status: result.status, diagnostics, output: result.stdout + result.stderr };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("the TypeScript 7 lint setup retains TypeScript, React, accessibility and Next.js checks", () => {
  const cases = [
    { rule: "no-explicit-any", source: "export const value: any = 1;" },
    { rule: "rules-of-hooks", source: 'import { useState } from "react"; export function Example({ enabled }: { enabled: boolean }) { if (enabled) { useState(0); } return <div />; }' },
    { rule: "alt-text", source: 'export function Example() { return <img src="https://example.invalid/image.png" />; }' },
    { rule: "no-html-link-for-pages", source: 'export function Example() { return <a href="/">Home</a>; }' },
    { rule: "no-location-assign-relative-destination", source: 'window.location.href = "/synthetic";' },
    { rule: "no-deprecated", source: 'import ReactDOM from "react-dom"; ReactDOM.render(null, document.body);' },
  ];
  for (const { rule, source } of cases) {
    const result = lint(source);
    assert.equal(result.status, 1, `${rule}: ${result.output}`);
    assert.ok(result.diagnostics.some(diagnostic => diagnostic.code.includes(rule)), `${rule}: ${result.output}`);
  }
});

test("lint accepts the dedicated credential-document navigation and the existing synthetic-test exception", () => {
  const credentialLink = lint('export function Example() { return <a href="/connect/apple" target="_top">Connect Apple</a>; }');
  assert.equal(credentialLink.status, 0, credentialLink.output);
  const syntheticDouble = lint("export const value: any = 1;", "tests", "example.ts");
  assert.equal(syntheticDouble.status, 0, syntheticDouble.output);
  const vendoredTypeError = lint("export const value: any = 1;", "src/components/ui");
  assert.equal(vendoredTypeError.status, 1, vendoredTypeError.output);
  assert.ok(vendoredTypeError.diagnostics.some(diagnostic => diagnostic.code.includes("no-explicit-any")), vendoredTypeError.output);
});
