# Tasker: workflow DSL, libraries, errors, and test harness

Status: implementation decision record, 2026-08-01  
Depends on: [`architecture.md`](architecture.md)  
Acceptance source: [`test-spec.md`](test-spec.md)

## 1. Outcome

Tasker will use a small typed TypeScript authoring DSL that compiles to the existing
serializable workflow IR. The DSL is an authoring convenience, not the runtime and not
the persisted source of truth.

There are three deliberately different representations:

| Representation | Producer | Purpose | May contain executable functions? |
|---|---|---|---|
| TypeScript source DSL | harness author | templates, policies, registered step definitions | only registration-time constructors; never persisted |
| JSON IR proposal | compiler/agent | task-specific proposed workflow | no |
| compiled graph artifact | deterministic compiler | validated, versioned, hashed run input | no |

The first-wave dependency set is intentionally small:

```text
runtime:  zod, better-sqlite3, execa, fastify, pino
ui:       react, react-dom, vite, @vitejs/plugin-react
tests:    vitest, @vitest/coverage-v8, fast-check, @playwright/test
quality:  eslint, @eslint/js, typescript-eslint, prettier
types:    @types/node, @types/react, @types/react-dom, @types/better-sqlite3
later:    msw when the first HTTP integration is implemented
```

No workflow engine, ORM, queue library, retry library, Result monad library, graph
layout library, or external observability SDK is part of M0.

For the domain/control-flow layer the dependency count is **zero**. Tasker does not
use LangGraph, XState, Effect, neverthrow, ts-pattern, Robot, RxJS, Redux Saga, or
another workflow/state/error/pattern-matching runtime. This is not a temporary M0
shortcut: introducing one requires a new ADR backed by a failure that plain
TypeScript cannot reasonably solve.

## 2. Toolchain baseline

- Node.js 24 LTS, ESM, pinned in the repository and CI;
- pnpm with an exact `packageManager` entry and committed lockfile;
- TypeScript in strict mode;
- exact dependency versions are selected and locked at bootstrap, while this document
  records the capability decision rather than a soon-stale patch version.

Required compiler options include:

```json
{
  "strict": true,
  "useUnknownInCatchVariables": true,
  "noUncheckedIndexedAccess": true,
  "exactOptionalPropertyTypes": true,
  "noImplicitOverride": true
}
```

IDs are branded at construction boundaries. Public domain data is readonly. Valid
states are discriminated unions, not objects containing unrelated optional fields or
combinations of booleans.

Use ESLint flat config with `typescript-eslint` type-aware rules. At minimum, enforce
floating/misused promise detection, exhaustive switches over domain unions, unknown
catch values, and unsafe-value boundaries. Run typed lint separately from fast editor
formatting. Prettier owns formatting; ESLint does not carry a parallel stylistic rule
set. Do not add Husky/lint-staged in M0: the same checks run through explicit package
scripts and CI, and local git-hook policy can be added only when it removes a measured
failure mode.

## 3. Workflow description

### 3.1 Human-authored templates use TypeScript

Templates and reusable fragments live in versioned `.ts` modules. TypeScript gives
refactoring, autocomplete, literal inference, and compile-time key-to-payload checks.
The authoring helpers only construct plain data.

Illustrative API:

```ts
export const bugfixWorkflow = defineWorkflow({
  id: 'bugfix',
  version: 1,
  root: sequence('delivery', [
    step('investigate', {
      uses: 'agent.investigate@1',
      with: { requireReproduction: true },
    }),
    branch('choose-verification', {
      when: predicate('change.needs_visual_verification@1'),
      then: step('visual-check', {
        uses: 'verify.visual@1',
        with: { baseline: 'current-main' },
      }),
      otherwise: step('targeted-check', {
        uses: 'verify.targeted@1',
        with: { selection: 'changed-files' },
      }),
    }),
    boundedLoop('ci-repair', {
      maxAttempts: 3,
      until: predicate('ci.is_acceptable@1'),
      body: sequence('repair-cycle', [
        step('run-ci', { uses: 'ci.run@1', with: {} }),
        step('classify-ci', { uses: 'ci.classify@1', with: {} }),
        step('repair', { uses: 'agent.repair@1', with: {} }),
      ]),
    }),
    wait('code-review', {
      for: 'review_event@1',
      slot: 'release',
      resumeAt: 'process-review',
    }),
    finalize('waiting-for-review', { outcome: 'waiting_for_review' }),
  ]),
} satisfies WorkflowSource);
```

The exact helper names can change during M0, but these properties cannot:

- helpers return only JSON-serializable values;
- node `kind` is the discriminant;
- every node has a stable author-visible ID;
- step, predicate, wait, retry, and policy references include an ABI version;
- `boundedLoop` requires its bound at construction;
- no inline predicate, callback, shell command, or arbitrary code can enter the IR;
- `satisfies` preserves literal information used to infer node and payload types.

Do not introduce a fluent builder with hidden mutable state. The full source graph
must remain readable top-to-bottom and serializable after one pure construction pass.

### 3.2 Agents produce JSON, not TypeScript

The analyzer receives the task snapshot, available workflow fragments, registered
step types, capabilities, and policy constraints. It proposes JSON matching
`WorkflowProposalSchema`. It cannot emit code that Tasker imports or executes.

The deterministic compiler then:

1. parses the proposal with Zod;
2. resolves template/fragment references;
3. validates ABI versions, capabilities, effect policies, terminal paths, loop bounds,
   waits, and recovery/handoff paths;
4. normalizes ordering and defaults;
5. emits canonical JSON;
6. hashes and persists the compiled graph plus validation report.

An invalid proposal is a visible compilation result with precise issues. It is never
partially executed. The analyzer may make a bounded new proposal; after its budget is
exhausted, Tasker opens the plan-review/human-clarification gate.

### 3.3 Zod is the only runtime schema system

Use Zod for every untyped boundary:

- agent-generated workflow proposals;
- persisted event/snapshot/artifact payloads;
- provider JSONL events;
- Jira/Bitbucket/Jenkins/Allure/Loop responses;
- HTTP requests and responses;
- operator intervention and wait-resolution payloads;
- rows decoded from JSON columns.

Types are inferred from schemas rather than duplicated. Zod 4 can emit JSON Schema for
provider structured-output hints and API/debug artifacts. A generated JSON Schema is a
projection of the Zod schema, not a second hand-maintained contract.

Use codecs only where wire and domain shapes genuinely differ, for example an ISO
timestamp on disk and a domain timestamp value. Domain events themselves should stay
JSON-native to keep replay simple.

### 3.4 No XState in the kernel

XState is not the workflow runtime or persistence model. Tasker already requires an
append-only event ledger, explicit external-effect receipts, replay, CAS, fencing,
worktree ownership, and version quarantine. Persisting XState actor snapshots would
create a second state/history contract and its own machine-version compatibility
problem.

Reducers remain pure TypeScript functions over discriminated unions. XState is not
used even for cockpit state in the planned architecture.

### 3.5 No LangGraph or other agent-graph runtime

LangGraph is not used at the top level or inside an agent step. Tasker already owns the
workflow IR, persisted cursor, wait/intervention semantics, attempts, receipts,
reconciliation, and replay. Nesting a second graph/checkpointer would create two
answers to “where is this task and what may run next?”. Agent providers are bounded
subprocess adapters that receive one step input and return normalized events and
artifacts.

### 3.6 Workflow rendering

M1 renders a read-only semantic tree from the compiled graph using ordinary React:

```text
sequence
├─ investigate
├─ branch: choose-verification
│  ├─ visual-check
│  └─ targeted-check
├─ loop <= 3: ci-repair
├─ wait: code-review
└─ finalize: waiting_for_review
```

Each row exposes status, elapsed/active/wait time, shadow cost, attempt count, prompt
and policy versions, artifacts, and the current recovery action. The same projection
can render before execution and after restart.

Do not install React Flow for M1. A canvas adds layout, zoom, accessibility, and E2E
surface before `parallel`, child runs, and graph revisions exist. Re-evaluate
`@xyflow/react` plus an automatic layout library at M8 only if the semantic tree no
longer explains real graphs. The compiled IR stays independent of either renderer.

## 4. Domain error and recovery model

### 4.1 Errors are values at expected boundaries

Expected rejection and recoverable failure are returned as values:

```ts
type Outcome<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };
```

Tasker owns this small type and `ok`/`err` constructors. Do not add `neverthrow` or
Effect to the planned architecture:

- Effect would introduce a second execution/concurrency/retry runtime beside the
  durable kernel;
- neverthrow is smaller, but its chaining API adds little while commands must persist
  every recovery decision rather than compose an in-memory error pipeline;
- the local union keeps public ports explicit without infecting every domain type with
  a library-specific abstraction.

Do not expand the local `Outcome` into a home-grown functional library.

Do not add `ts-pattern`. Recovery and aggregate reducers use native exhaustive
`switch` over discriminated unions, checked by TypeScript and
`@typescript-eslint/switch-exhaustiveness-check`. A tiny `assertNever(value: never)`
may exist at an untyped/version-skew boundary to fail closed. Pattern matching must not
hide which domain variants are handled.

### 4.2 There are three failure levels

1. **Command rejection** — expected domain decision such as invalid transition,
   ineligible task, stale version, or resolution-schema mismatch. It changes no state
   unless the contract explicitly records a rejected attempt.
2. **Operational failure** — provider, tool, network, credentials, quota,
   infrastructure, or remote-system result. It is normalized at the adapter boundary
   and mapped to an explicit durable recovery action.
3. **Defect/contract violation** — impossible reducer state, unsupported schema/ABI,
   corrupt ledger, secret-policy violation, or uncaught programmer error. It fails
   closed, quarantines the affected run where possible, and creates a debug bundle.

Do not throw for levels 1 or 2. Third-party calls may throw; the adapter catches
`unknown` once, normalizes it, and returns a typed value. A process-level exception
handler is the last containment boundary, not normal control flow.

### 4.3 External effects cannot use a flat error bag

Mutating adapters return one of three representable states:

```ts
type EffectOutcome<Receipt, Failure, Probe> =
  | { readonly status: 'applied'; readonly receipt: Receipt }
  | { readonly status: 'not_applied'; readonly failure: Failure }
  | {
      readonly status: 'unknown_outcome';
      readonly failure: Failure;
      readonly probe: Probe;
    };
```

This prevents invalid combinations such as `applied` without a receipt or
`unknown_outcome` without a reconciliation probe. The raw HTTP/CLI error never decides
whether retry is safe.

### 4.4 Normalized operational failures

The normalized taxonomy is intentionally about what Tasker can prove and do:

```text
invalid_input          -> repair input or terminal intake result
not_eligible           -> terminal routing result
access_denied          -> operator/environment gate; usually not_applied
authentication         -> credentials gate; no blind retry
quota_exhausted        -> slot-free quota_reset wait
rate_limited           -> durable retry_backoff wait using server evidence
transient_transport    -> bounded retry only when not_applied is proven
remote_rejected        -> terminal or human gate from adapter policy
contract_violation     -> fail closed/quarantine
infrastructure         -> operator gate or bounded probe
cancelled              -> audited cancellation result
unknown_outcome        -> reconcile before any retry
```

Every normalized failure includes:

```text
kind, code, safe_message, source, occurred_at,
retry_evidence, redacted_diagnostic_artifact?, correlation_id
```

Fields meaningful only for a specific variant belong to that variant. For example,
`quota_exhausted` must contain its reset evidence; `unknown_outcome` must contain a
probe contract; `access_denied` may contain the failed preflight and operator action.
Avoid `retryable: boolean`: it collapses materially different recovery protocols.

### 4.5 Recovery is a separate exhaustive decision

Policy maps the normalized result and persisted context to exactly one action:

```text
retry        attempt/step cursor + remaining bound
wait         typed Wait + resolution schema + slot policy
reconcile    versioned probe + effect intent
gate         precise human/environment action + resume precondition
fail         terminal classified outcome
quarantine   no further commands; debug bundle required
```

The selected action is persisted before it becomes runnable. Retry delays are durable
waits; do not use `p-retry`, hidden HTTP retries, recursive promise loops, or sleeps.
HTTP clients and subprocess wrappers have timeouts/cancellation, but automatic retry is
disabled unless the durable policy dispatched the new attempt.

### 4.6 Examples

| Observation | Effect proof | Recovery |
|---|---|---|
| Jira responds `400` during intake read | no mutation attempted | persist failed `IntakeRequest`; allow fetch/input repair only |
| provider reports quota reset time | no outward mutation | open `quota_reset` wait; release slot |
| Bitbucket push responds definite `403` | `not_applied` | preserve worktree; VPN/access gate; retry push step after preflight |
| connection drops after push payload | `unknown_outcome` | compare remote ref/SHA; never blind retry |
| CI test fails and classifier says ours | CI result applied, code still editable | create bounded repair/reverify path |
| CI classified flaky | build result applied | bounded rerun policy, then human/infra gate |
| unsupported event schema on replay | canonical compatibility violated | quarantine run; read-only inspection/debug bundle |

## 5. Runtime libraries

### 5.1 Persistence: `better-sqlite3` plus explicit SQL

Use the same file-backed database driver in production and tests. `better-sqlite3`
provides the synchronous transaction boundary that matches the single-writer local
kernel, full transactions, prepared statements, and WAL support.

Do not use Node's `node:sqlite` for M0 because the Node 24 API is still documented as a
release candidate. Revisit when it becomes stable and passes the complete repository
contract suite. Do not use a different driver only in tests.

Do not install an ORM or query builder initially. Ledger append, aggregate-head CAS,
projection update, outbox visibility, and lease fencing depend on precise transaction
ordering that should be visible in SQL. Runtime-decode selected rows with Zod instead
of pretending SQL result types are proven by TypeScript.

Migrations are ordered `.sql` files applied by a small repository-owned runner in one
transaction, recorded in `schema_migrations(version, checksum, applied_at)`. The runner
must reject a changed checksum. Adopt a migration library only if migrations acquire
cross-database or branching requirements; neither exists in the personal SQLite MVP.

Initial connection policy:

```text
journal_mode = WAL
foreign_keys = ON
busy_timeout = bounded configured value
synchronous = FULL for canonical ledger writes
```

Performance tuning must not weaken canonical durability silently. A future deliberate
change to `synchronous` needs crash evidence and an ADR.

### 5.2 Subprocesses: `execa`

Use Execa behind Tasker's own `ProcessRunner` port for Claude/Codex/Antigravity,
existing harness scripts, git, build, and test commands. It supplies argument-safe
execution without a shell, progressive stdout/stderr consumption, structured failure
metadata, cancellation, and termination handling.

Tasker still owns:

- process/session IDs and provider attempt records;
- JSONL parsing and Zod validation;
- source-side redaction before persistence;
- heartbeat, timeout, and kill escalation policy;
- exit/error normalization;
- durable retry/reconcile decisions.

Never pass an LLM-generated command string to a shell. Step types select registered
executables and provide an argument array validated by their schema. An explicitly
registered shell script may run as an artifact, but arbitrary `shell: true` is not a
workflow capability.

### 5.3 Local API: `fastify`

Use Fastify for the local HTTP API because it has a small plugin surface, TypeScript
support, request injection for tests, and Pino integration. Controllers parse
untrusted payloads with the same Zod schemas used by commands. Do not maintain a
parallel TypeBox/JSON-Schema domain model.

The cockpit event stream is a small native `text/event-stream` route over persisted
projection events. It supports `Last-Event-ID` by replaying from the ledger cursor.
Do not add a second event bus or SSE package until native implementation proves
insufficient.

Use Node's built-in `fetch` and `AbortController` for HTTP adapters. Automatic retries
are forbidden at this layer.

### 5.4 Operational logs: `pino`

Pino logs process diagnostics with child bindings such as `task_id`, `run_id`,
`step_id`, `attempt_id`, and `correlation_id`, and source-side redaction. Logs are not
domain history and cannot be replayed to make decisions. The SQLite ledger remains
canonical; JSONL provider transcripts and Pino logs are linked diagnostic artifacts.

OpenTelemetry remains a projection/export port after M6/M9 readiness. It must never be
required for scheduling, recovery, cost calculation, or retrospective truth.

## 6. UI libraries

Use React, React DOM, and Vite. In M1 the cockpit needs no global state library:

- initial state comes from the local API;
- SSE applies persisted projection deltas through one reducer;
- selected run/step/cursor stays in the URL;
- intervention, gate resolution, resume, and takeover are explicit commands.

Do not add Redux, Zustand, TanStack Query, a component framework, or React Flow before
a concrete repeated problem justifies it. This is a single-user cockpit, not a generic
workflow editor.

## 7. Test libraries and suite shape

### 7.1 Selected tools

- **Vitest**: unit, repository, adapter-contract, recovery, and non-browser operator
  suites; projects, fake timers where unavoidable, and V8 coverage.
- **fast-check**: selective model/property tests for reducers, command sequences,
  waits/signals, retry budgets, replay invariants, and scheduler interleavings.
- **Playwright**: real-browser cockpit/operator E2E, `webServer`, fixtures,
  auto-waiting, trace on first retry, and screenshot assertions where visual behavior
  is the contract.
- **MSW**: introduced with the first HTTP integration for ordinary in-process HTTP
  adapter contracts. It does not simulate ambiguous TCP outcomes.

Deferred:

- Testcontainers until a real dependent service cannot be represented faithfully by
  deterministic fixtures;
- WireMock until a reusable out-of-process/multi-language fake is needed;
- Stryker until reducer/policy tests and runtime are stable after M2/M4;
- Vitest Browser Mode while Playwright already owns real-browser behavior.

### 7.2 Project layout

```text
test/
  setup/        # deterministic clock, IDs, environment
  helpers/      # sqlite, worktree, process, scenario server, signals
  unit/         # reducers, validators, policies
  property/     # fast-check models and invariants
  repository/   # real file-backed SQLite, migrations, CAS, fencing, outbox
  contract/     # provider, CLI, HTTP, git, Jira, Bitbucket, Jenkins, review
  recovery/     # real process kill/restart and replay
  operator/     # non-browser full workflows
playwright/
  fixtures/
  cockpit/
```

Vitest uses projects named `unit`, `property`, `repository`, `contract`, `recovery`,
and `operator`. Recovery is serialized or low-concurrency. Playwright stays a separate
runner for browser E2E.

### 7.3 Required test harness utilities

Standardize these public test surfaces early:

```text
makeTestClock                 controlled time without wall-clock sleeps
makeTestIds                   stable aggregate/correlation IDs
withTempDatabase              real temporary SQLite file + production migrations
withTempRepository            bare repo + isolated worktree + cleanup
spawnProviderScenario         fixture CLI with programmable JSONL/stdout/stderr/exit
serveRemoteScenario           local HTTP/TCP server with phase barriers
waitForDurableBoundary        event/cursor barrier, never elapsed-time guessing
killAtBoundary                terminate app/runner after a named durable marker
runAdapterContract            same behavior suite for fake and real adapter
resolveWaitWithSignal         correlated, duplicate, stale, and invalid signals
assertReplayHasNoEffects      projection rebuild cannot dispatch
```

Helpers arrange and drive state; assertions remain in tests. Tests call public command,
port, or application surfaces rather than private normalization helpers.

### 7.4 Deterministic failure simulation

- **Quota:** fixture provider emits a validated quota event with reset evidence; inject
  a signal or advance `TestClock`; never wait in real time.
- **Definite 403:** fake remote returns 403 before applying the mutation; assert
  `not_applied` and push-step-only recovery.
- **Unknown outcome:** scenario server records the mutation and closes the socket
  before acknowledgement; explicit probe then returns applied/not-applied/ambiguous.
- **Waits:** create through the production repository and resolve with correlated
  signals; assert slot ownership separately from run status.
- **Kill/restart:** app/runner is a real subprocess. The test waits for a named durable
  boundary, kills it, restarts against the same DB/worktree, and asserts reconstruction.
- **CI ordering:** deliver CI and review events in both orders and property-generated
  interleavings; final readiness must be identical.

MSW is appropriate for normal response shapes and malformed payloads. A repository-
owned Node HTTP/TCP scenario server is required for accept-then-drop, half-close, and
other wire-level ambiguous outcomes.

### 7.5 What counts as evidence

Readiness order is:

1. named milestone behavior scenarios;
2. the same contract suite passing for fake and real adapters;
3. required kill/restart matrix;
4. replay/projection checksum parity;
5. coverage report as a diagnostic guardrail.

Do not make a line-coverage percentage the main gate. Do not commit arbitrary sleeps.
Do not snapshot large workflow JSON blobs as the only assertion: assert graph behavior,
validation issues, hashes, and public projections. Visual snapshots are used only when
rendered appearance is itself the promised behavior.

## 8. Dependency timing

| Milestone | Add | Reason |
|---|---|---|
| M0 | TypeScript, Zod, better-sqlite3, Vitest, coverage-v8, fast-check, Pino, ESLint/typescript-eslint, Prettier | domain/schema/ledger/test/quality contracts |
| M1 | Fastify, React, React DOM, Vite, Playwright | first persisted workflow and cockpit rendering |
| M2 | Execa | stub runner, real process lifecycle, kill/restart harness |
| M3 | no new orchestration library | first provider must fit the existing port |
| M4 | no retry/git workflow library | git/effect recovery remains domain policy |
| M5 | MSW | first ordinary HTTP integration contracts |
| M6+ | evaluate only from evidence | no speculative platform dependencies |

## 9. Explicitly rejected for the first wave

| Candidate | Decision | Reason |
|---|---|---|
| LangGraph | reject | duplicates graph, checkpoint, cursor, and replay ownership even inside agent steps |
| XState | reject | duplicates canonical event/replay and compatibility model |
| Temporal/Hatchet | reject as source of truth | second runtime/history before local product proof |
| Effect | reject | second concurrency/retry/dependency runtime and unfamiliar execution model |
| neverthrow | reject | local two-variant Outcome is enough; avoid library leakage |
| ts-pattern | reject | native exhaustive switch is sufficient and keeps handled variants visible |
| Robot/RxJS/Redux Saga | reject | another in-memory state/effect runtime without durable-domain value |
| Drizzle/Prisma/Kysely | defer | critical transaction ordering should stay explicit; no DB portability need |
| `node:sqlite` | defer | Node 24 API is still release candidate |
| BullMQ/p-queue | reject | readiness, waits, leases, and fencing are persisted domain rules |
| `p-retry`/HTTP auto-retry | reject | retry safety depends on durable effect proof and reconciliation |
| `@dagrejs/graphlib`/Graphology | reject | IR is a small nested algebra with bounded loops, not a generic DAG; its validator needs domain semantics, not a second graph model |
| React Flow/layout engine | defer to M8 evidence | semantic tree is simpler and adequate for first-wave graphs |
| Redux/Zustand | defer | local API + SSE reducer is sufficient |
| OpenTelemetry SDK | defer | ledger/Pino/debug bundle must work first; export remains optional |
| Testcontainers/WireMock/Stryker | defer | no first-wave scenario requires their extra runtime/cost |

## 10. Upgrade and replacement rules

A library can be replaced only after its public Tasker port passes unchanged contract
tests. Dependency upgrades are grouped by capability, reviewed with release notes, and
validated against:

- persisted schema/version fixtures;
- repository transaction/recovery suite;
- provider/process contract suite;
- cockpit smoke/E2E;
- redaction fixtures.

The lockfile, Node version, provider CLI versions, workflow/step ABI versions, and
pricing catalog version are captured in each run's debug metadata. Library versions
must never change the meaning of a historical run silently.

## 11. Official references

- [Zod 4](https://zod.dev/) and [JSON Schema conversion](https://zod.dev/json-schema)
- [better-sqlite3](https://github.com/WiseLibs/better-sqlite3)
- [Node 24 `node:sqlite` stability](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html)
- [Execa](https://github.com/sindresorhus/execa)
- [Fastify validation and serialization](https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/)
- [Pino redaction](https://github.com/pinojs/pino/blob/main/docs/redaction.md)
- [XState persistence and caveats](https://stately.ai/docs/persistence)
- [React Flow accessibility](https://reactflow.dev/learn/advanced-use/accessibility)
- [Vitest features](https://vitest.dev/guide/features.html)
- [fast-check model-based testing](https://fast-check.dev/docs/advanced/model-based-testing/)
- [Playwright trace viewer](https://playwright.dev/docs/trace-viewer-intro)
- [MSW Node integration](https://mswjs.io/docs/integrations/node/)
- [typescript-eslint typed linting](https://typescript-eslint.io/getting-started/typed-linting/)
- [typescript-eslint exhaustive switch checking](https://typescript-eslint.io/rules/switch-exhaustiveness-check/)
- [Prettier](https://prettier.io/docs/)
