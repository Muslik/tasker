# Tasker: detailed implementation plan

Status: approved by Planner -> Architect -> Critic consensus, v3  
Date: 2026-08-01  
Depends on: [`architecture.md`](architecture.md)  
Acceptance source: [`test-spec.md`](test-spec.md)

## 1. What becomes testable, and when

This is the delivery ladder. A milestone is not complete because code exists; it is
complete only after its operator demo and deterministic evidence pass.

| Milestone | What the owner can actually test | Near-horizon forecast |
|---|---|---|
| M1 | `fixture task -> compiled workflow -> visible tree in local cockpit` | after M0+M1, roughly 6-10 focused implementation days |
| M1.5 | `normalized task + real read-only repository inspection -> provider proposal -> validated visible workflow` | implemented and verified 2026-08-01 |
| M1.6 | `Jira key -> persisted current task snapshot -> operator details`, including cached recovery after `403` without sync-log growth | implemented and verified 2026-08-01 |
| M1.7 | `Jira repo:name or import fallback -> Bitbucket lookup -> managed application-data checkout` | implemented and verified 2026-08-02 |
| M1.8 | `Jira snapshot + managed checkout -> read-only analyzer -> validated persisted workflow -> visible operator graph` | implemented and verified 2026-08-02 |
| M2 | `task -> visible workflow -> complete stub traversal`, including kill/restart, wait/resume, intervention, and handoff | after M0-M2, roughly 12-20 focused days |
| M3 | one real subscription CLI executes a node in that same workflow | re-estimate after M2; planning envelope 3-6 focused days |
| M4 | a real provider changes an isolated worktree; a recoverable failure resumes at the failed node | re-estimate after M3; planning envelope 4-7 days |
| M5 | real Jira intake handles `400`, `not_eligible`, and eligible task compilation without partial runs | after the M4 worktree/recovery contract is green |
| M6 | real `Jira -> code/worktree -> PR -> concurrent CI/review -> revise -> waiting_for_review` | dependency-gated; do not promise a calendar date before M4 evidence |
| M7 | translation upload -> slot-free external wait -> signal -> translation pull | after generic waits and Loop/signal adapter exist |
| M8 | parent task -> linked cross-repo child -> dev publish -> parent verify -> human final publish -> resume | after single-run recovery and effects are proven |

The first workflow picture is therefore **M1**, not the end of the integration project.
M1.5 replaces the deterministic fixture analyzer with a real subscription-CLI analyzer
without granting write or execution authority. It is the first point where the owner
can give Tasker a task plus a repository and inspect the workflow assembled from both.
The first full walk through the picture is **M2** on deterministic stub steps. This
ordering is intentional: UI, compiler, and runtime semantics can be corrected before
Jira, Bitbucket, and Jenkins make failures expensive to diagnose.

Forecasts are focused implementation effort, not elapsed calendar promises. The repo
currently has no application code. M3 and later estimates are planning envelopes that
must be recalculated at the preceding gate.

## 2. RALPLAN-DR summary

### Principles

1. Ledger/replay correctness precedes real remote effects.
2. The earliest increments are independently demonstrable.
3. Waiting, human steering, and human ownership are different contracts.
4. Dynamic graphs use a stable IR and registered step ABI, never arbitrary executable
   plans from an LLM.
5. A remote error resumes at the smallest proven-safe cursor.

### Decision drivers

1. Preserve work and causal history under provider, process, infrastructure, CI, and
   human interruptions.
2. Make task-specific workflow generation inspectable and extensible without losing
   deterministic validation/replay.
3. Reuse the existing work harness and subscription CLIs while keeping personal
   operations simple.

### Options

#### A. Ledger-first modular monolith — selected

Best fit for worktree ownership, immutable intervention, effect reconciliation, and
cost/debug evidence. Cost: custom scheduler and reducer code.

#### B. External durable scheduler under a custom domain ledger

Good future escape hatch for multi-host timers/wakeups. Rejected for the first wave
because it creates a second operational/history surface before product proof.

#### C. Graph/checkpoint framework as the system of record

Fast graph vocabulary, but poor ownership and side-effect semantics for the top-level
task lifecycle. LangGraph and equivalent graph/checkpoint runtimes are not used at the
top level or inside agent steps; providers remain bounded subprocess adapters.

## 3. Cross-milestone working rules

### 3.1 Definition of done for every milestone

Every milestone must produce:

- runnable code and migrations;
- named green acceptance scenarios from `test-spec.md`;
- an operator demo script run against persisted state;
- a `DebugBundle` for at least one successful and one interrupted path;
- a short decision/change log;
- explicit known gaps and the next milestone entry decision.

### 3.2 Branching and rollback

- Build milestone slices behind explicit feature flags until their readiness gate is
  green.
- Schema migrations are additive during a milestone. A destructive rewrite requires a
  fixture export/reimport tool and separate approval.
- Integration adapters can be disabled independently without disabling ledger replay
  or graph inspection.
- A failed milestone does not force deletion of persisted evidence; it leaves the last
  compatible read-only cockpit usable.

### 3.3 Test order

For each behavior:

1. reducer/state invariant;
2. repository/transaction contract;
3. adapter contract with deterministic fixture server/process;
4. process-kill/restart evidence where applicable;
5. operator-level E2E demo.

### 3.4 Scope discipline

- Do not implement child runs before one-run wait/recovery is green.
- Do not implement rich in-run graph revisions before immutable graph and replay are
  green.
- Do not add a second/third provider until the first provider is stable through M6.
- Do not add VPS execution before local runner protocol and artifact redaction pass.
- Do not add external observability as a source of truth.

## 4. Milestone 0 — contracts and runnable skeleton

### Goal

Create a compilable modular-monolith skeleton and freeze the minimum contracts that
all parallel work must share.

### Entry criteria

- `architecture.md` and `test-spec.md` are approved as the source of truth.
- `/Users/dzhabrail/Projects/work/harness` integration scripts and worktree hooks are
  mapped, but not copied or rewritten.

### Implementation steps

1. Initialize Node.js/TypeScript workspace and package scripts for build, typecheck,
   lint, unit, integration, and E2E. Pin Node.js 24 LTS, pnpm, ESM, and the strict
   compiler flags from `technology-decisions.md`.
2. Create module boundaries under `src/domain`, `src/ledger`, `src/workflow`,
   `src/queue`, `src/runner`, `src/providers`, `src/integrations`, `src/review`,
   `src/observability`, and `src/app`.
3. Define IDs, event envelope, schema version, aggregate expected version, correlation
   and causation IDs, actor, timestamps, redaction status, and artifact references.
4. Define `IntakeRequest`, `Task`, `Run`, `Step`, `Attempt`, `Wait`,
   `InterventionEvent`, `ManualTakeover`, `ReviewCycle`, `ProviderAttempt`, and
   `MutationReceipt` command/event fixtures.
5. Add Zod schemas and the pure TypeScript authoring DSL for the first-wave workflow
   IR plus StepType/Predicate/Wait ABI. Agent proposals remain JSON; compile and hash
   canonical JSON rather than executing generated source.
6. Add `better-sqlite3` and create the explicit SQL migration baseline for events,
   aggregate heads, snapshots,
   projections, outbox, leases, signals, artifacts, and schema metadata.
7. Implement the fixed transaction-order test harness with CAS and fence tokens.
8. Add deterministic clock/ID providers and fixture builders.
9. Add source-side redaction hook before any event/transcript persistence.
10. Configure Vitest projects and fast-check, then write architecture contract tests
    before implementing business reducers.

### Acceptance evidence

- unsupported event/snapshot/step ABI version quarantines rather than continuing;
- CAS rejects stale aggregate mutation without outbox visibility;
- stale fence token cannot complete/release a run;
- Jira-400 fixture can exist as `IntakeRequest` without creating Task/Run rows;
- first-wave graph schema rejects an unbounded loop and unknown step type;
- secret-bearing fixture is redacted or blocked before durable write.

### Operator demo

1. Run migrations into an empty local database.
2. Inspect the schema/version report.
3. Execute contract fixtures for intake failure, quota wait, intervention, and
   takeover transitions.
4. Show that no remote command exists yet and no unsafe effect can run.

### Artifacts

- schema diagram and migration manifest;
- event/command/IR JSON schemas;
- contract-fixture catalog;
- M0 debug bundle;
- brownfield adapter map.

### Rollback/containment

If the domain expands uncontrollably, reserve later aggregate names but implement only
IntakeRequest/Task/Run/Step/Attempt/Wait in code. ManualTakeover and review fixtures
must still remain in the schema contract so their future addition does not break IDs.

### Estimate

2-4 focused days. Re-estimate M1 after schema and module skeleton are green.

M0 dependencies are limited to TypeScript, Zod, `better-sqlite3`, Pino, Vitest,
`@vitest/coverage-v8`, fast-check, ESLint/`typescript-eslint`, and Prettier. Do not
introduce XState, Effect/neverthrow, an ORM, a queue, or a retry library.
LangGraph, ts-pattern, Robot/RxJS/Redux Saga, and other domain/control-flow runtimes are
also out of scope; use plain typed reducers and exhaustive native switches.

## 5. Milestone 1 — visible `task -> generated workflow`

Status: **implemented and verified on 2026-08-01**. See
[`m1-implementation.md`](m1-implementation.md) for commands and evidence.

### Goal

Deliver the first user-visible value: submit a fixture task and inspect the exact
workflow Tasker proposes before any provider or integration executes.

### Entry criteria

- M0 migrations and contract suite are green.
- At least three fixture snapshots exist: short bug, long feature/review, translation
  or cross-repo-capable task.

### Implementation steps

1. Implement successful `IntakeRequest -> Task` creation from a local fixture.
2. Implement a versioned step registry and two initial templates:
   `short_bugfix` and `feature_with_review`.
3. Implement analyzer output as an untrusted `WorkflowProposal` artifact.
4. Implement deterministic compiler/validator that materializes the immutable graph.
5. Persist snapshot, validator report, graph hash, provider capabilities, retry
   budgets, waits, expected artifacts, verification-plan rationale, and ordered
   workflow-assembly decisions.
6. Implement graph diff from template to task-specific graph.
7. Add local HTTP read API for intake/task/run/graph projections.
8. Add a React/Vite operator console with:
   - a left task queue with persisted statuses and attention state;
   - a center task surface with **Why this workflow** and the persisted activity
     timeline;
   - a right sticky current-workflow tree with node type/status/retry budget/waits;
   - verification profile and rationale;
   - validation errors and graph JSON download;
   - a native SSE feed that announces new ledger events and refreshes projections;
   - the raw template diff collapsed under diagnostics rather than used as the main
     workflow explanation.
9. Keep the cockpit read-only in this milestone.
10. Add a CLI graph renderer as a fallback/debug surface.

### Acceptance evidence

- four accepted task/policy combinations compile into distinct valid graphs;
- copy intent in an external-translation project adds extract/wait/pull, while the
  inline/JSON project adds none of those nodes;
- identical task/policy input produces the same graph hash;
- unknown step, missing terminal path, unmet capability, unsafe effect, or unbounded
  loop is shown as a validation failure and cannot be queued;
- graph and template diff survive restart and render from projections;
- no LLM output is executed during this milestone.

### Operator demo

1. Open the local cockpit.
2. Choose a fixture task.
3. Click `Generate workflow` and see the left status and center ledger activity update
   from the event stream.
4. Inspect **Why this workflow**, the right-side tree, waits, bounded loops, and
   verification rationale; expand the template diff only when debugging the compiler.
5. restart the process and show the same persisted graph/hash.
6. submit an invalid graph fixture and show a precise validator error.

### Artifacts

- four compiled task/policy fixtures;
- graph/template diff artifacts;
- cockpit screenshot/video;
- validator report examples;
- successful and rejected debug bundles.

### Rollback/containment

If the React view delays the milestone, render the same persisted graph as a simple
HTML tree served by the API. Do not defer the visual demo itself.

### Estimate

4-6 focused days. Cumulative near-horizon forecast after M0: 6-10 focused days.

## 5.5 Milestone 1.5 — real read-only workflow assembly

### Goal

Use one subscription-authenticated CLI to inspect a normalized task and its repository
read-only, return a structured workflow proposal, then pass that proposal through the
same deterministic compiler/validator and cockpit used by M1.

### Entry criteria

- M1 proposal, compiler, persistence, and cockpit contracts are green.
- the provider adapter can run with an explicit read-only sandbox and structured final
  output;
- the normalized task and repository workflow-policy snapshot are available locally.

### Implementation steps

1. Extract a `WorkflowAnalyzerPort` whose output is untrusted JSON, not executable code.
2. Define a narrow analyzer-output schema: proposed workflow source, assembly decisions,
   and verification plan. Derive capabilities, waits, retry budgets, expected artifacts,
   template diff, and graph hash inside Tasker.
3. Add a Codex CLI adapter using saved ChatGPT subscription authentication,
   non-interactive `exec`, `--ephemeral`, `--sandbox read-only`, and
   `--output-schema`.
4. Capture provider/session ID, CLI version, duration, structured usage, stderr, and
   final proposal as redaction-aware attempt evidence.
5. Add a command accepting task snapshot, repository path, and database path; compile
   and persist the accepted or rejected result through the existing M1 store.
6. Show analyzer provenance, duration, and measured token fields in the cockpit without
   claiming an API dollar charge.
7. Keep deterministic fixtures as the test adapter and offline fallback, not as the
   production analyzer.
8. Add the typed `workflow_change_required` step outcome and preserved replan contract
   for M2. It does not mutate an M1 graph or execute a child run yet.

### Acceptance evidence

- the provider inspects a real repository in read-only mode and produces a proposal
  that either compiles or is rejected with the normal validator report;
- a malicious/invalid proposal cannot introduce an unknown step, unbounded loop, unsafe
  effect, or unavailable capability;
- replay of the persisted proposal produces the same graph hash without another
  provider call;
- provider duration/session/usage evidence is visible and clearly distinguished from
  hypothetical API cost;
- no repository file changes after analysis;
- a typed late discovery can request replanning only by preserving evidence and
  entering a recoverable gate.

### Operator demo

1. Choose a task snapshot and a real local repository.
2. Run the analyzer and watch the provider attempt in the center activity surface.
3. Inspect the generated graph and **Why this workflow** decisions.
4. restart Tasker and show the identical persisted graph without calling the provider.
5. feed an unsafe analyzer fixture and show deterministic rejection.

### Rollback/containment

If the provider is unavailable or quota-limited, preserve the analyzer attempt and
open a recoverable wait; do not silently substitute a different proposal. The owner
may explicitly select the deterministic adapter for offline UI/compiler testing.

### Estimate

2-4 focused days. Re-estimate M2 only after one real repository proposal is accepted
and restored from the ledger.

## 5.6 Milestone 1.6 — persisted Jira task surface

### Goal

Make a real Jira issue usable from the operator console without making Jira
availability a prerequisite for retaining work. This is a read-only intake slice, not
the later M5 eligibility/effect integration.

### Implemented slice

1. Import an issue key from the left task queue and persist the intake request before
   contacting Jira.
2. Normalize description, people, labels, repository hint, linked issues, comments,
   and attachment metadata at the adapter boundary.
3. Replace the current Jira projection in place and restore it after restart. Refresh
   success and failure do not append events, snapshots, or artifacts.
4. Classify `403` as retryable `access_blocked`; retain the last successful snapshot as
   `stale` and expose an inline retry after VPN/access returns.
5. Render only import and repository-binding changes in Activity; show the current
   sync/check time in compact Jira details and proxy attachments through the local
   authenticated adapter.
6. Show repository mapping as a blocking prerequisite in both the status band and
   workflow rail.
7. Refuse workflow generation for imported Jira tasks until a concrete repository is
   mapped. No fixture repository or workflow is silently substituted.

### Acceptance evidence

- `AVIA-13235` can be imported and read from the local console;
- a successful snapshot survives a process restart;
- a later `403` preserves the description, comments, and attachment metadata while
  changing the sync state to `stale`;
- Retry performs the smallest safe operation: only Jira synchronization is repeated;
- attachment URLs are same-origin checked and payloads are bounded to 32 MiB;
- Jira is read-only; no status, assignment, comment, or description mutation exists;
- visual verdict for the operator surface is 93/100.

## 5.7 Milestone 1.7 — explicit repository binding

### Implemented slice

1. Keep repositories in Tasker's OS application-data directory; never discover or
   mutate the operator's `~/Projects/work` clones.
2. Resolve `repo:name` from the Jira description first, then an optional Tasker import
   fallback. Never infer from a Jira project key.
3. Reuse a managed checkout or query Bitbucket by exact name and clone one unique
   result atomically. Require `project/repo` when equal names exist in several
   projects.
4. Persist the binding separately from the replaceable Jira projection, including the
   preferred checkout path and runner identity.
5. Block unknown, conflicting, missing, cross-project ambiguous, Bitbucket access, and
   clone-failure states without losing the Jira snapshot or prior work.
6. Keep the right workflow rail honest: mapping can be complete while workflow
   generation is ready but not started.
7. Expose the typed managed repository catalog to the minimal import form.

### Delivered continuation

M1.8 passes the current Jira projection plus resolved checkout to the existing M1.5
read-only analyzer, then compiles and validates its proposal. Jira writes remain part
of later durable effect work; they must not be added as direct UI requests.

## 5.8 Milestone 1.8 — Jira workflow generation

### Implemented slice

1. Admit a current Jira task only when its managed repository binding is resolved.
2. Classify bugs and non-bugs into conservative base templates without pretending to
   understand implementation details before repository analysis.
3. Give the analyzer the full Jira snapshot, including comments, links, and attachment
   metadata, plus the selected checkout and workflow policies/contracts.
4. Send the analyzer proposal through the existing typed proposal boundary,
   deterministic compiler, capability checks, and validator.
5. Persist provider receipt, proposal, diff, validator report, graph, and workflow view
   under a Jira-specific workflow aggregate. Do not collide with Jira intake history.
6. Merge Jira intake decisions and workflow planning decisions into one operator
   timeline while keeping repeated Jira synchronization out of activity.
7. Change the task from backlog to planned and render the persisted graph on the right
   without re-running analysis after reload.

### Remaining boundary

M2 executes this same graph with durable stub steps. Runtime discoveries such as an
unexpected cross-repository component remain execution results that request a declared
workflow continuation; initial planning must not claim knowledge that reproduction or
implementation has not produced yet.

## 6. Milestone 2 — durable stub traversal

### Goal

Execute the M1 graph end to end with deterministic stub steps while proving queue,
wait, intervention, takeover, replay, and slot semantics.

### Delivered vertical slice (2026-08-02)

The executable path now includes operator **Test workflow**, a durable ordered queue,
configurable capacity, per-run leases and fence tokens, immutable graph-to-operation
plans, per-node transactions and stub receipts, restart-safe cursors, durable
wait/signals, SSE activity, runtime tree projections, and stop at the code-review wait.
Recovery tests prove that committed steps are not repeated after reopening the database
and that an expired owner cannot write after lease replacement. See
[`m2-stub-execution.md`](m2-stub-execution.md).

This does not close the M2 gate. Step 2 still needs heartbeat and outbox dispatch;
steps 3, 7-10, and 13 remain. Steps 1, 4-6, 11, and 12 are implemented only for the
bounded stub semantics documented there.

### Entry criteria

- M1 graph hash and visual tree are stable.
- Reducer and repository transaction fixtures share the same event schemas.

### Implementation steps

1. Implement ready-set calculation for sequence, branch, bounded loop, wait, gate,
   and finalize nodes.
2. Implement queue slots, lease acquisition/heartbeat/release, monotonically
   increasing fence tokens, and outbox dispatcher.
3. Implement isolated temporary worktree allocation through a WorktreePort fixture.
4. Implement deterministic stub executors for agent/tool/verify nodes.
5. Persist every node transition, attempt, input/output artifact, active/wall/wait
   duration, and synthetic cost.
6. Implement Wait open, signal correlation, duplicate signal no-op, resolution, and
   step cursor resume.
7. Implement quota wait as a normal slot-free Wait.
8. Implement human clarification gate and `InterventionEvent -> new Attempt` input
   materialization.
9. Accept `workflow_change_required` from a stub step, persist its evidence, preserve
   the cursor/worktree, and compile a linked immutable continuation candidate. The
   current graph cannot be edited in place.
10. Implement ManualTakeover checkpoint, effect reconciliation, lease release, write
   freeze, handoff packet, and default new-run re-entry.
11. Implement projection rebuild and process restart recovery.
12. Extend cockpit with live state, active cursor, transcript, cost/time badges,
    wait/gate controls, intervention input, takeover control, and debug bundle link.
13. Add kill injection at transaction/outbox/lease/wait boundaries.

### Acceptance evidence

- one generated graph reaches completion on stubs;
- forced kill during executing, outbox visibility, wait open, and lease replacement
  rebuilds to the same legal projection;
- quota wait releases a slot and resumes only its cursor;
- intervention preserves the prior prompt hash and creates a new attempt;
- manual takeover stops all automation writes and produces a complete handoff packet;
- restart while waiting consumes no runner slot;
- replay never invokes a stub effect a second time.
- a runtime discovery preserves the completed prefix and creates a validated linked
  continuation candidate instead of mutating the current graph.

### Operator demo

1. Queue two stub tasks with one slot.
2. Run the first into a quota/external wait and show the second take the freed slot.
3. Restart Tasker and resolve the first wait.
4. Force a wrong-direction gate, enter a guidance message, and show a new attempt in
   the same run with the intervention overlay.
5. Trigger takeover on another run and show cwd/branch/diff/evidence in its packet.
6. Attempt an automation write after takeover and show deterministic rejection.

### Artifacts

- ledger/replay checksum report;
- kill/restart matrix;
- wait/signal traces;
- intervention attempt lineage;
- handoff packet;
- M2 demo recording.

### Rollback/containment

If full takeover re-entry is too broad, ship only `handed_off -> new linked run` and
defer same-run proof. If live streaming is unstable, the cockpit may poll projections;
the persisted event contract cannot change.

### Estimate

6-10 focused days. Cumulative near-horizon forecast after M0-M1: 12-20 focused days.

## 7. Milestone 3 — provider compatibility gate and first real node

### Goal

Choose the first real provider from local evidence and execute a real agent node
through the already-proven kernel.

### Entry criteria

- M2 deterministic readiness is green.
- No provider-specific field has leaked into workflow IR or domain reducers.

### Implementation steps

1. Build a standalone probe command using the same subprocess capture layer planned
   for adapters.
2. Probe installed Claude Code, Codex, and Antigravity versions with an identical,
   non-mutating prompt and temporary worktree.
3. Capture structured events, stdout/stderr separation, exit semantics, session IDs,
   resume after kill, permissions, quota/limit signatures, token fields, reported
   dollar fields, and version metadata.
4. Store the compatibility report as a versioned artifact.
5. Select the first provider using explicit weighted criteria: correctness of event
   stream, recovery, permission safety, usage evidence, and local stability.
6. Implement only the selected adapter's probe/start/resume/cancel/reconcile lifecycle.
7. Normalize provider events into attempt transcript and cost records.
8. Implement provider quota classification into `Wait(kind=quota_reset)`.
9. Implement killed/ambiguous provider dispatch reconciliation.
10. Execute one real analysis or planning node without external writes.

### Acceptance evidence

- provider choice cites measured report data rather than brand preference;
- one real node creates normalized transcript, artifacts, duration, tokens, and
  measured/estimated cost distinction;
- quota fixture opens a wait, not `provider_unavailable`;
- lost provider session can start a new attempt from durable artifacts without
  restarting the workflow;
- unsupported Antigravity or another provider is explicitly disabled with evidence.

### Operator demo

1. Open provider comparison report in cockpit.
2. Inspect why the selected provider won.
3. Run one real analysis node.
4. kill/resume or simulate unavailable resume and show preserved input/artifact
   lineage.

### Artifacts

- compatibility matrix;
- selected-provider ADR amendment;
- raw redacted and normalized transcripts;
- provider attempt lifecycle/debug bundle;
- pricing snapshot.

### Rollback/containment

If no provider passes the safety gate, M3 stops with the stub kernel intact. Fix the
subprocess contract or provider version; do not weaken permissions or bypass event
capture to claim progress.

### Estimate

Planning envelope 3-6 focused days. Re-estimate after the actual probe, before M4.

## 8. Milestone 4 — real worktree, steering, and smallest-safe resume

### Goal

Let the selected provider make a bounded real change while preserving work through
agent confusion, environment repair, process loss, and human takeover.

### Entry criteria

- M3 adapter passes non-mutating recovery tests.
- A disposable or fixture repository is available.

### Implementation steps

1. Integrate existing `wt`/harness hook semantics behind WorktreePort.
2. Persist repository, base/head SHA, branch, dirty state, diff, commit, and file
   artifact lineage.
3. Implement real agent/tool/verify step wrappers with declared allowed effects.
4. Implement course-correction gate after no-progress or operator intervention.
5. Materialize next-attempt input from snapshot + artifacts + gate answers +
   interventions.
6. Implement real manual takeover and new-run reconciliation against the human-edited
   worktree.
7. Implement change-aware verification selector for build-only, targeted, full,
   visual compare, and snapshot update profiles.
8. Persist verification rationale before running checks.
9. Add a local fake remote that can return definite `403` and ambiguous connection
   loss for push semantics.
10. Prove only the failed push node retries after environment repair.

### Acceptance evidence

- real worktree changes survive Tasker/provider restart;
- wrong-direction intervention creates a new attempt without mutating history;
- `403` retains commit/diff/tests and repeats only push;
- ambiguous push is not retried until remote-ref probe classifies it;
- takeover prevents stale runner write through fence token;
- verification profile is inspectable and cannot downgrade repository-required checks.

### Operator demo

1. Run a real small fixture change.
2. tell the agent "делаешь не то, лучше вот так" at its gate and inspect attempt diff.
3. fail push with `403`, repair the environment, and resume push only.
4. repeat with an ambiguous push and show reconciliation.
5. take the worktree manually, edit it, and create a new linked run from reconciled
   state.

### Artifacts

- real worktree/commit/diff manifest;
- intervention comparison;
- 403 and unknown-outcome evidence;
- takeover/new-run linkage;
- verification rationale/report.

### Rollback/containment

Keep all remote endpoints fake until `unknown_outcome` tests are green. If real
worktree ownership is unreliable, disable write-capable providers and retain M3
read-only execution.

### Estimate

Planning envelope 4-7 focused days; re-estimate M5/M6 after recovery evidence.

## 9. Milestone 5 — Jira intake and eligibility

### Goal

Replace fixture intake with real Jira/Confluence context while preserving the clean
pre-task failure boundary.

### Entry criteria

- M4 worktree/recovery is green.
- Existing Jira/Confluence scripts have deterministic input/output wrappers and
  redaction review.

### Implementation steps

1. Wrap existing Jira read and linked Confluence context scripts behind IntakePort.
2. Normalize HTTP/tool errors into definite, retryable, access, contract, or terminal
   intake results.
3. Persist source snapshot and provenance hashes.
4. Implement eligibility decision schema with reasons and optional operator override.
5. Ensure Jira `400` and `not_eligible` produce no Task/Run/worktree.
6. Add cockpit repair/retry controls and raw-response redaction-safe evidence.
7. Feed eligible snapshots to the same M1 compiler; do not create a separate Jira
   workflow engine.

### Acceptance evidence

- real or fixture-backed Jira `400` can be repaired and retried at intake only;
- unsuitable task ends as `not_eligible` with reasons;
- eligible task produces the same normalized snapshot/graph after restart;
- Confluence/link failure is classified according to policy rather than silently
  omitted.

### Operator demo

1. Submit an invalid Jira request and inspect the repairable intake state.
2. submit an unsuitable item and inspect reasons.
3. submit an eligible item and inspect the generated workflow before queueing.

### Rollback/containment

If live Jira access is blocked, ship the normalized IntakePort against recorded,
redacted fixtures while resolving credentials. Do not couple credentials to compiler
development.

### Estimate

Planning envelope 3-6 focused days; depends on actual corporate access and wrapper
quality.

## 10. Milestone 6 — Bitbucket, concurrent CI/review, and revise

### Goal

Reach the first real end-to-end target:
`Jira -> workflow -> code/worktree -> PR -> CI/review -> revise -> waiting_for_review`.

### Entry criteria

- M5 real intake and M4 side-effect reconciliation are green.
- Bitbucket/Jenkins/Allure wrappers pass fixture-server contract tests.
- Repository policy defines PR, CI retry, reply, and thread-resolution permissions.

### Implementation steps

1. Implement idempotent git push and Bitbucket PR create/update intents/receipts.
2. Start CI watching immediately after a shareable PR exists.
3. Ingest Jenkins stages/logs and Allure failure/artifact links into normalized build
   projections.
4. Implement CI classifier `ours | flaky | external | infrastructure | green` with
   evidence and bounded policy branches.
5. Implement CI `ours` fix/reverify loop, flaky rerun budget, external wait, and
   infrastructure repair gate.
6. Ingest Bitbucket review threads with dedupe and causal mapping.
7. Implement thread dispositions `accepted | question | disagree_with_evidence |
   already_addressed | blocked | resolved`.
8. Write review-specific responses to the PR as the canonical conversation channel.
9. Create code revision work only for accepted/actionable threads.
10. Allow CI and review signals to overlap; compute readiness from independent
    projections rather than a linear pipeline.
11. Re-run only verification/push/CI nodes invalidated by the revision diff.
12. Move to `waiting_for_review` when no agent-actionable review/CI work or unsafe
    unknown effect remains. The human alone chooses `done`/merge.

### Acceptance evidence

- PR create/update and replies are idempotent under duplicate delivery/restart;
- CI ours/flaky/external/infrastructure branches take distinct graph paths;
- non-actionable review thread does not create a code change;
- accepted comment creates exactly one revise attempt and updated PR;
- CI/review arrival order does not change the final legal projection;
- `waiting_for_review` consumes no runner slot;
- full run/debug bundle links Jira, graph, worktree, PR, CI, Allure, review, cost, and
  attempt evidence.

### Operator demo

1. Start an eligible Jira task and inspect its graph.
2. run to a shareable PR.
3. show CI and review listeners active together.
4. inject an `ours` CI failure and a flaky failure on separate runs.
5. add one accepted PR comment, one question, and one evidence-backed disagreement.
6. show PR replies and only the accepted thread creating code revision.
7. reach `waiting_for_review`, then manually mark done when satisfied.

### Artifacts

- end-to-end evidence index;
- PR/CI/review receipts and dispositions;
- readiness calculation trace;
- before/after revision diff;
- cost/time breakdown;
- M6 demo recording.

### Rollback/containment

Each adapter has a kill switch. If Jenkins/Allure blocks, retain real Jira/Bitbucket
and run CI against a deterministic fixture until the adapter is repaired. Never mark a
run ready when required CI evidence is absent.

### Estimate

Do not commit a calendar estimate before M4/M5 evidence. Initial planning envelope is
8-14 focused days with high integration uncertainty; split into M6a PR/effects, M6b CI,
and M6c review/revise if any adapter exceeds its contract budget.

## 11. Milestone 7 — translation/external-signal workflow

### Goal

Prove that a long human/external wait is a normal workflow node, not a special script
or occupied agent process.

### Entry criteria

- generic Wait/Signal ABI from M2 is stable.
- existing translation commands and Loop adapter boundary are mapped.

### Implementation steps

1. Register translation upload and pull step types.
2. Add correlated `translation_ready` wait with manual and Loop signal sources.
3. Persist translation batch/project correlation and expected evidence.
4. Resume only the pull/sync node after signal.
5. Handle duplicate/stale signal and process restart.
6. Show wait duration separately from active agent time/cost.

### Acceptance evidence

- upload opens slot-free wait;
- other queued work proceeds;
- matching signal resumes correct run/node;
- duplicate/stale signal is no-op;
- restart loses no correlation or worktree state.

### Operator demo

Run upload, stop Tasker, restart, resolve via Loop/manual signal, pull translations,
and continue the original workflow.

### Rollback/containment

Ship manual typed signal before live Loop write/read if credentials are blocked. The
Wait ABI remains unchanged.

### Estimate

Planning envelope 3-5 focused days; re-estimate after Loop contract probe.

## 12. Milestone 8 — declared graph expansion and cross-repo child runs

### Goal

Support the shared-component scenario without collapsing multiple repositories into
one opaque run.

### Entry criteria

- M2 replay, M4 worktree ownership, M6 effects, and M7 external artifact waits are
  green.
- parent/child policy decides whether child Jira creation is automatic or gated.

### Implementation steps

1. Add later-wave IR nodes `spawn_child_run`, `join_child_run`, and declared expansion
   points.
2. Implement append-only graph revision proposal/validation/application with parent
   graph hash and node lineage.
3. Reject expansion outside declared points or with unknown/unsafe step types.
4. Define `ChildRunRequest`, `ChildRunLink`, `ChildRunResult`, and parent join ABI.
5. Create separate repo/worktree/task/run for the child.
6. Wrap automatic dev publish as an idempotent effect producing exact package/version
   artifact.
7. Resolve parent join and run integration verification against dev version.
8. Open human final-publish gate; accept exact version input or registry proof.
9. Resume parent with released version; retain separate replay/debug bundles and a
   causal combined view.
10. Provide manual child-result entry as a fallback using the same schema.

### Acceptance evidence

- graph revision is append-only, validated, and replayable;
- parent and child failures do not corrupt each other's histories;
- child dev publish unblocks parent exactly once;
- final publish cannot execute autonomously;
- wrong/stale version cannot satisfy parent gate;
- process kill at child publish or parent join reconciles without duplicate publish.

### Operator demo

Start a parent task, discover shared-component need, inspect proposed graph expansion,
approve/create child, reach dev publish, resume parent verification, wait for human
final publish, provide version, and finish the parent path.

### Rollback/containment

If automatic graph revision is not trustworthy, keep immutable parent graph and use a
manual/gated child result with a new linked parent run. If dev publish is unsafe, enter
an operator-provided dev version through the same typed result contract.

### Estimate

High-uncertainty planning envelope 7-12 focused days. Re-estimate only after M6/M7;
do not schedule this concurrently with first integration hardening.

## 13. Milestone 9 — retrospective, readiness, and pilot

### Goal

Turn run history into human-approved future improvements and measure the 50% objective
without weakening deterministic gates.

### Entry criteria

- at least M6 end-to-end and M7 wait path are operational.
- a declared pilot cohort and eligibility rules exist.

### Implementation steps

1. Generate planned-vs-actual graph path, retries, waits, interventions, takeover,
   review, cost, and time analysis.
2. Produce future-only proposal artifacts for prompt, step, workflow, and policy
   versions.
3. Add approve/reject/apply-to-future-version flow and rollback metadata.
4. Build deterministic readiness report over replay/recovery/effect/redaction suites.
5. Build separate pilot report for eligible cohort outcomes and taxonomy.
6. Add optional OpenTelemetry/Phoenix/Langfuse export only as a projection after
   readiness is green.

### Acceptance evidence

- active/historical run snapshot is unchanged by a proposal;
- approved proposal creates a new future version with rollback;
- readiness can be green/failed independently of pilot percentage;
- only replay-safe classified runs count in pilot;
- dashboard distinguishes active, wait, handoff, blocked, and review time.

### Rollback/containment

Keep retrospective read-only if proposal application is not yet trustworthy. Defer
external tracing entirely if it adds operational instability.

### Estimate

Re-estimate from the actual volume/quality of M6 run data; no credible pre-M6 calendar
commitment.

## 14. Milestone 10 — provider expansion and VPS runner

This milestone is intentionally outside the first product proof.

Entry requires:

- first provider stable through M6;
- local protocol and artifact redaction green;
- proven need for another provider or unattended host;
- explicit secret/auth/bootstrap plan.

Add second/third providers one at a time through the same probe suite. Implement VPS
runner only through the existing runner protocol. Reassess Hatchet/Temporal if multiple
hosts must compete for the same queue or custom wakeup/lease logic becomes the primary
operational burden.

## 15. Execution staffing

### Available roles

`planner`, `architect`, `executor`, `debugger`, `test-engineer`, `verifier`,
`explore`, `researcher`, `security-reviewer`, `critic`, `writer`, `git-master`.

### Sequential `$ralph` path

- M0: architect high -> executor high -> test-engineer medium -> verifier high.
- M1-M2: executor high owns compiler/kernel; debugger high owns replay/lease faults;
  test-engineer medium owns fixtures; verifier signs each demo.
- M3-M6: one executor high remains integration owner; specialized debugger handles
  provider/effect ambiguity; security reviewer checks transcripts and secrets.
- M7-M9: architect re-reviews expansion/child-run and retrospective boundaries before
  executor work.

Launch hint:

```text
$ralph docs/codex/implementation-plan.md — execute M0 only; stop at its acceptance gate
```

### Coordinated `$team` path

Do not parallelize M0 contract ownership. After M0:

- Lane A, executor high: domain + ledger + migrations;
- Lane B, executor high: workflow compiler/validator + step registry;
- Lane C, executor medium: local API/cockpit graph and debug views;
- Lane D, test-engineer medium: reducer/replay/kill fixtures.

After M2 only:

- provider adapter lane;
- worktree/effect lane;
- integration lane;
- E2E/verifier lane.

Launch hint:

```text
$team docs/codex/implementation-plan.md — execute M1 after M0 contracts are frozen;
use file ownership and stop before M2
```

### Team verification path

1. All lanes consume the same versioned command/event/ABI fixtures.
2. Reducer/replay suite runs before adapter E2E.
3. Verifier reconstructs projections from an empty database before accepting a demo.
4. Security reviewer checks redaction before any real corporate payload is retained.
5. No team shuts down with an unresolved `unknown_outcome` hidden as retry/failure.

## 16. Final execution gate

Implementation may start at M0 only when:

- architecture and test spec are approved;
- M0 file ownership is assigned;
- runtime/toolchain versions are recorded;
- existing user files remain untouched;
- no real corporate write is enabled before fixture reconciliation tests are green.

Every later milestone starts only from the prior milestone's evidence, re-estimate, and
explicit scope lock. This is what keeps the project a useful personal harness rather
than an unfinished general workflow platform.

## 17. Consensus changelog

The final review loop applied these changes to the July 30 design:

- split the first integrated phase into M0 contracts, M1 visible workflow, and M2
  durable stub traversal;
- replaced ad hoc pause states with a typed resumable Wait contract;
- added separate ManualTakeover ownership transfer with new-run re-entry by default;
- added immutable run-specific intervention events and future-only harness changes;
- made provider selection conditional on a local compatibility spike;
- specified Jira-400/no-partial-run, push-403/smallest-safe-resume, and
  unknown-outcome reconciliation;
- made PR the code-review channel, with per-thread dispositions rather than automatic
  fixing of every comment;
- made CI and human review concurrent signals with deterministic readiness policy;
- added translation wait, change-aware verification, later graph expansion, and
  cross-repo child-run contracts;
- added StepType/Predicate/Wait/debug ABIs and named deterministic tests for every
  confirmed workflow family;
- removed the unjustified whole-project estimate and kept near-horizon estimates plus
  re-estimation gates.
