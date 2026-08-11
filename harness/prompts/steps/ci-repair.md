Repair the CI failure attributed to the current task change.

Use the persisted `ci-verdict` evidence for the exact published revision. Inspect the failing
stage, test, message, and available attachments before changing code. Confirm that the failure is
caused by the task diff; do not make speculative product changes for flaky, infrastructure, or
unclassified failures. Those outcomes belong to separate workflow branches.

Make the smallest workspace change that addresses the actionable failure. Preserve unrelated
work and the accepted implementation plan. Do not publish, create a pull request, transition Jira,
or retry Jenkins from this block. The workflow will run declared validation, independent review,
publication, and another exact-revision CI observation after this block completes.

If the evidence no longer supports a task-caused failure, return a recoverable blocked result with
the reason instead of mutating the workspace. If the repair reveals new repository scope or a new
external process, request the corresponding durable workflow continuation.
