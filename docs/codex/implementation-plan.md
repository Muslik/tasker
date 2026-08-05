# Temporal migration and Tasker delivery plan

Status: canonical execution plan, 2026-08-05

## 1. Goal and sequencing rule

Tasker has moved from the proven custom M2 stub runtime to Temporal without losing the
working product surfaces: Jira intake, repository binding, dynamic per-task graph
assembly, deterministic validation, plan review, graph continuation, and the operator
console.

New product behavior is now added only as blocks and Activities behind stable
contracts. The deleted legacy runner is not a compatibility target.

Temporal is the only execution authority. No runtime selector, legacy-run creation, or
fallback scheduler remains.

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

This milestone established the runtime boundary.

Implementation status on 2026-08-03: the executable skeleton, product run registry,
parallel wait/resume, Activity retry, history replay, and local CLI restart demo are
complete. The browser real-service harness is part of final cutover verification; see
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
  contracts.ts              # typed Workflow/Activity boundary
  public-state.ts           # operator-facing query state
  run-registry.ts           # product lookup for Workflow ID/Run ID
  worker.ts                 # worker bootstrap and activity registration
  workflows/
    task-workflow.ts        # deterministic graph interpreter
  activities/
    block-execution.ts      # versioned agent/process block execution
    planning-activity.ts    # implementation planning boundary
    workspace-activity.ts   # managed checkout/worktree/bootstrap boundary
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

Implementation status on 2026-08-03: immutable input snapshots, the heartbeating and
cancellable Activity, durable questions, plan approval/revision, stable command IDs,
API commands, and restart/idempotency tests are implemented. Bounded transcript
artifact streaming and a real subscription-provider interruption smoke remain before
the product-level T2 exit gate is closed; see `t2-temporal-planning.md`. They do not
justify retaining a second durable runtime.

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

### 5.1 Planning lifecycle correction

The 2026-08-05 architecture review found that the first compiled graph was being
treated as immutable too early and that Temporal special-cased `task.analyze@1` without
using its declared read-only skills. The correction is defined in
[`planning-lifecycle.md`](planning-lifecycle.md) and precedes additional execution-block
work:

1. run context discovery as a durable bootstrap lifecycle and persist an append-only,
   provenance-bearing Evidence Bundle;
2. assemble a complete task-specific draft from that bundle;
3. always run implementation planning with the pinned read-only skills and the same
   evidence;
4. treat `workflow_change_required` as a draft proposal, then reassemble, recompile,
   and validate the full graph;
5. apply optional plan review, freeze the accepted graph, and only then admit product
   execution;
6. reserve Child Workflow continuation for discoveries made after execution freeze;
7. remove name-based planning logic from the generic graph interpreter.

Delivered sub-slices now project the snapshotted `task.analyze@1` skills into the actual
read-only planner provider session and persist one provenance-bearing Evidence Bundle
consumed by both workflow analysis and implementation planning. The planning snapshot
contains only its immutable reference. Initial discovery/assembly now runs through a
dedicated Temporal bootstrap Workflow and heartbeat-enabled Activity; accepted drafts
are reused, validation-rejected attempts can be regenerated, and exhausted transient
failures can resume as a new run without discarding persisted evidence. Planning-time
workflow changes now produce immutable, operation-idempotent draft attempts through the
normal assembler/compiler/validator path; the planner rechecks every accepted revision,
and generic execution starts only after planning and optional review. Planning logic
has been removed from the node interpreter. Mediating external evidence reads and an
explicit retrospective-facing freeze receipt remain.

T2 exit gate:

- provider/API/worker restart cannot lose a submitted answer or completed plan;
- prompt and plan attempt hashes are visible;
- one task's plan review cannot block another task;
- hypothetical API cost and wall time are attributed to each attempt.

## 6. T3 — managed worktree and safe execution

Build the first real repository-changing vertical slice without remote mutation.

Implementation status on 2026-08-04: deterministic application-data worktrees,
durable locator/bootstrap receipts, target-aware `inspect`/`apply` bootstrap protocol,
the heartbeat-enabled Temporal preparation Activity, worktree-based immutable planning
snapshot, recoverable `workspace.retry@1` wait, and registered agent/process block
execution are complete. Temporal-backed browser parity and dependency isolation/replay
pass. The built-in company profile and first local mutation response-loss smoke also
pass: a replacement Worker continues the same dirty worktree, runs verification, and
reaches code review without repeating the mutation. T3 is complete.

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
analyze -> plan -> implement -> full verify -> code review wait
```

No Jira/Bitbucket/Jenkins mutation is allowed yet. Kill the worker after file mutation
and before Activity completion; recovery must preserve the change and avoid duplicating
it. This gate passed on 2026-08-04 with the built-in `front-avia` harness profile,
behavior tests, and a TypeScript build.

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

Implemented first slice on 2026-08-04: immutable external-effect intent/applied
receipts, adapter registry, `remote_reconciled` Activity delivery, controlled
`unknown_outcome`, and output-receipt replay. Automatic retries are enabled only for
the reconciled `pr.prepare@1` mutation boundary and the side-effect-free
`ci.observe@1` read boundary; other integration/process blocks remain `single_attempt`.

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

Implemented admission slice on 2026-08-04: `jira.start-work@1` is a file-backed,
Jira-origin-only `remote_reconciled` block. The policy requires it after
`plan.approved@1` and before any `workspace.write` or `command.run` effect. Its adapter
rejects disallowed issue types/statuses/labels and tasks assigned to somebody else,
assigns an unowned issue to the configured operator, discovers each configured status
edge from Jira transitions, and journals every assignment/transition separately. A
400/403 opens the existing step wait; operator guidance redelivers only admission in
the same worktree. The Worker registers Jira mutation adapters only with
`TASKER_ENABLE_JIRA_EFFECTS=true`.

Implemented review-ready slice on 2026-08-04: the same file-backed policy requires
`pr.prepare@1` -> `ci.observe@1` -> `jira.review-ready@1` before every Jira-origin
`code_review@1` wait. The adapter consumes only provider-neutral durable PR evidence,
follows the configured status path, and reconciles one compact PR-link comment through
independent transition/comment intents and receipts. A 403 resumes only this node;
lost responses and new operator attempts probe Jira first and do not repeat completed
implementation or PR preparation.

Implemented reproduction-evidence slice on 2026-08-04: the independent file-backed
`jira-reproduction-evidence` policy selects only `bug.reproduce@1` with `phase=before`
and requires `jira.attach-reproduction@1` before repair. Reproduction output is typed by
phase/outcome/evidence. The adapter accepts only safe managed-worktree media, uses
content-addressed Jira filenames, journals each attachment separately, and reconciles
403, lost responses, and partial batches without repeating reproduction or
implementation. Disabling this policy removes only its owned block.

### 7.3 Bitbucket and PR review

1. Reconcile branch existence, then push.
2. Create or reuse the PR using stable source/target identity.
3. Wait for CI and code review.
4. Import unresolved PR threads/comments.
5. Start a revision Activity with exact comment provenance.
6. Push amendments, re-observe CI, and reply through explicit policy.
7. If no comments appear, the operator may mark done; Tasker does not auto-merge.

Steps 1-6 and the operator completion path in step 7 are implemented behind
`TASKER_ENABLE_BITBUCKET_PR_EFFECTS=true`. Local-git
and fake-port tests cover lost push response, lost PR-create response, 403 resume, and
existing-PR reuse. The company `ai-assistance` requirement is now an ordinary
file-backed graph policy: it persists the accepted plan before implementation, harvests
actual evidence, validates same-branch artifacts, and produces the provider-neutral
draft consumed by Bitbucket. Review sync reads the exact PR from the durable
`pr.prepare@1` output, stores unresolved human threads as immutable evidence, and
resolves `code_review@1` with a typed decision. `changes_requested` enters a bounded
`review.revise@1` -> verify -> PR update -> Jenkins -> `review.acknowledge@1` -> review
loop. The reply adapter journals and probes each thread independently, so response loss
or a partial 403 resumes without duplicate comments. A later human follow-up reopens the
thread. Three unsuccessful cycles open `operator_guidance@1`; guidance resumes the same
loop and worktree rather than failing the run. The operator can explicitly finish a
review with no comments. The real pilot remains open, so the real-mutation flag stays
off by default. Automatic thread resolution is not assumed without a verified company
Bitbucket API contract.

### 7.4 Jenkins and Allure

Observe builds by webhook when possible and polling as recovery. Classify:

- passed;
- likely flaky/infrastructure;
- caused by current change;
- unknown.

Fetch relevant console/Allure attachments and preserve evidence. A flaky retry budget
is separate from an implementation-fix budget. After bounded unknown failures, open an
operator guidance/infrastructure wait.

Implemented on 2026-08-04 as the file-backed `ci.observe@1` block and
`jenkins.build@1` adapter. Project policy maps a repository to a job; the adapter waits
for the exact managed branch commit, reads pipeline/Allure evidence, classifies terminal
outcomes, and persists one operator-visible receipt. Its `read_only` Activity delivery
survives Worker failure without pretending a read is a reconciled mutation. 403/VPN,
flaky, infrastructure, and unknown outcomes pause at the CI boundary with all prior
work preserved. Company Jenkins has not yet been called; fake-port and local Temporal
recovery tests cover the contract.

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
5. Every accepted continuation starts as a Child Workflow with immutable graph input.
6. Independent repository/worktree/publication work also receives its own workspace lifecycle.
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

Implementation status on 2026-08-03: complete. Temporal is the only runtime, the
release suite and 12 Temporal-backed browser scenarios pass, and the cutover removes
more than 5,300 net lines.

Local cutover ergonomics were closed on 2026-08-04: `pnpm dev` now owns the complete
development stack and health gate, while an immutable `0002` migration preserves M0
product evidence and removes only obsolete scheduler storage.

Cutover only after the parity matrix in
[`temporal-migration.md`](temporal-migration.md) passes. Then:

1. stop creating legacy runs;
2. confirm there are no valuable active legacy fixture runs to export;
3. remove the legacy scheduler, lease/fence, cursor, custom wait/signal, retry timer,
   and duplicate execution-state code;
4. collapse ledger repository methods/tables to product metadata/artifacts/effects;
5. replace legacy runtime tests with Temporal integration/replay tests;
6. rename/remove `stub` runtime configuration and docs;
7. remove feature flags and the runtime fork;
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

The Temporal cutover, local review/revision/reply lifecycle, Jira task admission,
before-reproduction evidence attachment, and Jira review-ready effect are complete.
Enable the explicit remote-effect flags together with `TASKER_EXTERNAL_EFFECT_TASKS` for one
allowed pilot task. The Worker fails closed without the task allowlist, and an unlisted task is
blocked before any remote adapter call. The pilot path
remains Jira intake -> managed worktree -> agent implementation -> targeted
verification -> validated PR draft -> safe push/PR -> Jenkins classification -> human
review/revision.
