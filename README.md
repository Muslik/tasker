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
registered building blocks plus company/project policy. A dedicated Temporal bootstrap
Workflow now owns context discovery and initial draft assembly; it stores evidence and
the compiled draft outside Temporal history and returns only the bounded result/hash.
After planning and validation, the frozen graph is immutable input to a generic Temporal
graph interpreter. Agent calls, shell commands, filesystem work, and remote APIs run
only in Temporal Activities; review, clarification, translation, publication, CI, and
infrastructure pauses use durable Temporal messages and conditions.

Read the canonical design in [`docs/codex`](docs/codex/README.md), the migration and
deletion plan in
[`docs/codex/temporal-migration.md`](docs/codex/temporal-migration.md), and the extension
contract in
[`docs/codex/customization-guide.md`](docs/codex/customization-guide.md).

Prompts and company/project workflow guidance are editable under [`harness`](harness).
Company blocks and policies are file-backed under [`harness/steps`](harness/steps) and
[`harness/policies`](harness/policies); the small built-in catalog in
[`src/harness/step-definitions.ts`](src/harness/step-definitions.ts) contains only the
current generic/product blocks and shared runtime schemas.
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
and the three-pane operator console. Initial task, harness, and bounded repository
context is persisted as an append-only Evidence Bundle with provenance. The Generate
action reaches that collector and the initial graph assembler through a retryable,
heartbeat-enabled Temporal bootstrap Activity; a failed bootstrap can be retried after
infrastructure recovery without deleting its persisted evidence. Workflow analysis and
implementation planning consume the same immutable bundle revision, while Temporal
planning snapshots carry only its reference. Planning now runs before generic graph
traversal. A planning-time workflow change creates a complete, deterministically
validated and operation-idempotent draft revision; the planner checks it again, and
product execution begins only after the plan fits and optional review completes.
Post-freeze discoveries still use validated Child Workflow continuation. External
Jira/Confluence/Loop reads are not yet mediated back into the bundle. The company
`ai-assistance` policy now contributes
ordinary file-backed blocks and path obligations; accepted plans and actual run evidence
flow into same-branch artifacts and a validated provider-neutral PR draft. The gated
Bitbucket branch/PR adapter consumes that draft through its generic effect boundary and
passes its local crash matrix. The file-backed Jenkins block observes the exact task
commit, classifies pipeline/Allure evidence, and resumes at CI after Worker/VPN failure.
Real Bitbucket mutation remains disabled by default. Review comments now run through a
reconciled revision/reply loop. Jira-origin workflows require the file-backed
`jira.start-work@1` admission block after plan acceptance and before product effects;
its assignment/status effects reconcile lost responses and pause on 400/403 without
starting code. After PR publication and CI, `jira.review-ready@1` reconciles the Jira
Code Review transition and one compact PR-link comment before the human review wait.
For Jira bugs, the independent `jira-reproduction-evidence` policy inserts
`jira.attach-reproduction@1` only after a successful before-reproduction step. The
adapter uploads selected video/images from the managed worktree with content-addressed
names and reconciles 403, lost responses, and partial multi-file progress without
repeating reproduction or implementation.
Jira and Bitbucket mutations remain separately disabled by default. Enabling either family also
requires an exact comma-separated task allowlist in `TASKER_EXTERNAL_EFFECT_TASKS`; unlisted tasks
stop before the remote adapter. Optional thread resolution and the allowed real pilot are the
remaining T4 work. See
[`docs/codex/t1-temporal-walking-skeleton.md`](docs/codex/t1-temporal-walking-skeleton.md)
for the runtime boundary and recovery evidence.

```bash
fnm exec --using=24.16.0 /usr/local/bin/pnpm verify
fnm exec --using=24.16.0 /usr/local/bin/pnpm test:e2e
fnm exec --using=24.16.0 /usr/local/bin/pnpm dev
```

`pnpm dev` is the normal local entry point. It builds Tasker, starts or reuses the local
Temporal development service, starts the worker and API/operator console, waits for the
Temporal-backed health check, and stops every process it owns on Ctrl-C. Install the
Temporal CLI first. The operator console is available at `http://127.0.0.1:4311`; the
Temporal debugging UI is at `http://127.0.0.1:8233`.

The `temporal:dev`, `temporal:worker`, `temporal:api`, and `dev:cockpit` commands remain
available for diagnosing one process in isolation. `demo:m1` is a compatibility alias
for the complete `pnpm dev` stack, not a second runtime.
