# M0 implementation — contracts and runnable skeleton

Status: **implemented and verified**, 2026-08-01.

M0 is the deterministic kernel boundary. It can validate and compile a workflow,
persist append-only contract events and artifacts, enforce CAS/fencing, redact source
data, and create a DebugBundle. It cannot invoke an agent or create a remote command.

## Run it

The repository pins Node 24 and pnpm 10.13.1.

```bash
fnm exec --using=24.16.0 /usr/local/bin/pnpm install
fnm exec --using=24.16.0 /usr/local/bin/pnpm verify
fnm exec --using=24.16.0 /usr/local/bin/pnpm demo:m0
```

`demo:m0` creates a new temporary directory on every run and prints its absolute path.
It does not overwrite an earlier run. The directory contains:

```text
m0-ledger.sqlite     durable SQLite/WAL ledger
workflow.json        compiled immutable workflow + validator report + SHA-256 hash
schemas.json         event, workflow, DebugBundle, intake, wait and intervention schemas
fixtures.json        four executed M0 contract fixtures
debug-bundle.json    reference-only, redacted diagnostic manifest
schema-report.json   applied migration manifest and table inventory
schema.mmd           Mermaid schema relationship diagram
```

The generated workflow is `bugfix-to-code-review`. It contains analyzer, optional
plan-review, bounded implementation loop, code-review wait and finalize nodes. The
`code_review` wait inherits `slotPolicy: release` from the registered Wait ABI.

## Implemented modules

| Module | M0 responsibility |
|---|---|
| `src/domain` | Zod-first IDs, event envelope, aggregate fixtures, failure/outcome/recovery unions and state-dependent invariants |
| `src/workflow` | typed authoring DSL, strict JSON source boundary, ABI registries, validation, canonicalization, immutable IR and hash |
| `src/ledger` | explicit SQL migrations, WAL opener, append/CAS transaction, projections, outbox, artifacts, signals and fenced leases |
| `src/observability` | fail-closed source redaction and deterministic reference-only DebugBundle manifest |
| `src/app` | M0 capability boundary, redaction-before-commit composition and operator demo |

There are deliberately no LangGraph, XState, Effect, neverthrow, ts-pattern, ORM,
query-builder or graph dependencies. Control flow is plain TypeScript discriminated
unions plus exhaustive switches. Zod guards unknown boundaries.

## Demonstrated contract fixtures

1. Jira `400` remains an `IntakeRequest` in `waiting_for_intake_repair`; it does not
   create a task/run command.
2. Provider quota becomes an open `quota_reset` wait with a released runner slot.
3. Operator guidance is an append-only `InterventionEvent` tied to the prior attempt.
4. Manual takeover is a typed ownership-transfer request, not a generic wait.

The first fixture deliberately contains a fake authorization secret outside its domain
contract. The source-side redactor replaces it before commit. A second integration
test feeds an unsupported `Date`; the payload is blocked and the ledger remains empty.

## Durability and recovery invariants already executable

- migration checksums, names and source presence are fail-closed;
- aggregate writes use expected-version CAS;
- event, projection, artifact, outbox and lease changes share one IMMEDIATE transaction;
- a CAS or outbox conflict exposes no partial event/projection/outbox state;
- outbox rows with a lease require a same-transaction lease mutation or a verified
  fence guard;
- a fenced-out runner cannot commit completion state or an outbox command;
- artifact metadata is persisted instead of silently discarded;
- getters/accessors are never invoked by redaction; unsupported values block safely;
- the M0 demo asserts `outbox.length === 0` and has no provider/remote-effect capability.

## Test layout and evidence

Vitest projects separate unit, property, repository, contract, recovery and operator
layers. M0 currently exercises unit, property, repository and operator layers. The
top-level evidence command is `pnpm verify`, which runs formatting, type checking,
lint, all tests and the production build.

The important named scenarios include deterministic workflow hashes, unknown ABI
references, invalid loop bounds, missing terminal paths, nested branch continuation,
wait resolution contracts, invalid step/predicate inputs, source-boundary extra fields,
migration tampering, atomic rollback, stale fencing, redaction, blocked unsafe payloads,
and the complete M0 operator demo.

## Exact next boundary

M1 adds the local read API and cockpit. That is the first screen where the operator can
submit/seed a task and inspect:

```text
task -> generated workflow tree -> validator result -> workflow hash
```

M1 remains read-only with respect to execution. M2 adds the durable stub executor and
is the first milestone where the same graph is traversed node by node with waits,
signals, restart/replay and human intervention. No real Claude/Codex/Antigravity or
corporate integration is enabled until later milestones.
