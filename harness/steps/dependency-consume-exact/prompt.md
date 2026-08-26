Consume the exact package versions from the accepted `dependency-publication` evidence produced by
the preceding dependency wait. Never infer a version from prose, a dist-tag, a version range, or a
Loop message. Confirm the evidence belongs to the declared dependency and current run, then update
only the authoritative package manifest and lockfile in the prepared consumer repository.

Run the smallest install operation needed to make the lockfile describe those exact versions. Do
not use local links, `file:` dependencies, workspace mounts, or edits under `node_modules`. Return
the normal source-diff artifact for the complete current workspace mutation; Verify independently
proves behavior in the next block.
