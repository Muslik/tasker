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

Bootstrap persists a graph-free planning context and Evidence Bundle. The implementation
planner chooses the registered archetype, optional segments, and typed plan slots;
deterministic code materializes the workflow skeleton, compiles and validates it, and
freezes the resulting graph. Execution then uses the generic Temporal graph interpreter.
Agent calls, project shell commands, builds, tests, and Playwright run only in
Docker-backed Temporal Activities; typed remote APIs remain Activity adapters; review,
clarification, translation, publication, CI, and infrastructure pauses use durable
Temporal messages and conditions.

The built-system reference is [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md); operator
procedures are in [`docs/OPERATIONS.md`](docs/OPERATIONS.md). Rebuild phase status is
tracked in [`docs/REBUILD.md`](docs/REBUILD.md). Historical design documents are
archived in [`docs/archive`](docs/archive) and no longer describe the system.

Prompts and company/project workflow guidance are editable under [`harness`](harness).
Company step packages and policies are file-backed under [`harness/steps`](harness/steps) and
[`harness/policies`](harness/policies). This is the complete production block catalog;
[`src/harness/step-contracts.ts`](src/harness/step-contracts.ts) contains only the typed
runtime schemas referenced by those manifests.
The versioned multi-project agent configuration copied into managed worktrees lives in
[`harness/workspace`](harness/workspace/README.md); credentials remain outside that pack.

## Current implementation state

Temporal is the only runtime. A Bootstrap Workflow owns workspace preparation,
graph-free context, mediated evidence, bounded pre-plan investigation, mandatory
planning, optional plan review, deterministic validation, and freeze. A
separate Execution Workflow receives only the frozen task graph and bounded context
references. Planning nodes, Jira-specific behavior, Docker setup, and provider code do
not live in the execution interpreter.

The old Workflow type, registry, public-state adapter, compatibility parser, and
dedicated recovery tests have been deleted. Current development data is disposable;
only the current run-snapshot schema is accepted. Reproduction evidence is private run
evidence and is not attached to Jira automatically.

The typed step outcome contract is authoritative: normal agent steps return completed,
waiting, or failed envelopes (with explicit workflow-change control where needed). An
agent may return a candidate claim, but only independently collected process, artifact,
workspace, or reconciled-effect evidence can produce the immutable receipt that advances
the graph. Provider/model selection is a strict versioned execution-profile decision
resolved before freeze.

```bash
pnpm verify
pnpm test:unit
pnpm test:integration
pnpm test:contract
pnpm test:property
pnpm test:e2e
pnpm dev
```

`pnpm dev` is the normal local entry point. It builds Tasker, starts or reuses the local
Temporal development service, starts the worker and API/operator console, waits for the
Temporal-backed health check, and stops every process it owns on Ctrl-C. Install the
Temporal CLI first. The operator console is available at `http://127.0.0.1:4311`; the
Temporal debugging UI is at `http://127.0.0.1:8233`.

Bitbucket pull-request publication also requires an explicit Git identity. Set
`TASKER_GIT_AUTHOR_NAME` and `TASKER_GIT_AUTHOR_EMAIL` in the Tasker process environment
or the harness-work `.env`. Tasker uses that identity for task commits so repository
hooks see the same corporate author as an interactive commit. If it is absent or
invalid, the PR step pauses with operator guidance and resumes the same worktree after
the configuration is fixed.

Tasker's pull-request CI defaults to `https://build.twiket.com`. Set
`TASKER_JENKINS_BASE_URL` only when Tasker must observe another CI instance. Tasker does
not inherit the generic `JENKINS_BASE_URL` used by interactive tools because that variable
may point at a different Jenkins product. `JENKINS_USER` and `JENKINS_TOKEN` remain the
shared credentials. An authorization failure pauses the CI step without losing the pushed
branch or PR.

The `temporal:dev`, `temporal:worker`, `temporal:api`, and `dev:ui` commands remain
available for diagnosing one process in isolation. They are components of the same
runtime, not alternative execution paths.
