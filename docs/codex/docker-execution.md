# Docker-only workspace execution

Status: canonical execution boundary, 2026-08-09

## What runs where

Tasker has two intentionally different planes:

```text
host / VPS control plane
  Temporal Worker, API/UI, ledger, managed clone/worktree ownership
  git worktree control, Docker CLI, Jira/Bitbucket/Jenkins adapters
                         |
                         v
task-scoped Docker runtime
  Codex/Claude CLI, mise toolchains, project bootstrap, agent blocks,
  process blocks, Playwright, build/tests, and project dev services
```

There is no selectable host execution backend and no host fallback. If Docker or the
required image is unavailable, the same Temporal run opens/retries its infrastructure
boundary; Tasker does not quietly execute the command on the laptop.

The host process runner is an internal control-plane primitive only. It may invoke
`git` to own managed worktrees and `docker` to own exact Tasker-labelled resources.
It is not passed to workflow analyzers, planners, agent blocks, process blocks, or Git
mutation inspection.

## Runtime lifecycle

The preparation Activity performs this sequence:

1. resolve or clone the managed repository under Tasker application data;
2. create/reconcile the durable task worktree and branch;
3. materialize the pinned workspace harness profile;
4. resolve and pin the company/project Docker policy;
5. build or inspect the workspace image;
6. create the task network and named cache volumes;
7. run idempotent system and project bootstrap commands;
8. start/reconcile declared project services and wait for their readiness checks;
9. snapshot planning input and run mandatory implementation planning.

The Activity heartbeats throughout image preparation, bootstrap, and service readiness,
not only between phases. Cancellation is passed to the active command container. A
silent dependency install therefore remains a live Temporal Activity, while cancelling
the task terminates the concrete Docker command instead of abandoning an unknown host
process.

Initial workflow analysis happens before a task worktree exists, but it still runs in
an ephemeral read-only Docker command container. Planning and every later command use
the prepared task runtime.

Each agent/process attempt gets a fresh `docker run --rm` container. The task worktree,
Git common directory, named cache volumes, network, and declared service containers are
durable across attempts. This gives cancellation a concrete container boundary while
preserving all useful work.

Provider containers are started with an interactive stdin pipe because Codex and Claude
receive their task prompt through stdin. The provider's own process sandbox is disabled:
Docker is the external sandbox boundary, and attempting to nest bubblewrap inside the
container fails on standard Docker Desktop kernels. Tasker still enforces the effect
boundary at the mount layer: analyzer/planner repository mounts are read-only, while an
executable task block receives the read/write worktree declared by its contract. The
Docker socket and arbitrary host paths are never exposed to the provider.

## Pinned policy and recovery

`harness/company.json` owns Docker defaults: image, non-secret environment, common
cache mounts, and optional bootstrap/services. A project may override or extend them in
`harness/projects/<project>/project.json`. Runtime policy is data, not a branch in the
Temporal Workflow or application wiring.

The first successful preparation stores a runtime receipt under Tasker application
data. It contains the exact policy/hash, image ID, worktree/source paths, network,
volumes, initialized-volume IDs, service identities, completed bootstrap command
hashes, and timestamps. It contains no credentials.

The receipt advances monotonically for volume initialization and bootstrap progress and
pins the active run. Editing the harness changes future runs; a retry of an existing run
continues with the already pinned policy. A volume or command whose completion receipt
was persisted before Worker/response loss is skipped on the next attempt; an
unreceipted one is reconciled and repeated. Missing networks or services are reconciled
by exact Tasker-owned identity. The worktree is never reset merely because
infrastructure was temporarily unavailable.

Before every provider or workflow-step attempt, Temporal reconciles the pinned receipt
with Docker. An engine restart or image-store switch may make prior images and services
disappear; Resume rebuilds/restarts them without replacing the run, worktree, bootstrap
receipt, or planning snapshot.

Planning snapshots are independently versioned immutable artifacts. Runtime-policy
changes do not rewrite an accepted snapshot. During pre-pilot development, workers read
only the current snapshot schema; a breaking schema change deletes obsolete local runs
and Tasker development data instead of introducing an upcaster. Runtime-only recovery
within the current schema attaches the Docker receipt to the existing execution context
without rebuilding planning from a dirty worktree. Production deployment versioning is
a later release gate, not a compatibility parser in the application domain.

Failures are classified before they become the operator wait: unavailable image or
daemon, runtime identity conflict, receipt-store failure, failed bootstrap command, and
failed service/readiness check are distinct causes. After fixing the prerequisite (for
example VPN, registry access, or Docker disk space), Resume continues the same Temporal
run, worktree, volumes, and bootstrap receipt. It does not recreate the task.

## Toolchain and project setup

The image in `docker/runner/Dockerfile` contains stable system dependencies,
Playwright browsers, `mise`, Codex CLI, and Claude Code. Project language versions do
not accumulate in the image. `mise` reads the repository's `.mise.toml`, `.tool-versions`,
or enabled idiomatic files such as `.nvmrc`, installs the declared toolchain into the
task cache, and exposes it through shims.

`mise` does not guess project bootstrap. The project policy explicitly declares steps
such as `pnpm install --frozen-lockfile` and `pnpm run dicts`. The `front-avia` policy
also declares `pnpm start`, network aliases, and the HTTPS readiness probe. Therefore
Playwright and reproduction run against the service from the same managed worktree,
not an unrelated server that happened to be listening on the host.

The workflow analyzer receives this resolved runtime policy as planning context. It can
therefore know that a repository has a provisioned web service and Playwright-capable
runtime when it chooses reproduction/visual-verification blocks. Runtime preparation
itself remains kernel infrastructure and is not emitted as fake workflow steps.

## Mount and security rules

- the exact worktree is bind-mounted read/write at its absolute path;
- the managed source clone is mounted so Git worktree common-directory references work;
- analyzer and implementation-planner commands remount those repository paths read-only;
- only declared cache volumes and explicit provider temporary directories are mounted;
- credentials are copied into an isolated provider directory or mounted through the
  existing exact harness env-file boundary;
- the Docker socket is never mounted into an agent container;
- environment values are passed to Docker through the control process, while Docker
  arguments contain environment names rather than secret values;
- resource cleanup/reconciliation targets exact Tasker labels and deterministic names,
  never broad globs.

## Operating and extending it

Build manually when diagnosing the image:

```bash
docker build -t tasker/workspace:local -f docker/runner/Dockerfile docker/runner
docker run --rm tasker/workspace:local bash -lc 'node --version; mise --version; codex --version; claude --version'
```

Normal Tasker startup builds the default local image on first use when it is absent.
On a VPS the company/project runtime manifest should point at a versioned prebuilt
registry image. The manifest remains the visible source of truth used by both the
analyzer and runtime; deployment environment variables do not silently rewrite it.

To change setup for future tasks, edit the company/project `workspaceRuntime` manifest.
To add a service, declare its command, aliases, environment, and readiness check. To
change system packages/provider CLI versions, update the runner Dockerfile and image
tag. None of these changes requires modifying the graph interpreter.

## First real recovery pilot

`AVIA-12045` proved the migration path on 2026-08-06 without creating a replacement
task. One existing Temporal Run kept its original Workflow Run ID, managed worktree,
branch, frozen planning snapshot, task network, cache volumes, and bootstrap progress
while the operator fixed Docker image/bootstrap/service issues. Seven completed
bootstrap receipts were reused. The `front-avia` service reached its HTTPS readiness
probe and the next `bug.reproduce@1` attempt ran Codex plus Playwright inside Docker
against that service.

The pilot also exposed and fixed three cutover defects rather than hiding them with a
host fallback: provider stdin required `docker run --interactive`; nested Codex
bubblewrap had to yield to the Docker mount boundary; and the pre-Docker planning
snapshot required an explicit historical schema reader. Each defect resumed the same
workflow node after correction.
