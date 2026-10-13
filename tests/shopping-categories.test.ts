import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { AppError } from "../src/errors.ts";
import { CloudKitRemindersClient, type CloudKitConnection, type CloudKitLookupResult, type CloudKitRecord, type CloudKitRecordItem } from "../src/icloud/cloudkit.ts";
import { downloadShoppingAsset, uploadShoppingAsset } from "../src/icloud/shopping-assets.ts";
import {
  decodeGroceryCorrections,
  decodeSectionMemberships,
  encodeGroceryCorrections,
  encodeSectionOrdering,
  encodeSectionMemberships,
  groceryCorrectionsChecksum,
  membershipsChecksum,
  SHOPPING_PROTOCOL_VERSION,
  SHOPPING_ASSET_MAX_BYTES,
  type SetShoppingCategoryRequestData,
  type ShoppingGroceryCorrections,
  type ShoppingSectionMembership,
  type ShoppingSectionMemberships,
  type ShoppingSectionOrdering,
} from "../src/reminders/shopping-categories.ts";
import { buildCreateList } from "../src/reminders/list-writes.ts";
import { buildCreateReminder } from "../src/reminders/writes.ts";
import { planShoppingCategory, verifyShoppingPreservation } from "../src/reminders/shopping-plan.ts";
import { GetReminderListSectionsRequest, readStandardSectionsPage, SectionScanSchema, type SectionScan, type StandardSectionsClient } from "../src/reminders/sections.ts";
import { AppleHTTP } from "../src/transport/apple-http.ts";
import { CookieJar } from "../src/transport/cookie-jar.ts";

const sectionIDs = [
  "00000000-0000-4000-8000-000000000001",
  "00000000-0000-4000-8000-000000000002",
] as const;
const zone = { zoneName: "Reminders", zoneType: "REGULAR_CUSTOM_ZONE", ownerRecordName: "_synthetic-owned-zone" };
const listID = "List/00000000-0000-4000-8000-000000000010";
const ownerConnection: CloudKitConnection = {
  dsid: "123456789",
  clientId: "11111111-2222-3333-4444-555555555555",
  clientBuildNumber: "2534Project66",
  clientMasteringNumber: "2534B22",
  cloudKitURL: "https://p01-ckdatabasews.icloud.com/database/1/com.apple.reminders/production/private",
  remindersZoneOwner: zone.ownerRecordName,
};

function bytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

const hasCode = (code: string) => (error: unknown) => error instanceof AppError && error.code === code;

type ShoppingPlanState = {
  memberships: ShoppingSectionMemberships;
  ordering: ShoppingSectionOrdering;
  corrections: ShoppingGroceryCorrections;
};

function digestNativeArray(values: string[]): string {
  return createHash("sha512").update(JSON.stringify(values)).digest("hex");
}

type CapturedCloudKitRequest = { url: URL; method: string | undefined; body: Record<string, unknown> };

function cloudKitClientWith(responses: unknown[]) {
  const requests: CapturedCloudKitRequest[] = [];
  const http = new AppleHTTP(new CookieJar(), async (input, init) => {
    const url = new URL(String(input));
    requests.push({ url, method: init?.method, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    const response = responses.shift();
    assert.notEqual(response, undefined, `unexpected request to ${url.pathname}`);
    return new Response(JSON.stringify(response), { status: 200 });
  });
  return { api: new CloudKitRemindersClient(http, ownerConnection), requests };
}

function sectionRecord(overrides: Record<string, unknown> = {}) {
  return {
    recordName: `ListSection/${sectionIDs[0]}`,
    recordType: "ListSection",
    recordChangeTag: "section-version-1",
    zoneID: zone,
    fields: {
      List: { type: "REFERENCE", value: { recordName: listID, action: "VALIDATE" } },
      DisplayName: { type: "STRING", value: "Produce" },
      CanonicalName: { type: "STRING", value: "produce" },
      Deleted: { type: "INT64", value: 0 },
    },
    ...overrides,
  };
}

function standardListRecord(options: { recordChangeTag?: string; fields?: Record<string, unknown>; raw?: Record<string, unknown>; zoneID?: CloudKitRecord["zoneID"] } = {}): CloudKitRecord {
  const created = buildCreateList({ name: "Standard list", idempotencyKey: "00000000-0000-4000-8000-000000000010" });
  return {
    ...created,
    recordType: "List",
    recordChangeTag: options.recordChangeTag ?? "list-version-1",
    zoneID: options.zoneID ?? { ...zone },
    raw: options.raw ?? {},
    fields: {
      ...created.fields,
      ShouldCategorizeGroceryItems: { type: "INT64", value: 0, isEncrypted: true },
      ReminderIDs: { type: "STRING", value: "[]" },
      ...options.fields,
    },
  };
}

function standardSectionRecord(id: string, name: string, parentListId = listID, overrides: Partial<CloudKitRecord> = {}): CloudKitRecord {
  return {
    recordName: `ListSection/${id}`,
    recordType: "ListSection",
    recordChangeTag: `section-${id.slice(-1)}`,
    zoneID: { ...zone },
    raw: {},
    fields: {
      List: { type: "REFERENCE", value: { recordName: parentListId, action: "VALIDATE" } },
      DisplayName: { type: "STRING", value: name },
      Deleted: { type: "INT64", value: 0 },
    },
    ...overrides,
  };
}

function lookupResult(requestedRecordNames: string[], records: CloudKitRecordItem[] = [],
  recordErrors: CloudKitLookupResult["recordErrors"] = [], unresolvedRecordNames: string[] = []): CloudKitLookupResult {
  return { requestedRecordNames, records, recordErrors, unresolvedRecordNames,
    complete: recordErrors.length === 0 && unresolvedRecordNames.length === 0 };
}

function sectionAsset(key: string) {
  return { type: "ASSETID", value: { key } };
}

function standardSectionsClient(options: {
  lists: CloudKitRecord[];
  sections?: CloudKitRecordItem[];
  assets?: Map<string, Uint8Array>;
  page?: { records: CloudKitRecordItem[]; complete: boolean; continuation: string | null };
}) {
  const lists = [...options.lists];
  const sectionRecords = new Map((options.sections ?? []).map(record => [record.recordName, record]));
  const assets = options.assets ?? new Map<string, Uint8Array>();
  const calls = { listLookups: 0, sectionLookups: [] as string[][], feedLookups: 0, downloadedAssets: [] as string[] };
  const client: StandardSectionsClient = {
    remindersZoneOwner: zone.ownerRecordName,
    async lookup(recordNames) {
      assert.deepEqual(recordNames, [listID]);
      calls.listLookups++;
      const list = lists.shift();
      return lookupResult(recordNames, list ? [list] : [], list ? [] : [{ recordName: listID, serverErrorCode: "UNKNOWN_ITEM", reason: null, raw: {} }]);
    },
    async lookupListSections(recordNames) {
      calls.sectionLookups.push([...recordNames]);
      const records: CloudKitRecordItem[] = [];
      const recordErrors: CloudKitLookupResult["recordErrors"] = [];
      const unresolved: string[] = [];
      for (const id of recordNames) {
        const record = sectionRecords.get(id);
        if (record) records.push(record);
        else {
          recordErrors.push({ recordName: id, serverErrorCode: "UNKNOWN_ITEM", reason: null, raw: {} });
        }
      }
      return lookupResult(recordNames, records, recordErrors, unresolved);
    },
    async queryListSectionsPage() {
      calls.feedLookups++;
      return options.page ?? { records: [], complete: true, continuation: null };
    },
    async downloadSectionAsset(field) {
      const key = (field as { value?: { key?: unknown } }).value?.key;
      assert.equal(typeof key, "string");
      calls.downloadedAssets.push(key as string);
      const data = assets.get(key as string);
      assert.ok(data, `missing synthetic section asset ${String(key)}`);
      return data;
    },
  };
  return { client, calls };
}

test("Standard section pages retain explicit ordering, empty sections, and only native List membership", async () => {
  const memberId = sectionIDs[0];
  const membershipData: ShoppingSectionMemberships = {
    minimumSupportedVersion: SHOPPING_PROTOCOL_VERSION,
    memberships: [{ memberID: memberId, groupID: sectionIDs[0], modifiedOn: 757_382_400 }],
  };
  const orderingData: ShoppingSectionOrdering = {
    minimumSupportedVersion: SHOPPING_PROTOCOL_VERSION,
    orderedIdentifiers: [sectionIDs[1], sectionIDs[0]],
  };
  const membershipBytes = encodeSectionMemberships(membershipData);
  const orderingBytes = encodeSectionOrdering(orderingData);
  const assets = new Map([["membership", membershipBytes], ["ordering", orderingBytes]]);
  const list = standardListRecord({ fields: {
    ReminderIDs: { type: "STRING", value: JSON.stringify([`Reminder/${memberId}`]) },
    MembershipsOfRemindersInSectionsAsData: sectionAsset("membership"),
    MembershipsOfRemindersInSectionsChecksum: { type: "STRING", value: await membershipsChecksum(membershipData), isEncrypted: true },
    SectionIDsOrderingAsData: sectionAsset("ordering"),
  } });
  const alpha = standardSectionRecord(sectionIDs[0], "Alpha");
  const empty = standardSectionRecord(sectionIDs[1], "Empty");
  const unrelated = standardSectionRecord("00000000-0000-4000-8000-000000000099", "Another list", "List/00000000-0000-4000-8000-000000000099");
  const { client, calls } = standardSectionsClient({
    lists: [list, list],
    sections: [alpha, empty],
    assets,
    page: { records: [empty, unrelated, alpha], complete: true, continuation: null },
  });

  const result = await readStandardSectionsPage(client, listID);
  assert.deepEqual(result, {
    listRecordChangeTag: "list-version-1",
    sections: [
      { sectionId: `ListSection/${sectionIDs[0]}`, name: "Alpha", canonicalName: null, recordChangeTag: "section-1" },
      { sectionId: `ListSection/${sectionIDs[1]}`, name: "Empty", canonicalName: null, recordChangeTag: "section-2" },
    ],
    memberships: [{ reminderId: `Reminder/${memberId}`, sectionId: `ListSection/${sectionIDs[0]}` }],
    orderedSectionIds: [`ListSection/${sectionIDs[1]}`, `ListSection/${sectionIDs[0]}`],
    orderingStatus: "explicit",
    complete: true,
    nativeContinuation: null,
  });
  assert.equal(calls.listLookups, 2, "the first and final List reads bind the returned page to one version");
  assert.equal(calls.feedLookups, 1);
  assert.deepEqual(calls.sectionLookups, [[`ListSection/${sectionIDs[0]}`, `ListSection/${sectionIDs[1]}`]], "unrelated feed records are discarded before exact section reads");
});

test("Standard section pages preserve an empty incomplete feed page and distinguish absent ordering", async () => {
  const list = standardListRecord();
  const nativeCursor = "4e94c699-0c30-4826-ae5c-c7cbcdcccf52";
  const { client, calls } = standardSectionsClient({
    lists: [list, list],
    page: { records: [], complete: false, continuation: nativeCursor },
  });
  const result = await readStandardSectionsPage(client, listID, { cursor: null, limit: 1 });
  assert.equal(result.complete, false);
  assert.equal(result.nativeContinuation, nativeCursor);
  assert.deepEqual(result.sections, []);
  assert.deepEqual(result.orderedSectionIds, []);
  assert.equal(result.orderingStatus, "not_materialized");
  assert.deepEqual(calls.sectionLookups, []);
  assert.equal(calls.listLookups, 2);

  assert.deepEqual(GetReminderListSectionsRequest.parse({ listId: listID }), { listId: listID, limit: 200 });
  const digest = "a".repeat(64);
  const scan: SectionScan = SectionScanSchema.parse({ token: randomUUID(), expiresAt: 1, accountHash: digest,
    listId: listID, listRecordChangeTag: "list-version-1", limit: 200, cursor: nativeCursor, seen: [digest], pages: 1 });
  assert.equal(scan.cursor, nativeCursor);
  assert.equal(GetReminderListSectionsRequest.safeParse({ listId: listID, continuation: "not-a-uuid" }).success, false);
  assert.equal(SectionScanSchema.safeParse({ ...scan, pages: 1001 }).success, false);
});

test("Standard section reads reject checksum drift, unresolved references, and List version changes", async () => {
  const membershipData: ShoppingSectionMemberships = {
    minimumSupportedVersion: SHOPPING_PROTOCOL_VERSION,
    memberships: [{ memberID: sectionIDs[0], groupID: sectionIDs[0], modifiedOn: 757_382_400 }],
  };
  const membershipBytes = encodeSectionMemberships(membershipData);
  const assetFields = {
    MembershipsOfRemindersInSectionsAsData: sectionAsset("membership"),
    MembershipsOfRemindersInSectionsChecksum: { type: "STRING", value: "0".repeat(128), isEncrypted: true },
  };
  const invalidChecksum = standardListRecord({ fields: assetFields });
  const badAssetClient = standardSectionsClient({ lists: [invalidChecksum, invalidChecksum], assets: new Map([["membership", membershipBytes]]) });
  await assert.rejects(readStandardSectionsPage(badAssetClient.client, listID), hasCode("PROTOCOL_CHANGED"));

  const missingReferenceList = standardListRecord({ fields: {
    ReminderIDs: { type: "STRING", value: JSON.stringify([`Reminder/${sectionIDs[0]}`]) },
    MembershipsOfRemindersInSectionsAsData: sectionAsset("membership"),
    MembershipsOfRemindersInSectionsChecksum: { type: "STRING", value: await membershipsChecksum(membershipData), isEncrypted: true },
  } });
  const missingClient = standardSectionsClient({ lists: [missingReferenceList, missingReferenceList], assets: new Map([["membership", membershipBytes]]) });
  await assert.rejects(readStandardSectionsPage(missingClient.client, listID), hasCode("CONFLICT"));

  const feedOnlyEmpty = standardSectionRecord(sectionIDs[1], "Empty");
  const feedOnlyClient = standardSectionsClient({ lists: [standardListRecord(), standardListRecord()], page: { records: [feedOnlyEmpty], complete: true, continuation: null } });
  feedOnlyClient.client.lookupListSections = async ids => ({ requestedRecordNames: ids, records: [], recordErrors: [], unresolvedRecordNames: ids, complete: false });
  await assert.rejects(readStandardSectionsPage(feedOnlyClient.client, listID), hasCode("PROTOCOL_CHANGED"));

  const tombstoneOrdering: ShoppingSectionOrdering = { minimumSupportedVersion: SHOPPING_PROTOCOL_VERSION, orderedIdentifiers: [sectionIDs[0]] };
  const tombstoneList = standardListRecord({ fields: {
    ReminderIDs: { type: "STRING", value: JSON.stringify([`Reminder/${sectionIDs[0]}`]) },
    MembershipsOfRemindersInSectionsAsData: sectionAsset("membership"),
    MembershipsOfRemindersInSectionsChecksum: { type: "STRING", value: await membershipsChecksum(membershipData), isEncrypted: true },
    SectionIDsOrderingAsData: sectionAsset("ordering"),
  } });
  const tombstoneClient = standardSectionsClient({
    lists: [tombstoneList, tombstoneList],
    sections: [{ recordName: `ListSection/${sectionIDs[0]}`, deleted: true, zoneID: { ...zone }, raw: {} }],
    assets: new Map([["membership", membershipBytes], ["ordering", encodeSectionOrdering(tombstoneOrdering)]]),
  });
  const filteredTombstone = await readStandardSectionsPage(tombstoneClient.client, listID);
  assert.deepEqual(filteredTombstone.sections, []);
  assert.deepEqual(filteredTombstone.memberships, []);
  assert.deepEqual(filteredTombstone.orderedSectionIds, []);

  const first = standardListRecord({ recordChangeTag: "list-version-1" });
  const changed = standardListRecord({ recordChangeTag: "list-version-2" });
  const changedClient = standardSectionsClient({ lists: [first, changed] });
  await assert.rejects(readStandardSectionsPage(changedClient.client, listID), hasCode("CONFLICT"));
  const staleContinuationClient = standardSectionsClient({ lists: [changed] });
  await assert.rejects(readStandardSectionsPage(staleContinuationClient.client, listID, { expectedListRecordChangeTag: "list-version-1" }), hasCode("CONFLICT"));
});

test("Standard section reads reject Shopping, Smart, shared, and foreign ownership contexts", async () => {
  const cases: Array<{ name: string; list: CloudKitRecord; code: string }> = [
    { name: "Shopping", list: standardListRecord({ fields: { ShouldCategorizeGroceryItems: { type: "INT64", value: 1 } } }), code: "UNSUPPORTED_FEATURE" },
    { name: "Smart", list: standardListRecord({ fields: { SmartListQuery: { type: "STRING", value: "synthetic" } } }), code: "UNSUPPORTED_FEATURE" },
    { name: "shared", list: standardListRecord({ raw: { share: { recordName: "Share/synthetic" } } }), code: "FORBIDDEN" },
    { name: "foreign", list: standardListRecord({ zoneID: { ...zone, ownerRecordName: "_another-synthetic-owner" } }), code: "FORBIDDEN" },
  ];
  for (const item of cases) {
    const client = standardSectionsClient({ lists: [item.list] });
    await assert.rejects(readStandardSectionsPage(client.client, listID), hasCode(item.code), item.name);
  }

  const list = standardListRecord();
  const sharedSection = standardSectionRecord(sectionIDs[0], "Shared", listID, { raw: { share: { recordName: "Share/synthetic" } } });
  const sharedSectionClient = standardSectionsClient({ lists: [list, list], sections: [sharedSection],
    page: { records: [sharedSection], complete: true, continuation: null } });
  await assert.rejects(readStandardSectionsPage(sharedSectionClient.client, listID), hasCode("FORBIDDEN"));
});

test("shopping checksums preserve native framing, descending order, Apple dates, and strict asset shapes", async () => {
  const memberships: ShoppingSectionMembership[] = [
    { memberID: sectionIDs[0], groupID: "00000000-0000-4000-8000-00000000000A", modifiedOn: 757_382_400.99 },
    { memberID: sectionIDs[1], groupID: "00000000-0000-4000-8000-00000000000B", modifiedOn: 757_382_401.9 },
  ];
  const expectedMembershipLines = [
    "memberIdentifier:00000000-0000-4000-8000-000000000002,groupIdentifier:00000000-0000-4000-8000-00000000000B,modifiedOn:2025-01-01 00:00:01 +0000",
    "memberIdentifier:00000000-0000-4000-8000-000000000001,groupIdentifier:00000000-0000-4000-8000-00000000000A,modifiedOn:2025-01-01 00:00:00 +0000",
  ];
  const membershipDigest = digestNativeArray(expectedMembershipLines);
  assert.equal(await membershipsChecksum(memberships), membershipDigest);
  assert.equal(await membershipsChecksum([...memberships].reverse()), membershipDigest, "the native digest is independent of input order");

  const corrections = {
    lastResetDate: null,
    memberships: {
      apples: { identifier: "00000000-0000-4000-8000-000000000004", modifiedOn: 757_382_400.1 },
      milk: { identifier: "00000000-0000-4000-8000-000000000003", modifiedOn: 757_382_401.8 },
    },
  } as const;
  const expectedCorrectionLines = [
    "lastResetDate:nil",
    'milk:{Optional("identifier:Optional(00000000-0000-4000-8000-000000000003),modifiedOn:Optional(2025-01-01 00:00:01 +0000)")}',
    'apples:{Optional("identifier:Optional(00000000-0000-4000-8000-000000000004),modifiedOn:Optional(2025-01-01 00:00:00 +0000)")}',
  ];
  const correctionDigest = digestNativeArray(expectedCorrectionLines);
  assert.equal(await groceryCorrectionsChecksum(corrections), correctionDigest);
  assert.equal(await groceryCorrectionsChecksum({ lastResetDate: null, memberships: { milk: corrections.memberships.milk, apples: corrections.memberships.apples } }), correctionDigest,
    "correction keys use native descending order regardless of object insertion order");

  const validAsset = { minimumSupportedVersion: SHOPPING_PROTOCOL_VERSION, memberships };
  assert.deepEqual(decodeSectionMemberships(bytes(validAsset)), validAsset);
  const unknownVersion = bytes({ ...validAsset, minimumSupportedVersion: SHOPPING_PROTOCOL_VERSION + 1 });
  const duplicateMembers = bytes({ minimumSupportedVersion: SHOPPING_PROTOCOL_VERSION, memberships: [memberships[0], memberships[0]] });
  const resetDate = bytes({ lastResetDate: 757_382_400, memberships: {} });
  const prototypeKey = new TextEncoder().encode('{"lastResetDate":null,"memberships":{"__proto__":{"identifier":"00000000-0000-4000-8000-000000000005","modifiedOn":757382400}}}');
  for (const invalid of [unknownVersion, duplicateMembers]) {
    await assert.rejects(async () => decodeSectionMemberships(invalid),
      (error: unknown) => error instanceof AppError && error.code === "UNSUPPORTED_FEATURE");
  }
  await assert.rejects(async () => decodeGroceryCorrections(resetDate),
    (error: unknown) => error instanceof AppError && error.code === "UNSUPPORTED_FEATURE");
  await assert.rejects(async () => decodeGroceryCorrections(prototypeKey), hasCode("UNSUPPORTED_FEATURE"));
});

test("shopping assets use bounded Apple hosts, manual redirects, exact token binding, and byte-matched receipts", async () => {
  const payload = new Uint8Array([0x7b, 0x7d]);
  const downloadCalls: { url: URL; init: RequestInit }[] = [];
  const download = async (input: RequestInfo | URL, init?: RequestInit) => {
    downloadCalls.push({ url: new URL(String(input)), init: init ?? {} });
    return new Response(payload, { status: 200 });
  };
  const nativeReference = {
    type: "ASSETID",
    value: {
      fileChecksum: "synthetic-file-checksum",
      wrappingKey: "synthetic-wrapping-key",
      referenceChecksum: "synthetic-reference-checksum",
      size: payload.byteLength,
      downloadURL: "https://cvws.icloud-content.com/B/synthetic-asset-id",
    },
  };
  assert.deepEqual(await downloadShoppingAsset(nativeReference, download), payload);
  assert.equal(downloadCalls.length, 1);
  assert.equal(downloadCalls[0].url.origin, "https://cvws.icloud-content.com");
  assert.equal(downloadCalls[0].init.method, "GET");
  assert.equal(downloadCalls[0].init.credentials, "omit");
  assert.equal(downloadCalls[0].init.redirect, "manual");
  assert.equal(new Headers(downloadCalls[0].init.headers).get("cookie"), null);
  assert.equal(new Headers(downloadCalls[0].init.headers).get("authorization"), null);

  const expected = { recordName: listID, fieldName: "MembershipsOfRemindersInSectionsAsData" as const };
  const token = { ...expected, url: "https://cws.icloud-content.com/123456/singleFileUpload?token=synthetic-token" };
  const receipt = { singleFile: {
    referenceChecksum: "synthetic-upload-reference",
    size: payload.byteLength,
    fileChecksum: "synthetic-upload-file",
    wrappingKey: "synthetic-upload-wrapping-key",
    receipt: "synthetic-upload-receipt",
  } };
  const uploadCalls: { url: URL; init: RequestInit }[] = [];
  const upload = async (input: RequestInfo | URL, init?: RequestInit) => {
    uploadCalls.push({ url: new URL(String(input)), init: init ?? {} });
    return new Response(JSON.stringify(receipt), { status: 200 });
  };
  assert.deepEqual(await uploadShoppingAsset(token, expected, payload, upload), receipt.singleFile);
  assert.equal(uploadCalls.length, 1);
  assert.equal(uploadCalls[0].url.origin, "https://cws.icloud-content.com");
  assert.equal(uploadCalls[0].url.pathname, "/123456/singleFileUpload");
  assert.equal(uploadCalls[0].init.method, "POST");
  assert.equal(uploadCalls[0].init.credentials, "omit");
  assert.equal(uploadCalls[0].init.redirect, "manual");
  assert.equal(new Headers(uploadCalls[0].init.headers).get("cookie"), null);
  assert.equal(new Headers(uploadCalls[0].init.headers).get("authorization"), null);
  assert.deepEqual(new Uint8Array(uploadCalls[0].init.body as ArrayBuffer), payload);

  let forbiddenSendCount = 0;
  const forbiddenSend = async () => {
    forbiddenSendCount++;
    return new Response(JSON.stringify(receipt), { status: 200 });
  };
  await assert.rejects(downloadShoppingAsset({ ...nativeReference, value: { ...nativeReference.value, downloadURL: "https://attacker.example/B/asset" } }, forbiddenSend), AppError);
  await assert.rejects(uploadShoppingAsset({ ...token, url: "https://attacker.example/123456/singleFileUpload" }, expected, payload, forbiddenSend), AppError);
  await assert.rejects(uploadShoppingAsset({ ...token, recordName: "List/00000000-0000-4000-8000-000000000011" }, expected, payload, forbiddenSend), AppError);
  await assert.rejects(uploadShoppingAsset({ ...token, fieldName: "GroceryLocalCorrectionsAsData" }, expected, payload, forbiddenSend), AppError);
  await assert.rejects(downloadShoppingAsset({ ...nativeReference, value: { ...nativeReference.value, size: SHOPPING_ASSET_MAX_BYTES + 1 } }, forbiddenSend), AppError);
  await assert.rejects(uploadShoppingAsset(token, expected, new Uint8Array(SHOPPING_ASSET_MAX_BYTES + 1), forbiddenSend), AppError);
  assert.equal(forbiddenSendCount, 0, "invalid hosts, identities, and declared budgets fail before network transmission");

  let redirectCalls = 0;
  const redirectSend = async (input: RequestInfo | URL, init?: RequestInit) => {
    redirectCalls++;
    assert.equal(new URL(String(input)).origin, "https://cws.icloud-content.com");
    assert.equal(init?.redirect, "manual");
    return new Response(null, { status: 302, headers: { location: "https://cws.icloud-content.com/654321/singleFileUpload" } });
  };
  await assert.rejects(uploadShoppingAsset(token, expected, payload, redirectSend), AppError);
  assert.equal(redirectCalls, 1, "a redirect response never triggers a second upload");

  let mismatchCalls = 0;
  const mismatchSend = async () => {
    mismatchCalls++;
    return new Response(new Uint8Array([1]), { status: 200 });
  };
  await assert.rejects(downloadShoppingAsset(nativeReference, mismatchSend), AppError);
  assert.equal(mismatchCalls, 1, "an asset whose downloaded byte count disagrees with metadata is discarded");
});

test("ListSection discovery paginates only the owned category feed and keeps exact lookup type-scoped", async () => {
  const record = sectionRecord();
  const { api, requests } = cloudKitClientWith([
    { zones: [{ zoneID: zone, records: [record], moreComing: true, syncToken: "category-next-1" }] },
    { zones: [{ zoneID: zone, records: [], moreComing: true, syncToken: "category-next-2" }] },
    { records: [record] },
  ]);

  const first = await api.queryListSectionsPage({ limit: 8 });
  assert.equal(first.records.length, 1);
  assert.equal(first.records[0].recordName, record.recordName);
  assert.equal(first.complete, false);
  assert.equal(first.continuation, "category-next-1");
  const emptyPage = await api.queryListSectionsPage({ limit: 8, continuation: first.continuation });
  assert.deepEqual(emptyPage.records, []);
  assert.equal(emptyPage.complete, false, "an empty page can still advertise another category page");
  assert.equal(emptyPage.continuation, "category-next-2");

  const sectionLookup = await api.lookupListSections([record.recordName]);
  assert.equal(sectionLookup.complete, true);
  assert.equal(sectionLookup.records[0].recordName, record.recordName);
  assert.equal(requests.length, 3);
  assert.equal(requests[0].url.pathname.endsWith("/changes/zone"), true);
  assert.deepEqual(requests[0].body, {
    zones: [{ zoneID: zone }],
    reverse: true,
    desiredRecordTypes: ["ListSection"],
    desiredKeys: ["List", "DisplayName", "CanonicalName", "Deleted"],
    resultsLimit: 8,
  });
  assert.deepEqual(requests[1].body, {
    zones: [{ zoneID: zone, syncToken: "category-next-1" }],
    reverse: true,
    desiredRecordTypes: ["ListSection"],
    desiredKeys: ["List", "DisplayName", "CanonicalName", "Deleted"],
    resultsLimit: 8,
  });
  assert.deepEqual(requests[2].body, {
    records: [{ recordName: record.recordName }],
    zoneID: zone,
  });
  await assert.rejects(api.lookup([record.recordName]), AppError);
  assert.equal(requests.length, 3, "ordinary lookups remain limited to Lists and Reminders");

  for (const invalidRecord of [
    { ...record, recordType: "List" },
    { ...record, zoneID: { ...zone, ownerRecordName: "_another-synthetic-owner" } },
  ]) {
    const invalidFeed = cloudKitClientWith([{ zones: [{ zoneID: zone, records: [invalidRecord], moreComing: false }] }]);
    await assert.rejects(invalidFeed.api.queryListSectionsPage(), AppError);
    assert.equal(invalidFeed.requests.length, 1);
  }
  for (const invalidRecord of [
    { ...record, recordType: "List" },
    { ...record, zoneID: { ...zone, ownerRecordName: "_another-synthetic-owner" } },
  ]) {
    const invalidLookup = cloudKitClientWith([{ records: [invalidRecord] }]);
    await assert.rejects(invalidLookup.api.lookupListSections([record.recordName]), AppError);
    assert.equal(invalidLookup.requests.length, 1);
  }
});

test("manual Shopping category plans preserve the native List and learn a move with exact versions and parent context", async () => {
  const now = 1_800_000_123_456;
  const createdList = buildCreateList({ name: "Household groceries", idempotencyKey: randomUUID() }, now - 10_000);
  const listID = createdList.recordName;
  const list: CloudKitRecord = {
    ...createdList,
    recordChangeTag: "list-version-1",
    zoneID: { ...zone },
    raw: {},
    fields: {
      ...createdList.fields,
      ShouldCategorizeGroceryItems: { ...createdList.fields.ShouldCategorizeGroceryItems, value: 1 },
      ReminderIDs: { type: "STRING", value: "[]" },
    },
  };

  const rootWrite = buildCreateReminder({ listId: listID, idempotencyKey: randomUUID(), title: "Organic Whole Milk",
    notes: "", priority: 0, flagged: false, allDay: false }, now - 5_000);
  const selectedUUID = rootWrite.recordName.slice("Reminder/".length);
  const otherUUID = "00000000-0000-4000-8000-000000000020";
  const anotherUUID = "00000000-0000-4000-8000-000000000021";
  const rawListMembers = [otherUUID, selectedUUID, `Reminder/${anotherUUID}`];
  list.fields.ReminderIDs = { type: "STRING", value: JSON.stringify(rawListMembers) };
  const listParent = { recordName: listID, zoneID: { ...zone } };
  const root: CloudKitRecord = {
    ...rootWrite,
    recordChangeTag: "reminder-version-1",
    zoneID: { ...zone },
    raw: { parent: structuredClone(listParent), created: { timestamp: now - 5_000 }, modified: { timestamp: now - 5_000 } },
  };
  const category: CloudKitRecord = {
    recordName: `ListSection/${sectionIDs[0]}`,
    recordType: "ListSection",
    recordChangeTag: "section-version-1",
    zoneID: { ...zone },
    raw: { parent: structuredClone(listParent) },
    fields: {
      List: { type: "REFERENCE", value: { recordName: listID, action: "VALIDATE" } },
      DisplayName: { type: "STRING", value: "Dairy" },
      CanonicalName: { type: "STRING", value: "dairy" },
      Deleted: { type: "INT64", value: 0 },
    },
  };

  const state = {
    memberships: {
      minimumSupportedVersion: SHOPPING_PROTOCOL_VERSION,
      memberships: [
        { memberID: otherUUID, groupID: sectionIDs[1], modifiedOn: 757_382_400 },
        { memberID: selectedUUID, groupID: sectionIDs[1], modifiedOn: 757_382_401 },
      ],
    } satisfies ShoppingSectionMemberships,
    ordering: {
      minimumSupportedVersion: SHOPPING_PROTOCOL_VERSION,
      orderedIdentifiers: [sectionIDs[1], sectionIDs[0]],
    } satisfies ShoppingSectionOrdering,
    corrections: {
      lastResetDate: null,
      memberships: {
        "coffee beans": { identifier: "00000000-0000-4000-8000-000000000030", modifiedOn: 757_382_399 },
        "organic whole milk": { identifier: sectionIDs[1], modifiedOn: 757_382_401 },
      },
    } satisfies ShoppingGroceryCorrections,
  };
  const sourceMembershipBytes = encodeSectionMemberships(state.memberships);
  const sourceCorrectionBytes = encodeGroceryCorrections(state.corrections);
  assert.deepEqual(decodeSectionMemberships(sourceMembershipBytes), state.memberships);
  assert.deepEqual(decodeGroceryCorrections(sourceCorrectionBytes), state.corrections);
  list.fields = {
    ...list.fields,
    MembershipsOfRemindersInSectionsAsData: { type: "ASSETID", value: {
      fileChecksum: "synthetic-membership-file", wrappingKey: "synthetic-membership-key",
      referenceChecksum: "synthetic-membership-reference", size: sourceMembershipBytes.byteLength,
      downloadURL: "https://cvws.icloud-content.com/B/synthetic-memberships",
    } },
    MembershipsOfRemindersInSectionsChecksum: { type: "STRING", value: await membershipsChecksum(state.memberships), isEncrypted: true },
    GroceryLocalCorrectionsAsData: { type: "ASSETID", value: {
      fileChecksum: "synthetic-correction-file", wrappingKey: "synthetic-correction-key",
      referenceChecksum: "synthetic-correction-reference", size: sourceCorrectionBytes.byteLength,
      downloadURL: "https://cvws.icloud-content.com/B/synthetic-corrections",
    } },
    GroceryLocalCorrectionsChecksum: { type: "STRING", value: await groceryCorrectionsChecksum(state.corrections), isEncrypted: true },
  };
  const request: SetShoppingCategoryRequestData = {
    expectedGeneration: 1,
    listId: listID,
    reminderId: root.recordName,
    recordChangeTag: root.recordChangeTag!,
    listRecordChangeTag: list.recordChangeTag!,
    categoryId: category.recordName,
    categoryRecordChangeTag: category.recordChangeTag!,
  };
  const makePlan = (input = request, currentRoot = root, currentList = list, destination = category, currentState: ShoppingPlanState = state) =>
    planShoppingCategory(input, currentRoot, currentList, destination, currentState, zone.ownerRecordName!, now);

  const planned = await makePlan();
  assert.equal((list.fields.SortingStyle as { value: unknown }).value, "manual");
  assert.equal((list.fields.ShouldCategorizeGroceryItems as { value: unknown }).value, 1);
  assert.deepEqual(planned.memberships.memberships, [
    { memberID: otherUUID, groupID: sectionIDs[1], modifiedOn: 757_382_400 },
    { memberID: selectedUUID, groupID: sectionIDs[0], modifiedOn: now / 1_000 - 978_307_200 },
  ]);
  assert.deepEqual(planned.corrections.memberships, {
    "coffee beans": { identifier: "00000000-0000-4000-8000-000000000030", modifiedOn: 757_382_399 },
    "organic whole milk": { identifier: sectionIDs[0], modifiedOn: now / 1_000 - 978_307_200 },
  });
  assert.deepEqual(decodeSectionMemberships(planned.data.MembershipsOfRemindersInSectionsAsData), planned.memberships);
  assert.deepEqual(decodeGroceryCorrections(planned.data.GroceryLocalCorrectionsAsData), planned.corrections);
  assert.equal(planned.fields.MembershipsOfRemindersInSectionsChecksum.value, await membershipsChecksum(planned.memberships));
  assert.equal(planned.fields.MembershipsOfRemindersInSectionsChecksum.isEncrypted, true);
  assert.equal(planned.fields.GroceryLocalCorrectionsChecksum.value, await groceryCorrectionsChecksum(planned.corrections));
  assert.equal(planned.fields.GroceryLocalCorrectionsChecksum.isEncrypted, true);
  assert.equal(planned.fields.ReminderIDs.value, JSON.stringify([otherUUID, `Reminder/${anotherUUID}`, selectedUUID]));
  assert.equal(planned.rootWrite.fields.LastModifiedDate.value, now);

  const changedRootFields = ["LastModifiedDate", "ResolutionTokenMap"];
  const rootAfter: CloudKitRecord = {
    ...root,
    recordChangeTag: "reminder-version-2",
    fields: { ...root.fields, ...planned.rootWrite.fields },
    raw: { ...root.raw, parent: structuredClone(listParent) },
  };
  assert.doesNotThrow(() => verifyShoppingPreservation(root, rootAfter, changedRootFields, zone.ownerRecordName));
  assert.throws(() => verifyShoppingPreservation(root, {
    ...rootAfter,
    raw: { ...rootAfter.raw, parent: { recordName: "List/00000000-0000-4000-8000-000000000099", zoneID: { ...zone } } },
  }, changedRootFields, zone.ownerRecordName), hasCode("PROTOCOL_CHANGED"));

  const changedListFields = ["MembershipsOfRemindersInSectionsAsData", "MembershipsOfRemindersInSectionsChecksum",
    "GroceryLocalCorrectionsAsData", "GroceryLocalCorrectionsChecksum", "ReminderIDs", "ResolutionTokenMap"];
  const listAfter: CloudKitRecord = {
    ...list,
    recordChangeTag: "list-version-2",
    fields: {
      ...list.fields,
      ...planned.fields,
      MembershipsOfRemindersInSectionsAsData: { type: "ASSETID", value: {
        fileChecksum: "synthetic-next-membership-file", wrappingKey: "synthetic-next-membership-key",
        referenceChecksum: "synthetic-next-membership-reference", size: planned.data.MembershipsOfRemindersInSectionsAsData.byteLength,
        downloadURL: "https://cvws.icloud-content.com/B/synthetic-next-memberships",
      } },
      GroceryLocalCorrectionsAsData: { type: "ASSETID", value: {
        fileChecksum: "synthetic-next-correction-file", wrappingKey: "synthetic-next-correction-key",
        referenceChecksum: "synthetic-next-correction-reference", size: planned.data.GroceryLocalCorrectionsAsData.byteLength,
        downloadURL: "https://cvws.icloud-content.com/B/synthetic-next-corrections",
      } },
    },
  };
  assert.doesNotThrow(() => verifyShoppingPreservation(list, listAfter, changedListFields, zone.ownerRecordName));

  for (const staleRequest of [
    { ...request, recordChangeTag: "stale-reminder" },
    { ...request, listRecordChangeTag: "stale-list" },
    { ...request, categoryRecordChangeTag: "stale-section" },
  ]) await assert.rejects(makePlan(staleRequest), hasCode("CONFLICT"));

  const wrongListRoot: CloudKitRecord = {
    ...root,
    fields: { ...root.fields, List: { type: "REFERENCE", value: { recordName: "List/00000000-0000-4000-8000-000000000099", action: "VALIDATE" } } },
  };
  await assert.rejects(makePlan(request, wrongListRoot), hasCode("CONFLICT"));
  const foreignParentCategory: CloudKitRecord = {
    ...category,
    raw: { ...category.raw, parent: { recordName: listID, zoneID: { ...zone, ownerRecordName: "_foreign-synthetic-owner" } } },
  };
  await assert.rejects(makePlan(request, root, list, foreignParentCategory), AppError);

  const extraWrapperMetadataList: CloudKitRecord = {
    ...list,
    fields: { ...list.fields, GroceryLocalCorrectionsAsData: {
      ...(list.fields.GroceryLocalCorrectionsAsData as Record<string, unknown>), futureMetadata: "preserve",
    } },
  };
  await assert.rejects(makePlan(request, root, extraWrapperMetadataList), hasCode("UNSUPPORTED_FEATURE"));
  const malformedAssignmentsRoot: CloudKitRecord = {
    ...root,
    fields: { ...root.fields, AssignmentIDs: { type: "UNKNOWN_LIST", value: ["synthetic-assignment"] } },
  };
  await assert.rejects(makePlan(request, malformedAssignmentsRoot), hasCode("UNSUPPORTED_FEATURE"));
  const unsafeCorrections = JSON.parse('{"lastResetDate":null,"memberships":{"__proto__":{"identifier":"00000000-0000-4000-8000-000000000040","modifiedOn":757382400}}}') as ShoppingGroceryCorrections;
  await assert.rejects(makePlan(request, root, list, category, { ...state, corrections: unsafeCorrections }), hasCode("UNSUPPORTED_FEATURE"));
});
