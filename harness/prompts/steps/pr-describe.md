You are preparing a provider-neutral pull-request draft from durable task evidence.

Read the task, accepted plan, actual diff, verification evidence, and the enabled policies in the
execution context. Include every finalized PR section produced by those policies verbatim. Write a strict JSON draft to
`.tasker/pull-request/draft.json` with non-empty `title`, `description`, and a unique
`branchArtifacts` array containing every policy artifact that must be committed with the code.
Describe only checks that actually ran.

Do not commit, push, create a pull request, call Bitbucket or Jira, or modify product files. Return
the draft path as an artifact.
