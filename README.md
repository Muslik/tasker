# Tasker

Personal, local-first operator console for task-adaptive coding-agent workflows.
Tasker turns a Jira task and repository evidence into a validated workflow assembled
specifically for that task, runs it through Temporal, and lets the operator intervene
without losing completed work.

Temporal is the execution kernel. Tasker owns the product-specific layers around it:

- task and repository analysis;
- versioned workflow blocks, prompts, skills, policies, and deterministic validation;
- dynamic per-task graph assembly and late graph revisions;
- Jira, Bitbucket, Jenkins/Allure, Confluence, provider, process, and worktree adapters;
- operator UI, artifacts, transcripts, shadow API cost, elapsed time, and retrospective.

There are no base workflow templates. The analyzer starts from an empty graph and uses
registered building blocks plus company/project policy. The accepted graph is immutable
input to a generic Temporal graph interpreter. Agent calls, shell commands, filesystem
work, and remote APIs run only in Temporal Activities; review, clarification,
translation, publication, CI, and infrastructure pauses use durable Temporal messages
and conditions.

Read the canonical design in [`docs/codex`](docs/codex/README.md), the migration and
deletion plan in
[`docs/codex/temporal-migration.md`](docs/codex/temporal-migration.md), and the extension
contract in
[`docs/codex/customization-guide.md`](docs/codex/customization-guide.md).

Prompts and company/project workflow guidance are editable under [`harness`](harness).
Typed step contracts currently live in
[`src/harness/step-definitions.ts`](src/harness/step-definitions.ts).

## Current implementation state

M0–M2 proved task intake, dynamic graph assembly, deterministic validation, the
three-pane operator console, plan review, workflow continuation, and restart-safe stub
execution. That execution slice predates the Temporal decision and still contains a
custom queue, cursor, lease, wait, and recovery implementation. It is not the target
runtime and will be removed after Temporal parity tests pass. Repository and remote
system mutation remain disabled until the Temporal activity boundary is in place.

T1 now provides an opt-in Temporal walking skeleton: a generic compiled-graph
interpreter, typed Query/Update contracts, Activity retry, independent durable waits,
worker replay, Tasker run-ID indexing, and control-plane/cockpit projection. See
[`docs/codex/t1-temporal-walking-skeleton.md`](docs/codex/t1-temporal-walking-skeleton.md)
for the exact boundary and current limitations.

```bash
fnm exec --using=24.16.0 /usr/local/bin/pnpm verify
fnm exec --using=24.16.0 /usr/local/bin/pnpm demo:m0
fnm exec --using=24.16.0 /usr/local/bin/pnpm test:e2e
fnm exec --using=24.16.0 /usr/local/bin/pnpm demo:m1
```

The legacy comparison runtime remains available through `demo:m1`. To exercise the
Temporal slice, install Temporal CLI and run `pnpm temporal:dev`,
`pnpm temporal:worker`, `pnpm temporal:api`, and `pnpm dev:cockpit` in separate
terminals. The cockpit is then available at `http://127.0.0.1:4311`, with Temporal UI
at `http://127.0.0.1:8233`.
