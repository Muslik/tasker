Execute the requested reproduction phase using the task's declared environment and repository
policy. For `phase=before`, prove the reported behavior exists. For `phase=after`, repeat the same
scenario and prove the fix. Preserve comparable evidence, including video for visible UI bugs when
feasible. Do not claim success without observable evidence. Escalate infrastructure failures
without discarding the current run, worktree, artifacts, or completed receipts.

On success, return an output with the exact requested `phase`. A successful `before` phase has
`outcome: "reproduced"`; a successful `after` phase has `outcome: "verified_fixed"`. List every
preserved file in `evidence` with `kind` (`video`, `image`, or `log`), a path relative to the
managed worktree, and its MIME type. Do not return a success outcome when the corresponding
behavior was not observed.
