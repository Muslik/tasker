# T3 managed work execution

Status: managed workspace, built-in multi-project harness bootstrap, Docker-only
preparation and executable block Activities, response-loss reconciliation, and browser
E2E parity implemented 2026-08-05. The T3 gate is complete.

## Boundary

T3 permits the first local repository mutation, but still forbids Jira, Bitbucket,
Jenkins, publication, and other remote effects. Temporal owns when workspace preparation
and executable blocks run. Tasker product storage owns their locators, receipts,
transcripts, and artifacts.

The workspace is kernel-owned infrastructure, not a company workflow template. Every
task still receives a newly assembled graph. Agent and process nodes in that graph bind
to registered versioned blocks; the Temporal interpreter never gains project names,
translation rules, `ai-assistance` branches, or provider-specific behavior.

## Managed workspace invariants

- The source checkout must be inside Tasker's configured repository application-data
  store. A checkout under `~/Projects/work` or any other operator path is rejected
  before Git runs.
- Workspace identity, branch, and path are deterministic from the task, Workflow ID,
  Workflow Run ID, accepted workflow hash, and repository reference.
- Worktrees live under Tasker's configured application-data `worktrees` directory.
- The first Git commit is recorded as the immutable base; later retries preserve the
  current branch, dirty files, commits, and agent evidence.
- A retry reads the durable locator and reconciles branch plus Git common directory.
  Missing, replaced, or foreign worktrees open a typed conflict; Tasker does not reset,
  delete, or silently recreate them.
- If the process dies after `git worktree add` but before ledger persistence, retry
  recognizes the deterministic path and persists the original locator instead of
  creating a second branch or worktree.

## Harness bootstrap boundary

The personal harness command `bootstrap init <profile>` discovers worktrees
from the profile's original project checkout and does not accept an explicit target.
Calling it for a separately managed Tasker clone would configure the wrong checkout and
could touch `~/Projects/work`. Tasker instead loads `harness/workspace/manifest.json`,
resolves the exact managed repository, pins an immutable content-addressed snapshot,
and copies the selected profile into only the managed worktree. Git exclusions and
worktree-local `skip-worktree` bits keep this configuration out of the task diff.

`inspect` verifies the pinned selection, file hashes, and Git hidden state. If a worker
or response is lost after a partial apply, the next Activity attempt completes the same
snapshot. Editing the source pack affects future workspaces only.

Project bootstrap is declared in company/project `workspaceRuntime` policy and runs
only inside Docker. The removed external host bootstrap backend is not a compatibility
surface. Another company replaces the portable workspace pack and runtime policy,
without adding a host hook.

Runtime preparation heartbeats while the image, toolchain, dependencies, and service
readiness are being reconciled. Volume ownership and every bootstrap command are
receipted independently, so retry neither recursively rewrites a populated cache nor
forgets an interrupted pre-bootstrap volume. Docker/image/bootstrap/service failures
become the recoverable workspace wait with their exact cause.

`ai-assistance` remains an optional company policy pack that contributes ordinary
registered blocks. It is unrelated to workspace allocation and Temporal durability.

## Activity delivery and mutation recovery

Activity retry safety is part of each registered step contract and is copied into the
accepted compiled graph. It is not inferred from a node name inside the Temporal
interpreter:

- `workspace_reconciled` is used by local agent blocks. Before the provider starts,
  Tasker persists a mutation-intent artifact containing the worktree fingerprint,
  tracked diff hash, and changed paths. A replacement Activity delivery inspects the
  same worktree and receives both the baseline and current state in its execution
  context.
- `single_attempt` is used by process blocks and integrations that cannot yet prove
  read-before-write reconciliation. Temporal does not retry these effects merely
  because a Worker response was lost.
- `read_only` is used by side-effect-free observations such as `ci.observe@1`. Temporal
  may redeliver them after Worker failure because they cannot duplicate a remote write.
- `remote_reconciled` is introduced in T4 for an integration whose versioned adapter
  persists intent, probes the remote system, and records an applied receipt. The first
  user is `pr.prepare@1`; see `t4-external-effects.md`.

Agent completion, controlled block, and workflow-change results are persisted as exact
Activity output receipts before returning to Temporal. If the receipt is committed but
the response is lost, the replacement delivery returns the stored result without
invoking the provider again. If only workspace changes exist, the provider resumes with
an explicit `recovery_delivery` context and must inspect and continue the existing work
instead of assuming a clean attempt.

## Delivered evidence

- application-data path derivation for macOS/Linux/Windows through the existing
  repository-store convention;
- durable workspace projection keyed by deterministic workspace identity;
- branch/worktree creation from a managed checkout;
- manager and SQLite restart reuse the same dirty worktree without duplicating it;
- response-loss reconciliation between Git mutation and ledger receipt;
- durable bootstrap receipt plus `inspect`/`apply` response-loss reconciliation;
- seven repository profiles imported from the existing work harness without copying
  credentials or operator checkout hooks;
- content-addressed harness snapshots that isolate active runs from later edits;
- explicit rejection of a source checkout outside the managed repository store.
- a heartbeat-enabled Temporal Activity bound to `task.analyze@1` that prepares the
  worktree, bootstraps it, then creates the immutable planning snapshot from that path;
- API start no longer performs filesystem/snapshot work before starting Temporal;
- planning snapshot identity includes the managed `workspaceId`, so a later run of the
  same task and graph cannot silently reuse another run's repository input;
- workspace/bootstrap/snapshot locators are visible as one valid execution-context
  state, never as independently nullable fields;
- infrastructure failure opens a recoverable `workspace.retry@1` wait and resumes in
  the same Workflow Run after worker replacement.
- registered `agent` and `process` blocks now execute through one Temporal Activity
  that reads immutable step bindings from the accepted planning snapshot rather than
  from project-specific step-name logic;
- agent execution runs Codex inside the managed worktree, streams bounded transcript
  chunks into product storage, persists full stdout/stderr as artifacts, validates the
  structured output contract, and can return a typed `workflow_change_required`
  request;
- process execution accepts only the snapshotted command line, rejects unsupported
  shell syntax, persists full output, and blocks cross-repository or unregistered
  execution instead of guessing how to continue;
- execution-time `blocked` and `workflow_change_required` outcomes reopen durable waits
  on the same node, so the run can resume after operator guidance instead of restarting
  the task.
- existing pre-Docker Temporal histories recover through versioned Workflow patches and
  a runtime-only Activity. The recovery keeps the original workspace, bootstrap receipt,
  planning snapshot, and execution prefix rather than rerunning preparation;
- planning snapshot v4 remains readable without the later required Docker policy, while
  newly captured snapshots use v5. Snapshot immutability is preserved instead of
  backfilling the historical artifact from a potentially dirty worktree;
- provider prompts cross `docker run --interactive`; Codex's nested bubblewrap is
  disabled because Docker is the sandbox boundary. Analyzer/planner worktrees are still
  bind-mounted read-only, and executable blocks receive the explicit read/write boundary;
- the real `AVIA-12045` run reconciled a complete `front-avia` runtime and reached a
  live Codex/Playwright reproduction attempt against the managed HTTPS service without
  changing Workflow Run ID, branch, or worktree.
- a disposable TypeScript feature ran through the built-in `front-avia` profile. The
  first Worker changed `src/passenger-name.ts` and stopped before acknowledging the
  Activity; a replacement Worker observed the dirty worktree, applied no duplicate
  mutation, ran the behavior test and TypeScript build, passed non-mutating PR/CI smoke
  adapters, and reached `code_review@1` in the same Workflow Run;
- the smoke asserts both mutation-intent and exact output-receipt artifacts, one
  provider invocation per delivery, one durable worktree identity, and an unchanged
  final diff.

## T3 exit

T3 has no remaining implementation item. Jira, Bitbucket, Jenkins/Allure, push, and
publication are deliberately still disabled; they enter in T4 one effect family at a
time with their own intent, reconciliation, receipt, and unknown-outcome contracts.
