# T4 external effects and Bitbucket PR preparation

Status: generic effect journal, `remote_reconciled` Temporal delivery, and the first
Bitbucket branch/PR adapter implemented behind an explicit pilot flag on 2026-08-04.
Jira lifecycle mutation, Jenkins/Allure observation, review ingestion/revision, and the
real company pilot remain open.

## Boundary

The Temporal graph interpreter knows only the step's declared delivery class. It does
not know Bitbucket endpoints, branch names, PR payloads, or company policy. An immutable
`integration` binding selects a versioned adapter from the Worker registry.

Delivery classes now mean:

- `single_attempt`: Temporal does not redeliver the Activity automatically;
- `workspace_reconciled`: local agent mutation can be redelivered after inspecting the
  durable worktree intent/baseline;
- `remote_reconciled`: a typed adapter owns read-before-write reconciliation and may be
  redelivered after Worker/process failure.

Only `pr.prepare@1` uses `remote_reconciled` today. Adding an integration does not add a
vendor branch to the Workflow interpreter.

Because the compiled step delivery union changed, the compiler/IR markers advance to
compiler `2` and IR `m1`; new runs cannot silently mistake the older schema for this
recovery contract.

## Effect protocol

Every enabled remote mutation uses this sequence:

```text
persist stable intent -> inspect remote state -> execute only when absent/safe
                      -> inspect again after ambiguous failure -> persist applied receipt
```

The effect journal stores immutable intent and applied-receipt artifacts under the
logical Activity operation. Repeating an operation with a different effect identity is
rejected. A committed Activity output receipt prevents the adapter from being called a
second time when only the response to Temporal was lost.

`unknown_outcome` is a controlled wait. It is used when a request may have reached the
remote service and the adapter cannot prove the result. Temporal does not convert that
state into a blind second write.

## Bitbucket adapter

`bitbucket.pull-request@1` currently:

1. resolves the target branch from `refs/remotes/origin/HEAD`;
2. refuses unresolved merge conflicts;
3. stages only paths reported by Git and creates one local task commit when needed;
4. prepares a push intent and probes the exact remote branch ref;
5. pushes only when the ref is absent and refuses to overwrite a different commit;
6. probes again after timeout/failed response and accepts a matching remote commit;
7. prepares a PR intent and finds an existing open PR by exact source/target refs;
8. creates the PR only when absent, then reconciles after conflict or response loss;
9. persists push, PR, and Activity output receipts before returning completion.

A 403 or unavailable preflight opens an infrastructure wait. Operator resume creates a
new logical step attempt against the same worktree; completed implementation and
verification nodes do not run again. The new attempt reads the existing commit/remote
state and continues at branch publication or PR creation.

The access token exists only in Worker memory and Git/fetch request configuration. It is
not placed in command arguments, Workflow input/results, effect identity, artifacts, or
metadata.

## Pilot gate

Worker registration additionally requires:

```text
TASKER_ENABLE_BITBUCKET_PR_EFFECTS=true
```

The default is disabled even when `BITBUCKET_TOKEN` exists. This is deliberate: the
company `ai-assistance` rule must first be represented as a selectable workflow block
that produces the required branch artifacts and PR section. Hard-coding that rule in
the Bitbucket adapter would violate the customization boundary. Until that block and
its graph obligation are implemented, the pilot flag must remain off for company work.

The current PR title/description are derived from the normalized task. A later
policy/description block may provide richer reviewed content without changing the
effect protocol or Temporal interpreter.

## Evidence

Automated tests prove:

- intent reuse, applied receipts, and changed-identity rejection;
- exact Bitbucket REST source/target payloads and 403 classification;
- successful remote push followed by a simulated lost response is reconciled by ref;
- successful PR creation followed by a simulated lost response is reconciled by lookup;
- 403 leaves one local commit, and a later attempt publishes that exact commit without
  repeating implementation;
- an existing matching open PR is reused;
- Temporal redelivers only the `remote_reconciled` Activity after failure and does not
  repeat completed workspace-step nodes;
- the Activity's durable output receipt prevents a second adapter call after response
  loss.

No request was sent to company Bitbucket in this milestone. The first real pilot still
requires the policy block, explicit flag, and operator-visible confirmation of the
selected task/repository.

## Remaining T4 sequence

1. model `ai-assistance` as ordinary policy blocks/obligations and generate reviewed PR
   description evidence;
2. run a disposable/local end-to-end PR simulation through the real Worker adapter;
3. implement Jenkins observation and CI classification;
4. ingest Bitbucket review threads with provenance and execute revision/push/CI loops;
5. add Jira assignment/status/comment/attachment effects under project policy;
6. enable the real flag for one allowed task and complete the T4 exit gate.
