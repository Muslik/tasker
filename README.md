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
graph interpreter. Agent calls, project shell commands, builds, tests, and Playwright
run only in Docker-backed Temporal Activities; typed remote APIs remain Activity
adapters; review, clarification, translation, publication, CI, and
infrastructure pauses use durable Temporal messages and conditions.

Read the canonical design in [`docs/codex`](docs/codex/README.md) and the extension
contract in
[`docs/codex/customization-guide.md`](docs/codex/customization-guide.md).
Docker-only execution and project bootstrap are documented in
[`docs/codex/docker-execution.md`](docs/codex/docker-execution.md).

Prompts and company/project workflow guidance are editable under [`harness`](harness).
Company blocks and policies are file-backed under [`harness/steps`](harness/steps) and
[`harness/policies`](harness/policies); the small built-in catalog in
[`src/harness/step-definitions.ts`](src/harness/step-definitions.ts) contains only the
current generic/product blocks and shared runtime schemas.
The versioned multi-project agent configuration copied into managed worktrees lives in
[`harness/workspace`](harness/workspace/README.md); credentials remain outside that pack.

## Current implementation state

Temporal is the only runtime. A Bootstrap Workflow owns workspace preparation, context,
mandatory planning, optional plan review, deterministic validation, and freeze. A
separate Execution Workflow receives only the frozen task graph and bounded context
references. Planning nodes, Jira-specific behavior, Docker setup, and provider code do
not live in the execution interpreter.

The old Workflow type, registry, public-state adapter, compatibility parser, and
dedicated recovery tests have been deleted. Current development data is disposable;
only the current run-snapshot schema is accepted. Reproduction evidence is private run
evidence and is not attached to Jira automatically.

Block Contract v2 is authoritative: an agent may return a candidate claim, but only
independently collected process, artifact, workspace, or reconciled-effect evidence can
produce the immutable receipt that advances the graph. Provider/model selection is a
strict versioned execution-profile decision resolved before freeze. See
[`docs/codex/implementation-plan.md`](docs/codex/implementation-plan.md).

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
available for diagnosing one process in isolation. `demo:m1` starts the same complete
`pnpm dev` stack; it is not a second runtime.
