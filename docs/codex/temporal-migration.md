# Temporal migration and deletion map

Status: approved migration decision, 2026-08-03

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

For any run, exactly one runtime is authoritative. During migration:

- legacy runs are readable and may finish only while their migration fixture is still
  explicitly supported;
- Temporal fixture runs are created with a distinct runtime marker;
- no event, API handler, or UI action advances both runtimes;
- once parity passes, all new runs use Temporal;
- the runtime marker and legacy fork are then removed rather than retained forever.

SQLite and Temporal are not dual ledgers. Temporal owns execution; SQLite owns product
data and external-effect evidence.

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
  runner/                   delete after parity: custom execution runtime
```

Module names may change during implementation, but the ownership rule may not: no
Temporal-shaped leases/cursors are recreated under a different folder.

## Expected deletion surface

After T1–T5 parity, delete or heavily reduce:

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

Legacy run history is not imported into Temporal as synthetic Event History.

1. Keep legacy runs readable through their existing projection during the short
   migration window.
2. Export a compact immutable debug bundle containing graph, state, decisions,
   artifacts, attempts, and terminal/open wait.
3. Do not resume an arbitrary half-complete legacy run inside a new Temporal Workflow;
   that would manufacture execution semantics without real history.
4. For selected non-mutating development fixtures, start a new Temporal run explicitly
   from an operator-reviewed checkpoint artifact.
5. Once no valuable active legacy run remains, remove the legacy runtime tables/code;
   retain debug bundles as ordinary artifacts if useful.

Because real repository/remote mutation is not enabled in the current stub runtime,
this clean cutover is practical now. Delaying until after real pushes/PRs would make the
migration materially riskier.

## First vertical slice

The walking skeleton consumes an already accepted task-specific graph and supports:

```text
start -> stub Activity -> bounded branch/loop -> durable wait -> operator Update -> done
```

It must run two tasks concurrently, survive worker/API restart, and display independent
states in the console. It intentionally excludes real agent work, external mutation,
graph children, and production deployment. Those are downstream Activities/product
features, not prerequisites for proving the kernel boundary.

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
- [ ] Workflow module dependency isolation enforced.
- [ ] T1–T5 milestone gates pass.
- [ ] Representative histories replay against release worker.
- [ ] Event History/Search Attribute payload audit passes.
- [ ] External-effect crash matrix passes for every enabled mutation.
- [ ] UI/API no longer depends on legacy scheduler state.
- [ ] No new legacy runs can be created.
- [ ] Valuable legacy runs exported/read-only or explicitly closed.
- [ ] Legacy runtime code/tests/tables/config removed.
- [ ] Full lint/typecheck/unit/integration/e2e suite passes after deletion.
- [ ] Docs and operator guide describe only the final runtime, with historical files
      clearly marked.

## Rollback

Before cutover, a Temporal slice can be removed without changing legacy fixture runs.
After cutover, rollback means deploying the previous compatible Temporal Worker/API
build through Temporal's versioning strategy. It does not mean re-enabling the custom
scheduler for the same Workflow IDs.

## Decision warning

Future contributors must not interpret “Temporal owns durability” as “put all Tasker
logic in one Workflow file.” Blocks, policies, adapters, prompts, artifacts, and product
projections remain replaceable boundaries. Conversely, they must not interpret “Tasker
needs observability” as permission to recreate a second execution ledger. These two
errors are the main ways the migration could produce a larger Frankenstein instead of
a smaller Tasker.
