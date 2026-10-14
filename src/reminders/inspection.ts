import { z } from "zod";
import { AppError } from "../errors.ts";
import { normalizeList, normalizeReminder, referenceField, type CloudKitRecord, type CloudKitRemindersClient } from "../icloud/cloudkit.ts";
import { jsonBytes, fingerprint } from "../lib/canonical.ts";
import { CreateReminderInput, ReminderTargetInput, updateResolutionTokenMap } from "./writes.ts";
import { RecurrenceCalendarTimeZone } from "./recurrence-calendar.ts";
import { loadSchedulingGraph, type SchedulingGraph } from "./linked-records.ts";
import { readPreservedRecurrence, type RecurrenceState } from "./recurrence.ts";
import { earlyReminderPayload, EARLY_UNITS } from "./early-reminder.ts";
import { inspectLocationAlarms, locationSummary } from "./location-alarm.ts";
import { validateAbsoluteDatePair } from "./date-alarm-lifecycle.ts";
import { inspectRootAbsoluteDatePair } from "./linked-date.ts";
import { readReminderOrganization, readReminderOrganizationSelection, reminderOrganizationIds, normalizeURLAttachment, normalizeReminderTag } from "./organization.ts";
import { inspectListChildren, requireNoReadErrors } from "./subtasks.ts";
import { inspectLifecycleFamily, planLifecycle } from "./lifecycle.ts";
import { loadScheduledFamilyPairs, planScheduledFamilyLifecycle } from "./scheduled-family-lifecycle.ts";
import { planRecurringCompletion } from "./recurring-lifecycle.ts";
import { planRecurringDeletion } from "./recurring-deletion.ts";
import { requireOrdinaryTransfer } from "./transfers.ts";
import { requireMutableList } from "./list-writes.ts";
import { loadShoppingAssets, requireShoppingList, categorySummary } from "./shopping-plan.ts";

export const InspectReminderInput = ReminderTargetInput.omit({ recordChangeTag: true }).extend({
  expectedGeneration: z.number().int().nonnegative().safe().describe("Required Apple session generation from connection_status."),
  recurrenceCalendarTimeZone: RecurrenceCalendarTimeZone.optional(),
}).strict();

type Status = "known" | "unknown";
type Action = "complete" | "reopen" | "delete" | "move" | "copy" | "update";
export interface ReminderActionCheck {
  status: "supported" | "unsupported" | "requires_input";
  reason: string;
  affectedReminderIds: string[];
  requiredInputs: string[];
}
const check = (status: ReminderActionCheck["status"], reason: string, affectedReminderIds: string[] = [], requiredInputs: string[] = []): ReminderActionCheck =>
  ({ status, reason, affectedReminderIds, requiredInputs });

// Only fixed messages leave this boundary. Native error messages can mention
// private field names or opaque payload paths, so they are not response data.
function reason(error: unknown, fallback: string): string {
  if (error instanceof AppError && error.code === "UNSUPPORTED_FEATURE" && [
    "Recurring completion found unreviewed native parent/child metadata.",
    "Recurring completion found unreviewed native relationship fields.",
    "Recurring completion found native assignment metadata.",
    "Recurring completion requires the observed monthly one-day early alert.",
  ].includes(error.message)) return error.message;
  if (error instanceof AppError && error.code === "CONFLICT") return "The exact participants changed or could not be resolved. Read the reminder and list again before a new request.";
  if (error instanceof AppError && error.code === "PROTOCOL_CHANGED") {
    if (error.message === "Apple rejected the Reminders read request.") return "Apple rejected the native relationship read request. This inspection cannot establish support.";
    if (/response.*byte budget|more data than.*response budget/i.test(error.message)) return "Apple's relationship response exceeded the bounded transport size. This inspection cannot establish support.";
    if (/without its source-proven List relationship/.test(error.message)) return "Apple returned a reminder without its expected List relationship. This inspection cannot establish support.";
    if (/ParentReminder/.test(error.message)) return "Apple returned an unrecognized ParentReminder relationship. This inspection cannot establish support.";
    if (/List relationship|linked to a different list|reminder from another list/.test(error.message)) return "Apple returned a reminder outside the selected List. This inspection cannot establish support.";
    return "Apple returned an unrecognized relationship or field shape. This inspection cannot establish support.";
  }
  return fallback;
}
function propagateReadFailure(error: unknown) {
  if (error instanceof AppError && !["CONFLICT", "PROTOCOL_CHANGED", "UNSUPPORTED_FEATURE", "VALIDATION_ERROR"].includes(error.code)) throw error;
  // Transport errors must remain errors, rather than become claims about a
  // reminder's capabilities. Only native classification failures are summarized.
  if (!(error instanceof AppError)) throw error;
}

/** Read-only native recipe eligibility, with no reservation, staging or intent. */
export async function inspectReminder(client: CloudKitRemindersClient, current: CloudKitRecord, sourceList: CloudKitRecord, owner: string,
  options: { recurrenceCalendarTimeZone?: string } = {}) {
  const reminder = normalizeReminder(current, owner, true);
  const root = { ...current, zoneID: current.zoneID ?? { zoneName: "Reminders", ownerRecordName: owner } };
  const list = { ...sourceList, zoneID: sourceList.zoneID ?? { zoneName: "Reminders", ownerRecordName: owner } };
  const target = { listId: list.recordName, reminderId: current.recordName, recordChangeTag: current.recordChangeTag ?? "" };
  const schedulingReads = new Map<string, ReturnType<CloudKitRemindersClient["lookupSchedulingRecords"]>>();
  const schedulingClient = { lookupSchedulingRecords: (ids: string[]) => {
    const key = JSON.stringify(ids); if (!schedulingReads.has(key)) schedulingReads.set(key, client.lookupSchedulingRecords(ids));
    return schedulingReads.get(key)!;
  } };
  const actions = Object.fromEntries((["complete", "reopen", "delete", "move", "copy", "update"] as Action[])
    .map(action => [action, check("unsupported", "The required exact live participants have not been established.")])) as Record<Action, ReminderActionCheck>;

  const schedule: { status: Status; dueDate: string | null; timeZone: string | null; allDay: boolean | null; recurrence: RecurrenceState | null;
    earlyReminder: { unit: typeof EARLY_UNITS[number]; count: number } | null; locationAlarm: ReturnType<typeof locationSummary> | null; reason: string | null } =
    { status: "unknown", dueDate: reminder.dueDate, timeZone: reminder.timeZone, allDay: reminder.allDay, recurrence: null, earlyReminder: null, locationAlarm: null, reason: null };
  let graph: SchedulingGraph | undefined;
  try {
    graph = await loadSchedulingGraph(root, owner, ids => schedulingClient.lookupSchedulingRecords(ids));
    const rules = graph.records.filter(record => record.recordType === "RecurrenceRule");
    if (rules.length > 1 || rules.some(rule => referenceField(rule, "Reminder", "Reminder", owner) !== reminder.id))
      throw new AppError("UNSUPPORTED_FEATURE", "Unclassified recurrence graph.");
    if (rules.length) schedule.recurrence = readPreservedRecurrence(rules[0]);
    const early = root.fields.DueDateDeltaAlertsData as { type?: unknown; value?: unknown } | undefined;
    if (early !== undefined && !(early?.type === "ENCRYPTED_BYTES" && early.value === null)) {
      const alert = earlyReminderPayload(root).dueDateDeltaAlerts[0];
      schedule.earlyReminder = { unit: EARLY_UNITS[alert.dueDateDeltaUnit], count: -alert.dueDateDeltaCount };
    }
    const locations = inspectLocationAlarms(graph, owner);
    if (locations.locations.length) schedule.locationAlarm = locationSummary(locations.locations[0].trigger);
    if (normalizeReminder(locations.dateGraph.reminder, owner).alarmIds?.length) {
      if (reminder.parentReminderId === null && !locations.dateGraph.schedulingParent && schedule.recurrence?.frequency === "monthly" && schedule.recurrence.interval === 1 && schedule.recurrence.endDate === null &&
        ((JSON.stringify(schedule.recurrence.monthDays) === "[28,29]" && JSON.stringify(schedule.recurrence.setPositions) === "[-1]" &&
          schedule.earlyReminder?.unit === "days" && schedule.earlyReminder.count === 1) ||
          (!schedule.recurrence.monthDays && !schedule.recurrence.weekdays && !schedule.recurrence.ordinalWeekday && !schedule.recurrence.months && !schedule.recurrence.setPositions &&
            (schedule.earlyReminder === null || schedule.earlyReminder.unit === "days" && schedule.earlyReminder.count === 1))))
        inspectRootAbsoluteDatePair(locations.dateGraph, owner, { acknowledgedCompletionAt: Date.now() });
      else validateAbsoluteDatePair(locations.dateGraph.reminder, locations.dateGraph.records.filter(record => ["Alarm", "AlarmTrigger"].includes(record.recordType)), owner);
    }
    if (reminder.startDate !== null || reminder.allDay === null) throw new AppError("UNSUPPORTED_FEATURE", "Unclassified schedule.");
    schedule.status = "known";
  } catch (error) {
    propagateReadFailure(error);
    schedule.reason = reason(error, "Some schedule relationships or payloads are unrecognized or unresolved. Null summaries in this section do not establish absence.");
  }

  const organization: { status: Status; url: { id: string; url: string } | null; tags: { id: string; name: string }[];
    otherAttachmentIds: string[]; reason: string | null } = { status: "unknown", url: null, tags: [], otherAttachmentIds: [], reason: null };
  let attachments: CloudKitRecord[] = [], hashtags: CloudKitRecord[] = [];
  try {
    const ids = { attachments: reminderOrganizationIds(root, owner, "url").map(id => `Attachment/${id}`),
      hashtags: reminderOrganizationIds(root, owner, "tags").map(id => `Hashtag/${id}`) };
    if (ids.attachments.length + ids.hashtags.length > 31) throw new AppError("UNSUPPORTED_FEATURE", "Organization budget exceeded.");
    const load = async (ids: string[], type: "Attachment" | "Hashtag") => {
      if (!ids.length) return [];
      const found = type === "Attachment" ? await client.lookupAttachments(ids) : await client.lookupHashtags(ids);
      requireNoReadErrors(found.recordErrors);
      if (!found.complete || found.unresolvedRecordNames.length || found.records.length !== ids.length || new Set(found.records.map(record => record.recordName)).size !== ids.length ||
        found.records.some(record => !("recordType" in record) || record.recordType !== type || !ids.includes(record.recordName)) || jsonBytes(found.records) > 262_144)
        throw new AppError("UNSUPPORTED_FEATURE", "Incomplete organization.");
      return found.records as CloudKitRecord[];
    };
    attachments = await load(ids.attachments, "Attachment"); hashtags = await load(ids.hashtags, "Hashtag");
    // The search reader rejects unclassified non-URL attachments rather than
    // interpreting an unknown attachment type as proof that there is no URL.
    readReminderOrganizationSelection(root, attachments, owner, "url");
    const details = readReminderOrganization(root, attachments, hashtags, owner);
    Object.assign(organization, { status: "known", url: details.url, tags: details.tags, otherAttachmentIds: details.otherAttachmentIds });
  } catch (error) {
    propagateReadFailure(error);
    organization.reason = reason(error, "The bounded URL and literal tag relationships could not all be classified. Empty values in this section do not establish absence.");
  }

  const category: { status: Status | "not_applicable"; assignment: ReturnType<typeof categorySummary> | null; reason: string | null } =
    { status: "unknown", assignment: null, reason: null };
  try {
    const marker = list.fields.ShouldCategorizeGroceryItems as { type?: unknown; value?: unknown } | undefined;
    const categoryMetadata = ["MembershipsOfRemindersInSectionsAsData", "MembershipsOfRemindersInSectionsChecksum", "SectionIDsOrderingAsData"]
      .some(key => Object.hasOwn(list.fields, key));
    if ((marker === undefined || marker?.type === "INT64" && marker.value === 0) && !categoryMetadata) {
      category.status = "not_applicable";
    } else {
      requireShoppingList(list, owner);
      const state = await loadShoppingAssets(client, list);
      const membership = state.memberships.memberships.find(entry => entry.memberID === reminder.id.slice("Reminder/".length).toUpperCase());
      if (membership) {
        const id = `ListSection/${membership.groupID}`, found = await client.lookupListSections([id]);
        requireNoReadErrors(found.recordErrors);
        if (!found.complete || found.unresolvedRecordNames.length || found.records.length !== 1 || !("recordType" in found.records[0]) ||
          found.records[0].recordName !== id || jsonBytes(found.records) > 262_144) throw new AppError("UNSUPPORTED_FEATURE", "Unresolved selected category.");
        const section = found.records[0] as CloudKitRecord;
        category.assignment = categorySummary({ ...section, zoneID: section.zoneID ?? list.zoneID }, owner, list.recordName);
      }
      category.status = "known";
    }
  } catch (error) {
    propagateReadFailure(error);
    category.reason = reason(error, "The selected Shopping category or bounded native membership asset could not be classified. Use get_shopping_categories to review supported metadata; no absence of assignment is claimed.");
  }

  // The normal complete membership reader has fixed page, record and byte
  // budgets. Reuse its reads in family planners so six checks do not rescan Apple.
  const lookups = new Map<string, ReturnType<CloudKitRemindersClient["lookup"]>>();
  const pages = new Map<string, ReturnType<CloudKitRemindersClient["queryRemindersPage"]>>();
  const familyClient = {
    lookup: (ids: string[]) => { const key = JSON.stringify(ids); if (!lookups.has(key)) lookups.set(key, client.lookup(ids)); return lookups.get(key)!; },
    lookupRelationshipRecords: (ids: string[]) => {
      const key = `relationships:${JSON.stringify(ids)}`;
      if (!lookups.has(key)) lookups.set(key, client.lookupRelationshipRecords(ids)); return lookups.get(key)!;
    },
    queryRemindersPage: (input: Parameters<CloudKitRemindersClient["queryRemindersPage"]>[0]) => {
      const key = JSON.stringify(input); if (!pages.has(key)) pages.set(key, client.queryRemindersPage(input)); return pages.get(key)!;
    },
  };
  const subtasks: { status: Status; parentReminderId: string | null; childIds: string[] | null; familyIds: string[] | null; reason: string | null } =
    { status: "unknown", parentReminderId: reminder.parentReminderId, childIds: null, familyIds: null, reason: null };
  let relationships: Map<string, string[]> | undefined;
  try {
    relationships = await inspectListChildren(familyClient, owner, list);
    const rootId = reminder.parentReminderId ?? reminder.id, childIds = relationships.get(rootId) ?? [];
    if (childIds.length > 30 || relationships.has(reminder.id) && reminder.parentReminderId || childIds.includes(rootId) || childIds.some(id => relationships!.has(id)) ||
      reminder.parentReminderId && !childIds.includes(reminder.id)) throw new AppError("UNSUPPORTED_FEATURE", "Unsupported family.");
    Object.assign(subtasks, { status: "known", childIds: relationships.get(reminder.id) ?? [], familyIds: [rootId, ...childIds] });
  } catch (error) {
    propagateReadFailure(error);
    subtasks.reason = reason(error, "Complete one-level relationships could not be established within the inspection budget. Read smaller supported families; no absence of children is claimed.");
  }

  const timestamp = Date.now();
  for (const action of ["complete", "reopen", "delete"] as const) {
    if (reminder.deleted !== false || current.deleted || !current.recordChangeTag || reminder.listId !== list.recordName) continue;
    if (options.recurrenceCalendarTimeZone !== undefined && !reminder.recurrenceRuleIds?.length) {
      actions[action] = check("unsupported", "recurrenceCalendarTimeZone applies only to the supported ended all-day daily recurrence. Omit it when inspecting ordinary lifecycle actions.");
      continue;
    }
    if (action !== "delete" && reminder.completed !== (action === "reopen")) {
      actions[action] = check("unsupported", action === "complete" ? "Completion requires an open reminder. Read its current state." : "Reopening requires a completed reminder. Read its current state.");
      continue;
    }
    try {
      if (subtasks.status !== "known") throw new AppError("UNSUPPORTED_FEATURE", "Unresolved family.");
      if (reminder.recurrenceRuleIds?.length) {
        if (!graph || relationships!.has(reminder.id)) throw new AppError("UNSUPPORTED_FEATURE", "Recurring source unavailable.");
        if (action === "delete") {
          await planRecurringDeletion(graph, list, owner, "all_future", undefined, timestamp, options.recurrenceCalendarTimeZone);
          actions.delete = check("requires_input", "The source supports native series deletion. Choose recurringDeletionScope=all_future to retire the series, or separately review occurrence eligibility with its exact version.", [reminder.id], ["recurringDeletionScope", "recordChangeTag"]);
        } else {
          const plan = await planRecurringCompletion(graph, list, owner, undefined, timestamp, action, options.recurrenceCalendarTimeZone);
          actions[action] = check("supported", plan.mode === "advance" ? "The native recurring recipe advances this root and creates a completed occurrence with a fresh identity at execution. Versions and next-date eligibility are checked again." : "The native final-occurrence recipe updates this exact root. Versions are checked again at execution.", [reminder.id]);
        }
      } else {
        const family = await inspectLifecycleFamily(familyClient, action, target, current, list, owner, true);
        if (family.records.some(record => normalizeReminder(record, owner).alarmIds?.length)) {
          const pairs = await loadScheduledFamilyPairs(schedulingClient, family, owner);
          const plan = planScheduledFamilyLifecycle(action, target, family, pairs, list, owner, timestamp);
          actions[action] = check("supported", "The native timed family recipe supports this action. Every family member, date pair and list version is checked again at execution.", plan.writes.map(write => write.recordName));
        } else {
          const plan = await planLifecycle(familyClient, action, target, current, list, owner, timestamp, family);
          actions[action] = check("supported", "The native ordinary family recipe supports this action. Exact participant versions are checked again at execution.", plan.writes.map(write => write.recordName));
        }
      }
    } catch (error) {
      propagateReadFailure(error);
      if (error instanceof AppError && error.message === "A nonmidnight recurrence EndDate requires an explicit recurrenceCalendarTimeZone.")
        actions[action] = check("requires_input", "This ended all-day daily recipe needs an explicit recurrenceCalendarTimeZone before eligibility can be determined. Supply the calendar zone and inspect again.", [reminder.id], ["recurrenceCalendarTimeZone", ...(action === "delete" ? ["recurringDeletionScope"] : [])]);
      else actions[action] = check("unsupported", reason(error, subtasks.status !== "known" ? subtasks.reason! :
        reminder.recurrenceRuleIds?.length ? "This recurring root is outside the native lifecycle recipes. Supported completion recipes include daily, timed weekly, ordinary timed monthly anchored to the current due date, all-day last-day monthly, and the observed timed monthly [28,29]/[-1] rule with a one-day early alert. Recurring deletion and reopening have separate recipes. Children, URL/tags, location alarms, assignments and other early-alert recipes are refused." :
        reminder.alarmIds?.length ? "The timed family must have one exact absolute date pair per scheduled member and no recurrence, early/location alarms, URL/tags or assignments." :
        "The ordinary one-level family or its exact completion/list metadata is outside the native lifecycle recipe. Review family relationships and current versions."));
    }
  }

  for (const action of ["move", "copy"] as const) {
    try {
      if (subtasks.status !== "known" || relationships!.has(reminder.id) || organization.status !== "known") throw new AppError("UNSUPPORTED_FEATURE", "Unresolved transfer source.");
      // Validate the actual source with the transfer planner's source gate;
      // destination-dependent recipe checks remain explicitly unperformed.
      requireOrdinaryTransfer(root, owner, { ...target, destinationListId: "List/inspection-destination", sourceListChangeTag: list.recordChangeTag ?? "", destinationListChangeTag: "inspection" });
      requireMutableList(list, owner);
      const members = normalizeList(list).reminderIds;
      if (!members || members.length > 2000 || new Set(members.map(id => id.toUpperCase())).size !== members.length ||
        members.some(id => !/^Reminder\/[0-9a-f-]{36}$/i.test(id)) || !members.some(id => id.toUpperCase() === reminder.id.toUpperCase()))
        throw new AppError("UNSUPPORTED_FEATURE", "Unsupported transfer membership.");
      if (attachments.length > 1) throw new AppError("UNSUPPORTED_FEATURE", "Unsupported transfer attachments.");
      attachments.forEach(record => normalizeURLAttachment(record, reminder.id, owner));
      hashtags.forEach(record => normalizeReminderTag(record, reminder.id, owner));
      if (action === "move") updateResolutionTokenMap(root, ["list", "lastModifiedDate"], timestamp);
      const relatedCount = attachments.length + hashtags.length;
      if (action === "move" ? relatedCount + 3 > 32 : relatedCount * 2 + 4 > 32) throw new AppError("UNSUPPORTED_FEATURE", "Transfer source exceeds atomic budget.");
      if (action === "copy" && (!CreateReminderInput.shape.title.safeParse(reminder.title ?? "").success ||
        !CreateReminderInput.shape.notes.safeParse(reminder.notes ?? "").success || !CreateReminderInput.shape.priority.safeParse(reminder.priority ?? 0).success || hashtags.length > 16))
        throw new AppError("UNSUPPORTED_FEATURE", "Unsupported copy contents.");
      actions[action] = check("requires_input", "The source is eligible. Supply a different owned private destination list and current source/destination list versions; the full native recipe and budgets are checked with that destination.", action === "move" ? [reminder.id] : [],
        ["destinationListId", "recordChangeTag", "sourceListChangeTag", "destinationListChangeTag", ...(action === "copy" ? ["idempotencyKey"] : [])]);
    } catch (error) {
      propagateReadFailure(error);
      actions[action] = check("unsupported", reason(error, "Transfers require a completely resolved, childless, open, undated ordinary root with supported URL/tags and exact source membership."));
    }
  }
  if (reminder.completed === false && reminder.deleted === false && !current.deleted && current.recordChangeTag)
    actions.update = check("requires_input", "Supply exact changes and the current recordChangeTag to prepare_reminder_update for a native read-only recipe preview. Eligibility depends on those changes; this inspection does not authorize or reserve a write.", [reminder.id], ["changes", "recordChangeTag"]);
  // Synthetic-only shape/equality diagnostics, without native UUIDs or binary values.
  const syntheticEarlyAlert = reminder.title?.startsWith("MCP protocol ") && schedule.earlyReminder ? (() => {
    const payload = earlyReminderPayload(root), alert = payload.dueDateDeltaAlerts[0];
    return { payload, alert };
  })() : null;
  const syntheticDiagnostics = syntheticEarlyAlert ? {
    alertIdentity: await fingerprint(["synthetic-alert-v1", reminder.title, syntheticEarlyAlert.alert.identifier]),
    accountIdentity: await fingerprint(["synthetic-account-v1", reminder.title, syntheticEarlyAlert.payload.accountIdentifier]),
    creationDate: syntheticEarlyAlert.alert.creationDate,
    acknowledgedDate: syntheticEarlyAlert.alert.acknowledgedDate ?? null,
    reminderIdentityMatches: true as const,
    minimumSupportedVersion: syntheticEarlyAlert.payload.minimumSupportedVersion,
  } : undefined;
  const result = { schedule, organization, category, subtasks, actions, inspectionOnly: true as const,
    ...(syntheticDiagnostics ? { syntheticEarlyAlert: syntheticDiagnostics } : {}) };
  if (jsonBytes(result) > 65_536) throw new AppError("UNSUPPORTED_FEATURE", "The normalized inspection exceeds its response byte budget.");
  return result;
}
