# T1 Temporal walking skeleton

Status: implemented and verified locally, 2026-08-03.

## What this slice proves

Tasker can submit an already compiled task-specific graph to one generic Temporal
Workflow. The Workflow interprets sequences, steps, branches, bounded loops, waits,
gates, and finalization. It exposes a typed public-state Query and accepts a validated
Update for the active operator wait.

Temporal owns runtime position, Activity retry, wait durability, and replay for every
run started through the Temporal runtime. SQLite stores only the Tasker product index
that links a task reference to its Temporal Workflow ID, Run ID, workflow hash, and
immutable start settings. It does not independently advance Temporal nodes.

The control plane accepts exactly one execution port:

- `legacy_stub` keeps existing pre-Temporal runs readable during migration;
- `temporal` starts and controls only Temporal runs;
- the TypeScript API options make configuring both runtimes together invalid.

There is no fallback from Temporal to the legacy scheduler when Temporal or a worker is
unavailable.

## Local topology

Install Temporal CLI once:

```bash
brew install temporal
```

Then use four terminals:

```bash
pnpm temporal:dev
pnpm temporal:worker
pnpm temporal:api
pnpm dev:cockpit
```

The development service creates namespace `tasker-dev`, listens on `127.0.0.1:7233`,
and serves Temporal UI at `http://127.0.0.1:8233`. Tasker remains at
`http://127.0.0.1:4311`.

The local database `.tasker/temporal.sqlite` is development state, not a production
durability design. Delete it only when intentionally resetting all local Temporal
history.

## Operator behavior

Starting a generated workflow returns both Temporal identifiers. The task list and
right-hand graph are derived from the Workflow Query:

- a required plan gate appears as `plan_review`;
- code review appears as `code_review`;
- other durable waits appear as `waiting`;
- unavailable Temporal Query/service state appears as `needs_attention`;
- completed workflows appear as `done`.

Approving a plan sends an Update for the exact active node and wait kind. A generic
resume command does the same for other waits. A stale or duplicate command is rejected
without failing the Workflow Execution.

## Recovery evidence

Automated Temporal integration tests use the official time-skipping test environment
and real worker bundles. They prove:

- two task graphs execute independently and stop at different waits;
- a replacement worker reconstructs the wait from Event History;
- an Update after cold replay advances only the addressed workflow;
- a duplicate Update is rejected without damaging the workflow;
- a transient Activity error retries only that Activity boundary;
- Workflow ID and Run ID are recorded in the Tasker product projection.

A real local Temporal CLI service was also exercised with two fixture workflows. After
both API and worker restart, both tasks returned to their existing `code_review` waits;
resuming one completed only that run.

## Deliberate T1 limits

This is the durable execution skeleton, not the real coding agent yet:

- T1 Activities return deterministic stub results and perform no repository or remote
  mutation;
- plan `request_changes`, agent questions, workflow revisions, worktrees, provider
  transcripts/cost, Jira/Bitbucket/Jenkins effects, and retrospective data migrate in
  T2–T5;
- Temporal mode therefore supports plan approval but rejects plan revision explicitly;
- the legacy runtime remains the default until those behaviors have Temporal parity;
- worker availability is visible through per-task Query failure, while richer Task
  Queue health and bounded projection streaming remain follow-up work.

These limits are migration gates, not permanent dual-runtime architecture. New
features must target Temporal; the custom scheduler is deleted after parity.
