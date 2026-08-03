# Temporal migration and Tasker delivery plan

Status: canonical execution plan, 2026-08-03

## 1. Goal and sequencing rule

Move Tasker from the proven custom M2 stub runtime to Temporal without losing the
working product surfaces: Jira intake, repository binding, dynamic per-task graph
assembly, deterministic validation, plan review, graph continuation, and the operator
console.

We do not build the final real coding-agent workflow on the legacy runner and migrate
it later. The next vertical slice establishes Temporal first, then real Activities are
added behind stable block contracts.

At no point may both the custom scheduler and Temporal be authoritative for the same
run. Legacy runs remain readable. New migration-fixture runs select one runtime at
creation; after parity, new runs are Temporal-only and the legacy executor is deleted.

## 2. Milestone map

| Milestone | Operator-visible result | Runtime result |
|---|---|---|
| T0 — decision baseline | docs clearly show target/current state | no code behavior change |
| T1 — Temporal walking skeleton | start two fixture tasks and see independent live workflows | generic interpreter, worker, Query, Activity, wait/update |
| T2 — planning parity | choose plan review; answer question; request revision | real planning Activity and durable message loop |
| T3 — managed work execution | run one safe repository task through worktree/build | agent/process Activities, heartbeats, recovery |
| T4 — integrations and PR lifecycle | Jira -> code -> PR -> CI -> review/revise | reconciled external effects and webhook/poll signals |
| T5 — late workflow change | discover another repo/translation/publish step and continue | validated graph revision/Child Workflow |
| T6 — cutover and deletion | Temporal is the only runtime shown | custom scheduler/lease/cursor/wait code removed |
| T7 — pilot and retrospective | measure >=50% useful autonomous throughput | policy tuning from reviewed evidence |

## 3. T0 — architecture baseline

Deliverables:

1. Rewrite canonical architecture, technology decisions, plan, tests, README, research
   conclusion, and customization guide around Temporal.
2. Add a migration/deletion inventory.
3. Mark M0–M2 documents and colleague research as historical pre-Temporal evidence.
4. Keep current tests green so documentation does not silently alter behavior.

Exit gate:

- no canonical document presents the custom queue/lease/cursor as target architecture;
- current implementation is explicitly labeled legacy, not already migrated;
- the deletion gate and non-duplication rule are documented.

## 4. T1 — Temporal walking skeleton

This is the next code milestone and the first point at which the new runtime is useful.

Implementation status on 2026-08-03: the executable skeleton, API runtime selection,
product run registry, parallel wait/resume, Activity retry, worker replay, and local
CLI restart demo are complete. Stub transcript projection, richer worker health, and
the real-service subprocess test harness remain before the full T1 gate is closed; see
`t1-temporal-walking-skeleton.md`.

### 4.1 Dependencies and local service

1. Pin compatible Temporal TypeScript SDK packages and document the selected version.
2. Add scripts to start a local Temporal development service, worker, API, and cockpit.
3. Use a dedicated namespace and Task Queue for Tasker development.
4. Add health reporting for Temporal Service and worker availability.
5. Keep service data outside managed repositories; do not confuse development-server
   persistence with a supported deployment.

### 4.2 Runtime module boundaries

Create target modules without copying legacy scheduler concepts:

```text
src/temporal/
  client.ts                 # start/query/update/signal/cancel boundary
  worker.ts                 # worker bootstrap and activity registration
  workflows/
    task-workflow.ts        # deterministic graph interpreter
    public-state.ts         # query/update/signal contracts
    interpreter.ts          # pure graph transition helpers
  activities/
    stub-activities.ts      # deterministic-looking test activities only for T1
  contracts/
    input.ts
    messages.ts
    results.ts
```

Workflow modules must be dependency-isolated so build-time checks catch accidental
filesystem/database/network imports.

### 4.3 Interpreter slice

Support enough compiled IR to prove the architecture:

- sequence;
- one typed executable step;
- bounded loop;
- durable wait;
- terminal state;
- `question` and `workflow_change_required` outcomes as typed states, with graph
  revision execution deferred until later milestones.

Implement one public-state Query and validated Updates for resume/answer. Persist
Temporal Workflow ID/Run ID in Tasker product storage and expose them through the API.

### 4.4 Console slice

Replace global generation/execution flags with selected-task state. Show two tasks in
parallel, each with its own:

- lifecycle/attention state;
- current graph node and attempt;
- wait reason;
- elapsed execution/wait time;
- stub transcript/activity entry.

The right pane renders the compiled graph already persisted by Tasker; active/complete
state comes from the Workflow Query/projection.

### 4.5 T1 acceptance demo

1. Generate valid workflows for two fixture tasks.
2. Start both; each advances independently.
3. One reaches plan-review wait and the other code-review wait.
4. Restart the worker while one Activity is running; it retries/resumes at that
   Activity, not task intake.
5. Restart Tasker API/cockpit; both Workflow states remain available.
6. Send an answer/approval Update; only the selected run continues.
7. A duplicate Update is rejected or idempotently returns the existing decision.

## 5. T2 — real implementation planning

Move the existing subscription-Codex planning capability into a Temporal Activity.

1. Snapshot task/repository/prompt/skill/policy references before the Activity.
2. Route `fast`, `normal`, or consensus planning using deterministic run policy and
   bounded input evidence.
3. Run the provider CLI in an Activity with timeout, heartbeat, cancellation, streaming
   transcript persistence, and measured usage.
4. Validate structured plan output at the Activity boundary.
5. Treat blocking questions as Workflow state in both reviewed and auto-plan modes.
6. If `planReviewRequired=false`, proceed after an accepted plan.
7. If `true`, wait for approve or revision feedback.
8. A revision creates a new immutable planning attempt linked to feedback.
9. Implement `workflow_change_required` as a typed planner outcome but keep revision
   approval mandatory in this milestone.

T2 exit gate:

- provider/API/worker restart cannot lose a submitted answer or completed plan;
- prompt and plan attempt hashes are visible;
- one task's plan review cannot block another task;
- hypothetical API cost and wall time are attributed to each attempt.

## 6. T3 — managed worktree and safe execution

Build the first real repository-changing vertical slice without remote mutation.

### 6.1 Repository lifecycle

1. Resolve repository from explicit Tasker selection, future Jira field, or
   `repo:<name>` description marker.
2. Clone/fetch into the OS-standard Tasker application-data path if absent.
3. Create a per-run branch and managed worktree before repository analysis/planning.
4. Invoke the external harness bootstrap/profile adapter and persist its receipt.
5. Reuse the same worktree on retry, question, worker restart, and plan revision.
6. Never mutate `~/Projects/work` or duplicate its `work` overlays.

### 6.2 Agent and process Activities

1. Implement a provider-neutral agent Activity runner for registered `agent` blocks.
2. Implement registered process Activities for build/test/reproduction commands.
3. Stream bounded transcript events and persist full output as artifacts.
4. Heartbeat long provider/process calls and terminate subprocesses on cancellation.
5. Reconcile the worktree before retry: inspect git state/artifacts instead of assuming
   a failed Activity did nothing.
6. Return typed outcomes: completed, retryable, question, blocked, or workflow change.

### 6.3 First safe task

Use a disposable fixture repository to execute:

```text
analyze -> plan -> implement -> targeted verify -> operator acceptance
```

No Jira/Bitbucket/Jenkins mutation is allowed yet. Kill the worker after file mutation
and before Activity completion; recovery must preserve the change and avoid duplicating
it.

## 7. T4 — Jira, Bitbucket, Jenkins/Allure, and review

External mutation is introduced one effect family at a time.

### 7.1 Effect protocol first

For each mutation define:

- stable operation ID and idempotency surface;
- `prepare` intent artifact;
- read-before-write reconciliation;
- safe retry cases;
- applied receipt;
- unknown-outcome state and operator recovery.

Do not enable generic Temporal retries before these contracts exist.

### 7.2 Jira lifecycle

Add policy-controlled Activities for assignment/status/comment/attachment. Recommended
default behavior:

- take into work only when task type/status/project policy allows agent ownership;
- do not take non-agent tasks;
- post compact meaningful transitions, not every internal step;
- attach/link successful before-reproduction evidence when policy enables it;
- keep the cockpit's Jira view editable through the same adapter/effect boundary.

A Jira 400 is a typed task-admission/integration error. A VPN/403 is infrastructure
blocked. Neither restarts code work.

### 7.3 Bitbucket and PR review

1. Reconcile branch existence, then push.
2. Create or reuse the PR using stable source/target identity.
3. Wait for CI and code review.
4. Import unresolved PR threads/comments.
5. Start a revision Activity with exact comment provenance.
6. Push amendments, re-observe CI, reply/resolve through explicit policy.
7. If no comments appear, the operator may mark done; Tasker does not auto-merge.

### 7.4 Jenkins and Allure

Observe builds by webhook when possible and polling as recovery. Classify:

- passed;
- likely flaky/infrastructure;
- caused by current change;
- unknown.

Fetch relevant console/Allure attachments and preserve evidence. A flaky retry budget
is separate from an implementation-fix budget. After bounded unknown failures, open an
operator guidance/infrastructure wait.

T4 exit gate: a real allowed pilot task reaches `code_review_pending`, survives VPN
loss during push by resuming only push/reconciliation, consumes human PR comments, and
returns to review after revision and CI.

## 8. T5 — late graph change and cross-repository work

Implement graph evolution after the main single-repository path is stable.

1. An Activity returns typed evidence plus `workflow_change_required`.
2. A planning Activity proposes a compiled continuation against the current catalog and
   exact project/global policies.
3. Deterministic validation remains mandatory.
4. Pilot policy opens graph-revision review with rationale and diff.
5. Same-repository bounded suffixes continue in the parent Workflow.
6. Independent repository/worktree/publication work starts a Child Workflow.
7. Parent waits on a typed join and retains all completed state.
8. Child may dev-publish automatically only if policy grants that effect.
9. Human final publish remains a wait; resume payload includes the released version.
10. Consumer work resumes, installs/pulls the exact version, verifies, then continues.

Demonstrate both:

- translation: implement copy -> extract -> wait translator -> pull -> verify;
- shared component: discover component -> child repo change -> dev publish/probe ->
  parent verify -> human final publish/version -> consumer continuation.

After enough reviewed runs, allow policy to auto-accept known low-risk revision classes.

## 9. T6 — cutover and code deletion

Cutover only after the parity matrix in
[`temporal-migration.md`](temporal-migration.md) passes. Then:

1. stop creating legacy runs;
2. leave a read-only legacy-run projection/export path for an explicit short period;
3. remove the legacy scheduler, lease/fence, cursor, custom wait/signal, retry timer,
   and duplicate execution-state code;
4. collapse ledger repository methods/tables to product metadata/artifacts/effects;
5. replace legacy runtime tests with Temporal integration/replay tests;
6. rename/remove `stub` runtime configuration and docs;
7. remove feature flags and the runtime fork after legacy fixtures are exported;
8. run dead-code/dependency analysis and simplify API/UI projections.

The code-reduction claim is evaluated here from the actual diff. We expect substantial
deletion in `src/runner`, execution-specific `src/ledger`, and control-plane scheduling,
but do not set a line-count target that could reward moving complexity elsewhere.

## 10. T7 — pilot and retrospective

Run a representative personal backlog:

- small frontend bug with before/after evidence;
- ordinary feature with targeted tests;
- flaky CI case;
- plan question and plan revision;
- PR review/revise;
- translation wait;
- cross-repository component continuation;
- VPN/403 and worker/laptop restart recovery.

Measure per task and block:

- accepted without operator implementation;
- time to PR/code review;
- operator attention time and number of interventions;
- retries by cause;
- false/avoidable questions;
- graph revisions and whether they were correct;
- CI classification quality;
- token usage and shadow API cost;
- lost/duplicated external effects (target: zero).

The pilot succeeds when at least 50% of selected in-scope tasks reach code review with
useful results and acceptable operator attention. Retrospective proposes prompt,
policy, block, validator, or adapter changes. A human approves every harness change;
nothing self-modifies.

## 11. Work order for each milestone

Every milestone follows the same engineering order:

1. write/adjust public behavior tests;
2. define typed boundary contracts;
3. implement the narrow vertical slice;
4. test worker/service/API restart and duplicate delivery;
5. exercise the operator flow in the cockpit;
6. inspect histories/artifacts for secret and payload bloat;
7. run lint, typecheck, unit/integration/e2e tests;
8. update the implementation-status docs;
9. commit a small reversible decision record.

## 12. Immediate next step

Implement T1 only. Do not add real Jira/Bitbucket mutation, cross-repository
continuations, or Effect/LangGraph while establishing the Temporal walking skeleton.
The acceptance demo is concrete: two dynamically assembled fixture graphs execute
independently, survive worker/API restart, stop at separate durable waits, and resume
only the selected task.
