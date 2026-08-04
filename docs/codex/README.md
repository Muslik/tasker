# Tasker design package

Status: **Temporal-only runtime cutover and T3 managed execution implemented**,
2026-08-04.

## Canonical documents

Read these for decisions and future implementation:

1. [`architecture.md`](architecture.md) — product/runtime boundary, dynamic graph
   assembly, Activities, messages, graph evolution, operator UI, security, and
   invariants.
2. [`temporal-migration.md`](temporal-migration.md) — preserve/replace/delete map,
   parity matrix, data transition, cutover, and rollback.
3. [`implementation-plan.md`](implementation-plan.md) — T0–T7 delivery ladder and the
   delivered Temporal runtime and the remaining product milestones.
4. [`t1-temporal-walking-skeleton.md`](t1-temporal-walking-skeleton.md) — implemented
   runtime boundary, local commands, recovery evidence, and deliberate limits.
5. [`t2-temporal-planning.md`](t2-temporal-planning.md) — real planning Activity,
   immutable input snapshot, durable question/review loop, and remaining exit work.
6. [`test-spec.md`](test-spec.md) — domain, Temporal, recovery, effect, UI, and pilot
   acceptance gates.
7. [`technology-decisions.md`](technology-decisions.md) — concrete TypeScript/Temporal
   contracts, messages, Activities, persistence, retry, and dependency decisions.
8. [`customization-guide.md`](customization-guide.md) — how to add or change blocks,
   prompts, policies, providers, trackers, repositories, and company packs without
   rewriting the runtime.
9. [`research-index.md`](research-index.md) — evidence trail and the 2026-08-03 decision
   correction.

These eight files are the source of truth. Older `.omx` plans are audit history only.

## Current code versus target

The codebase preserves these product slices:

- dynamic task-specific workflow generation from Jira/repository/policy evidence;
- deterministic IR validation and stable rationale/provenance;
- subscription-Codex task and implementation planning;
- Jira task surface and explicit repository binding;
- operator console with task list, live activity, plan/question/review/intervention
  surfaces, and workflow tree.

The Temporal runtime is now the only execution runtime in the codepath for new runs.
Compiled graphs, durable waits, validated Updates, implementation planning, managed
workspace preparation, and registered agent/process step execution all run through
Temporal. Planning questions, plan review/revision, provider retry, workspace retry,
execution-time workflow change review, and child-workflow continuation have recovery
coverage. Local mutation now also survives Worker replacement after a dirty worktree is
created but before its Activity response is acknowledged. Jira/Bitbucket/Jenkins
mutation remains disabled.

## Historical implementation records

The following files describe what was built before the Temporal decision. They remain
useful for behavior parity and audit, but their custom runtime mechanisms are not target
architecture:

- [`m0-implementation.md`](m0-implementation.md)
- [`m1-implementation.md`](m1-implementation.md)
- [`m1.5-implementation.md`](m1.5-implementation.md)
- [`m1.6-jira-task-surface.md`](m1.6-jira-task-surface.md)
- [`m1.7-repository-binding.md`](m1.7-repository-binding.md)
- [`m1.8-jira-workflow-generation.md`](m1.8-jira-workflow-generation.md)
- [`m2-stub-execution.md`](m2-stub-execution.md)
- [`m2.1-implementation-planning.md`](m2.1-implementation-planning.md)
- [`m2.2-workflow-continuation.md`](m2.2-workflow-continuation.md)

Historical behavior survives only when it is still a product requirement. Tests for
custom ready sets, leases, fence tokens, cursors, and wait tables are replaced by
Temporal public recovery/integration tests after parity.

## Immediate implementation target

T3 managed execution is now implemented in
[`t3-managed-execution.md`](t3-managed-execution.md). The next runtime milestone is
T4: real external integrations and PR/CI lifecycle behind explicit effect and recovery
contracts. The Temporal cutover, full release verification, and browser parity are
complete; future work must not reintroduce a second runtime.
