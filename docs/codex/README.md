# Tasker design package

Status: canonical v4 architecture, 2026-08-09

Tasker has one supported runtime model: a Temporal Bootstrap Workflow prepares and
freezes one task-specific graph, then a small Temporal Execution Workflow interprets
that immutable graph. There is no legacy runner, workflow template, or historical
schema compatibility path.

## Canonical documents

Read these in order:

1. [`architecture.md`](architecture.md) — ownership boundaries, lifecycle, block
   semantics, recovery, operator projection, and invariants.
2. [`planning-lifecycle.md`](planning-lifecycle.md) — context discovery, mandatory
   planning, optional plan review, candidate revision, validation, and freeze.
3. [`implementation-plan.md`](implementation-plan.md) — phased route from the current
   kernel cutover to the pilot release.
4. [`test-spec.md`](test-spec.md) — domain, Temporal, recovery, effect, UI, and pilot
   acceptance gates.
5. [`customization-guide.md`](customization-guide.md) — adding blocks, prompts, skills,
   policies, providers, trackers, repositories, and company packs.
6. [`docker-execution.md`](docker-execution.md) — Docker-only agent/process execution,
   task-scoped services, caches, and project bootstrap.
7. [`technology-decisions.md`](technology-decisions.md) — concrete implementation
   choices that remain below the architecture boundary.
8. [`research-index.md`](research-index.md) — external evidence and decision trail.

The deleted M0–M2 and T1–T4 documents described superseded implementations. Git
history is the audit trail; they are not inputs to new work.

## Current cut

- Bootstrap v3 and Execution v2 are the only worker/API path.
- Bootstrap persists a graph-free planning context; the mandatory planner owns the
  first complete execution workflow candidate after any selected investigation.
- Planning and plan review belong to Bootstrap and are absent from execution graphs.
- Jira before-reproduction attachment policy is removed; reproduction evidence stays
  private to execution unless an explicit final-demo policy publishes it later.
- Run snapshots accept only the current schema and current Docker runtime policy.
- Block Definition/Receipt v3 is the only authority that may advance the execution
  graph. It carries deterministic output-to-predicate facts; obsolete schemas are rejected,
  not migrated.
- Company/project execution profiles select Codex or Claude, model, reasoning effort,
  service tier, and timeout. The resolved profile and hash are frozen with the run;
  unknown profiles reject pack loading instead of falling back to another provider.
- The right-rail workflow is a disposable operator projection over complete Temporal
  lifecycle state, the frozen graph, and immutable Block Receipts. Runtime stages are
  not persisted inside `WorkflowView`; obsolete persisted stage/tree schemas are
  deleted rather than adapted.
- Operator stages expose only configurable work: one agent invocation, one configured
  process command, or one durable human wait per row. Temporal sequences, branches,
  loops, retries, integrations and receipt checks only drive stage state. Future stages
  stay as headers; rows appear when they start, so conditional recovery bodies are
  absent unless selected. Required operator decisions
  remain visible in an amber action surface, and the console persists a light/dark theme
  preference.
