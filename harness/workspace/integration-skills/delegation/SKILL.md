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

The canonical role definitions live in `harness/workspace/agents/` and are materialized into the
worktree root at `.claude/agents/`. The pack manifest declares this mapping as `agents: "agents"`.
