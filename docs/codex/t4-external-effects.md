# T4 external effects, Bitbucket PR preparation, and Jenkins observation

Status: generic effect journal, `remote_reconciled` Temporal delivery, validated
provider-neutral PR draft, and the first Bitbucket branch/PR adapter implemented behind
an explicit pilot flag on 2026-08-04. The Jenkins/Allure read boundary and CI
classification are also implemented. Jira lifecycle mutation, review
ingestion/revision, and the real company pilot remain open.

## Boundary

The Temporal graph interpreter knows only the step's declared delivery class. It does
not know Bitbucket endpoints, branch names, PR payloads, or company policy. An immutable
`integration` binding selects a versioned adapter from the Worker registry.

Delivery classes now mean:

- `single_attempt`: Temporal does not redeliver the Activity automatically;
- `read_only`: Temporal may redeliver a side-effect-free remote observation after a
  Worker/process failure;
- `workspace_reconciled`: local agent mutation can be redelivered after inspecting the
  durable worktree intent/baseline;
- `remote_reconciled`: a typed adapter owns read-before-write reconciliation and may be
  redelivered after Worker/process failure.

`pr.prepare@1` uses `remote_reconciled`; `ci.observe@1` uses `read_only`. Adding either
integration did not add a vendor branch to the Workflow interpreter.

Because step artifact dependencies are now part of the compiled contract, the current
compiler/IR markers are compiler `3` and IR `m1`; new runs cannot silently mistake an
older graph for the current recovery and dataflow contract.

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

`bitbucket.pull-request@1` first loads the strict PR draft referenced by the step input
and refuses to commit or push when that draft is missing, invalid, or escapes the
managed worktree. It then:

1. resolves the target branch from `refs/remotes/origin/HEAD`;
2. refuses unresolved merge conflicts;
3. stages only paths reported by Git and creates one local task commit when needed;
4. verifies every `branchArtifacts` path declared by the draft exists in that commit;
5. prepares a push intent and probes the exact remote branch ref;
6. pushes only when the ref is absent and refuses to overwrite a different commit;
7. probes again after timeout/failed response and accepts a matching remote commit;
8. prepares a PR intent and finds an existing open PR by exact source/target refs;
9. creates the PR only when absent, then reconciles after conflict or response loss;
10. persists push, PR, and Activity output receipts before returning completion.

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

The default remains disabled even when `BITBUCKET_TOKEN` exists. The company
`ai-assistance` rule is now represented as selectable workflow blocks and a path
obligation; it is not hard-coded in this adapter. `pr.describe@1` produces a strict
provider-neutral draft, the enabled policy validates its own required section, and
Bitbucket consumes only the draft title/description. This keeps future policy packs and
other SCM providers outside one another's code.

## Jenkins observation

`ci.observe@1` is a file-backed integration block bound to `jenkins.build@1`. The
snapshotted project manifest supplies only the Jenkins job name. The adapter:

1. resolves the exact `HEAD` of the managed task worktree;
2. finds the multibranch job matching the exact managed branch, including Jenkins'
   percent-encoded branch names;
3. ignores stale builds until Jenkins reports that exact commit;
4. waits through branch indexing, build start, and active build states with bounded
   heartbeats;
5. reads pipeline stages and failing Allure cases/attachment metadata;
6. classifies the terminal result as `passed`, `likely_flaky`,
   `likely_caused_by_change`, `infrastructure`, or `unknown`;
7. persists one terminal step receipt and exposes one meaningful linked Activity entry.

Polling is a recovery mechanism, not operator timeline content. A 403/VPN failure,
timeout, flaky result, or ambiguous result opens the existing resumable step wait. A
later attempt re-observes Jenkins against the same branch and current exact commit;
implementation, verification, local commit, and PR preparation are not restarted.

The `read_only` delivery class is intentionally distinct from `remote_reconciled`: the
Jenkins adapter performs no write and therefore needs no remote mutation intent or
applied receipt. Secrets remain in Worker memory. Jenkins URLs and classified evidence
may be persisted; authorization headers may not.

Configuration:

- project: `ci: { "kind": "jenkins", "job": "front-avia" }`;
- credentials: `JENKINS_USER` and `JENKINS_TOKEN`;
- optional: `JENKINS_BASE_URL`, `TASKER_JENKINS_REQUEST_TIMEOUT_MS`,
  `TASKER_JENKINS_POLL_INTERVAL_MS`, and `TASKER_JENKINS_OBSERVATION_TIMEOUT_MS`.

## Evidence

Automated tests prove:

- intent reuse, applied receipts, and changed-identity rejection;
- exact Bitbucket REST source/target payloads and 403 classification;
- a declared but uncommitted branch artifact blocks before any push or PR request;
- successful remote push followed by a simulated lost response is reconciled by ref;
- successful PR creation followed by a simulated lost response is reconciled by lookup;
- 403 leaves one local commit, and a later attempt publishes that exact commit without
  repeating implementation;
- an existing matching open PR is reused;
- Temporal redelivers only the `remote_reconciled` Activity after failure and does not
  repeat completed workspace-step nodes;
- the Activity's durable output receipt prevents a second adapter call after response
  loss.
- a read-only CI Activity is redelivered after Worker failure without repeating prior
  graph nodes;
- Jenkins waits for the exact task commit, separates flaky/infrastructure/product
  verdicts, preserves Allure failure evidence, and bounds branch-indexing polling;
- a local managed-worktree run reaches code review through the real Bitbucket and
  Jenkins adapters backed by deterministic fake remote ports;
- the operator Activity surface contains only terminal CI evidence and links to the
  relevant build.

No request was sent to company Bitbucket or Jenkins in this milestone. The first real
pilot still requires the policy block, explicit flag, and operator-visible confirmation
of the selected task/repository.

## Remaining T4 sequence

1. ingest Bitbucket review threads with provenance and execute revision/push/CI loops;
2. add Jira assignment/status/comment/attachment effects under project policy;
3. enable the real flags for one allowed task and complete the T4 exit gate.
