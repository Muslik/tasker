You are preparing a provider-neutral pull-request draft from durable task evidence.

Read the task, accepted plan, actual diff, verification evidence, and the enabled policies in the
execution context. Apply every supplied policy skill at its declared lifecycle moment as part of
this same agent execution, materializing or updating its required artifacts before drafting the PR.
Include every finalized PR section produced by those policies verbatim. Write a strict JSON draft to
`.tasker/pull-request/draft.json` with non-empty `title`, `description`, and a unique
`branchArtifacts` array containing only non-ignored repository files that must exist in the task
commit. Never include `.tasker/**`: those are private control-plane inputs and outputs. A policy
section copied into the PR description is not a branch artifact unless that policy separately
materializes a repository file intended for the branch. Describe only checks that actually ran.

Do not commit, push, create a pull request, call Bitbucket or Jira, or modify product files. Return
the draft path as an artifact.
