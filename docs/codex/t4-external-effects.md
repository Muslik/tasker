# T4 external effects, Bitbucket PR preparation, and Jenkins observation

Status: generic effect journal, reconciled Bitbucket PR publication, Jenkins/Allure
observation, human-review/revision/reply lifecycle, and Jira task admission implemented
behind explicit pilot flags on 2026-08-04. Jira review readiness and optional
before-reproduction evidence publishing were added behind the same Jira flag on
2026-08-04. The real company pilot remains open. Thread resolution is not implemented
because the supported local Bitbucket contract exposes replies but no verified resolve
endpoint.

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

`pr.prepare@1`, `review.acknowledge@1`, `jira.start-work@1`,
`jira.attach-reproduction@1`, and `jira.review-ready@1` use `remote_reconciled`;
`ci.observe@1` uses `read_only`. Adding these integrations did not add a vendor branch
to the Workflow interpreter.

## Jira admission

The file-backed `jira-lifecycle` policy applies only to tasks normalized with origin
`jira`. Its effect-based path obligations require `plan.approved@1` and
`jira.start-work@1` before any `workspace.write` or `command.run` product effect. This
keeps the graph dynamic while making a future block unable to bypass admission merely
because it has a new name.

The adapter reads eligibility before mutation: issue type and status must be permitted,
excluded labels must be absent, and an existing assignee must match the configured
operator. It then assigns an unowned issue and traverses the policy-owned status path by
querying Jira's currently available transitions rather than hard-coding transition IDs.
Each assignment and status edge has its own intent/probe/receipt. Lost responses are
reconciled from the live assignee/status; 400 is an admission error, while 403/VPN is an
infrastructure wait. Neither reaches the next code step. Operator guidance retries only
admission against the same prepared worktree.

Registration additionally requires `TASKER_ENABLE_JIRA_EFFECTS=true` and an exact Tasker
task reference in `TASKER_EXTERNAL_EFFECT_TASKS`. Credentials alone never enable writes,
and enabling the adapter family does not authorize unrelated tasks handled by the same Worker.

## Jira before-reproduction evidence

The independent file-backed `jira-reproduction-evidence` policy applies only to Jira
`short_bugfix` tasks. Its obligation selects `bug.reproduce@1` with
`with.phase=before` and requires
`jira.attach-reproduction@1` after that successful step; a second obligation requires
both before `code.implement@1`. Fixture assembly places the attachment immediately
after reproduction. Feature graphs, local-origin bug graphs, and after-fix reproduction
do not acquire this effect. The policy can be disabled together with its owned step
without changing Jira admission, review readiness, the compiler, or the Temporal
Workflow.

`bug.reproduce@1` now has a discriminated output contract: a before result can succeed
only as `reproduced`, an after result only as `verified_fixed`, and every preserved
video/image/log carries a managed-worktree-relative path plus MIME type. The attachment
adapter selects only policy-permitted video/images, validates lexical and real paths,
regular-file type, size, and non-empty content, then names each remote file from its
SHA-256 digest. It stores no media bytes in Temporal history or the effect journal.

Each attachment has its own intent/probe/receipt identity. Existing files with the same
content-derived name and size are reused; a name collision with another size is a
remote conflict. A lost upload response is accepted only after Jira lists the expected
attachment. A 403 pauses only this block, and a later attempt probes Jira before write,
so reproduction and implementation are not repeated. No selected media is a successful
`no_media` outcome rather than a fabricated upload.

## Jira review readiness

The same file-backed policy requires `pr.prepare@1`, `ci.observe@1`, and
`jira.review-ready@1`, in that order, before every `code_review@1` wait in a Jira-origin
graph. The workflow analyzer remains free to assemble the rest of the task graph; the
deterministic validator rejects any initial or revised PR path that bypasses this
boundary.

`jira.review-ready@1` reads the latest durable provider-neutral PR output, requires a
concrete URL, follows the configured Jira status path to Code Review, and publishes one
compact Jira-wiki link. It never imports Bitbucket code or response types. Both the
transition and comment have independent intent/probe/receipt identities. A repeated
Activity or a later operator-resumed attempt observes the live issue and comments first,
so an existing transition or link is not repeated. A 403 pauses only this block; a lost
response is accepted only when the post-write observation proves the result.

Because wait-result mappings and recoverable loop exhaustion are now part of the
compiled contract, the current compiler/IR markers are compiler `4` and IR `m2`; new
runs cannot silently mistake an older graph for the current recovery and dataflow
contract.

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
6. creates a missing ref, or advances the task ref only when its remote commit is an
   ancestor of the new local commit and the exact remote value still matches a
   force-with-lease guard;
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

## Review and revision

`code_review@1` is a durable Temporal wait, not a long-running polling Activity. An
operator sync (and later a webhook using the same coordinator) reads the exact PR from
the latest completed `pr.prepare@1` output. Pending review leaves the wait untouched.
Approval or unresolved human comments produce a small typed wait result while the full
thread tree, anchors, authors, and timestamps are stored in an immutable
`pull-request-review` artifact outside Workflow history. Re-importing identical review
state is deduplicated by content hash.

The compiled wait maps `approved` and `changes_requested` to generic predicate facts.
The task-specific graph decides what follows. Current company graphs use a pre-checked,
three-attempt loop containing `review.revise@1`, targeted verification, PR draft and
policy regeneration, guarded branch update/PR reconciliation, Jenkins observation,
`review.acknowledge@1`, and another `code_review@1` wait. Approval skips or exits the
loop. Exhaustion opens `operator_guidance@1`; the operator's prompt is passed to the
next revision Activity in the same Workflow Run and managed worktree.

The operator may explicitly mark a comment-free review done. Tasker never auto-merges.
The file-backed `review-feedback` policy requires every `review.revise@1` path to publish
the revision, observe CI, acknowledge the imported threads, and return to review. Its
directional path obligation is configuration, not Temporal code. The Bitbucket adapter
posts a localized reply to each root thread with a hidden stable marker. Every reply has
its own intent and receipt; a preflight/post-failure activity probe reconciles lost
responses and partial batches. A 403 pauses only this step. The review observer ignores
an acknowledged thread while that marker is the latest comment; any later reviewer
reply makes the thread actionable again.

## Pilot gate

Worker registration additionally requires:

```text
TASKER_ENABLE_BITBUCKET_PR_EFFECTS=true
TASKER_EXTERNAL_EFFECT_TASKS=jira:AVIA-12045
```

The allowlist is comma-separated when a deliberately bounded pilot contains more than one task.
Worker startup fails closed when either Jira or Bitbucket mutations are enabled without at least
one exact task reference. An unlisted task pauses at the integration boundary before the remote
adapter is invoked. The default remains disabled even when `BITBUCKET_TOKEN` exists. The company
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
- paginated Bitbucket activities preserve nested human threads and file/line anchors,
  ignore bot-only roots, classify VPN/403, and deduplicate immutable review evidence;
- review changes execute revise/verify/PR/CI cycles, bounded exhaustion opens operator
  guidance, and the supplied prompt resumes the same loop and worktree;
- review replies reconcile lost responses and partial 403 batches per root thread, and
  a later human follow-up makes the thread actionable again;
- a remote task-branch revision advances only through an exact lease after proving the
  remote commit is an ancestor of the local commit.
- Jira review readiness rejects missing PR evidence before mutation, reconciles lost
  comment responses, deduplicates the PR link across attempts, and resumes a 403 at the
  same Temporal node without repeating implementation or PR preparation.
- Jira reproduction publishing verifies the actual worktree bytes, reconciles a lost
  upload response without a duplicate, resumes 403 at only the attachment node, and
  does not repeat before-reproduction or product implementation.

No request was sent to company Jira, Bitbucket, or Jenkins in this milestone. The first real
pilot still requires the policy block, explicit flag, and operator-visible confirmation
of the selected task/repository.

## Remaining T4 sequence

1. enable the real flags for one allowed task and complete the T4 exit gate;
2. add automatic Bitbucket thread resolution only if a supported company endpoint and
   desired review policy are verified during the pilot.
