Repeat the investigated scenario after implementation using the task's declared environment and
repository policy. Prove the reported behavior is fixed and preserve comparable evidence,
including video for visible UI bugs when feasible. The pre-change observation belongs to the
bootstrap investigation evidence bundle and must not be recreated in this execution block.

Do not claim success without observable evidence. Escalate infrastructure failures without
discarding the current run, worktree, artifacts, or completed receipts. On success, return
`phase: "after"` and `outcome: "verified_fixed"`. List every preserved file in `evidence` with
`kind` (`video`, `image`, or `log`), a path relative to the managed worktree, and its MIME type.
