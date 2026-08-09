# Tasker v4 delivery plan

Status: canonical execution plan, 2026-08-09

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

Do not add more production effects until Block Contract v2 makes completion evidence
authoritative. The execution kernel is now small; the remaining risk is allowing the
Activity runner to advance it from an agent's schema-valid prose claim.

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

Temporal kernel v2 is the only runtime path. Bootstrap owns preparation, context,
planning, review, validation, and freeze; Execution owns deterministic traversal of the
frozen graph. The old Workflow type, compatibility parser, registry, state adapter,
tests, and Jira before-evidence policy are deleted.

The next active boundary is `src/temporal/activities/block-execution.ts`: it still
accepts a schema-valid agent completion without proving declared workspace/artifact
obligations. Preserve its worktree, artifact, transcript, effect journal, response-loss
reconciliation, durable wait, and independent-task guarantees while replacing only
completion authority with Block Contract v2 receipts.

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

## Core release gate

Run at least ten allowlisted representative tasks. At least five must reach useful
human code review without operator code edits. The pilot must produce zero duplicate
remote mutations, zero discarded managed worktrees/completed prefixes, and attributable
time, tokens, shadow cost, retries, waits, questions, and guidance.

Repository-wide phase verification is `pnpm verify`, supplemented by Temporal replay,
response-loss recovery, provider subscription smoke, and Playwright operator journeys
where the phase changes those surfaces.
