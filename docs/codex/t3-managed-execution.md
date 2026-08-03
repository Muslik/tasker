# T3 managed work execution

Status: managed workspace, built-in multi-project harness bootstrap, optional external
adapter protocol, Temporal preparation Activity, executable block boundary, and browser
E2E parity implemented 2026-08-04; real local mutation response-loss smoke remains.

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

An optional `TASKER_WORKSPACE_BOOTSTRAP_COMMAND` retains the target-aware external
adapter protocol for another company or packaging system. It receives `inspect` or
`apply` plus the exact workspace locator and must return `absent` or a versioned ready
receipt.

`ai-assistance` remains an optional company policy pack that contributes ordinary
registered blocks. It is unrelated to workspace allocation and Temporal durability.

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

## Remaining T3 sequence

1. Prove a disposable file change and build survive worker replacement after mutation
   but before Activity completion without applying the change twice.
2. Pilot the built-in profile and mutation recovery against a disposable managed
   repository; Temporal-only browser E2E coverage already passes.
