# Tasker v4 delivery plan

Status: canonical execution plan, 2026-08-10

The detailed implementation-ready plan is
[`../../.omx/plans/implementation-plan-task-adaptive-agent-harness-v4.md`](../../.omx/plans/implementation-plan-task-adaptive-agent-harness-v4.md).
It supersedes the T0-T7 milestone plan and the task-family-oriented T4 graph as the
target architecture. Superseded milestone documents are deleted rather than parsed,
indexed, or preserved as compatibility guidance; Git history remains the audit trail.

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

Block Contract v2 now makes completion evidence authoritative. Do not add more
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
| 1. Temporal kernel v2 | frozen graphs run through a vendor-free interpreter | A: fixture graph survives restart |
| 2. Block contract v2 | agent claims require completion evidence | B: claim, evaluator, and evidence are inspectable |
| 3. Execution profiles | Codex/Claude profiles and actual models are configurable | actual profile visible |
| 4. Honest bootstrap | context, investigation, plan, validation, then freeze | C: real task becomes a task-specific graph |
| 5. Operator projection | macro stages with expandable blocks/effects | readable parallel live work |
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

Block Contract v2 is the active execution boundary. The immutable planning snapshot
contains the full block definition; Activities persist the agent/process/effect
candidate, collect completion evidence independently, evaluate the declared contract,
and persist an idempotent Block Receipt. Only an accepted receipt returns `completed`
to the Temporal interpreter. Obsolete step-manifest and planning-snapshot schemas fail
closed and have no compatibility reader.

Execution profiles are now the only provider-selection boundary. Company configuration
registers Codex and Claude subscription-CLI profiles; company routing selects analyzer
and fast/ralplan planner profiles; a project may redirect those routes and logical agent
profiles. Resolution fails closed, and the immutable planning snapshot records the
resolved provider, command, model, effort, timeout, service tier, and configuration
hash. Receipts expose the actual CLI version, session, token usage, duration, prompt
hash, and reported API-equivalent cost where available. There is no legacy model field,
hard-coded `gpt-5.4` path, or silent provider fallback.

Phase 4B is complete: Generate starts Bootstrap v3 without a graph/hash, prepares the
managed worktree and Docker runtime, persists graph-free context and evidence, and runs
mandatory planning. The planner may request registered investigation blocks and owns
the first complete workflow candidate. Deterministic compilation and validation feed
bounded corrections back to planning before optional review and freeze. The former
pre-planning assembler, draft-revision Activity, schema v7 reader, and `phase=before`
execution reproduction are deleted with no compatibility path.

Phase 5 is complete. The former raw `workflow.tree` response, persisted
`workflow.stages`, and Cockpit tree component are deleted. Blocks and durable waits own
configurable stage descriptors. A dedicated operator endpoint joins the complete
Bootstrap lifecycle, the frozen graph, live Execution node state, and immutable Block
Receipts into one disposable read model. It shows preparation, investigation, and
planning before an execution graph exists, then adjacent execution episodes with
explicit attempt counts, accepted/rejected claims, evidence, and reconciled effects.
The raw graph remains a downloadable diagnostic artifact. View schema v5 projections
are deleted when encountered instead of being interpreted or upcast.

The next active boundary is Phase 6: prove a real feature and bug through local
implementation, selected validation, and independent agent review without adding
remote publication authority yet.

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
- the current run snapshot accepts only schema v8 and contains the complete resolved
  profile for every agent block and both planner strategies;
- the operator session banner shows the actual profile, provider, model, effort, time,
  measured tokens, and API-equivalent cost status.

## Phase 5 exit gate

- stage identity and labels come from harness block/wait contracts rather than UI code;
- adjacent work is grouped into ordered episodes and a later revisit creates a new
  episode with the same semantic stage id;
- the primary rail shows stage state while technical graph nodes, block attempts,
  receipts, and effects are expandable details;
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
