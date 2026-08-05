# T2 Temporal implementation planning

Status: core control loop, durable operator transcript, and real-provider recovery
evidence completed 2026-08-03.

Architecture update (2026-08-05): planning now runs as a first-class pre-freeze
Temporal lifecycle rather than a `task.analyze@1` branch inside the generic graph
interpreter. It retains the snapshotted read-only skills and shared Evidence Bundle;
proposed workflow changes are fully recompiled and validated before execution. See
[`planning-lifecycle.md`](planning-lifecycle.md).

## Operator-visible behavior

A Temporal task now performs real implementation planning at its `task.analyze@1`
boundary. Planning can:

- finish with a typed implementation plan;
- ask one or more blocking questions in reviewed or automatic-plan mode;
- pause for plan approval when the run setting requires it;
- accept revision guidance and create another immutable attempt;
- report `workflow_change_required`, recompile a validated draft, and request operator
  guidance only when the bounded automatic cycle cannot progress;
- exhaust provider retries and wait for an explicit retry without restarting the task.

Questions, approvals, revision feedback, and retry commands are validated Temporal
Updates. A wait releases the worker slot: no Activity or provider process remains alive
while the operator is away.

## Immutable input boundary

Before the Temporal Workflow starts, Tasker persists one `planning_run_snapshot`
artifact. The Temporal payload contains only its `artifactId` and checksum. The
snapshot contains the normalized task, accepted graph/hash, repository reference,
planner prompt, relevant block bindings and skill references, and matching
company/project policy manifests.

Every initial, clarification, and revision Activity in that run loads the same
checksum-verified artifact. Editing a prompt or project/company harness file therefore
affects a future run snapshot, not the active conversation. Jira bodies, prompt text,
and policy documents remain outside Temporal Event History.

## Recovery and idempotency

Each logical provider command has a stable ID:

```text
<temporal-workflow-id>:planning:<sequence>
```

The implementation-planning projection records that ID before invoking the provider.
If an Activity completion is lost, retry returns the already persisted result. If a
worker dies while the provider is running, retry re-enters only that planning attempt.
A changed graph hash or snapshot checksum fails closed before the provider is called.

The provider subprocess receives Temporal cancellation and emits heartbeats at start,
every ten seconds, and when stdout/stderr arrives. Workflow cancellation is propagated;
it is not converted into an operator retry wait.

Provider stdout/stderr is appended before heartbeat progress to bounded SQLite artifact
chunks. The Temporal state and implementation-plan projection contain only a stable
transcript ID. A worker retry appends a new provider-attempt number to the same logical
transcript, so output captured before interruption remains available. If persistence
fails, the provider process is stopped and the Activity fails recoverably instead of
continuing with an observability gap. The operator console polls this separate surface
only while planning is live; transcript chunks never become activity-timeline noise.

## Runtime ownership

Temporal owns current position, retries, questions, reviews, and waiting. Tasker SQLite
owns normalized product artifacts and projections:

- the immutable planning snapshot;
- the typed plan/question/change-request artifact for every attempt;
- exact clarification-answer artifacts;
- provider receipts with duration, token usage, prompt hash, and hypothetical API cost.

Planner-selected Jira, Confluence, and Loop reads cross a Tasker-owned mediation
boundary. The provider emits a typed evidence request instead of calling the system;
Tasker persists that request and its receipt, runs the adapter, appends provenance, and
invokes planning with the new bundle revision. Pending reads survive Activity retry, so
a 403/VPN interruption does not spend the preceding planner round again. Large response
bodies are content-addressed outside the bundle and verified before planner
materialization.

Company processes are not special-cased in this control loop. For example, a temporary
`ai-assistance` policy is represented by registered workflow blocks selected by the
analyzer. Removing that policy changes future assembled graphs without changing the
Temporal interpreter.

## Verification delivered

- worker replacement while a planning question is open;
- question answer followed by plan revision and approval in the same Workflow run;
- Activity retry without duplicate provider completion;
- immutable snapshot checksum across all attempts;
- harness prompt edit does not alter an active run;
- graph-hash mismatch stops before provider invocation;
- typed HTTP commands reject generic or malformed wait resolutions;
- independent tasks do not share planning/review state.
- a failed mediated read resumes from its persisted request without rerunning the
  preceding planner call;
- planning-added evidence survives a later provider failure and new planning attempt;
- large external evidence is referenced from the bundle and materialized with checksum
  verification;
- bounded stdout/stderr chunks survive ledger restart and preserve retry order;
- transcript overflow is marked and capped instead of growing without limit;
- persistence failure stops the provider attempt;
- the transcript API and operator console expose live and completed provider output
  separately from durable business activity.

The real-provider smoke used Temporal Server 1.31.2 and subscription-authenticated
`codex-cli 0.120.0` with model `gpt-5.4`. The first worker was stopped after provider
attempt 1 had persisted 1,208 transcript bytes. A replacement worker replayed the same
Workflow and resumed the same stable planning command as provider attempt 2. The final
transcript contained both attempts (24 chunks, 6,405 bytes), and the planning Activity
completed with a typed `workflow_change_required` result. The Workflow ID, Run ID,
command ID, transcript ID, and implementation-plan attempt remained unchanged across
the interruption.

## T2 exit status

All T2 exit evidence is complete. The implementation-plan projection and compact
operator surface expose the checksum-addressed immutable planning snapshot, while the
dedicated agent-log surface exposes the linked transcript. Repository mutation remains
disabled; T3 introduces the managed worktree and executable workflow-block boundary.
