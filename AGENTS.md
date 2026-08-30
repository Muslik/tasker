# Tasker project guidance

The project is mid-rebuild. The single source of truth for architecture decisions,
target structure, and phase status is [`docs/REBUILD.md`](docs/REBUILD.md). The old
design documents live in [`docs/archive/`](docs/archive) and describe a system that
partially never existed — never base decisions on them.

## Working rules

- Evaluate every proposal (including the user's) against `docs/REBUILD.md` and the
  current code. If it contradicts the target model, weakens an invariant, or
  duplicates a concept, say so concretely before implementing.
- LLM only where intelligence is required; everything determinable is deterministic;
  "waiting on the world" is a state, not a failure.
- No backward compatibility: dev data is disposable, schema bumps are fine.
- Choose the simplest implementation that fully meets the current requirement; no
  speculative generality, no compatibility shims, no `if` patches around symptoms —
  fix causes.
- Every production incident becomes a test fixture (see the test taxonomy in
  `docs/REBUILD.md`) before it is fixed.
- Commits: one line, no trailers.
