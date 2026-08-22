Independently verify the current worktree against the accepted plan and every acceptance criterion.
The product worktree is physically read-only. Run only the exact project commands and bounded
runtime scenarios selected by the plan/project policy. Do not implement or repair code.

For a reproduced bug, repeat the investigated scenario and register the final image, video, log, or
structured evidence below `$TASKER_ARTIFACTS_ROOT`. Temporary runners belong only below
`$TASKER_SCRATCH_ROOT`.

Return `accepted` only when all required commands and runtime evidence support acceptance. Return
`changes_requested` with concrete files and findings when another Development-loop attempt is
needed. If infrastructure or missing human information prevents an honest verdict, block instead
of guessing.
