import test from "node:test";
import assert from "node:assert/strict";
import { withinCloudKitRequestBudget } from "../src/icloud/budgets.ts";

test("expanded request capacity belongs only to bounded List ordering values", () => {
  const membership = JSON.stringify(Array.from({ length: 1822 }, () => crypto.randomUUID()));
  const list = { operationType: "update", record: { recordType: "List", fields: { ReminderIDs: { type: "STRING", value: membership } } } };
  const reminder = (length: number) => ({ operationType: "update", record: { recordType: "Reminder", fields: { TitleDocument: { type: "STRING", value: "x".repeat(length) } } } });
  assert.equal(withinCloudKitRequestBudget({ operations: [list, reminder(100)] }), true);
  assert.equal(withinCloudKitRequestBudget({ operations: [reminder(65_536)] }), false);
  assert.equal(withinCloudKitRequestBudget({ operations: [list, reminder(65_536)] }), false);
  assert.equal(withinCloudKitRequestBudget({ operations: [{ ...list, record: { ...list.record, recordType: "Reminder" } }] }), false);
  assert.equal(withinCloudKitRequestBudget({ operations: [{ ...list, record: { ...list.record, fields: { ReminderIDs: { type: "BYTES", value: membership } } } }] }), false);
  const maximum = { ...list, record: { ...list.record, fields: { ReminderIDs: { type: "STRING", value: "x".repeat(131_072) } } } };
  assert.equal(withinCloudKitRequestBudget({ operations: [maximum] }), true);
  assert.equal(withinCloudKitRequestBudget({ operations: [maximum, maximum] }), false);
  assert.equal(withinCloudKitRequestBudget({ operations: [{ ...maximum, record: { ...maximum.record, fields: { ReminderIDs: { type: "STRING", value: "x".repeat(131_073) } } } }] }), false);
  // JSON escapes and UTF-8 bytes count against the total wire budget.
  const unicode = { ...maximum, record: { ...maximum.record, fields: { ReminderIDs: { type: "STRING", value: "猫".repeat(100_000) } } } };
  assert.equal(withinCloudKitRequestBudget({ operations: [unicode] }), false);
});
