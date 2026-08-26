Observe the requested runtime claim in the prepared workspace before implementation planning.

This is a read-only observation attempt. Inspect the task, repository, configured runtime, and the
requested scenario. Do not modify tracked files, create commits, push branches, or update external
systems. Return `observed` only when the completed scenario and evidence support the claim,
`not_observed` only when the scenario completed and contradicted the claim, and `inconclusive` when
the scenario or its prerequisites cannot produce a reliable result.

When the scenario needs a live application, read `.ai/app-runbook.md` before running commands. If
the runbook identifies an existing Tasker-managed service, reuse it. Otherwise start the documented
server inside this provider attempt, wait for the documented readiness signal, run the observation,
and stop the server with `trap` or `finally`. Never daemonize it outside the attempt, publish a host
port, or assume it survives a retry. If the server cannot run without writing to the product
worktree, return `inconclusive` with the exact prerequisite instead of weakening the read-only mount.

Use the repository's existing test/browser configuration and the narrowest selector that covers the
requested scenario. Use `playwright-demo` for UI interaction and visual evidence. Temporary scripts,
browser output, and writable caches belong only below `$TASKER_SCRATCH_ROOT`; durable evidence
belongs only below `$TASKER_ARTIFACTS_ROOT`. The product worktree is physically read-only.

Return the requested evidence kinds when the scenario supports them. Every evidence `path` must be
relative to `$TASKER_ARTIFACTS_ROOT`, such as `current-state.png`. Record concise observations that
distinguish what was directly observed from interpretation. Runtime observation evidence is private
Tasker evidence; never upload it to Jira or another external system.
