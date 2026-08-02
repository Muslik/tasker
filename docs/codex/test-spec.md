# Tasker: canonical test specification

Status: approved by Planner -> Architect -> Critic consensus, v3  
Date: 2026-08-01  
Architecture: [`architecture.md`](architecture.md)  
Delivery order: [`implementation-plan.md`](implementation-plan.md)

## 1. Testing principles

1. Assert behavior at public domain/port boundaries, not implementation details.
2. One act per test: compile, transition, dispatch, reconcile, resume, or hand off.
3. Every real adapter first passes the same deterministic contract suite as its fake.
4. Process-kill tests are required evidence, not optional chaos polish.
5. Replay reconstructs facts and projections; it never reissues side effects.
6. Every remote-write test distinguishes `applied`, `not_applied`, and
   `unknown_outcome`.
7. Deterministic readiness and the nondeterministic `>=50%` pilot KPI are reported
   separately.

## 2. Test layers

### Unit/reducer

- IR and ABI validators;
- aggregate reducers and impossible-state rejection;
- predicate and verification-policy decisions;
- resume cursor, retry budget, and readiness policy;
- cost and duration calculations.

### Repository/transaction

- SQLite migrations and version gates;
- atomic event/projection/outbox/lease write order;
- CAS and fencing;
- dedupe constraints and artifact lineage.

### Adapter contract

- provider subprocess lifecycle;
- Jira/Confluence/Bitbucket/Jenkins/Allure/Loop/Git wrappers;
- signal normalization;
- receipt/probe/reconcile classification.

### Recovery/replay

- kill at transaction, dispatch, wait, lease, effect, takeover, and join boundaries;
- rebuild projections from empty projection tables;
- stale runner and duplicate delivery behavior.

### E2E/operator

- visible generated workflow;
- durable stub traversal;
- real provider/worktree traversal;
- Jira/PR/CI/review/revise;
- translation wait;
- cross-repo child run;
- retrospective/readiness/pilot reports.

### Selected test tooling

- Vitest projects: `unit`, `property`, `repository`, `contract`, `recovery`, and
  `operator`;
- fast-check only for stateful sequences and invariants where generated cases can
  find a defect that examples may miss;
- Playwright for real-browser cockpit/operator behavior and traces;
- MSW from the first HTTP integration onward for ordinary response contracts;
- a repository-owned Node HTTP/TCP scenario server for `unknown_outcome` wire cases;
- real temporary file-backed SQLite databases, repositories, worktrees, and
  subprocesses for transaction and recovery evidence.

The dependency timing, suite layout, and required test drivers are specified in
[`technology-decisions.md`](technology-decisions.md#7-test-libraries-and-suite-shape).

## 3. Canonical fixtures

### Task families

- `short_bugfix` based on AVIA-13236/AVIA-13235 characteristics;
- `long_feature_review` based on AVIA-12536 characteristics;
- `translation_wait`;
- `shared_component_parent` and `shared_component_child`;
- `not_agent_eligible`;
- `visual_change` and `build_only_change`.

### Failure fixtures

- Jira definite `400`;
- provider quota exhaustion;
- provider session lost after dispatch;
- process kill at every persistence/effect boundary;
- Bitbucket push definite `403`;
- Bitbucket push ambiguous connection loss;
- duplicate PR/review/webhook/signal delivery;
- CI ours/flaky/external/infrastructure;
- stale lease completion;
- secret-bearing provider/tool output;
- unsupported event/snapshot/step ABI version.

## 4. Requirement-to-scenario catalog

### R1 — Intake and eligibility

- `jira_400_persists_intake_failure_without_task_run_or_worktree`
- `intake_repair_retries_fetch_only`
- `not_eligible_is_terminal_routing_decision_with_reasons`
- `eligible_intake_creates_exactly_one_task_and_snapshot`
- `duplicate_intake_submission_is_idempotent`
- `linked_context_failure_obeys_declared_policy`

Evidence:

- IntakeRequest event history;
- absence/presence queries for Task/Run/worktree;
- normalized source snapshot and provenance hashes.

### R2 — Workflow compilation and visibility

- `same_snapshot_and_policy_produce_same_graph_hash`
- `different_task_families_produce_distinct_graphs`
- `graph_tree_renders_from_persisted_projection_after_restart`
- `graph_diff_shows_task_specific_changes_from_template`
- `reject_unknown_step_type`
- `reject_unbounded_loop`
- `reject_missing_terminal_path`
- `reject_unmet_capability`
- `reject_effect_without_idempotency_or_reconcile_policy`
- `reject_wait_without_resolution_contract`
- `verification_rationale_is_visible_before_execution`
- `external_translation_policy_adds_extract_wait_and_pull`
- `inline_json_translation_policy_adds_no_translation_nodes`
- `assembly_decisions_explain_repository_policy_effects`
- `every_accepted_task_graph_contains_the_universal_planning_boundary`
- `provider_cannot_remove_or_reorder_the_planning_boundary`

Evidence:

- snapshot/graph/validator artifacts;
- cockpit and CLI render captures;
- rejection debug bundle.

### R3 — Transaction, CAS, fencing, and replay

- `append_projection_outbox_and_lease_change_commit_atomically`
- `cas_conflict_exposes_no_outbox_command`
- `lease_replacement_increments_fence_before_work_visibility`
- `stale_fence_completion_is_rejected_without_mutation`
- `projection_rebuild_matches_live_projection_checksum`
- `unsupported_event_version_quarantines_run_fail_closed`
- `unsupported_snapshot_or_step_abi_quarantines_run_fail_closed`
- `replay_never_dispatches_effects`

### R4 — Durable Wait and Signal

- `quota_exhaustion_opens_quota_wait_not_provider_failure`
- `open_wait_releases_slot_when_policy_is_slot_free`
- `matching_signal_resolves_wait_and_resumes_exact_cursor`
- `duplicate_signal_is_audited_noop`
- `stale_or_wrong_correlation_signal_does_not_resume`
- `restart_during_wait_preserves_cursor_and_slot_state`
- `ci_translation_review_and_human_waits_share_wait_abi`
- `each_wait_kind_enforces_its_own_resolution_schema`

### R5 — Intervention and immutable prompts

- `course_correction_appends_intervention_event`
- `intervention_creates_new_attempt_in_same_run`
- `next_attempt_input_contains_intervention_overlay`
- `historical_prompt_hash_and_transcript_remain_unchanged`
- `multiple_interventions_preserve_order_and_authorship`
- `future_prompt_version_change_does_not_mutate_active_or_historical_run`
- `gate_answer_without_guidance_resumes_declared_path`
- `required_plan_approval_opens_a_durable_plan_review_wait`
- `automatic_plan_approval_skips_only_the_human_wait_not_planning`
- `duplicate_start_cannot_change_immutable_run_settings`
- `blocking_question_pauses_in_both_plan_approval_modes`

### R6 — ManualTakeover

- `manual_takeover_is_not_encoded_as_wait`
- `takeover_reconciles_inflight_effect_before_transfer`
- `takeover_releases_fenced_runner_lease`
- `takeover_freezes_all_automation_writes_to_worktree`
- `stale_runner_write_after_takeover_is_rejected`
- `handoff_packet_contains_cwd_branch_sha_diff_cursor_effects_waits_and_tests`
- `human_edit_defaults_to_new_linked_run_on_reentry`
- `same_run_reentry_requires_proof_of_no_material_human_write`
- `takeover_and_new_run_preserve_task_history_linkage`

### R7 — Provider capability and lifecycle

- `provider_probe_records_installed_version_and_capabilities`
- `provider_selection_uses_persisted_compatibility_report`
- `provider_start_stream_complete_reconcile_lifecycle_is_normalized`
- `provider_quota_signature_maps_to_quota_wait`
- `provider_resume_unavailable_starts_new_attempt_from_durable_artifacts`
- `kill_after_provider_dispatch_reconciles_before_new_attempt`
- `provider_cost_records_preserve_measured_vs_estimated_source`
- `unsupported_provider_is_disabled_with_reason`

### R8 — Worktree and smallest-safe resume

- `one_active_run_owns_one_isolated_worktree`
- `worktree_metadata_and_diff_survive_restart`
- `succeeded_steps_are_not_reexecuted_after_downstream_failure`
- `definite_push_403_is_not_applied_and_blocks_push_step_only`
- `vpn_repair_resumes_new_push_attempt_only`
- `unknown_push_outcome_requires_remote_ref_probe_before_retry`
- `remote_ref_contains_commit_classifies_push_applied`
- `remote_ref_absent_classifies_push_not_applied`
- `ambiguous_probe_blocks_or_hands_off_without_duplicate_push`

### R9 — Change-aware verification

- `narrow_compile_change_selects_build_only_when_policy_allows`
- `local_behavior_change_selects_targeted_tests`
- `shared_package_change_upgrades_to_full_or_composed_suite`
- `rendered_ui_change_selects_visual_compare`
- `snapshot_change_requires_snapshot_update_evidence`
- `repository_mandated_check_cannot_be_silently_downgraded`
- `verification_rationale_inputs_and_result_are_persisted`
- `revision_invalidates_only_affected_verification_nodes`

### R10 — Bitbucket review conversation

- `review_comment_ingest_is_deduplicated_by_remote_identity`
- `accepted_thread_creates_exactly_one_revision_item`
- `question_thread_posts_reply_without_code_revision`
- `disagree_with_evidence_posts_evidence_without_code_revision`
- `already_addressed_thread_does_not_duplicate_fix`
- `blocked_thread_opens_gate_or_recoverable_blocker`
- `human_reply_wakes_correlated_review_wait`
- `agent_does_not_resolve_human_thread_without_policy`
- `pr_is_canonical_review_channel_but_not_universal_gate_channel`

### R11 — Concurrent CI and review

- `pr_creation_starts_ci_watch_and_review_ingest_concurrently`
- `ci_ours_opens_bounded_fix_reverify_loop`
- `ci_flaky_uses_bounded_rerun_budget`
- `ci_external_waits_without_invalidating_completed_work`
- `ci_infrastructure_opens_recoverable_environment_wait`
- `ci_green_satisfies_ci_readiness_projection`
- `review_before_ci_and_ci_before_review_converge_to_same_projection`
- `waiting_for_review_requires_no_agent_actionable_ci_or_review_work`
- `waiting_for_review_holds_no_runner_slot`

### R12 — Translation wait

- `translation_upload_opens_correlated_slot_free_wait`
- `loop_signal_resolves_matching_translation_wait`
- `manual_signal_uses_same_resolution_schema_as_loop_signal`
- `translation_signal_resumes_pull_node_only`
- `duplicate_translation_signal_is_noop`
- `restart_during_translation_wait_preserves_batch_and_worktree`
- `translation_wait_time_is_separate_from_active_agent_time`

### R13 — Later graph expansion and child runs

- `first_wave_run_uses_one_immutable_compiled_graph`
- `runtime_discovery_returns_typed_workflow_change_required`
- `workflow_change_request_preserves_cursor_worktree_and_evidence`
- `first_wave_replan_compiles_linked_immutable_continuation`
- `rejected_continuation_leaves_parent_recoverably_blocked`
- `unsupported_first_wave_expansion_opens_preserved_replan_gate`
- `graph_revision_only_applies_at_declared_expansion_point`
- `graph_revision_preserves_parent_hash_and_node_lineage`
- `graph_revision_rejects_unknown_or_unsafe_step`
- `child_request_creates_separate_task_run_and_worktree`
- `parent_and_child_histories_replay_independently`
- `child_dev_publish_emits_exact_version_artifact_once`
- `dev_version_resolves_parent_join_and_triggers_integration_verify`
- `final_publish_requires_human_gate`
- `wrong_or_stale_release_version_does_not_resume_parent`
- `kill_after_publish_before_receipt_reconciles_registry_before_retry`
- `manual_child_result_fallback_satisfies_same_typed_contract`

### R14 — Observability, cost, and debug bundle

- `attempt_step_run_cost_rollups_match_call_records`
- `active_wall_and_wait_time_are_distinct`
- `pricing_snapshot_reproduces_historical_shadow_cost`
- `cockpit_active_cursor_matches_projection_after_restart`
- `debug_bundle_contains_snapshot_graph_events_checksum_lineage_waits_receipts_and_artifacts`
- `debug_bundle_redacts_secret_bearing_content`
- `branch_retry_wait_provider_and_verification_decisions_have_visible_rationale`
- `external_otel_export_toggle_does_not_change_ledger_behavior`

### R15 — Retrospective and future-only change

- `retrospective_compares_planned_and_actual_graph_path`
- `retrospective_attributes_retries_waits_interventions_and_takeover`
- `proposal_requires_human_approval`
- `approved_proposal_creates_new_future_version_with_rollback`
- `proposal_never_changes_active_or_historical_snapshot`
- `readiness_report_is_independent_of_pilot_percentage`
- `only_eligible_replay_safe_classified_runs_count_in_pilot`

### R16 — Redaction and secret safety

- `secret_is_redacted_or_blocked_before_event_commit`
- `blocked_raw_payload_is_not_readable_through_manifest_lineage`
- `provider_and_integration_credentials_never_enter_snapshot`
- `artifact_derivative_retains_safe_lineage`
- `exporter_runs_second_redaction_pass`

### R17 — Error normalization and recovery action

- `third_party_throw_is_caught_once_and_normalized_at_adapter_boundary`
- `expected_domain_rejection_is_returned_without_exception_control_flow`
- `applied_effect_requires_receipt`
- `unknown_outcome_requires_versioned_probe_contract`
- `access_denied_maps_to_gate_not_hidden_retry`
- `quota_failure_requires_reset_evidence_and_maps_to_slot_free_wait`
- `transient_not_applied_retry_respects_persisted_budget`
- `contract_violation_quarantines_and_exposes_no_new_command`
- `selected_recovery_action_is_persisted_before_dispatch`
- `http_and_subprocess_layers_do_not_retry_outside_durable_policy`
- `raw_exception_and_diagnostic_are_redacted_before_persistence`

## 5. Kill/restart matrix

For every supported boundary, run the test with the process killed:

| Boundary | Required recovery |
|---|---|
| before event transaction commit | command may be retried; no visible partial state |
| after event append before projection | impossible under atomic transaction |
| after outbox visibility before dispatch | one dispatch with current fence |
| after dispatch before receipt | reconcile; never blind retry |
| during provider stream | resume if supported, otherwise new attempt from artifacts |
| after Wait open | wait remains open and slot remains released |
| after matching Signal ingest | idempotent resolution and one resume command |
| during takeover | either runner-owned or human-owned, never both |
| after push send before response | remote-ref probe before retry |
| after dev publish before local receipt | registry/version probe before publish retry |
| during review/CI concurrent events | deterministic projection independent of arrival order |

## 6. Milestone gates

### M0 gate — contracts

- schema/version/CAS/fence/redaction tests green;
- IntakeRequest can fail without Task/Run;
- IR and ABI fixtures validate/reject deterministically.

### M1 gate — visible workflow

- at least three task fixtures render distinct persisted graphs;
- graph hash survives restart;
- invalid graphs are visibly rejected;
- cockpit demo recorded.

### M2 gate — durable stub traversal

Current evidence (incremental vertical slice, 2026-08-02): Start durably queues a run;
capacity `2` admits two independent runs, capacity `1` is reused after a slot-free wait,
and a restarted scheduler replaces an expired lease without duplicate receipts. A run
reaches a persisted plan-review wait; operator feedback creates an immutable guidance
artifact and planning attempt `2`; reopening SQLite returns to plan review without
discarding attempt `1`. Every accepted graph contains the universal planning boundary;
an immutable per-run setting either opens that wait or records an automatic continuation
after the same planning node, and a conflicting duplicate start is rejected. Another
run reaches a slot-releasing code-review wait; API/UI
runtime projections update from ledger events; and a forced stop after two committed
steps resumes from the same cursor. A real typed implementation plan now runs through
subscription Codex CLI (or an explicit deterministic test provider), persists its
strategy/provenance/token receipt, and survives operator-guided attempt revision. The
planner can also open a slot-releasing blocking-clarification wait; exact operator
answers are persisted and resume the same run at a new planning attempt, including
after restart and during plan revision. The full gate remains open for heartbeat/outbox
dispatch, executor-originated clarification, provider capacity pools, quota behavior,
generalized intervention, workflow continuation, takeover, projection rebuild, and the
complete kill matrix.

- one graph completes on stubs;
- kill/restart matrix for kernel boundaries green;
- quota wait, intervention, takeover, and slot reuse demonstrated;
- projection rebuild checksum matches.

### M3 gate — first provider

- compatibility report exists;
- first provider selected from evidence;
- one real read-only node and provider recovery case pass.

### M4 gate — real worktree/recovery

- real isolated diff/commit evidence;
- wrong-direction intervention path;
- definite `403` push-only resume;
- unknown push reconciliation;
- manual takeover/new linked run.

### M5 gate — real intake

- Jira 400, not-eligible, and eligible paths pass;
- real eligible snapshot compiles through the M1 path.

### M6 gate — real Jira/PR/CI/review

- one end-to-end eligible fixture reaches `waiting_for_review`;
- CI classifications and mixed review dispositions pass;
- duplicate delivery and restart tests pass;
- no unresolved unknown effect exists.

### M7 gate — translation

- upload/wait/signal/pull path survives restart and frees slot.

### M8 gate — cross-repo child

- validated expansion, linked child, dev version, parent verification, human final
  publish, and resume path pass without duplicate publish.

### M9 gate — readiness/pilot

- all deterministic gates through implemented scope green;
- retrospective future-only rules green;
- pilot report separate and cohort eligibility auditable.

## 7. Deterministic execution-readiness gate

Tasker is not execution-ready merely because a demo reaches a PR. Readiness requires:

1. zero unsupported schema versions in active runs;
2. projection rebuild parity from the canonical ledger;
3. process-kill evidence for implemented effect/wait boundaries;
4. no stale lease mutation;
5. no blind retry of unknown remote outcome;
6. source-side redaction before persistence;
7. operator-visible graph, cursor, rationale, waits, receipts, and worktree state;
8. classified recovery/handoff path for every non-success outcome;
9. milestone-specific tests and operator demo complete.

## 8. Pilot KPI

After deterministic readiness:

- define an eligible cohort before running it;
- count optional plan review, genuine questions, and normal PR review separately from
  unexpected mandatory intervention;
- report at least the percentage reaching `waiting_for_review`, failure taxonomy,
  active/wait/human time, attempts, and shadow cost;
- `>=50%` is success for the pilot but can never waive a failed deterministic gate.

## 9. Exit criteria for implementation handoff

- architecture, plan, and this spec use the same state/ABI vocabulary;
- every M0-M2 requirement has a named scenario and evidence type;
- later milestones have dependency gates and explicit fallback/containment;
- provider-first is not hardcoded;
- PR is scoped to code review, not all human communication;
- ManualTakeover defaults to a new linked run after human edits;
- persisted GraphRevision is staged after first-wave immutable graph/replay;
- no executor must invent the 403, Jira 400, intervention, translation, CI, review,
  verification, or child-run behavior.
