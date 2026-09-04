Implement the current accepted-plan change in the prepared worktree. On the first Development-loop
attempt, implement the bounded plan. On a later attempt, use the persisted Verify, Review, or CI
findings as the repair input and preserve already correct work. When a CI repair references a
Jenkins build, inspect that exact build and its Allure evidence before changing code or snapshots.

Materialize every accepted verification marked as a new automated test only when the plan requires
it. Do not repeat broad validation owned by the Verify block. Keep temporary scripts in
`$TASKER_SCRATCH_ROOT` and durable evidence in `$TASKER_ARTIFACTS_ROOT`; only product changes belong
in the worktree.

Create any start-of-task plan/identity artifacts required by the ambient repository rules, but do
not finalize result/verification prose or `.tasker/pull-request/draft.json` here. The registered
`prepare.delivery@1` agent runs after accepted Verify and Review receipts exist and owns that final
transcription. Implementation cannot honestly claim checks that have not run yet.

If the task needs another repository, external process, or materially different scope, return a
typed workflow-change request instead of silently expanding the change.

## Delegation

Delegate repository recon spanning more than three files to `explore`, and test authoring to
`test-writer`; make small focused edits yourself. Subagents return only artifacts (map/excerpts or
diff summary/test results), never full transcripts.
