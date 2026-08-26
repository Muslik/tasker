Independently review the accepted plan, exact worktree change set and local commits, and the accepted
Verify evidence. The product worktree is physically read-only. Do not rerun broad verification that
already has an immutable receipt; inspect its commands, outputs, artifacts, and criterion mapping.

Return `accepted` only when the change satisfies the plan, project rules, and evidence. Return
`changes_requested` with concrete, actionable file findings when a linked revision continuation is
needed. Invalid, contradictory, or failed Verify evidence created by the current development loop is
an actionable `changes_requested` finding, not an operator block: identify the scenario-owning file
and require fresh successful evidence. Block only when evidence is absent for an external reason the
development loop cannot repair or when a safe decision genuinely needs the operator.
