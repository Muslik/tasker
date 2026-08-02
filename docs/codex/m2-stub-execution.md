# M2: durable stub execution — first vertical slice

Status: implemented and verified 2026-08-02

Scope: start an already accepted workflow, persist progress after every executable
node, recover that cursor after a process restart, and stop at a durable external wait.
This is the first M2 slice, not the complete M2 milestone.

## Operator path

1. Generate a valid workflow as before.
2. Press **Test workflow** in the task header. This never starts a real provider or
   repository operation.
3. The task becomes `running` while the run is executable.
4. Every deterministic stub step appends a ledger event and a unique effect receipt.
5. A `code_review@1` node changes the task to `code_review`, marks the workflow rail
   as waiting, and releases the conceptual runner slot.
6. Reloading Tasker restores the same run, wait, activity, receipts, and graph state.

The normal HTTP path is:

- `POST /api/workflows/:taskReference/start` — create or resume the one current run;
- `GET /api/workflows/:taskReference/run` — inspect its durable projection;
- `POST /api/workflows/:taskReference/resume` — resolve the current wait and continue;
- `GET /api/runs/:runId` — inspect the lower-level run projection.

`Start` is idempotent. Calling it again while the run is waiting or complete returns
the current projection and appends nothing.

## What is persisted

The accepted compiled graph remains immutable. M2 derives a linear execution plan from
that graph and stores it in a separate run projection together with:

- graph ID and hash;
- current cursor and status;
- per-node runtime states;
- deterministic effect keys and stub receipts;
- the current wait, including wait kind and slot policy;
- start, update, and completion timestamps.

The run aggregate is `run:<taskReference>`. Each node transition is its own atomic
ledger transaction that appends one event and advances both `m2_run_by_task` and
`m1_run` projections. The cursor advances only in the same transaction that persists
the corresponding receipt. This is the key no-lost-work boundary: after a crash the
runner reads the projection and starts at the first uncommitted node.

Effect keys have the stable form
`<runId>:<nodeId>:attempt-1`. A restarted process therefore does not invent a new
identity for completed work. The current stub implementation never invokes remote
effects, but it exercises the persistence contract later real executors must obey.

## Current graph semantics

The first slice intentionally keeps runtime policy deterministic:

- sequence children execute in order;
- a bounded loop succeeds on its first stub attempt;
- a branch selects `then` because predicate execution is not part of this slice;
- step nodes write a stub receipt;
- wait and gate nodes open a durable wait;
- finalize writes the terminal outcome.

These choices are test semantics, not the final agent behavior. Real predicates,
additional loop attempts, provider retries, and runtime workflow continuations remain
explicit later M2 work. They will advance the same aggregate rather than replacing the
current graph or rerunning its completed prefix.

## Wait and resume

Opening a wait does not advance past its node. The projection records its node ID,
resolution kind, opened time, and `release|retain` slot policy. Resolving it writes a
signal and `WaitResolved` event atomically, marks only that node succeeded, advances
one cursor, and continues.

The first UI stops at code review. The resume endpoint exists to exercise the durable
signal boundary; PR comment ingestion and review dispositions belong to the later
Bitbucket/CI integration milestone.

## Realtime console

Run events share the existing SSE stream. The center activity surface shows run start,
each completed step, opened/resolved waits, and completion. The left queue derives
`running`, `waiting`, `code_review`, or `done` from the run projection. The right graph
derives container state from its children and renders planned, running, waiting,
succeeded, skipped, or failed nodes.

## Verified recovery

The recovery test deliberately stops after two committed steps, closes SQLite, opens
the same database through new service instances, and calls `Start` again. Execution
continues from cursor 2, reaches the code-review wait, and produces exactly one receipt
per stubbed step. A duplicate start at the wait appends no event. Resolving the wait
then reaches the terminal node and retains the same `m1_run` projection.

Verification at delivery:

- 110 Vitest tests across 26 files;
- one dedicated kill/restart/no-duplicate recovery scenario;
- one HTTP contract scenario for start, activity, task state, and runtime tree state;
- 8 Playwright operator scenarios, including **Test workflow -> code review wait**;
- formatting, server/cockpit typecheck, lint, and production builds green.

## Still required for the full M2 gate

- queue capacity, leases, fence tokens, heartbeat, and outbox dispatch;
- real predicate evaluation and multi-attempt loops;
- duplicate signal classification and correlation policies;
- quota waits and proof that another queued run reuses the slot;
- intervention as a new attempt with prior-attempt lineage;
- `workflow_change_required` as an immutable linked continuation;
- manual takeover, write freeze, reconciliation, and handoff packet;
- time/cost aggregation, attempt transcripts, and debug bundle controls;
- projection rebuild from events and the complete kill-injection matrix.
