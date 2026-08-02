# Tasker design package

Status: **approved by Planner -> Architect -> Critic consensus**, v3, 2026-08-01.

Read in this order:

1. [`architecture.md`](architecture.md) — canonical product/system model and all
   determinism, failure, wait, intervention, review, CI, translation, and cross-repo
   contracts.
2. [`implementation-plan.md`](implementation-plan.md) — dependency-ordered delivery
   ladder, operator demo at every milestone, estimates, rollback, and staffing.
3. [`test-spec.md`](test-spec.md) — named acceptance and recovery scenarios plus
   milestone/readiness gates.
4. [`technology-decisions.md`](technology-decisions.md) — concrete workflow DSL,
   dependency, error/recovery, persistence, rendering, and test-harness decisions.
5. [`research-index.md`](research-index.md) — source and decision trail.
6. [`m0-implementation.md`](m0-implementation.md) — implemented kernel contracts,
   commands, demo artifacts, and the exact boundary before M1.
7. [`m1-implementation.md`](m1-implementation.md) — the working task-to-workflow
   planner, durable projections, local API/CLI, cockpit, and operator demo.
8. [`m1.5-implementation.md`](m1.5-implementation.md) — real subscription-CLI
   workflow assembly, provider isolation, provenance, token evidence, and runtime
   discovery boundary.
9. [`m1.6-jira-task-surface.md`](m1.6-jira-task-surface.md) — persisted read-only Jira
   intake, operator task details, attachment proxy, and VPN/403 recovery semantics.
10. [`m1.7-repository-binding.md`](m1.7-repository-binding.md) — explicit Jira task to
    managed Bitbucket checkout resolution without project-name guessing or touching
    operator working clones.
11. [`m1.8-jira-workflow-generation.md`](m1.8-jira-workflow-generation.md) — real Jira
    snapshot plus managed checkout through the subscription analyzer, validator, ledger,
    and visible operator graph.
12. [`m2-stub-execution.md`](m2-stub-execution.md) — durable execution slice: bounded
    queue capacity, fenced ownership, per-node receipts, restart-safe cursor, realtime
    runtime state, mandatory planning with immutable per-run human-approval policy, an
    immutable plan-review correction loop, and a slot-releasing code-review wait.
13. [`m2.1-implementation-planning.md`](m2.1-implementation-planning.md) — real typed
    implementation plans through subscription Codex CLI, deterministic fast/ralplan
    routing, persisted provenance/usage, plan revision, blocking clarification, and the
    operator plan surface.
14. [`m2.2-workflow-continuation.md`](m2.2-workflow-continuation.md) — immutable linked
    workflow candidates, deterministic lineage validation, `review_all`, recoverable
    repository retry, candidate review, and linked child-run execution projected as one task.
15. [`customization-guide.md`](customization-guide.md) — operator/developer extension
    contract, prompt and harness pack layout, step registration, provider-neutral
    `SkillRef` mapping, tracker adapter boundaries, and provenance-preserving materialization.

The first visible workflow shipped in M1. M1.5 now assembles it through a real read-only
subscription CLI provider. M2 has started: accepted graphs can now queue and traverse
durable stub steps in parallel up to configured capacity, recover fenced ownership,
stop at persisted plan/code-review waits, and turn operator plan feedback into a new
restart-safe provider attempt. Blocking planner questions also pause without consuming
a slot, persist exact operator answers, and continue the same run. Every accepted graph
retains the same planning boundary; the start checkbox determines only whether the
operator must approve the resulting plan. A planning-discovered repository change now
compiles a separate immutable candidate, pauses for review, and after acceptance
executes a durable child cursor through the scheduler without rewriting or restarting
the parent. Corporate integrations remain later milestones.

M0, M1, M1.5, M1.6, M1.7, M1.8, and the first M2 vertical slice are implemented. The operator
console has the task queue on the left, persisted activity and workflow rationale in
the center, and the current graph on the right. It includes validation failures,
waits, retry bounds, project/global policy decisions, verification rationale,
capabilities, collapsed template diagnostics, SSE refresh, and JSON download.
Implementation planning now uses a real subscription Codex CLI provider; accepted
continuations reach their own durable code-review wait and resolve the parent join on
completion, while graph nodes remain deterministic local stubs. Tasker performs no repository, Jira,
Bitbucket, or CI mutation. Provider provenance and measured tokens are persisted and
visible.
An imported Jira task with a resolved checkout can now be compiled into a workflow.
Jira text only selects a conservative admission template; the analyzer receives the
full Jira snapshot and bounded repository evidence before proposing the graph.

Older July 30 versions remain under `.omx/plans/` for audit history; they are not the
current implementation source of truth.
