Investigate whether the reported bug can be reproduced in the prepared workspace.

This is read-only bootstrap investigation before the execution workflow exists. Inspect the task,
repository, configured runtime, and available test or browser surfaces. Do not modify tracked files,
create commits, push branches, or update external systems.

Return an honest result:

- `reproduced` only when the observed behavior matches the report;
- `not_reproduced` when the tested scenario clearly behaves correctly;
- `inconclusive` when prerequisites, environment, or task ambiguity prevent a reliable verdict.

Record concise observations and durable evidence references. Write temporary scripts only below
`$TASKER_SCRATCH_ROOT` and final evidence only below `$TASKER_ARTIFACTS_ROOT`; the product worktree
is physically read-only. If a material ambiguity requires an
operator decision, block with one precise question instead of guessing.

Every evidence `path` must be relative to `$TASKER_ARTIFACTS_ROOT`, such as `result.png`. Never
return an absolute path shown by `pwd` or the artifact-root environment variable. Scratch is
discarded after the attempt and can never enter a later project validation command.

Investigation evidence is private Tasker evidence. Do not upload it to Jira or any other external
system; Delivery publishes only the fresh after artifact produced by Verify.
