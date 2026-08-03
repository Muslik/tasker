# Temporal migration and deletion map

Status: runtime cutover and release verification complete, 2026-08-03

## Why this migration exists

M0–M2 intentionally proved the hard product questions before real external mutation:
can Tasker assemble a workflow per task, validate it, show it to an operator, pause for
plan/review/questions, preserve evidence, and continue after a late discovery? The
answer is yes.

The proof also exposed an infrastructure boundary that Tasker should not own. Queue
admission, leases/fencing, execution cursors, retry timers, waits/signals, crash
recovery, and parent/child scheduling are a durable-execution system. Temporal already
provides these with a mature TypeScript SDK and operational model. Continuing the
custom implementation would spend the project on infrastructure rather than the
quality of coding workflows.

## Preserve, replace, delete

| Existing capability | Target |
|---|---|
| task normalization and Jira cache | preserve in Tasker product store |
| repository binding/catalog/managed checkout | preserve; invoke through Activities |
| dynamic analyzer and `WorkflowSource` | preserve |
| IR canonicalization/hash/compiler/validator | preserve and isolate as pure code |
| step catalog, prompts, skills, company/project policy | preserve |
| graph rationale and diagnostics | preserve |
| implementation planning and revisions | preserve; execute as Activities/messages |
| operator cockpit | preserve; read Temporal runtime state plus Tasker product data |
| artifacts/transcripts/cost/retrospective | preserve outside Event History |
| custom ready-set/queue scheduler | replace with Temporal Task Queues/Workers |
| leases and fence tokens | replace with Temporal Activity delivery/timeout/heartbeat |
| custom execution cursor | replace with Workflow Event History/state |
| custom wait/signal table | replace with Signals/Updates/conditions/timers |
| custom retry/backoff scheduling | replace with Activity Retry Policy/Workflow timers |
| custom parent/child join scheduling | replace with Child Workflows where appropriate |
| execution state in SQLite projections | reduce to cache/index with explicit staleness |
| external effect intent/receipt/reconciliation | preserve; Temporal does not solve it |

## Runtime authority rule

For any run, exactly one runtime is authoritative. Tasker now starts, queries, and
resumes runs only through Temporal. There is no runtime selector or fallback to the
deleted custom executor.

SQLite and Temporal are not dual ledgers. Temporal owns execution; SQLite owns product
data and external-effect evidence. The product schema contains no execution outbox or
signal table; Temporal owns Activity delivery and Workflow messages.

## Target code ownership

```text
src/
  workflow/                 keep: IR, compiler, validator, pure interpreter helpers
  harness/                  keep: blocks, prompts/skills/policy loading
  planning/                 keep: analyzer/planner domain and schemas
  temporal/                 add: client, Worker, Workflows, Activities, messages
  integrations/             keep/adapt: Jira/Bitbucket/Jenkins/Confluence
  repositories/             keep/adapt: catalog/checkout/worktree/bootstrap
  control-plane/            simplify: API and projection, no scheduler ownership
  ledger/                   shrink/rename: product/artifact/effect store only
  runner/                   deleted: no Tasker-owned execution runtime remains
```

Module names may change during implementation, but the ownership rule may not: no
Temporal-shaped leases/cursors are recreated under a different folder.

## Expected deletion surface

The cutover deleted or heavily reduced:

- `src/runner/stub-runner.ts` and the custom scheduler path;
- lease/fence acquisition, renewal, replacement, and stale-owner writes;
- ready-set and global stub-capacity state;
- custom execution cursor/checkpoint and node-dispatch transactions;
- custom wait open/resume tables and wakeup scanning;
- retry/backoff timer persistence owned only by execution;
- scheduler-specific control-plane boot/shutdown and environment variables;
- duplicate run-state projection transitions that are derivable from Temporal;
- tests asserting those implementation details.

Do not delete:

- external operation intents/receipts/reconciliation evidence;
- graph source, accepted hash, decisions, provenance, and artifacts;
- task/Jira/repository/worktree/product projections;
- cost, transcript, media, test, CI, and retrospective evidence;
- public behavior tests that prove recovery and no duplicate effects.

The migration should remove thousands of lines, but deletion happens only after public
behavior is covered. Line count is evidence of simplification, not the acceptance
criterion.

## Data migration

The deleted runtime executed development fixtures only and had no valuable active
remote-mutating runs. Its history was therefore not manufactured into Temporal Event
History. Existing product artifacts remain ordinary Tasker data; new execution starts
as an explicit Temporal run.

## First vertical slice

The runtime consumes an accepted task-specific graph and supports:

```text
start -> workspace/planning Activity -> agent/process blocks -> branch/loop
      -> durable wait or validated Child Workflow -> operator Update -> done
```

It runs tasks independently, survives worker/API replacement, and displays independent
states in the console. Real remote mutations remain downstream effect-safe Activities;
they are product work, not a reason to keep a second runtime.

## Parity matrix

| Behavior already proved | Temporal proof required before deletion |
|---|---|
| accepted graph stable after reload | same graph input/hash visible after API/worker restart |
| bounded parallel fixture runs | two Temporal Workflows progress independently |
| plan-review wait and feedback | Update creates immutable revision attempt and resumes one run |
| blocking question | answer Update survives restart and is consumed once |
| code-review wait | Signal/Update resumes only matching run |
| restart-safe node cursor | worker kill redelivers only pending Activity |
| bounded retry/loop | attempt and loop budget stop deterministically |
| workflow continuation | validated revision/Child Workflow preserves parent prefix |
| operator graph/activity projection | UI restores from Temporal + Tasker product data |
| no duplicate stub receipts | no duplicate real effect under crash matrix |

## Failure rules during migration

- Temporal unavailable: Tasker shows runtime unavailable and does not fall back to the
  legacy scheduler for a Temporal run.
- Worker unavailable: Workflow remains pending; starting a compatible worker continues
  it.
- API/cockpit unavailable: Workflow continues or waits; reopening reconstructs state.
- Tasker product store unavailable to an Activity: retry according to safe policy;
  Workflow history remains authoritative.
- Activity outcome unknown after external mutation: reconcile or open attention; never
  restart the task or blindly repeat.
- incompatible worker deployment: stop routing new work and use versioning/replay
  evidence; do not patch Event History.

## Cutover checklist

- [x] Temporal SDK versions pinned and tested CLI/server versions documented.
- [x] Workflow module dependency isolation enforced by the Temporal bundle.
- [x] Runtime parity needed for deletion passes.
- [x] Representative history replays against the current worker bundle.
- [x] Event History input boundary rejects vendor payloads and secrets.
- [x] External-effect crash matrix passes for every enabled mutation; no remote mutation
      adapter is enabled at cutover, and each future adapter must add this evidence.
- [x] UI/API no longer depend on legacy scheduler state.
- [x] No new legacy runs can be created.
- [x] No valuable active legacy runs required export.
- [x] Legacy runtime code/tests/tables/config removed.
- [x] Full lint/typecheck/unit/integration/e2e suite passes after deletion.
- [x] Docs and operator guide describe only the final runtime, with historical files
      clearly marked.

Current cutover evidence on 2026-08-03:

- `pnpm verify` passes: formatting, server/cockpit typecheck, lint, 118 Vitest tests,
  and the production server/cockpit build;
- explicit replay, payload-boundary, recovery, block-execution, and repository tests
  pass;
- `pnpm test:e2e` passes all 12 Temporal-backed cockpit scenarios without retries;
- the cutover diff removes 5,300+ net lines, including the runner, scheduler,
  lease/fence/runtime contracts, M0-only demo/domain code, and implementation-detail
  tests.

## Rollback

Rollback means deploying a previous compatible Temporal Worker/API build through
Temporal's versioning strategy. It does not mean re-enabling a custom scheduler for
the same Workflow IDs.

## Decision warning

Future contributors must not interpret “Temporal owns durability” as “put all Tasker
logic in one Workflow file.” Blocks, policies, adapters, prompts, artifacts, and product
projections remain replaceable boundaries. Conversely, they must not interpret “Tasker
needs observability” as permission to recreate a second execution ledger. These two
errors are the main ways the migration could produce a larger Frankenstein instead of
a smaller Tasker.
