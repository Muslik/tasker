Implement the current accepted-plan change in the prepared worktree. On the first Development-loop
attempt, implement the bounded plan. On a later attempt, use the persisted Verify, Review, or CI
findings as the repair input and preserve already correct work. When a CI repair references a
Jenkins build, inspect that exact build and its Allure evidence before changing code or snapshots.

Materialize every accepted verification marked as a new automated test only when the plan requires
it. Do not repeat broad validation owned by the Verify block. Keep temporary scripts in
`$TASKER_SCRATCH_ROOT` and durable evidence in `$TASKER_ARTIFACTS_ROOT`; only product changes belong
in the worktree.

Before completing, maintain `.tasker/pull-request/draft.json` for the current worktree. It is an
internal delivery draft with `title`, `description`, `commit`, and `branchArtifacts`. Follow the
repository history and every applicable AGENTS/CLAUDE rule and selected skill when composing it.
List any required tracked support artifacts in `branchArtifacts`; never list `.tasker` paths. On a
later Development iteration update the same draft for the actual current change rather than
creating another delivery description.

If the task needs another repository, external process, or materially different scope, return a
typed workflow-change request instead of silently expanding the change.
