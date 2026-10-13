# Bounded connector create workflows

`CreateWorkflowService.run` creates one ordinary root and then, in order, applies
one prepared schedule update, `set_url`, and `set_tags`. Optional stages are
omitted. These are separate existing Apple mutations, not an atomic compound
native operation: a failure can leave a successfully created, partially configured
root. This module does not create children, roll back successful stages, or add
Apple protocol recipes.

## Wiring and request

Apply `migrations/0006_create_workflows.sql` to the deployment's D1 database.
The MCP tool `create_reminder_workflow` exposes the workflow with the same strict output.
The workflow requires enabled Reminders write permission and independent Apple Reminders approval; its inspection and preparation reads also require read permission.
The tool accepts optional `expectedGeneration`; omission uses the current session generation.
Fresh databases include the table in `schema.sql`; existing databases apply migration 0006. The module exports strict `CreateWorkflowInput` and
`CreateWorkflowOutput` schemas and an adapter for the existing service:

```ts
const workflow = new CreateWorkflowService(
  env, owner, createWorkflowAppleFacade(env, owner, appleConnectionService),
);
const result = await workflow.run(request);
```

The facade uses `AppleConnectionService.mutate`, `prepareUpdate`, and
`readReminderForMCP`. Its binding reads the current ready Apple session using
`AppleSessionRepository.load` and `accountScope`. Every service operation receives
the pinned `expectedGeneration`. The existing service's generation fencing and
the rule that account replacement advances generation must remain intact; a
custom facade must preserve these protections. Runtime envelope keys come from
`configuredEnvelopes(env)`; storage is required even for a single-stage workflow.

The input is `{ workflowId, expectedGeneration, create, schedule?, url?, tags? }`.
`create` uses `CreateReminderInput` without `idempotencyKey`. The caller generates
and retains one UUID `workflowId`; it is also the ordinary creation idempotency
key. The exact root is `Reminder/<uppercase workflowId>`. UUID case is normalized.
Creation defaults are normalized before hashing, so omitted defaults and their
explicit equivalents have the same meaning. A changed request with the same
identity conflicts, as do a different account or generation. A request is at
most 64 KiB, and a workflow issues at most four writes.

`schedule` accepts **exactly one** of these existing planner inputs:

- `{ recurrence: RecurrenceChanges }`: requires an all-day creation date and
  time zone, and excludes hourly frequency. Ordinary creation does not establish
  the absolute date-alarm graph needed for timed recurrence.
- `{ earlyReminder: EarlyReminder }`: requires a creation date. Preparation
  must find the existing versioned same-list private metadata witness; this
  workflow does not invent account metadata or bypass the bounded witness scan.
- `{ locationAlarm: LocationAlarmSummary }`: requires complete existing place,
  proximity, and radius parameters.

The module calls the existing preparation API against the confirmed root and
requires a supported plan and its token. Graph completeness, recurrence pattern,
alarm, witness, record-count, and request-byte constraints still belong to the
existing planners. An unsupported preparation blocks that stage and all later
stages, while returning earlier confirmed receipts. Combined scheduling features,
date conversions, date moves, partial location metadata, and new native recipes
are excluded. Existing planners establish support for the individual scheduling
features; this module makes no claim of evidence for simultaneous feature creation.

`url` and `tags` reuse the strict `URLChanges` and `TagChanges` values: a
credential-free HTTP(S) URL and up to 16 unique literal tags. Null URLs and empty
tag arrays are refused for a new root because they would request removal of
relationships that ordinary creation does not create. Omit those stages instead.

## Durable progress and recovery

An owner-scoped workflow has one exclusive SQL lease with a fixed 60-second
expiry and a random lease UUID. The lease is not extended. Claims and progress
writes compare the revision; each progress write also compares account,
generation, request hash, lease identity, and unexpired lease. Plaintext storage
contains only owner/account/request hashes, the workflow UUID, revision and
lease fences, and overall stage state. The entire normalized request, stage
receipts, exact root versions, and complete service root outcomes are encrypted
with owner/account/generation/workflow-bound authenticated envelope context.

Before **each** service mutation, the module durably saves `started` and the
exact input root version (null for creation, whose UUID establishes identity).
Confirmed results are saved under the same compare-and-swap fence. Before each
subsequent stage, a read must match the last confirmed root's exact stored
version. A native edit, completion, deletion, move, or changed session cannot
silently replace that version or authorize another write.

Stage statuses are `pending`, `started`, `confirmed`, `uncertain`, and `blocked`.
Overall states are `pending`, `paused`, `completed`, `blocked`, and
`recovery_required`. A transient failure before a durable start can return
`paused`; an identical request may resume its pending stages. A completed replay
returns the saved receipts without Apple writes. A pre-dispatch unsupported or
version-conflicting stage becomes `blocked` and is never resumed automatically.

**Any failure after a durable start is treated as uncertain.** This includes
service rejection, a lost Apple acknowledgement, malformed confirmation, or
failed persistence of the confirmation. No started or uncertain stage is ever
redispatched, including after its lease expires. An interrupted process may
leave `started` rather than `uncertain`; both mean read-only recovery. Earlier
confirmed stages remain confirmed, and later stages remain pending.

Repeating the exact tool request in that state invokes only
`readReminderForMCP` for the exact root. It returns `recovery.readOnly: true`,
the halted stage, and an inspection receipt or `missing`/`unavailable` status.
An observed version is **not** adopted as confirmation, even when it appears to
contain the intended changes. The workflow does not continue later writes or
offer a force-retry/adopt endpoint. Inspect the root using the normal read and
inspection tools and explicitly review any independent recovery operation.

Public output is strict: the UUID/key, exact root ID, pinned generation, overall
state, replay flag, and per-stage status, input version, failure category, and
confirmed root receipt. A receipt contains only `id`, `listId`, and
`recordChangeTag`; the complete root outcome remains encrypted in D1. Read the
normal reminder/organization APIs for contents. Raw Apple records, preparation
tokens, service errors, account identifiers, and envelope material are not public
workflow output. An account or generation mismatch returns `CONFLICT` even during
recovery.

## Verification and limitations

`tests/create-workflow.test.ts` uses the existing SQLiteD1 helper and synthetic
service callbacks that exercise ordinary creation, scheduling preparation, and
URL/tag planners. It checks service-instance resume, exact stage-version chains,
complete replay without changed Apple state, lost acknowledgements at every
stage, lost durable-start acknowledgements, expired in-flight leases, competing
SQL leases, owner/account/session isolation, native root-version changes, and
unsupported scheduling. Fixtures contain no real Apple credentials or contents.

This is synchronous bounded orchestration, not a queued job runner. Pending
work after an expired lease needs another identical call. Uncertain work always
requires inspection and explicit human reconciliation. There is no retention or
purge operation here: deleting a retained workflow would remove its no-replay
fence, so integration must not purge unresolved workflows or reuse their UUIDs.
Synthetic built-Worker journeys exercise the public tool. This follow-up was not deployed
and has no new live native acceptance beyond the existing individual-operation recipes.
