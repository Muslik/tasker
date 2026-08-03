# T3 managed work execution

Status: managed workspace foundation implemented 2026-08-03; Temporal workspace
Activity, bootstrap adapter, executable blocks, and mutation recovery smoke remain.

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

The current personal harness command `bootstrap init <profile>` discovers worktrees
from the profile's original project checkout and does not accept an explicit target.
Calling it for a separately managed Tasker clone would configure the wrong checkout and
could touch `~/Projects/work`. T3 therefore requires a target-aware, configurable
bootstrap adapter contract. Until such an adapter is configured, company bootstrap is a
typed unavailable capability; Tasker will not copy the existing `work` tree or invent a
nested overlay.

`ai-assistance` remains an optional company policy pack that contributes ordinary
registered blocks. It is unrelated to workspace allocation and Temporal durability.

## Delivered evidence

- application-data path derivation for macOS/Linux/Windows through the existing
  repository-store convention;
- durable workspace projection keyed by deterministic workspace identity;
- branch/worktree creation from a managed checkout;
- manager and SQLite restart reuse the same dirty worktree without duplicating it;
- response-loss reconciliation between Git mutation and ledger receipt;
- explicit rejection of a source checkout outside the managed repository store.

## Remaining T3 sequence

1. Add the target-aware bootstrap adapter and persist/reconcile its receipt.
2. Run workspace preparation as a heartbeat-enabled Temporal Activity before planning.
3. Create the immutable planning snapshot from the prepared worktree, not the source
   clone.
4. Replace stub execution with provider-neutral agent/process block Activities.
5. Prove a disposable file change and build survive worker replacement after mutation
   but before Activity completion without applying the change twice.
