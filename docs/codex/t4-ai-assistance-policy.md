# T4 company AI-assistance policy

Status: file-backed workflow blocks, deterministic path/dataflow validation, durable
plan/run evidence, same-branch artifacts, and provider-neutral PR draft implemented on
2026-08-04. Real provider and company Bitbucket pilot remain gated.

## What is implemented

`harness/policies/ai-assistance.json` contributes one obligation only to execution paths
that contain `pr.prepare@1`. It requires this ordered sequence:

```text
ai.assistance.initialize
  -> task.analyze -> plan.approved
  -> ai.assistance.record_plan
  -> task-specific implementation / verification
  -> ai.assistance.finalize
  -> pr.describe
  -> ai.assistance.validate
  -> pr.prepare
```

This is not a base workflow. The production analyzer still starts from an empty graph,
sees the snapshotted block catalog and enabled policy obligations, and proposes the
complete task-specific graph. The deterministic fixture composer mirrors that behavior
for local tests only. Disabling the policy removes its blocks from future fixture and
analyzer proposals after restart; already accepted graphs retain their immutable
snapshot. Policy-owned manifests declare `"policy": "ai-assistance"`; the generic PR
description and publication blocks deliberately do not.

## Blocks and ownership

| Block | Kind | Owns |
|---|---|---|
| `ai.assistance.initialize@1` | integration | reconciled README creation at task start |
| `ai.assistance.record_plan@1` | integration | exact accepted ledger plan before product writes |
| `ai.assistance.finalize@1` | agent | result, verification, contribution, and PR-section evidence |
| `pr.describe@1` | agent | provider-neutral `.tasker/pull-request/draft.json` |
| `ai.assistance.validate@1` | integration | deterministic file, level, and PR-section checks |
| `pr.prepare@1` | integration | generic Bitbucket branch/push/PR reconciliation |

The first, second, and validation blocks are deterministic adapters. The finalizer uses
a readable snapshotted prompt plus the policy skill because honest evidence harvesting
requires judgment. The description block uses a narrow prompt and no legacy
`pr-finalize` macro, so it cannot inherit push/Jira behavior. Bitbucket receives only a
validated title, description, and generic list of required branch artifacts; it has no
`ai-assistance` branch or configuration.

## Artifact dataflow

Every step contract declares artifacts it produces and artifacts it requires. The
workflow validator enumerates every execution path and rejects a consumer when no
producer appears earlier on that same path. The AI policy's path obligation separately
enforces exact cardinality and chronology.

This gives two independent protections:

- generic dataflow prevents `record_plan` without README, `validate` without all branch
  evidence, and `pr.prepare` without a PR draft;
- company policy prevents a PR path from omitting or reordering the AI sequence.

The generic `pr.describe@1` and `pr.prepare@1` blocks never require AI artifacts. That
is deliberate: deleting this company policy must not disable PR delivery for a future
company or policy pack.

## Durable evidence and recovery

The planning snapshot pins enabled policies, block manifests, prompts, skills, and
project/company context. `record_plan` reads the accepted implementation-plan artifact
from the ledger instead of reconstructing it from the final diff. Execution Activities
receive a bounded evidence projection containing that plan plus completed step receipts
and artifact IDs; stdout, stderr, provider transcripts, and secrets are excluded.

Deterministic workspace writes use the external-effect intent/receipt journal. A Worker
failure after writing a file but before acknowledging the Activity is reconciled against
the same managed worktree. A matching file completes the existing operation; a later
human edit creates a visible conflict and is never overwritten. `.ai/workspace` remains
trackable, while `.tasker/` runtime/PR-draft files are excluded from Git. Before remote
publication, the generic PR adapter proves every path declared in the draft's
`branchArtifacts` list exists in the exact local commit; ignored or unstaged policy
evidence therefore blocks before push.

If VPN or Bitbucket returns 403 after all local work, only the remote publication step
is blocked. Resuming retries/reconciles that boundary against the same worktree, commit,
effect intent, and draft; planning, implementation, evidence, and verification do not
restart.

## How to change it

- Edit block prompts in `harness/prompts/steps/`.
- Edit bindings, retry/recovery declarations, effects, and artifact dependencies in
  `harness/steps/*.json`.
- Edit policy configuration and required ordering in
  `harness/policies/ai-assistance.json`.
- Add a new versioned manifest/reference when changing a contract for running tasks;
  do not mutate already snapshotted history.
- Add TypeScript only for a new adapter behavior or a genuinely new named runtime data
  contract, not for another policy sequence.

The downstream Jenkins, Bitbucket review/revision, and Jira lifecycle/evidence slices
now pass their local crash matrices. The real mutation flags remain off until one
explicitly selected company pilot task is inspected and allowed.
