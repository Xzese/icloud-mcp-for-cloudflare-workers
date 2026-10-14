import test from "node:test";
import assert from "node:assert/strict";
import { DRIVE_ROOT, type DriveItem, type DriveListing } from "../src/icloud/drive.ts";
import { DriveFolderPathResult, resolveDriveFolderPath } from "../src/drive/folder-path.ts";
import { ResolveDriveFolderPath } from "../src/drive/schemas.ts";

function folder(name: string, key: string, parentId = DRIVE_ROOT): DriveItem {
  return { id: `FOLDER::com.apple.CloudDocs::${key}`, documentId: key, zone: "com.apple.CloudDocs", name, type: "folder", parentId, etag: "synthetic-version", size: null, modifiedAt: null };
}
function page(items: DriveItem[], parentId = DRIVE_ROOT): DriveListing {
  return { folder: { ...folder("parent", "parent"), id: parentId }, items, complete: true, reasons: [], counts: {
    expected: items.length, received: items.length, processed: items.length, returned: items.length,
    excluded: 0, excludedShared: 0, excludedAppLibrary: 0, excludedOtherZone: 0, unprocessed: 0,
  } };
}

test("folder paths prefer exact, then canonical Unicode, then deterministic case matches without broad folding", async () => {
  const names = [folder("Café", "accent"), folder("CAFE", "upper"), folder("Cafe", "title"), folder("Ｃａｆｅ", "wide")];
  const client = { listItems: async () => page(names) };
  for (const [path, id] of [["Café", "accent"], ["Cafe\u0301", "accent"], ["CAFÉ", "accent"], ["Cafe", "title"], ["Ｃａｆｅ", "wide"]]) {
    const result = await resolveDriveFolderPath(client, DRIVE_ROOT, path!);
    assert.equal(result.status, "resolved");
    assert.equal(result.folder?.documentId, id);
    assert.equal(DriveFolderPathResult.safeParse(result).success, true);
  }
  const ambiguous = await resolveDriveFolderPath(client, DRIVE_ROOT, "cafe");
  assert.equal(ambiguous.status, "ambiguous");
  assert.equal(ambiguous.reason, "ambiguous_name");
  assert.deepEqual(ambiguous.choices.map(item => item.documentId), ["title", "upper"]);
  assert.equal(ambiguous.folder, null);
  assert.deepEqual(ambiguous.remainingSegments, ["cafe"]);
  const missing = await resolveDriveFolderPath({ listItems: async () => page([names[0]!, names[3]!]) }, DRIVE_ROOT, "Cafe");
  assert.equal(missing.status, "not_found", "accents and compatibility characters must not be discarded");
});

test("duplicate exact and canonically equivalent names return choices without reading descendants", async () => {
  for (const names of [["Docs", "Docs"], ["Café", "Cafe\u0301"]]) {
    let reads = 0;
    const result = await resolveDriveFolderPath({ listItems: async () => { reads++; return page(names.map((name, i) => folder(name, `choice-${i}`))); } }, DRIVE_ROOT, `${names[0] === "Docs" ? "Docs" : "CAFÉ"}/child`);
    assert.equal(result.status, "ambiguous");
    assert.equal(result.choices.length, 2);
    assert.equal(reads, 1);
    assert.equal(result.remainingSegments.length, 2);
  }
});

test("an incomplete parent returns unresolved even when an exact name is visible", async () => {
  let reads = 0;
  const result = await resolveDriveFolderPath({ listItems: async () => {
    reads++;
    return { ...page([folder("Documents", "docs")]), complete: false, reasons: ["missing_direct_children_count"], counts: { ...page([]).counts, expected: null, received: 1, processed: 1, returned: 1 } };
  } }, DRIVE_ROOT, "Documents/Snap Heaven");
  assert.equal(result.status, "unresolved");
  assert.equal(result.reason, "parent_listing_incomplete");
  assert.deepEqual(result.parentListing.reasons, ["missing_direct_children_count"]);
  assert.equal(result.parentListing.counts.expected, null);
  assert.equal(result.resolvedPath, "");
  assert.equal(result.folder, null);
  assert.equal(reads, 1);
});

test("folder paths validate every segment and enforce depth and length bounds", () => {
  assert.equal(ResolveDriveFolderPath.parse({ path: "Documents/Snap Heaven/01/FY 2026" }).folderId, DRIVE_ROOT);
  for (const path of ["", "/Documents", "Documents/", "Documents//child", ".", "..", "Documents/../child", "Docs\\child", " Docs", "Docs/child ", "Docs/\u0000", "x".repeat(256), Array(65).fill("x").join("/"), Array(64).fill("x".repeat(65)).join("/")]) {
    assert.equal(ResolveDriveFolderPath.safeParse({ path }).success, false, JSON.stringify(path));
  }
  assert.equal(ResolveDriveFolderPath.safeParse({ path: Array(64).fill("x").join("/") }).success, true);
});
