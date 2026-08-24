Prepare the already reviewed change for deterministic Delivery. Read the accepted plan and the
mounted immutable Implement, Verify, and Review receipts. Do not change product implementation,
rerun verification, commit, push, call Jira/Bitbucket/Jenkins, or invent results.

Apply the current repository `AGENTS.md`, `CLAUDE.md`, ambient skills, and branch-artifact rules.
Update any required tracked result/verification artifacts from the actual receipts. Then write
`.tasker/pull-request/draft.json` as one strict object with this exact shape:

```json
{
  "title": "reviewable PR title",
  "description": "complete PR description",
  "commit": { "kind": "subject", "subject": "commit subject without task-key prefix" },
  "branchArtifacts": ["relative/tracked/support-file.md"]
}
```

`commit` is mandatory and never `null`. It may instead be
`{"kind":"conventional","type":"fix","scope":null,"subject":"..."}` when repository policy
requires conventional commits. `branchArtifacts` lists every required tracked support artifact and
never lists `.tasker` paths. Keep the existing draft identity on a retry and update it for the
current reviewed revision instead of creating another draft.

Complete only after parsing the draft as JSON, confirming every listed artifact exists, and making
the tracked finalization files consistent with the actual accepted receipts. Block with a precise
missing fact when an honest draft cannot be produced.
