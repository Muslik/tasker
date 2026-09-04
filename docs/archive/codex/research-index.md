# Research index: Task-Adaptive Agent Harness

Date: 2026-08-03

> **Decision correction (2026-08-03).** The original research selected a narrow custom
> ledger/scheduler for the first proof. M0–M2 supplied that proof and also demonstrated
> that queueing, leases, cursors, timers, waits, and recovery are non-differentiating
> infrastructure. Temporal is now the selected execution kernel. The old conclusion is
> retained below only as research provenance; canonical decisions are in
> [`architecture.md`](architecture.md).

This index is the evidence map behind:

- `.omx/plans/prd-task-adaptive-agent-harness.md`
- `.omx/plans/test-spec-task-adaptive-agent-harness.md`

The PRD is the decision and implementation handoff. The research notes are
supporting evidence, not runtime dependencies.

## Recommended reading order

1. **Provider surfaces**
   - `.omx/research/provider-subscription-interfaces.md`
   - Compares subscription auth, headless execution, machine-readable output,
     resume, approvals, usage reporting, and VPS constraints for Claude Code,
     Codex, and Google Antigravity.
   - Decision impact: capability-negotiated provider adapters; Codex-first
     vertical slice; no fake provider parity.

2. **Workflow engines**
   - `.omx/research/workflow-engines.md`
   - Compares Temporal, LangGraph, custom event-ledger orchestration, Hatchet,
     Inngest, Prefect, and Dagster.
   - Original decision impact: narrow custom ledger/reducer proof with an engine
     migration seam. Current decision impact: exercise that seam now and move execution
     to Temporal before enabling real repository/remote mutation.

3. **Enterprise integrations and security**
   - `.omx/research/integrations-security.md`
   - Covers Jira, Confluence, Bitbucket Data Center/Server, Jenkins, Allure, git
     worktrees, webhook/poll reconciliation, idempotency, secrets, and artifact
     provenance.
   - Decision impact: webhook as trigger, polling as recovery, mutation
     intent/receipt ledger, fail-closed unknown-outcome handling.

4. **Observability, cost, and evaluations**
   - `.omx/research/observability-cost-evals.md`
   - Compares OpenTelemetry GenAI conventions, Langfuse, Phoenix, MLflow,
     Braintrust, PostgreSQL JSONB, and ClickHouse.
   - Decision impact: Temporal Event History is canonical for execution. Tasker keeps
     product/artifact/effect/cost/retrospective data outside it; OTel-compatible export
     remains optional.

5. **Existing coding harnesses and runner substrates**
   - `.omx/research/coding-harnesses-runners.md`
   - Compares OpenHands, Continue, Cline, Aider, vendor agents, containers,
     devcontainers, E2B, Fly Machines, and Firecracker.
   - Decision impact: reuse cockpit and isolation ideas, but do not replace the
     task-specific control plane with an IDE agent or infrastructure substrate.

6. **Local brownfield map**
   - `.omx/research/local-brownfield-map.md`
   - Maps `/Users/dzhabrail/Projects/work/harness`, its bootstrap/layering model,
     existing skills, REST scripts, environment loading, and current workflow
     handoffs.
   - Decision impact: preserve working connector/skill assets behind typed Temporal
     Activities; treat the existing repository as brownfield input, not as the runtime.

7. **Concrete implementation libraries**
   - [`docs/codex/technology-decisions.md`](technology-decisions.md)
   - Selects the workflow authoring/compiled representations, runtime dependencies,
     error/recovery taxonomy, persistence driver, subprocess/API/logging boundaries,
     graph renderer timing, and deterministic test harness.
   - Decision impact: TypeScript data DSL + JSON IR, Temporal TypeScript SDK, Zod,
     `better-sqlite3` for product data, Execa, Fastify/Pino, and
     Vitest/Temporal-test-environment/Playwright. LangGraph, XState, Effect, BullMQ,
     `p-queue`, and nested generic retry runtimes remain unnecessary.

## Requirements provenance

- Deep-interview specification:
  `.omx/specs/deep-interview-task-adaptive-agent-harness.md`
- Interview transcript:
  `.omx/interviews/task-adaptive-agent-harness-20260730T181407Z.md`
- Context snapshot:
  `.omx/context/task-adaptive-agent-harness-20260730T171837Z.md`

These artifacts establish the personal/single-user scope, optional plan review,
PR review/revise loop, three-attempt bounded recovery, no automatic production
actions, immutable active-run snapshots, human-approved retrospectives, and the
`>=50%` pilot target.

## Consensus trail

- Planner v1:
  - `.omx/drafts/prd-task-adaptive-agent-harness-v1.md`
  - `.omx/drafts/test-spec-task-adaptive-agent-harness-v1.md`
- Architect v1 (`ACCEPT_WITH_REQUIRED_CHANGES`):
  `.omx/drafts/architect-review-task-adaptive-agent-harness-v1.md`
- Critic v1 (`ITERATE`):
  `.omx/drafts/critic-review-task-adaptive-agent-harness-v1.md`
- Architect v2 (`ACCEPT`):
  `.omx/drafts/architect-review-task-adaptive-agent-harness-v2.md`
- Critic v2 (`APPROVE`):
  `.omx/drafts/critic-review-task-adaptive-agent-harness-v2.md`

The accepted v2 changes locked TypeScript/Node.js and specified transactional
outbox/CAS/fencing, unknown-outcome reconciliation, provider-attempt lifecycle,
event/snapshot schema evolution, artifact lineage, and deterministic readiness. The
2026-08-03 architecture keeps external-effect reconciliation, provider attempts, and
artifact lineage, while replacing custom scheduling/CAS/fencing/readiness with
Temporal.

## Primary official reference groups

Provider automation:

- [Claude Code CLI reference](https://docs.anthropic.com/en/docs/claude-code/cli-reference)
- [Claude Code authentication](https://docs.anthropic.com/en/docs/claude-code/iam)
- [Codex non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode)
- [Codex app server](https://learn.chatgpt.com/docs/app-server)
- [Antigravity headless mode](https://antigravity.google/docs/cli/headless)

Durable execution and agent graphs:

- [Temporal documentation](https://docs.temporal.io/)
- [Workflow determinism](https://docs.temporal.io/workflow-definition)
- [Activities](https://docs.temporal.io/activities)
- [TypeScript message passing](https://docs.temporal.io/develop/typescript/workflows/message-passing)
- [Child Workflow guidance](https://docs.temporal.io/child-workflows)
- [TypeScript testing suite](https://docs.temporal.io/develop/typescript/best-practices/testing-suite)
- [Worker Versioning](https://docs.temporal.io/production-deployment/worker-deployments/worker-versioning)
- [LangGraph persistence](https://docs.langchain.com/oss/python/langgraph/persistence)
- [LangGraph interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts)
- [Inngest durable execution](https://www.inngest.com/docs/learn/how-functions-are-executed)
- [Hatchet](https://github.com/hatchet-dev/hatchet)

Implementation libraries and testing:

- [Zod 4](https://zod.dev/) and [JSON Schema conversion](https://zod.dev/json-schema)
- [better-sqlite3](https://github.com/WiseLibs/better-sqlite3)
- [Node 24 `node:sqlite` release-candidate status](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html)
- [Execa](https://github.com/sindresorhus/execa)
- [Fastify validation](https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/)
- [Pino redaction](https://github.com/pinojs/pino/blob/main/docs/redaction.md)
- [XState persistence caveats](https://stately.ai/docs/persistence)
- [React Flow accessibility](https://reactflow.dev/learn/advanced-use/accessibility)
- [Vitest features](https://vitest.dev/guide/features.html)
- [fast-check model-based testing](https://fast-check.dev/docs/advanced/model-based-testing/)
- [Playwright trace viewer](https://playwright.dev/docs/trace-viewer-intro)
- [MSW Node integration](https://mswjs.io/docs/integrations/node/)
- [typescript-eslint typed linting](https://typescript-eslint.io/getting-started/typed-linting/)
- [Prettier](https://prettier.io/docs/)

Observability and evaluation:

- [OpenTelemetry GenAI semantic conventions](https://github.com/open-telemetry/semantic-conventions-genai)
- [Langfuse self-hosting](https://langfuse.com/self-hosting)
- [Phoenix](https://arize.com/docs/phoenix)
- [MLflow GenAI tracing](https://mlflow.org/docs/latest/genai/tracing/)

Enterprise systems:

- Official Atlassian Jira/Confluence REST and webhook references, Bitbucket Data
  Center REST/webhook references, Jenkins Remote Access API, and Allure result
  format references are catalogued with version caveats in
  `.omx/research/integrations-security.md`.

## Evidence policy

- A source-backed product capability is labeled evidence.
- Gaps inferred from missing public documentation remain labeled inference.
- Stack choices and sequencing are recommendations constrained by the personal
  MVP, not universal product rankings.
- Installed CLI versions and observed local help output must be captured again
  in each run snapshot; research-time versions are not permanent guarantees.
