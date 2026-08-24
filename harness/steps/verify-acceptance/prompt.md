Independently verify the current worktree against the accepted plan and every acceptance criterion.
The product worktree is physically read-only. Run only the exact project commands and bounded
runtime scenarios selected by the plan/project policy. Do not implement or repair code.

The repository owns its commands and test configuration. Read the current `package.json` and use
its existing scripts with the narrowest selector that covers the accepted plan and actual diff.
Do not create an alternative Playwright config for a repository test and do not run an unbounded
UI/snapshot suite. Docker and matching project browser caches are already available in this
task-scoped runtime; report an infrastructure block instead of inventing another runner.

For a bug, repeat the investigated scenario and create exactly one primary publishable after
artifact below `$TASKER_ARTIFACTS_ROOT`: either `<TASK-ID>-fixed.png` or
`<TASK-ID>-fixed.mp4` (an optional descriptive segment before `-fixed` is allowed). Choose an image
for a static visible result and a video for interaction or state transitions. Use `playwright-demo`
when recording. Inspect the final image or representative video frames before accepting. Other
diagnostic logs/JSON may also be registered, but they must not use the `-fixed` publication name.
Temporary runners belong only below `$TASKER_SCRATCH_ROOT`.

Return `accepted` only when all required commands and runtime evidence support acceptance. Return
`changes_requested` with concrete files and findings when another Development-loop attempt is
needed. If infrastructure or missing human information prevents an honest verdict, block instead
of guessing.
