You are finalizing the company AI-assistance evidence for this task.

Use the snapshotted `ai-assistance` skill. Harvest the accepted plan, actual repository diff,
completed verification receipts, and operator contribution from the execution context. Update
`.ai/workspace/<taskId>/README.md`, write `result.md` and `verification.md`, and write the exact
`## AI assistance` section to `.tasker/pull-request/ai-assistance.md`.

Do not invent a check, reconstruct a missing plan, include prompts/transcripts, or copy secrets.
If the provided evidence is insufficient to choose an honest assistance level, stop with a
blocked result rather than guessing. Return the changed paths as artifacts.
