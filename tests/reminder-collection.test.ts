import test from "node:test";
import assert from "node:assert/strict";
import type { Reminder } from "../src/icloud/cloudkit.ts";
import { collectReminders, exportReminderCollection, ReminderCollectionError, type ReminderSearchCollectionResponse } from "../src/reminders/collection.ts";

function reminder(id: string, dueDate: string | null, allDay: boolean | null = false, extra: Partial<Reminder> = {}): Reminder {
  return {
    id, listId: "List/abc123", title: id, notes: null, completed: false, completedDate: null, dueDate, startDate: null,
    priority: null, flagged: false, allDay, deleted: false, timeZone: null, parentReminderId: null, alarmIds: [],
    attachmentIds: [], hashtagIds: [], recurrenceRuleIds: [], created: null, modified: null, recordChangeTag: null, raw: {}, ...extra,
  };
}

const baseInput = { view: "today" as const, timeZone: "Europe/London", referenceInstant: "2026-03-29T12:00:00+01:00", upcomingDays: 3, filters: { status: "open" as const } };

function response(records: Reminder[], paginationComplete = true, continuation: string | null = null, generation = 4): ReminderSearchCollectionResponse {
  return { generation, result: { records, scannedRecords: records.length, complete: true, paginationComplete, continuation } };
}

test("calendar views preserve all-day dates and use DST-aware local day boundaries for timed due dates", async () => {
  const allDay = reminder("all-day", "2026-03-29T00:00:00.000Z", true);
  const timedBeforeMidnight = reminder("before-midnight", "2026-03-28T23:30:00.000Z");
  const timedToday = reminder("today", "2026-03-29T22:30:00.000Z");
  const timedTomorrow = reminder("tomorrow", "2026-03-29T23:30:00.000Z");
  const run = async (view: "overdue" | "today" | "upcoming") => collectReminders({ input: { ...baseInput, view }, searchPage: async () => response([allDay, timedBeforeMidnight, timedToday, timedTomorrow]) });
  assert.deepEqual((await run("overdue")).records.map(item => item.id), ["before-midnight"]);
  assert.deepEqual((await run("today")).records.map(item => item.id), ["all-day", "today"]);
  assert.deepEqual((await run("upcoming")).records.map(item => item.id), ["tomorrow"]);
});

test("collection returns nothing on incomplete pages, generation changes, duplicate IDs, or overflow", async () => {
  await assert.rejects(collectReminders({ input: baseInput, searchPage: async () => ({ ...response([]), result: { ...response([]).result, complete: false } }) }), ReminderCollectionError);
  let pageIndex = 0;
  await assert.rejects(collectReminders({ input: baseInput, searchPage: async () => response([reminder(`id-${pageIndex++}`, null)], false, "next", pageIndex === 1 ? 4 : 5) }), /generation changed/);
  pageIndex = 0;
  await assert.rejects(collectReminders({ input: baseInput, searchPage: async () => pageIndex++ === 0 ? response([reminder("same", null)], false, "next") : response([reminder("same", null)]) }), /duplicate reminder ID/);
  await assert.rejects(collectReminders({ input: baseInput, maxReminders: 1, searchPage: async () => response([reminder("one", null), reminder("two", null)]) }), /bound/);
  await assert.rejects(collectReminders({ input: baseInput, maxReminders: 1000, searchPage: async () => ({ generation: 4,
    result: { records: [], scannedRecords: 1001, complete: true, paginationComplete: true, continuation: null } }) }), /scanned reminder bound/);
});

test("collection walks continuations with a frozen generation and refuses cursor cycles", async () => {
  const seen: { continuation: string | null; expectedGeneration?: number }[] = [];
  const collection = await collectReminders({ input: baseInput, searchPage: async request => {
    seen.push({ continuation: request.continuation, expectedGeneration: request.expectedGeneration });
    return request.continuation === null ? response([reminder("b", "2026-03-29T13:00:00Z")], false, "c1") : response([reminder("a", "2026-03-29T14:00:00Z")]);
  } });
  assert.deepEqual(seen, [{ continuation: null, expectedGeneration: undefined }, { continuation: "c1", expectedGeneration: 4 }]);
  assert.deepEqual(collection.records.map(item => item.id), ["b", "a"]);
  let calls = 0;
  await assert.rejects(collectReminders({ input: baseInput, searchPage: async () => calls++ === 0 ? response([], false, "repeat") : response([], false, "repeat") }), /repeated a continuation/);
});

test("untagged view requests hasTags=false and CSV neutralizes formula cells", async () => {
  let filtersHasTags: boolean | undefined;
  const collection = await collectReminders({ input: { ...baseInput, view: "untagged" }, searchPage: async request => {
    filtersHasTags = request.filters.hasTags;
    return response([reminder("=2+2", null, false, { title: "\t=SUM(A1:A2)", notes: "safe, \"quoted\"" })]);
  } });
  assert.equal(filtersHasTags, false);
  const csv = exportReminderCollection(collection, { format: "csv" });
  assert.match(csv, /"'=2\+2"/);
  assert.match(csv, /"'\t=SUM\(A1:A2\)"/);
  assert.match(csv, /"safe, ""quoted"""/);
  assert.throws(() => exportReminderCollection(collection, { format: "csv", maxBytes: 4 }), ReminderCollectionError);
  const prioritized = await collectReminders({ input: { ...baseInput, view: "all", sortBy: "priority" }, searchPage: async () => response([
    reminder("none", null, false, { priority: 0 }), reminder("low", null, false, { priority: 9 }),
    reminder("high", null, false, { priority: 1 }), reminder("medium", null, false, { priority: 5 }),
  ]) });
  assert.deepEqual(prioritized.records.map(item => item.id), ["high", "medium", "low", "none"]);
});
