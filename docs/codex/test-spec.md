# Tasker Temporal test specification

Status: canonical acceptance and recovery specification, 2026-08-03

## 1. Test strategy

The tests prove Tasker behavior, Temporal integration, and external-effect safety. They
do not re-test Temporal internals or preserve legacy queue/lease implementation details.

Use four layers:

1. pure unit/property tests for IR, compiler, validator, interpreter helpers, policies,
   schemas, and cost calculations;
2. Temporal time-skipping integration tests with mocked Activities for Workflow state,
   messages, timers, retries, graph revisions, and child coordination;
3. real local Temporal service tests for client/worker/API restart, task routing, and
   replay/deployment compatibility;
4. adapter/process/Playwright tests for worktrees, providers, Jira/Bitbucket/Jenkins,
   artifacts, and the operator journey.

Assertions target public state, emitted artifacts/effects, and operator behavior. Avoid
asserting exact internal Event History sequences unless required by a replay or
duplicate-effect invariant.

## 2. Universal invariants

Every accepted implementation must prove:

- a generated graph is rejected until its IR, ABI, capabilities, effects, bounds, and
  semantic obligations validate;
- every initial graph is assembled for its task, not selected from a base template;
- Temporal is the only authority for execution position, waits, timers, and retries;
- Workflow code is deterministic and imports no I/O/provider/database/process modules;
- worker/API/process restart never restarts task intake or completed nodes;
- human waits consume no Activity worker slot;
- duplicate messages and Activity delivery do not duplicate remote effects;
- blocking uncertainty pauses for an answer regardless of plan-review preference;
- graph/plan/prompt/policy revisions are immutable and provenance-bearing;
- large artifacts and secrets do not enter Workflow payloads, Search Attributes, or
  logs;
- two task states are independent;
- manual guidance resumes from the blocked boundary;
- retrospective changes require human approval.

## 3. Pure domain tests

### 3.1 Workflow compiler and validator

Required scenarios:

- `task_specific_source_compiles_to_stable_hash`
- `same_semantics_with_different_object_order_has_same_hash`
- `unknown_step_version_is_rejected`
- `unbounded_loop_is_rejected`
- `terminal_path_without_terminal_or_wait_is_rejected`
- `step_without_required_capability_is_rejected`
- `effect_without_reconciliation_contract_is_rejected`
- `bug_without_before_reproduction_is_rejected`
- `bug_without_after_reproduction_is_rejected`
- `write_path_without_verification_is_rejected`
- `pr_path_without_ci_and_code_review_is_rejected`
- `compiler_does_not_silently_insert_missing_obligation`
- `company_or_vendor_payload_is_absent_from_workflow_domain`

### 3.2 Interpreter

- `sequence_advances_only_after_recorded_step_result`
- `branch_uses_recorded_typed_predicate_input`
- `loop_stops_at_bound_and_exposes_exhaustion`
- `completed_node_is_not_selected_after_resume`
- `wait_consumes_matching_message_once`
- `wrong_wait_payload_is_rejected_without_state_change`
- `question_opens_in_reviewed_and_unreviewed_plan_modes`
- `graph_revision_preserves_completed_node_set`
- `terminal_state_cannot_return_to_runnable`

Property tests generate bounded valid/invalid graphs and check stable canonicalization,
terminal-path safety, monotonic completion, and no step selection outside the graph.

### 3.3 Policies and schemas

- repository precedence: explicit selection -> field -> description marker -> blocked;
- `repo:<name>` does not guess among ambiguous repositories;
- project translation policy applies only to its project/repository;
- global package policy does not imply an external publish without task evidence;
- plan-size routing selects consensus only for configured evidence/operator choice;
- prompt/harness edit changes future snapshot hash, not active run input;
- shadow price table version is stored with calculated cost;
- secret-bearing fields fail or redact before persistence.

## 4. Temporal Workflow integration tests

Run these with the TypeScript time-skipping test environment and mocked Activities.

### 4.1 Basic traversal

- `accepted_graph_reaches_first_activity_and_terminal`
- `two_workflows_advance_independently`
- `activity_retry_preserves_node_identity_and_attempt_count`
- `non_retryable_error_opens_failure_or_attention_state`
- `timer_backoff_survives_worker_unavailability`
- `query_returns_bounded_public_state`
- `cancellation_stops_future_nodes_and_records_reason`

### 4.2 Plan and questions

- `plan_review_false_proceeds_after_valid_plan`
- `plan_review_true_waits_for_approval`
- `plan_feedback_creates_new_plan_attempt`
- `blocking_question_waits_even_when_plan_review_is_false`
- `answer_update_validates_question_and_payload_identity`
- `duplicate_answer_is_idempotent_or_rejected_without_reexecution`
- `answer_for_another_run_cannot_resume_selected_run`

### 4.3 Human/external waits

- `code_review_wait_consumes_no_activity_slot`
- `translation_signal_resumes_only_matching_wait`
- `final_publish_update_requires_exact_version_payload`
- `ci_webhook_duplicate_is_ignored`
- `poll_observation_and_webhook_for_same_ci_build_collapse_to_one_event`
- `wait_timeout_opens_configured_escalation_not_task_restart`

### 4.4 Workflow change

- `workflow_change_required_stops_original_suffix`
- `invalid_revision_is_rejected_and_visible`
- `pilot_policy_waits_for_revision_review`
- `accepted_same_repo_revision_appends_suffix_without_replaying_prefix`
- `independent_repo_revision_starts_child_workflow`
- `parent_waits_without_worker_slot_until_child_result`
- `child_failure_or_question_projects_to_parent_attention`
- `released_version_resumes_parent_consumer_step`
- `wrong_or_stale_release_version_does_not_resume_parent`

### 4.5 Replay and versioning

- capture representative histories for sequence, wait/update, Activity retry, graph
  revision, and child workflow;
- replay them against the candidate worker build before release;
- verify old IR/block versions are either supported by the worker or fail deployment
  compatibility before new work is routed there.

## 5. Real Temporal service recovery tests

These tests use a real local Temporal Service and real worker subprocesses.

### 5.1 Process boundaries

1. Start a Workflow and block a controlled Activity.
2. Kill the worker process.
3. Start a replacement worker.
4. Assert only the pending Activity is redelivered and completed nodes remain complete.

Repeat with:

- API/control-plane restart during an open wait;
- cockpit disconnect/reconnect;
- worker restart after heartbeat;
- Temporal service restart using the chosen persistent development configuration;
- cancellation while a child process is active.

### 5.2 Concurrency

- start at least two tasks with worker capacity >1 and observe overlap;
- constrain provider Activity capacity to 1 and verify non-provider work/waits remain
  independent;
- one task in plan review does not set another task to generating/review;
- one task's failure/retry budget does not alter another task;
- Task Queue routing sends filesystem work only to a capable worker.

### 5.3 Payload and history audit

For a representative run, inspect Event History and Search Attributes:

- no credentials/tokens;
- no full prompt/transcript/source/Jira description;
- no screenshot/video bodies;
- payload sizes stay within the documented budget;
- artifact IDs/hashes resolve in Tasker storage;
- Query response is bounded.

## 6. Activity and adapter contract tests

### 6.1 Provider/process execution

- provider Activity streams transcript to artifact storage and returns a bounded result;
- measured token usage and price-table version produce shadow cost;
- heartbeat records attempt/session/artifact progress, not raw logs;
- cancellation terminates the subprocess or reports unconfirmed termination;
- provider session resume failure starts a new attempt from persisted context;
- process exit classification distinguishes task failure, infra failure, and cancellation;
- no nested generic retry multiplies Temporal Activity attempts.

### 6.2 Worktree recovery

- managed clone is created only in Tasker application data;
- existing `~/Projects/work` clone is never mutated;
- retry reuses the same task branch/worktree;
- harness bootstrap is invoked once or reconciled by receipt;
- kill after file write/before Activity completion preserves change and does not apply it
  twice;
- dirty/conflicting state opens typed attention instead of destructive reset;
- deleting/recreating API process does not lose worktree locator.

### 6.3 Jira

- sync success only updates snapshot and `syncedAt`, not activity history;
- VPN/403 sync failure updates health without erasing cached task;
- Jira 400 on take-into-work is classified and does not start code Activity;
- non-agent task policy prevents assignment/status mutation;
- repeated comment/attachment Activity reconciles existing remote result;
- before-reproduction media attaches only when explicit policy permits it.

### 6.4 Bitbucket

- push retry reconciles remote ref after response loss;
- PR creation reuses matching open PR;
- unresolved review threads become one revision input with provenance;
- reply operations are idempotent or reconciled;
- no automatic merge occurs.

Implemented local evidence additionally proves that approval skips the revision body,
changes run revise -> verify -> PR -> CI before returning to review, and three
unsuccessful cycles open operator guidance instead of failing or rebuilding the task
workspace. Local adapter tests prove per-thread reply reconciliation after response
loss, partial 403 recovery, and Activity redelivery. A real company call remains part of
the pilot gate; resolve is not assumed without a verified endpoint.

### 6.5 Jenkins/Allure

- build success signals code-review readiness;
- likely flaky failure uses flaky budget, not implementation budget;
- attributable failure returns to revision;
- unknown failure runs diagnostic Activity then opens guidance after its bound;
- webhook loss is recovered by polling;
- Allure artifacts remain outside Temporal history and resolve in the console.

### 6.6 External-effect crash matrix

For each mutation adapter, inject process termination:

| Boundary | Required recovery |
|---|---|
| before prepare receipt | operation may start cleanly |
| after prepare, before request | reconcile sees not applied and executes once |
| after request, before response | reconcile remote state before retry |
| after response, before applied receipt | reconcile returns applied receipt |
| remote state cannot prove outcome | open `external_effect_unknown`; never blind retry |

## 7. Operator UI tests

Playwright acceptance scenarios:

1. task list shows per-task state, attention, elapsed time, and cost independently;
2. selecting a task shows its agent/process stream in the center and active graph on the
   right;
3. start form includes optional repository and plan-review checkbox;
4. plan review accepts feedback and visibly creates a new attempt;
5. blocking question shows evidence/options and accepts an answer;
6. VPN/403 displays compact sync/infra health without activity-log spam;
7. stopping/reopening the cockpit restores selected task state;
8. PR review comments enter revise and return to CI/review;
9. late graph revision shows rationale/diff and preserves completed nodes;
10. Jira task details are readable/editable through the integration boundary;
11. raw Temporal diagnostics are available on demand, not mixed with task activity;
12. minimal layout remains usable at the supported desktop viewport.

## 8. Milestone gates

### T1 gate

- two dynamic fixture graphs run independently;
- worker and API restart pass;
- separate durable waits resume only their own runs;
- Workflow code dependency isolation passes;
- no payload/secret violation.

### T2 gate

- real subscription planning Activity passes plan approval/revision/question flows;
- attempts, time, tokens, and shadow cost are visible;
- provider interruption resumes from the planning boundary.

### T3 gate

- disposable repository change/build survives worker kill without duplicate mutation;
- worktree/bootstrap paths and recovery rules pass;
- no remote mutation capability is enabled.

Evidence on 2026-08-04: `temporal-local-mutation-recovery.test.ts` stops the first
Worker after a TypeScript source mutation and before Activity completion, starts a
replacement Worker on the same Task Queue, verifies `recovery_delivery` against the
same built-in-profile worktree, runs the task test and build, and reaches
`code_review@1`. Mutation intent and exact Activity output receipts are both asserted.

### T4 gate

- allowed Jira task reaches PR code review;
- Jira admission rejects ineligible ownership/status before code, classifies 400/403,
  reconciles lost responses, and resumes in the same worktree;
- 403 during push resumes only push/reconciliation;
- CI classifications and PR revise loop pass;
- external-effect crash matrix is green for enabled mutations.

### T5 gate

- translation and cross-repository continuation demos pass;
- completed parent work never restarts;
- invalid/stale graph and publish messages cannot resume work.

### T6 deletion gate

- Temporal parity is green for every public behavior previously owned by the legacy
  runtime;
- incomplete product milestones such as future Bitbucket/Jenkins mutations do not
  block deletion when no equivalent legacy mutation path remains;
- representative legacy behavior has an equivalent public Temporal test;
- no new run can select legacy runtime;
- code search finds no runtime dependency on legacy ready-set/lease/fence/cursor/wait
  tables;
- current legacy fixtures are exported or deliberately discarded with documented scope;
- lint, typecheck, unit, integration, replay, e2e, and dead-code checks pass.

### Pilot gate

- >=50% of selected in-scope tasks reach useful code review;
- zero lost or duplicated remote effects;
- every recovery resumes from the correct boundary;
- operator interventions, time, and cost are measurable;
- retrospective changes are proposed and manually approved, never self-applied.
