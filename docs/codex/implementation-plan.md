# Tasker v4 delivery plan

Status: canonical execution plan, 2026-08-13

The detailed historical execution plan is
[`../../.omx/plans/implementation-plan-task-adaptive-agent-harness-v4.md`](../../.omx/plans/implementation-plan-task-adaptive-agent-harness-v4.md).
This file is the current phase map; canonical architecture and tests live beside it in
`docs/codex`. Superseded milestone documents remain only in Git history.

## Goal

The first production-quality path is:

```text
Jira backlog
-> managed Docker workspace
-> context and task-specific investigation
-> mandatory implementation plan
-> optional operator plan review
-> frozen task-specific workflow
-> implementation
-> selected validation
-> independent agent review
-> reconciled PR publication
-> CI classification and recovery
-> Jira review-ready
-> human code-review wait
```

Every execution workflow is generated for its task from registered blocks. There is no
default bugfix, feature, translation, or delivery graph. Temporal is the durable
execution substrate; Tasker owns block semantics, completion evidence, effects, policy,
and operator projections.

## Sequencing rule

Block Definition v3 and Block Receipt v4 make completion evidence, durable usage, and deterministic predicate facts authoritative. Do not add more
production effects until the current receipt boundary remains green under repository-
wide recovery tests. The execution kernel advances only from immutable receipts, never
from an agent's schema-valid prose claim.

Each phase follows this order:

1. state the public behavior and recovery invariant;
2. add the test that proves it;
3. define the smallest typed contract;
4. implement one vertical slice;
5. verify worker/API/provider/response-loss recovery where relevant;
6. verify the operator projection;
7. update canonical documentation in the same change.

## Phase map

| Phase | Result | Operator checkpoint |
|---|---|---|
| 0. Canonical reset | docs and tests describe the v4 boundaries | current guarantees inventoried |
| 1. Temporal kernel | frozen graphs run through a vendor-free interpreter | A: independent graphs survive restart |
| 2. Block contract v3 | claims require evidence; receipts own predicate facts | B: claim, evaluator, and evidence are inspectable |
| 3. Execution profiles | Codex/Claude profiles and actual models are configurable | actual profile visible |
| 4. Honest bootstrap | context, investigation, plan, validation, then freeze | C: real task becomes a task-specific graph |
| 5. Operator projection | semantic stages with configurable agent/process/wait work | readable parallel live work |
| 6. Local implementation | implementation, selected checks, independent review | D: real feature and bug are locally ready |
| 7. Delivery | base reconciliation, commit, push, PR, Jira receipts | safe allowlisted publication |
| 8. CI recovery | passed/flaky/infra/ours/unknown branches | E: Jira task reaches human review wait |
| 9. PR revision | human comments drive bounded revision and CI | same PR/worktree returns to review |
| 10. Retrospective | time, cost, interventions, improvement suggestions | preliminary and final reports |
| 11. Continuations | late cross-repo/translation/publish work | parent prefix and worktrees preserved |
| 12. Pilot and release | 10+ representative tasks and release audit | release gate |

## Current implementation cut

Bootstrap v3 plus Execution v2 is the only runtime path. Bootstrap owns preparation, context,
planning, review, validation, and freeze; Execution owns deterministic traversal of the
frozen graph. The old Workflow type, compatibility parser, registry, state adapter,
tests, and Jira before-evidence policy are deleted.

The cleanup cut also removes production fixture composers, task-family inference,
deterministic planner fallbacks, M0/M1 control-plane naming, and incremental schema
migrations. Production planning now starts from a neutral `WorkflowGenerationSubject`
resolved by registered task-source adapters, and a new installation creates the one
current SQLite baseline. Repository architecture tests prevent the workflow domain and
Temporal kernels from importing the operator control plane or external integrations.

An accepted plan starts Execution immediately after freeze. There is no separate
operator launch gate or passive planned state. During an active run the operator
projection must show either a real running Temporal node with persisted progress or a
durable wait with its required action; tracker admission belongs to `Implement`. The
runtime refresh path reads only the selected task's Temporal projection, persisted
transcript, and activity instead of reloading Jira and the full planning surface. Query
failures are rendered as observability failures rather than swallowed by polling.

Block Definition v3 with Block Receipt v4 is the active execution boundary. The immutable planning snapshot
contains the full block definition; Activities persist the agent/process/effect
candidate, collect completion evidence independently, evaluate the declared contract,
derive only block-declared output predicates, and persist an idempotent Block Receipt. Only an accepted receipt returns `completed`
to the Temporal interpreter. Obsolete step-manifest and planning-snapshot schemas fail
closed and have no compatibility reader.

Execution profiles are now the only provider-selection boundary. Company configuration
registers Codex and Claude subscription-CLI profiles; company routing selects analyzer
and fast/ralplan planner profiles; a project may redirect those routes and logical agent
profiles. Resolution fails closed, and the immutable planning snapshot records the
resolved provider, command, model, effort, timeout, service tier, and configuration
hash. Receipts expose the actual CLI version, session, token usage, duration, prompt
hash, and a versioned price-table, provider-reported, or explicitly unrated API-equivalent cost. There is no legacy model field,
hard-coded `gpt-5.4` path, or silent provider fallback.

The former Phase 8 expanded CI slice is superseded by semantic Delivery. Exact-revision
Jenkins observations remain provider-neutral typed operations; task-caused failures
materialize one linked implementation continuation, while flaky, infrastructure, and
unknown results remain states of the active Delivery block and re-observe on resume.
Automatic Jenkins retrigger remains a later reconciled effect rather than a hidden read-side mutation.

Jira lifecycle transitions now preflight provider-owned field requirements for both
admission and review-ready paths. Missing values become an actionable durable wait
before mutation; Resume re-observes Jira and continues the same block without replaying
completed transitions or delivery work. Jira 400 field/validator reasons remain a
fallback for server rules that transition metadata cannot describe.
Review-ready delivery reconciles one configured-prefix managed PR comment across task
runs: it updates the old link, accepts an existing human comment with the exact current
URL without rewriting it, and stops on multiple managed matches.

Bootstrap delivery failures now preserve their bounded Activity root cause in the
durable operator wait. Workspace/Docker, context, planning, investigation, and freeze
failures are diagnosable from the console and Resume retries only the pending stage.

Phase 4B is superseded by the semantic-workflow cutover: Generate starts Bootstrap v3 without a workflow/hash, prepares the
managed worktree and Docker runtime, persists graph-free context and evidence, and runs
mandatory planning. The planner may request registered investigation blocks and owns
the first complete semantic workflow candidate. Deterministic compilation and validation feed
bounded corrections back to planning before optional review and freeze. The former
pre-planning assembler, draft-revision Activity, schema v7 reader, and `phase=before`
execution reproduction are deleted with no compatibility path.

Implementation Plan v2 makes verification part of the accepted planning decision rather
than an execution-time guess. Each criterion has a stable id, observable expectation,
typed verification strategy, and references to the exact semantic Verify work that proves
it. Missing references reject the decision. The planner may select a new automated test,
but test creation remains implementation work and no universal materialization block is
inserted. Planner receipts are `implementation-planner@3`; v1 plans and prior receipts
have no compatibility reader.

The former Phase 5 projection is superseded. The raw `workflow.tree` response, persisted
`workflow.stages`, and Cockpit tree component are deleted. Blocks and durable waits own
configurable stage descriptors. A dedicated operator endpoint joins the complete
Bootstrap lifecycle, frozen semantic source, executable provenance, live Execution state,
and immutable Block Receipts/Run Events into one disposable read model. It shows preparation,
investigation, and planning before execution starts, then semantic execution stages. Agent
invocations and durable human decisions become rows; configured commands are expandable operations. Internal
Temporal containers, integrations, retries, reconciliation and receipt validation affect
stage state but remain diagnostics. Future stages remain compact headers; rows appear
when their work starts, so unselected recovery branches stay absent. Operator waits use
a persistent amber action surface, and the console
supports persisted light/dark themes.
The raw graph remains a downloadable diagnostic artifact. Operator workflow projection schema v6
includes a typed intervention action; obsolete projections are deleted instead of interpreted or
upcast.

Phase 6 implementation is present: project manifests own exact `validate.*` commands; non-zero
validation results become typed loop facts; `code.repair`, `bug.validate_fix`, and
`review.agent` have separate completion contracts; and validation/review repair is bounded by
durable operator guidance. The remaining checkpoint is empirical: run one real feature and one
real bug through this suffix and inspect same-run receipts, worktree reuse, final bug evidence,
and accepted independent review before enabling remote publication authority.

## Phase 0 exit gate

- canonical documents describe Stage, Block, Effect, Agent Episode, and the completion
  protocol consistently;
- current recovery guarantees are tested independently of business step names;
- no new implementation depends on `short_bugfix`, automatic Jira before-evidence, or
  per-step retry badges;
- the old Workflow implementation is not a supported execution path and is deleted as
  part of the v2 kernel cutover.

## Phase 1 exit gate

- a versioned Execution Workflow accepts only a frozen graph, run settings, and opaque
  context/artifact references;
- its modules contain no planning, Docker, provider, tracker, SCM, CI, or repository
  knowledge;
- sequence, branch, bounded loop, wait, finalize, public Query, and validated wait
  Update work in Temporal tests;
- two runs remain independent and a worker replacement preserves progress;
- client, worker, and control-plane routes use only the new Workflow type;
- the old Workflow type, compatibility parser, patches, and dedicated tests are gone.

## Phase 2 exit gate

- `AgentClaim` and authoritative `BlockOutcome` are distinct contracts;
- a summary with empty evidence cannot complete an implementation block;
- process, workspace mutation, structured evidence, and reconciled remote-effect
  evaluators produce immutable block receipts;
- question, infrastructure, provider, workflow-change, and permanent failure outcomes
  are different public states;
- response loss after receipt persistence returns the same outcome.

## Phase 3 exit gate

- analyzer, fast planner, ralplan planner, and agent steps resolve registered logical
  profiles rather than model identifiers embedded in code;
- Codex and Claude implement the same structured analyzer/planner/step contracts through
  subscription CLIs;
- company routing, project overrides, and explicit operator overrides have deterministic
  precedence and reject an unknown profile;
- the current run snapshot accepts only schema v10 and contains the complete resolved
  profile for every agent block and both planner strategies;
- the operator session banner shows the actual profile, provider, model, effort, time,
  measured tokens, and API-equivalent cost status.

## Phase 5 exit gate

- stage identity and labels come from harness block/wait contracts rather than UI code;
- one agent invocation, configured process command, or durable wait produces exactly
  one operator step;
- the primary rail shows stage state while technical graph nodes, integrations,
  reconciliation, receipts, and effects stay on diagnostic/transcript surfaces;
- planned stages remain headers and conditional repair, CI, and review bodies do not
  appear before their branch executes;
- workspace, context, investigation, planning, review, freezing, and execution progress
  share one operator projection even before an execution graph exists;
- changing the projection never mutates, patches, or influences the frozen graph;
- the removed raw-tree response, component, and schema reader do not remain as a
  compatibility path.

## Core release gate

Run at least ten allowlisted representative tasks. At least five must reach useful
human code review without operator code edits. The pilot must produce zero duplicate
remote mutations, zero discarded managed worktrees/completed prefixes, and attributable
time, tokens, shadow cost, retries, waits, questions, and guidance.

Repository-wide phase verification is `pnpm verify`, supplemented by Temporal replay,
response-loss recovery, provider subscription smoke, and Playwright operator journeys
where the phase changes those surfaces.
