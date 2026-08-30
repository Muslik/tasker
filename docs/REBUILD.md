# Tasker rebuild — canon

This file is the single source of truth during the rebuild (August 2026). The old
design documents in [`docs/archive/`](archive) describe a system that partially never
existed; do not consult them for decisions. A final `ARCHITECTURE.md` and
`OPERATIONS.md` will replace this file when the rebuild converges.

## Why (audit findings, verified against code and the run ledger)

The system ran 3 real tasks; none passed cleanly. The failure sources were not random:

1. The planner had to synthesize the full workflow graph in one JSON shot against a
   fail-closed validator (15 error classes + a mandated loop skeleton it must retype),
   with a 2-correction budget.
2. Stream parsing died on any non-JSON stdout line, discarding 10–35 min agent runs.
3. Activity timeout (35 m) equaled the CLI profile timeout exactly — no headroom.
4. Legitimate "waiting on the world" claims (`blocked` + waitKind) were recorded as
   rejected receipts and re-run (7 of 10 delivery receipts).
5. Only `front-avia` had a complete `project.json`; unbound process blocks silently
   vanished from the planner catalog in other repos.
6. Verify was an LLM procedure while the docs claimed deterministic commands.
7. Harness edits reached only new runs; Restart destroyed evidence and then failed on
   a branch conflict.
8. Observability: the operator could not see the rendered prompt, the stuck point, or
   token burn without reading worker logs.

## Target model

**LLM only where intelligence is required. Everything determinable is deterministic.
"Waiting on the world" is a state, not a failure.**

- **Archetypes**: workflow skeletons are code (`deliver-pr`, `research`, …). The
  planner picks an archetype, picks optional segments from a menu
  (`dependency_await`, `translations`, `runtime_observe`), and fills slots: the
  implementation plan, acceptance criteria, verify spec. The planner does NOT emit
  workflow topology.
- **Step outcome contract (3 outcomes)**: `completed {output, evidence}` ·
  `waiting {waitKind, reason, resumeHint}` · `failed {category, detail, retryable}` —
  category is a typed enum from the agent, never regex over prose. Single-encoded
  JSON envelope (no JSON-in-a-string).
- **Verify**: project `validation.*@1` process commands run by the machine; the agent
  judges results and gathers runtime/visual evidence per the plan's verify spec.
- **Claims vs receipts stays**: an agent claim is verified against independently
  collected evidence before the graph advances. `waiting` is a legitimate verdict.
- **Observability is first-class**: every agent invocation persists the exact rendered
  prompt, mounted files/skills, profile/model, timings, token usage, cost, prompt
  size; the operator UI answers "what is happening / why is it stuck / where did
  tokens go" in ≤2 clicks.

## Target repository structure

```
src/
  kernel/         Temporal workflows + graph interpreter; imports nothing domain-specific
  graph/          archetype skeletons, slot compiler, IR, validation
  planning/       evidence assembly, planner prompt, slot schema, correction loop
  steps/          step runtime: agent/process/effect runners, evidence, verdicts, receipts
  agents/         CLI providers (claude, codex), stream parsing, profiles, usage/cost
  workspace/      git worktree + Docker runtime + harness pack materialization
  integrations/   jira/ bitbucket/ jenkins/ nexus/ — client + adapter + contract tests
  store/          SQLite domain tables (no event sourcing), migrations, DAO
  server/         Fastify API, thin
  ui/             cockpit v2 (TanStack Query, small components, SSE realtime)
  shared/         canonical-json (the ONLY implementation), clock, result, ids
harness/          unchanged concept: steps/ prompts/ policies/ projects/ workspace/
```

Rules: every `src/*` folder has a ≤15-line README; public surface via `index.ts` only;
dependency direction top-down enforced by dependency-cruiser in `pnpm verify`; file
size ceiling ~400 lines.

## Test taxonomy

- **unit** — colocated `src/**/*.test.ts`; pure logic, no I/O.
- **integration** — `test/integration/`; real SQLite + Temporal test env.
- **contract/providers** — `test/contract/providers/`; parsers against a corpus of
  real CLI output fixtures (incl. garbage). Every production incident becomes a
  fixture before it is fixed.
- **contract/integrations** — recorded HTTP for jira/bitbucket/jenkins/nexus edge cases.
- **e2e** — one full pass: server + worker + cockpit + `fake-agent` (a stub executable
  that plays scripted streams).

## Decisions in force

- Scope during rebuild: `front-avia` only; other repos onboarded one by one after.
- `.tasker` run history is disposable; one breaking-change window for the store rewrite.
- Corpus priority: codex first, claude second.
- Research archetype terminal artifact: markdown report + Jira comment with a link.
- SQLite: worker is the single writer; the API reads.
- Plan review defaults to `required` until the rebuild converges.
- Commits: one line, no trailers.

## Phase status

- [x] Phase 0 — stop-cock: tolerant stream parsers + corpus; `blocked` → `waiting`
      verdict (receipt v6); restart reattaches existing branch; timeout headroom
      (45 m / 3 h); heartbeat covers probe + docker build; full failure reasons;
      prompt growth capped. (waves 1–2)
- [ ] Phase 1 — observability: agent-invocation artifact, live "what/why/tokens" API.
- [ ] Phase 2 — contract v-next + archetypes + deterministic verify.
- [ ] Phase 3 — structure surgery: dead code removal, target layout, store rewrite,
      test relayout, docs from code, credentials out of agent containers.
- [ ] Phase 4 — cockpit v2: TanStack Query, component decomposition, SSE realtime.
- [ ] Phase 5 — extensions: review packet (screens + MSW mocks), figma skill, more
      archetypes, then parallelism.
