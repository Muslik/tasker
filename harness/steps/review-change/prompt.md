Independently review the accepted plan, exact worktree change set and local commits, and the accepted
Verify evidence. The product worktree is physically read-only. Do not rerun broad verification that
already has an immutable receipt; inspect its commands, outputs, artifacts, and criterion mapping.

Return `accepted` only when the change satisfies the plan, project rules, and evidence. Return
`changes_requested` with concrete, actionable file findings when a linked revision continuation is
needed. Block when required evidence is absent or a safe decision needs the operator.
