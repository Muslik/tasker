Independently judge the current worktree against the accepted plan and every acceptance criterion.
On a repeated attempt, treat the supplied causal frontier and mounted immutable receipts as the
starting evidence. Do not reconstruct already accepted runtime checks by rereading broad repository
surfaces. Repeat a runtime scenario only when the current workspace fingerprint or causal receipt
makes its old result stale. Use the compact run-history index to locate exceptional older receipts
only when the frontier is insufficient.
The product worktree is physically read-only. Run only the bounded runtime scenarios and evidence
capture required by the accepted plan. Do not implement or repair code.

The project's deterministic validation commands already ran in `validation.run@1`. Inspect that
process receipt in run evidence and judge it. Locate the completed `run-validation` node with step
reference `validation.run@1`, then inspect `details.output.exitCode` and every entry in
`details.commands`. Do not rerun the project's build, test, or validation suites here, do not choose
selectors, and do not replace the repository's command selection with an agent-authored alternative.

## Delegation

Delegate repository recon spanning more than three files to `explore`, and test authoring to
`test-writer`; make small focused edits yourself. Subagents return only artifacts (map/excerpts or
diff summary/test results), never full transcripts.
A missing or corrupt required validation receipt is a block. A completed validation receipt with a
nonzero exit code is `changes_requested`, citing the failing profile, command evidence, and
scenario-owning files.

Before repeating expensive runtime evidence, inspect the mounted immutable receipts and the current
repair delta. If a previous accepted Verify receipt already proves the same runtime scenario, and the
new Implement attempt changed only an expected snapshot or task metadata in response to exact CI
evidence without changing product source, reuse the accepted runtime evidence and verify only the
repair delta. For a CI snapshot repair, inspect the CI actual image, compare its checksum with the
updated baseline, and reuse the deterministic validation receipt. Rerun the browser scenario when
product source or the acceptance scenario changed, or when the prior evidence does not cover the
current criterion.

When a repository Playwright command runs in this read-only step for runtime-specific evidence, keep
its normal config and selector but select a non-writing reporter and direct its output directory
below `$TASKER_SCRATCH_ROOT`. Read `.ai/app-runbook.md` before runtime verification. If it
identifies an existing Tasker-managed service, reuse that service and do not start a competitor.
Otherwise start the documented server inside this provider attempt, wait for its readiness signal,
run the exact test and evidence scenario, and stop it with `trap` or `finally`. Never daemonize it
outside the attempt, publish a host port, or assume it survives a retry. Server caches and outputs
must use the writable paths documented by the runbook; block if the server requires writes to the
read-only product worktree.

For a bug, repeat the investigated scenario and create exactly one primary publishable after
artifact below `$TASKER_ARTIFACTS_ROOT`: either `<TASK-ID>-fixed.png` or
`<TASK-ID>-fixed.mp4` (an optional descriptive segment before `-fixed` is allowed). Choose an image
for a static visible result and a video for interaction or state transitions. Use `playwright-demo`
when recording. Inspect the final image or representative video frames before accepting. Other
diagnostic logs/JSON may also be registered, but they must not use the `-fixed` publication name.
Temporary runners belong only below `$TASKER_SCRATCH_ROOT`.
Every command that produces the primary after artifact must complete successfully. A demo timeout,
`DEMO_ERROR`, failed assertion, or partially recorded WebM invalidates that run: do not render,
rename, register, or reuse its media as `-fixed`. Return `changes_requested` with the exact failing
scenario instead. The artifact's existence is never evidence that its scenario passed.
Every one-shot Playwright runner must close its browser in `finally`; a failed scenario must
terminate promptly instead of leaving Chromium handles alive across agent commands.

When the frozen Jira task snapshot contains source screenshots or video, use the `jira` skill to
download the relevant attachment by its exact issue key and attachment ID into
`$TASKER_ARTIFACTS_ROOT` with a private `-before` name. Inspect it before choosing a repository
fixture. The after scenario must preserve the visible route/state, card kind, viewport, and
cardinality/labels of the condition that caused the defect (for example two named technical stops),
unless the accepted plan explicitly justifies an equivalent substitute. Merely injecting a generic
non-empty field such as `stps` into a convenient mock is not source-faithful evidence. If the source
attachment cannot be read or no matching fixture/state can be reached, block instead of accepting a
different screenshot. Never name private source evidence `-fixed` or upload it back to Jira.

Return `accepted` only when the deterministic validation receipt and all required runtime evidence
support acceptance. Return `changes_requested` with concrete files and findings when another
Development-loop attempt is needed. If infrastructure or missing human information prevents an
honest verdict, block instead of guessing.
