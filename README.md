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
The versioned multi-project agent configuration copied into managed worktrees lives in
[`harness/workspace`](harness/workspace/README.md); credentials remain outside that pack.

## Current implementation state

Temporal is the only runtime. The custom queue, scheduler, cursor, lease/fence, wait
table, and stub runner have been deleted. The generic Workflow interprets an immutable
task graph; typed Activities execute snapshotted agent and process blocks; Updates
handle plan review, clarification, code review, and operator guidance; late discoveries
start validated Child Workflows without rewriting the accepted parent graph.

The current vertical slice covers dynamic graph generation, managed workspace setup,
implementation planning/revision, durable waits, recovery/replay, parallel task runs,
and the three-pane operator console. A gated Bitbucket branch/PR adapter now implements
intent/probe/receipt reconciliation and its local crash matrix; it remains disabled by
default until the company PR-policy block is in the graph. Jira lifecycle,
Jenkins/Allure, and review/revision are the remaining T4 work. See
[`docs/codex/t1-temporal-walking-skeleton.md`](docs/codex/t1-temporal-walking-skeleton.md)
for the runtime boundary and recovery evidence.

```bash
fnm exec --using=24.16.0 /usr/local/bin/pnpm verify
fnm exec --using=24.16.0 /usr/local/bin/pnpm test:e2e
fnm exec --using=24.16.0 /usr/local/bin/pnpm demo:m1
```

To exercise Tasker, install Temporal CLI and run `pnpm temporal:dev`,
`pnpm temporal:worker`, `pnpm temporal:api`, and `pnpm dev:cockpit` in separate
terminals. The cockpit is then available at `http://127.0.0.1:4311`, with Temporal UI
at `http://127.0.0.1:8233`.
