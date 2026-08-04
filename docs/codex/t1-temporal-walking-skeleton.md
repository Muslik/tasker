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

The control plane accepts exactly one execution port: Temporal. There is no runtime
selector and no fallback scheduler when Temporal or a worker is unavailable.

## Local topology

Install Temporal CLI once:

```bash
brew install temporal
```

The normal local path is one command:

```bash
pnpm dev
```

It builds the app once, starts or reuses the local Temporal service, starts the Worker
and API/operator console, waits for the Temporal-backed health response, and owns
coordinated shutdown. The development service creates namespace `tasker-dev`, listens
on `127.0.0.1:7233`, and serves Temporal UI at `http://127.0.0.1:8233`. Tasker remains
at `http://127.0.0.1:4311`.

Use `pnpm temporal:dev`, `pnpm temporal:worker`, `pnpm temporal:api`, and
`pnpm dev:cockpit` separately only when diagnosing one process boundary.

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

## Current boundary after cutover

Later slices replaced the original deterministic T1 Activities with snapshotted agent
and process block execution, managed workspaces, plan revision and clarification,
operator guidance, and validated Child Workflows. The walking skeleton remains the
runtime contract, not a second implementation.

The remaining product boundary is external mutation: Jira transitions/comments,
Bitbucket PR lifecycle, Jenkins/Allure observation, and publication must run through
effect-safe Activities with intent, receipt, and reconciliation evidence. Task Queue
health, richer cost/retrospective views, and production Worker deployment are also
follow-up work. None requires restoring a custom scheduler.
