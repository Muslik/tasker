# Tasker operations

## Start locally

Install Node 24.x, pnpm 10.13.1, Docker, and the Temporal CLI. From the repository:

```bash
pnpm dev
```

The command builds the server and UI, starts or reuses Temporal, starts the worker and
operator API, waits for health, and owns the processes until Ctrl-C. The cockpit is at
`http://127.0.0.1:4311`; Temporal UI is at `http://127.0.0.1:8233`.

## Harness tuning

| Surface | Purpose | Change here |
| --- | --- | --- |
| `company.json` profiles | Provider, model, effort, timeout, and service tier | Change a named execution profile. |
| `company.json` routing | Strategy/role selection for analyzer, planner, context, implementation, verification, and review | Change `executionProfileRouting`; project overrides can take precedence. |
| `company.json` subagentProfiles | Required workspace roles and their Claude/Codex models | Keep role keys synchronized with workspace agent files and `models.env`. |
| `steps/` | Versioned executable step packages | Edit `step.json` and the package prompt; bindings are snapshotted before execution. |
| `policies/` | Quality boundaries and lifecycle policies | Edit enabled JSON policies; archetype obligations are derived from them. |
| `projects/` | Repository-specific profiles and overrides | Edit the matching `project.json`. |
| `workspace/` | Managed-worktree guidance and role pack | Edit `profiles/`, `agents/`, and the workspace manifest; materialization is validated and hashed. |

Changes to the harness affect new planning snapshots. A frozen run continues to use its
snapshotted definitions and references.

## When a task is stuck

Use the cockpit in this order:

1. Open the task and read the sticky **current attempt** header: node, block run, elapsed
   time, and the live status.
2. If it is waiting, read the **wait reason** and wait kind. Use the matching operator
   action when one is available; `waiting` can represent an external dependency,
   review, clarification, or infrastructure state.
3. Open the invocation from the header or Attempts list. Inspect the rendered **prompt**,
   transcript/raw log, argv, model/profile, exit status, and artifact metadata.
4. Compare the **tokens** table: invocation totals, input/cached/output tokens, duration,
   cost, and highlighted prompt growth by node.
5. If the state or history is unclear, open Temporal UI and inspect the workflow history,
   current run, pending update/condition, and worker activity failure. The cockpit is the
   product view; Temporal UI is the runtime-level source for execution state.

## Resume and restart

**Resume** resolves the active durable wait on the current Temporal run. It preserves the
run ID, completed work, evidence, branch, and current graph position; use the dedicated
review, clarification, dependency, or generic resume action where applicable.

**Restart** is available only for a non-completed run and requires the expected active run
ID. It terminates the existing workflow, starts bootstrap again with the saved settings,
and reattaches the new run to the existing task branch when the managed workspace finds
that branch. It is a fresh workflow run, not a deletion of the branch or its evidence.

## Incidents and fixtures

Every production incident becomes a regression fixture in the relevant test corpus
before the fix is accepted. Provider/parser incidents belong in
`test/contract/providers/fixtures/`; other durable behavior belongs with its unit or
integration test. Keep the fixture free of private task content.

## Model selection

| Work | Default route | Guidance |
| --- | --- | --- |
| Simple task context/implementation | `context-simple` / `implementation-luna-medium` | Use for narrow, well-understood changes. |
| Standard implementation | `implementation-sol-medium` | Use when several files or ordinary integration risk is involved. |
| Complex context/implementation/verification | `investigation` / `implementation-sol-xhigh` / `verification-complex` | Use for broad uncertainty, recovery, or high-risk validation. |
| Planning | `planning-fast` or `planning-ralplan` | Fast uses Terra; Ralplan uses Sol with the longer timeout. |
| Review | `review-claude-sonnet` | Keep independent review separate from implementation. |

Escalate on data, not intuition: first inspect the task evidence, wait reason, prompt,
transcript, and token growth. Move to the next strategy only when that evidence shows
uncertainty, repeated failure, or a materially broader scope; record the routing change
in the run context.

