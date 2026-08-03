# Tasker design package

Status: **Temporal target architecture approved**, 2026-08-03.

## Canonical documents

Read these for decisions and future implementation:

1. [`architecture.md`](architecture.md) — product/runtime boundary, dynamic graph
   assembly, Activities, messages, graph evolution, operator UI, security, and
   invariants.
2. [`temporal-migration.md`](temporal-migration.md) — preserve/replace/delete map,
   parity matrix, data transition, cutover, and rollback.
3. [`implementation-plan.md`](implementation-plan.md) — T0–T7 delivery ladder and the
   next Temporal walking-skeleton milestone.
4. [`test-spec.md`](test-spec.md) — domain, Temporal, recovery, effect, UI, and pilot
   acceptance gates.
5. [`technology-decisions.md`](technology-decisions.md) — concrete TypeScript/Temporal
   contracts, messages, Activities, persistence, retry, and dependency decisions.
6. [`customization-guide.md`](customization-guide.md) — how to add or change blocks,
   prompts, policies, providers, trackers, repositories, and company packs without
   rewriting the runtime.
7. [`research-index.md`](research-index.md) — evidence trail and the 2026-08-03 decision
   correction.

These seven files are the source of truth. Older `.omx` plans are audit history only.

## Current code versus target

The codebase has working pre-Temporal M0–M2 slices:

- dynamic task-specific workflow generation from Jira/repository/policy evidence;
- deterministic IR validation and stable rationale/provenance;
- subscription-Codex task and implementation planning;
- Jira task surface and explicit repository binding;
- operator console with task list, live activity, plan/question/review surfaces, and
  workflow tree;
- a custom durable stub runner with queue, leases, cursor, waits, and continuation.

The last bullet is now legacy migration code. Temporal will replace its scheduling,
history, waits, retries, recovery, and parent/child coordination. It does not replace
Tasker's analyzer, IR, compiler, validator, block catalog, policies, integrations,
worktree management, operator console, artifacts, costs, or retrospective.

No real repository/Jira/Bitbucket/Jenkins mutation is enabled in the legacy stub
runtime. That is deliberate: the next implementation milestone is the Temporal walking
skeleton, followed by real Activities with idempotency/reconciliation.

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

T1 proves the new boundary with two independently running dynamically assembled fixture
graphs. They must survive worker/API restart, stop at different durable waits, resume
only the selected task, and render live state in the existing console. Real coding,
remote mutation, CI, and cross-repository continuation follow only after this kernel
slice is green.
