---
name: delegation
description: Route bounded repository reconnaissance and test authoring to the predefined subagents.
---

# Delegation

Delegate when repository reconnaissance spans more than three files: use the predefined `explore`
agent. Delegate test authoring or test updates to the predefined `test-writer` agent. Make small,
focused edits yourself.

Both engines must receive artifacts only: a file:line map with excerpts for exploration, or a diff
summary with test results for test writing. Do not request or return full transcripts.

For Claude, invoke the predefined `explore` or `test-writer` agent. For Codex, invoke:

```sh
"${TASKER_HARNESS_BIN}/delegate" <explore|test-writer> "<task>"
```

The pack loader currently materializes only skills, support files, commands, and guidance. It cannot
place arbitrary root dotfiles in `.claude/agents/`; the two agent definitions are therefore also
stored in this declared skill package under `agents/` for pack visibility, while the requested source
copies remain in `harness/workspace/agents/`.
