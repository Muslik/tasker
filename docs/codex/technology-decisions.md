# Technology decisions

Status: canonical target stack, Temporal revision, 2026-08-03

This document selects concrete implementation surfaces. Product semantics and
invariants live in [`architecture.md`](architecture.md); sequencing lives in
[`implementation-plan.md`](implementation-plan.md).

## 1. Runtime baseline

| Concern | Decision | Reason |
|---|---|---|
| Language | TypeScript on Node.js 24 | Existing codebase/provider integrations and one type system |
| Durable execution | Temporal TypeScript SDK | Proven recovery, waits, messaging, retries, queues, and versioning |
| Workflow model | Generic deterministic interpreter over Tasker's compiled JSON IR | Dynamic per-task workflows without dynamic code deployment |
| Boundary validation | Zod | Existing schemas, runtime validation, JSON Schema export |
| Product store | SQLite/WAL with `better-sqlite3` initially | Local-first metadata/artifacts/indexes; not execution authority |
| HTTP/control plane | Fastify | Existing typed local API and SSE-compatible surface |
| Workspace execution | Docker-only `WorkspaceCommandRunner`; ephemeral command containers plus task-scoped network/volumes/services | Reproducible toolchains, cancellation, isolation, and no dependency on laptop PATH |
| Toolchain setup | `mise` inside the workspace image | Repository-pinned Node/other versions without one image per project |
| UI | React, Vite, shadcn-style primitives | Minimal operator console, no graph-editor requirement |
| Tests | Vitest, fast-check where useful, Playwright | Unit/property/integration/operator acceptance |
| Logs | Pino with redaction | Operational diagnostics separate from task activity |

The runtime pins `@temporalio/client`, `@temporalio/worker`,
`@temporalio/workflow`, and `@temporalio/testing` at `1.21.1`. The local acceptance
demo was verified with Temporal CLI `1.8.2`, embedded Temporal Server `1.31.2`, and UI
`2.50.1`. During pre-pilot development an upgrade may delete obsolete local histories
and data. Replay/recovery gates for existing histories become mandatory only when a
production durability milestone explicitly freezes that policy.

## 2. Temporal topology

The development topology is:

```text
Temporal Service <- Tasker Temporal Client <- Tasker API
        |
        +-> Task Queue <- Tasker Worker(s) <- Activities/adapters/Docker workspaces
```

Use the Temporal CLI development server for tests and local development. Docker is the
only provider/project command environment; no host runner is selectable. The Temporal
development server is not the
durability target for unattended operation. A VPS pilot must use a supported persistent
self-hosted deployment or Temporal Cloud and must test backup/recovery and worker
deployment compatibility.

Namespaces separate environments, not companies or projects. Task Queues route work by
capability/location, for example:

- `tasker-local-fs` for activities requiring the laptop's managed checkout;
- `tasker-vps` for portable integrations/analysis;
- optional provider-specific queues only when subscription concurrency requires it.

Do not create one queue per task or repository.

## 3. Workflow contracts

Register two stable Workflow entry points with separate responsibilities:

```ts
BootstrapWorkflowV3(input: BootstrapWorkflowInput): Promise<BootstrapWorkflowResult>
ExecutionWorkflowV2(input: ExecutionWorkflowInput): Promise<ExecutionWorkflowResult>
```

Bootstrap owns workspace/context preparation, mandatory planning, optional plan review,
draft validation, and freeze. Execution receives the frozen graph and opaque context
references only. A validated continuation starts a new Bootstrap or Execution Workflow
according to whether it needs planning or is already frozen.

Bootstrap input contains only bounded, immutable, non-secret data:

- task reference;
- planning strategy and optional plan-review policy;
- manual or automatic execution-start policy.

It does not contain a graph, graph hash, repository path, or planning snapshot. Bootstrap
creates those only after the managed worktree and Docker runtime exist. Execution input
then receives the frozen compiled graph, IR ABI version, and opaque artifact/context
references needed to interpret it.

Workflow code may use Temporal Workflow APIs, pure helpers, and deterministic Tasker IR
logic. It may not import filesystem, database, network, provider, Jira, Bitbucket, or
process modules.

Development histories created before Bootstrap v3 are unsupported and disposable. The
v2 bootstrap implementation, workflow IDs, queue name, API path, and tests are deleted;
there is no compatibility worker or fallback parser. Once real pilot runs exist, use
Worker Versioning and replay tests for histories created by released builds. IR/block
versions protect frozen run data; they do not reintroduce deleted development schemas.

## 4. Messages

Use a Query for read-only public state:

- current graph revision and node;
- attempts/retry budget;
- open wait/question/review;
- child workflow references;
- bounded recent decision summary.

Use a Workflow Update when the operator needs synchronous validation and a result:

- submit clarification answer;
- approve/request plan revision;
- provide agent guidance;
- accept/reject a graph revision during the pilot;
- request cancellation/manual takeover;
- confirm human publication with a version payload.

Use a Signal for asynchronous notifications:

- Jenkins completion/webhook;
- Bitbucket review/comment change;
- translation completion;
- remote package availability;
- a poller's recovery observation.

Update and Signal payloads have versioned Zod schemas at the API boundary. Workflow
handlers still validate domain preconditions deterministically. Duplicate external
events carry stable IDs and are ignored after first consumption.

## 5. Activity groups

Activities are grouped by domain boundary rather than one enormous executor:

| Group | Examples |
|---|---|
| intake/repository | sync task, resolve repo, clone/fetch, allocate worktree, bootstrap harness |
| planning | analyze task/repo, assemble graph revision, create/revise implementation plan |
| agent | execute versioned prompt/skills with Codex, Claude, or Antigravity |
| process | run registered build/test/reproduction commands, capture media |
| SCM/tracker | branch/push/PR/thread/Jira comment operations |
| CI | start/observe Jenkins, fetch Allure evidence, classify failure |
| package/translation | extract/pull translations, dev-publish probe, released-version probe |
| artifacts/projection | persist transcript, receipt, cost/usage, operator-facing metadata |

Activity inputs reference stored task/repository artifacts instead of copying large
blobs into Event History. Outputs are small typed summaries plus artifact/receipt IDs.

### Timeouts, heartbeats, cancellation

Every Activity definition declares:

- Schedule-to-Close and Start-to-Close timeouts;
- heartbeat timeout for long provider/process work;
- cancellation behavior and subprocess termination policy;
- retry classification and maximum attempts.

Heartbeats contain only resumable evidence such as attempt ID, subprocess/session ID,
last persisted artifact, and phase. They are not a log transport.

## 6. Retry and external-effect policy

Temporal Activity retries are enabled only when the Activity boundary is safe. Error
classification is typed:

The registered step contract declares its Activity delivery class. The compiler copies
that class into the immutable graph, and the generic Workflow interpreter only selects
the matching Temporal Activity route:

- `workspace_reconciled`: local agent work may be redelivered after Tasker persists a
  baseline mutation intent. The replacement delivery receives the current Git state,
  while an already committed exact output receipt bypasses the provider entirely.
- `single_attempt`: no automatic Activity retry. Process and external-effect adapters
  remain here until they implement effect-specific reconciliation.

Logical workflow retry budgets remain separate from Activity redelivery. A new logical
attempt may use operator guidance or another bounded-loop iteration; a Temporal
redelivery has the same operation ID and must only recover the interrupted attempt.

| Class | Default handling |
|---|---|
| transient network/5xx | bounded retry with backoff |
| provider rate/quota limit | retry/timer from server evidence; release worker |
| VPN/403/credentials unavailable | `infrastructure_blocked` wait; resume same boundary |
| invalid task/input/policy | non-retryable failure or operator question |
| agent cannot progress | bounded new attempt, then guidance wait |
| external effect known not applied | safe retry |
| external effect known applied | return reconciled receipt |
| external effect outcome unknown | reconcile; if unresolved, operator-visible wait |
| programmer/schema/invariant error | non-retryable failure with diagnostic bundle |

Do not stack process/HTTP retry libraries under Temporal retries. Adapter calls make one
attempt unless the adapter's protocol explicitly requires an internal poll. Temporal or
the Workflow domain owns retry decisions.

Remote mutations use stable operation IDs and effect-specific reconciliation. Temporal
provides durable at-least-once Activity execution, not exactly-once Jira/Bitbucket/git
semantics.

## 7. Persistence

### Temporal is authoritative for

- Workflow state and current node;
- pending timers/messages and retry schedule;
- Activity attempts and results referenced by history;
- parent/child coordination;
- cancellation and completion.

### Tasker SQLite is authoritative for

- normalized task and cached Jira projections;
- repository catalog, checkout/worktree/bootstrap locators;
- workflow source/rationale and artifact bodies;
- prompts/skills/policy/block snapshots and hashes;
- transcripts, screenshots, videos, test/Allure reports;
- remote-effect intents/receipts/reconciliation evidence;
- provider usage, shadow cost, operator annotations, and retrospective results;
- UI indexes that can be rebuilt or reconciled from Temporal plus artifacts.

No Tasker table may independently claim a Temporal node is runnable. Runtime projection
rows include Temporal Workflow ID, Run ID, and last observed Event ID/close state so
staleness is visible.

## 8. Identifiers and payload discipline

- Workflow ID: stable Tasker task-run identity, for example `task/AVIA-13235/<run-id>`.
- Child Workflow ID: parent ID plus linked repository/revision identity.
- Activity ID: deterministic graph node/attempt identity where duplicate scheduling
  must be visible.
- External operation ID: stable effect intent, reused across retries/reconciliation.
- Artifact ID: content-addressed or immutable generated identity with hash/size/type.

Temporal payloads and Search Attributes must not include secrets, full Jira bodies,
prompts, source code, transcripts, videos, or arbitrary provider output. Search
Attributes contain only operational lookup fields such as Tasker task ID, lifecycle
state, attention state, repository key, and graph revision.

## 9. Candidate revisions and execution continuations

Before product execution, no graph exists until the mandatory planner returns `ready`
with a plan and complete workflow candidate. The compiler and all deterministic
validators run against that candidate. Rejection is persisted with exact feedback and
the rejected decision; the planner must return a complete replacement candidate. Only
an accepted candidate can be frozen.

After freeze, an execution Activity may return `workflow_change_required`. A planning
Activity then produces a new compiled continuation artifact. The Workflow records its
hash and decision.

An accepted continuation starts as a Child Workflow and the parent waits for its typed
result. This preserves the accepted parent graph and its completed prefix without
teaching the interpreter how to mutate graph input. Ordinary branches inside an
accepted graph remain interpreter nodes and do not create Child Workflows.

During the pilot, a run-policy flag may require operator approval for the accepted plan
and candidate, and separately for execution continuations.
Later, validator-approved low-risk classes can auto-apply. Validation cannot be
disabled.

## 10. Provider execution

Provider selection is configuration, not workflow structure. Named company profiles
contain the subscription CLI, model, effort, timeout, and provider-specific options;
company routes and project redirects select among them. Codex and Claude implement the
same structured Activity contract. Unknown profiles fail pack loading, and the resolved
profile is frozen into the run snapshot. Antigravity requires its own adapter and a
registered profile before it can be selected.

A logical skill in graph data maps to provider-specific instructions in the Activity
adapter. Provider sessions and resumption tokens are optimization hints, not durability
authority. If resumption fails, a new attempt receives persisted bounded context and
artifacts.

Receipts record profile/hash, provider, CLI version, model, effort, session, duration,
prompt hash, and normalized token usage. Shadow API cost is computed from measured
tokens when a versioned price table is available; provider-reported API equivalent is
retained when supplied. Subscription use does not claim that amount was charged.

## 11. UI and observability

The API merges:

- Temporal Workflow Query/Describe/Visibility data for live runtime state;
- Tasker product data for Jira content, rationale, artifacts, transcripts, costs, and
  retrospectives.

The selected run may stream Activity-owned transcript events from Tasker storage and
receive runtime state changes through a bounded projection stream. Temporal Event
History is available in diagnostics but is not rendered as raw operator activity.

Pino logs are bounded/redacted infrastructure diagnostics. Routine Jira sync success or
failure updates sync health only. OpenTelemetry export may be added after the Temporal
slice is stable; it is not another source of truth.

## 12. Testing stack

- pure Vitest tests for IR/compiler/validator/interpreter helpers;
- Temporal TypeScript time-skipping test environment for Workflow integration tests;
- mocked Activities for graph/message/retry/child behavior;
- real local Temporal server tests for worker/service restart and API/UI integration;
- adapter contract tests with MSW/fake subprocesses;
- Playwright for the three-pane operator journey;
- selected replay tests against captured production-like histories.

Most runtime confidence must come from integration tests, not mocked unit tests of SDK
internals.

## 13. Dependency decisions

| Candidate | Decision |
|---|---|
| Temporal TypeScript SDK | adopt as execution kernel |
| Effect v4 | do not adopt; no unsolved boundary justifies another runtime |
| LangGraph | do not adopt; Tasker already owns graph IR/validation and Temporal owns durability |
| XState / Redux Saga / RxJS | do not adopt as runtime |
| BullMQ / p-queue | remove/avoid; Temporal Task Queues and Worker concurrency own dispatch |
| `p-retry` / generic HTTP retries | avoid below Activity policy |
| React Flow | defer; current workflow tree is operationally clearer than an editor |
| OpenTelemetry SDK | defer until core runtime projection is proven |
| Temporal Cloud | deployment option, not required for local development |

## 14. Official references

- [Temporal Workflow definition and determinism](https://docs.temporal.io/workflow-definition)
- [Temporal Activities](https://docs.temporal.io/activities)
- [TypeScript message passing](https://docs.temporal.io/develop/typescript/workflows/message-passing)
- [Child Workflow guidance](https://docs.temporal.io/child-workflows)
- [TypeScript Child Workflows](https://docs.temporal.io/develop/typescript/workflows/child-workflows)
- [TypeScript Workers](https://docs.temporal.io/develop/typescript/workers)
- [TypeScript testing suite](https://docs.temporal.io/develop/typescript/best-practices/testing-suite)
- [Worker Versioning](https://docs.temporal.io/production-deployment/worker-deployments/worker-versioning)
- [Temporal server and CLI repository](https://github.com/temporalio/temporal)
