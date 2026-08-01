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

The first visible workflow has shipped in M1. The first full traversal of that graph on
durable stub steps arrives at M2. Real providers and corporate integrations are
deliberately later milestones.

M0 and M1 are now implemented. M1 renders the persisted graph in a read-only cockpit
and CLI, including validation failures, waits, retry bounds, verification rationale,
capabilities, template diff, and JSON download. Execution remains disabled until M2.

Older July 30 versions remain under `.omx/plans/` for audit history; they are not the
current implementation source of truth.
