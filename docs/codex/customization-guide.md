# Customizing Tasker without changing the kernel

Status: canonical extension guide, 2026-08-03

Tasker has no reusable workflow templates. Every initial workflow and every linked
continuation is assembled for one task from an empty graph. Reuse happens below the
graph level: versioned node kinds, steps, predicates, waits, policies, prompts, skills,
and deterministic obligations.

## Ownership boundaries

| Surface | Current location | What changes here |
|---|---|---|
| Workflow domain and compiler | `src/workflow/` | Generic IR parsing, canonicalization, hashes, terminal-path and ABI validation |
| Company step catalog | `src/harness/step-definitions.ts` | Typed input/output contracts, effects, capabilities, retries, artifacts, and executor binding |
| Agent prompts | `harness/prompts/` | Readable task analyzer, implementation planner, and agent-step instructions |
| Company policy | `harness/company.json` | Capabilities and reusable package/process rules |
| Project workflow policy | `harness/projects/*/project.json` | Repository-specific translation and validation facts |
| Project guidance | `harness/projects/*/workflow.md` | Short human-readable workflow context; never effect authority |
| Mandatory graph obligations | `src/planning/obligations.ts` | Deterministic semantic checks that an analyzer cannot waive |
| Task/integration adapters | `src/integrations/`, `src/repositories/` | Jira/Bitbucket/Jenkins today; another tracker or SCM later |

The compiler knows none of Twiket, Jira, translations, Bitbucket, Jenkins, or `@ott`.
It accepts registered contracts and an untrusted workflow source. Company behavior is
outside that kernel.

## How a workflow is assembled

```text
task snapshot + linked context + read-only repository evidence
                  +
company/project policy + building-block catalog + obligations
                  |
                  v
       analyzer emits complete WorkflowSource JSON
                  |
                  v
      parse -> ABI/effect/capability validation
            -> semantic obligation validation
                  |
          rejected or immutable graph
```

The analyzer is free to omit irrelevant blocks and add relevant registered blocks. It
is not free to violate invariants. Examples currently checked deterministically:

- every task starts with analysis and the plan boundary;
- a write-capable path contains later verification and PR preparation;
- a PR path contains later CI observation and code review;
- a bug contains `bug.reproduce@1` for both `phase=before` and `phase=after`.

The compiler never silently adds a missing CI, reproduction, verification, or review
node. A bad proposal is visible and can be regenerated; changing it behind the
analyzer would make provenance and debugging dishonest.

## Step definitions and execution bindings

A step definition combines a stable workflow contract with exactly one execution kind:

- `agent`: prompt plus logical skills; a provider adapter executes it;
- `process`: a registered local process executor that resolves a policy-owned command;
  arbitrary shell text never enters workflow IR;
- `integration`: a prepare/execute/reconcile adapter such as Bitbucket or Jenkins.

`wait` and `gate` are workflow nodes, not pretend executors. There is intentionally no
vague `system` execution kind.

Input and output are real Zod schemas in the TypeScript registration. JSON such as
`inputKind: "task"` is insufficient: it loses field-level validation and cannot make
executor output safe for later nodes.

### Add `fill-test-ops-plan`

The current example is registered as `fill-test-ops-plan@1` in
`src/harness/step-definitions.ts` and reads
`harness/prompts/steps/fill-test-ops-plan.md`.

Adding another company step requires:

1. add one typed definition with a new versioned reference;
2. choose `agent`, `process`, or `integration` explicitly;
3. declare input/output schemas, effects, capabilities, retry/reconciliation behavior,
   artifacts, and allowed workflow-change outcomes;
4. add or reuse a readable prompt for an agent binding;
5. add a public behavior test that compiles a graph containing the new step;
6. rebuild Tasker.

It must not require a compiler, scheduler, ledger, API, or cockpit rewrite. If it does,
the new behavior is probably a new workflow-domain concept rather than a step.

## Project policy

Project policy describes workflow peculiarities, not code architecture. Appropriate
facts include:

- translations are inline JSON or an external extract/wait/pull process;
- which validation commands apply to which changed surface;
- a human owns final publication;
- repository/package relationships and permitted effects.

FSD rules, reducers, styling conventions, and implementation advice belong in skills
or repository instructions. They may guide an agent step but cannot grant an effect or
create a graph node.

Unknown projects receive conservative defaults. An external translation wait or
package publish must never be guessed from a similarly named repository.

## Prompts and skills

Prompts remain normal Markdown so the operator can read and edit them. The loader
records content hashes; a run snapshot must retain the exact prompt/skill/policy
versions it used. An edit affects future planning or attempts, never an already
persisted graph.

Logical skill names are provider-neutral. A provider adapter maps them to the provider's
actual mechanism (Codex skills, Claude instructions, or another subscription CLI).
Provider-specific syntax must not leak into the graph contract.

## Worktree harness bootstrap

Tasker must not invent `harness/work` and copy it into every project. The existing
developer harness at `/Users/dzhabrail/Projects/harness/work` already owns global,
shared, and project profiles and exposes `work/bootstrap init <profile>`.

When real worktrees are enabled, `WorktreePort` should:

1. allocate the managed task worktree;
2. invoke that external bootstrap/profile adapter;
3. persist its profile, version, receipt, and resulting instruction/skill hashes;
4. retry only bootstrap if it fails;
5. keep the worktree and completed evidence intact.

Tasker stores the receipt and locator, not a duplicate overlay tree. Replacing the
external harness later changes one bootstrap adapter, not the workflow kernel.

## A new company or toolchain

Moving from Twiket to a company that uses GitLab Issues instead of Jira should replace
configuration and adapters, not orchestration semantics:

- add a task-tracker adapter producing the same normalized task snapshot;
- add SCM/CI adapters and bind integration steps to them;
- provide company/project policy and prompts;
- register company step definitions and obligations;
- leave workflow IR, ledger, scheduler, recovery, waits, interventions, and cockpit
  projections intact.

If company names or vendor response shapes appear inside `src/workflow/`, the boundary
has been broken.

## Late discoveries

Initial assembly is intentionally not omniscient. Reproduction or implementation may
discover a shared component, another repository, a translation process, or a different
verification surface. A step returns typed `workflow_change_required`; Tasker preserves
the cursor, worktree, receipts, and evidence, then asks the analyzer for a complete
linked continuation graph. The same compiler and obligations validate it.

Neither the running agent nor the operator edits the accepted graph in place. Operator
guidance creates a new immutable planning attempt. Harness edits still affect only
future attempts/runs.

## Extension checklist

Before accepting a customization:

- is it a building block/policy/adapter rather than a hidden base workflow?
- is every untyped boundary validated?
- are effects, idempotency, reconciliation, and retries explicit?
- can the operator read the prompt and see why the graph contains the step?
- does failure resume from the failed boundary without discarding earlier work?
- does the change affect only future immutable snapshots?
- can another company replace the adapter/config without modifying the kernel?
