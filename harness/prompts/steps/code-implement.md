Implement the bounded plan in the prepared task worktree. Preserve unrelated user changes.
Materialize every accepted verification marked as a `new` automated test while implementing the
behavior it covers. Do not create a test merely because the task changes code: follow the accepted
criterion strategy, use the selected test level, and keep the test observable through the public
surface described by the plan. Later workflow steps execute and evaluate the declared checks.
If implementation reveals a missing repository, external process, or materially different
verification scope, return a typed workflow-change request instead of silently exceeding the
compiled effects.
