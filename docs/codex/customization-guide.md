# Customizing Tasker

Status: canonical extension guide, Temporal revision, 2026-08-03

Tasker has no reusable workflow templates. Every initial workflow is assembled from an
empty graph for one task. Reuse exists below the graph: versioned blocks, predicates,
waits, prompts, skills, policies, obligations, and adapters.

Temporal is replaceable infrastructure at the execution boundary, not the place where
company workflow knowledge is encoded. Most customization must not touch Temporal
Workflow code.

## 1. Ownership boundaries

| Surface | Target/current location | Change it for |
|---|---|---|
| Workflow IR/compiler/validator | `src/workflow/` | generic graph syntax, hashes, ABI, deterministic invariants |
| Temporal interpreter | `src/temporal/workflows/` | genuinely new generic control-flow semantics only |
| Block catalog | `harness/steps/*.json` plus the small built-in catalog | versioned task capabilities and Activity bindings |
| Activities/executors | `src/temporal/activities/` | provider, process, or integration execution |
| Agent prompts | `harness/prompts/` | readable analyzer/planner/step instructions |
| Company policy | `harness/company.json` | reusable organization-wide workflow facts |
| Project workflow policy | `harness/projects/*/project.json` | repository-specific translation/test/publication facts |
| Project guidance | `harness/projects/*/workflow.md` | short human-readable workflow context, never effect authority |
| Mandatory obligations | `src/planning/obligations.ts` | safety/semantic rules an analyzer cannot waive |
| Integrations/repositories | `src/integrations/`, `src/repositories/` | Jira/Bitbucket/Jenkins today, alternatives later |
| Operator UI/API | `src/control-plane/` and UI modules | presentation and operator commands |

The compiler and Temporal Workflow know none of Twiket, Jira, Bitbucket, Jenkins,
translations, or `@ott`. Vendor payloads terminate at adapters. Company policy affects
analyzer input and block availability, not interpreter code.

## 2. Assembly versus execution

```text
task + linked context + bounded repository evidence
      + company/project policy + block catalog + obligations
                         |
                         v
              analyzer proposes complete graph
                         |
                         v
       parse -> ABI/effect/capability/semantic validation
                         |
                  accepted graph hash
                         |
                         v
     generic Temporal Workflow interprets the graph
                         |
                         v
       registered Activities execute individual blocks
```

The analyzer chooses relevant blocks and order. The validator decides whether the
proposal is safe and complete. The interpreter records progress. Activities perform
I/O. Keeping these roles separate is what lets a new company or process replace one
layer without rewriting the application.

## 3. Add a workflow block

A block has a stable reference such as `test_ops.fill_plan@1` and exactly one execution
kind:

- `agent`: invokes a provider with a versioned prompt and logical skills;
- `process`: invokes a registered policy-owned command/process adapter;
- `integration`: invokes a typed adapter with external-effect reconciliation.

Waits and gates are graph nodes/messages, not fake executors.

To add `fill-test-ops-plan`:

1. add a versioned `harness/steps/*.json` manifest (use code only when introducing a
   genuinely new runtime input/output contract);
2. define Zod input/output schemas;
3. declare capabilities, effects, artifacts, timeout, heartbeat, retry, cancellation,
   idempotency/reconciliation, and allowed outcomes;
4. add/reuse a readable prompt for an agent block, or bind a registered
   process/integration Activity;
5. expose the block to the relevant company/project policy;
6. add a public test proving a task graph can contain it and invalid use is rejected;
7. add an Activity contract test for execution/recovery;
8. rebuild the worker/application.

This must not require changes to the generic interpreter, task queue, Temporal Client,
operator layout, or another block. If it does, first prove that the behavior is a new
generic control-flow concept rather than an ordinary task step.

For a `process` block, add its executor key and command to the relevant versioned
`processCommands` map in company or project policy. The analyzer sees the available
block; execution uses the command captured in that run's immutable snapshot. Do not add
step-name branching to an Activity.

### Block outcome contract

Every executing block returns one typed result:

- `completed` with small structured output and artifact references;
- `retryable` with a classified reason/evidence;
- `question` with the exact human decision needed;
- `blocked` with a resumable external/infrastructure condition;
- `workflow_change_required` with discovery evidence and proposed intent;
- `failed` with a non-retryable diagnostic reference.

Arbitrary natural-language text cannot secretly alter the graph or grant effects.

## 4. Prompts and skills

Prompts remain ordinary Markdown so the operator can inspect and change them. Each
planning/execution Activity receives an immutable snapshot reference and content hash.
A file edit affects future attempts/runs according to explicit run policy; it never
rewrites a completed Activity result or accepted history.

Logical skill names are provider-neutral. An adapter maps the same portable package to
Codex, Claude, or another subscription CLI discovery surface. The graph must not
contain provider-specific command syntax.

The built-in workspace pack stores one portable Agent Skills package per logical name.
Bootstrap creates an effective pinned catalog under `.tasker/harness/skills`; it does
not expose that whole catalog to an agent. At Activity start, the provider adapter
materializes only the names captured in the immutable step snapshot:

- Codex: `<isolated CODEX_HOME>/skills/<name>`;
- Claude: `<temporary directory>/.claude/skills/<name>` with `--add-dir`.

Supporting scripts and assets travel with the package. `TASKER_SKILLS_ROOT` points to
the selected provider view, so a skill must never depend on a hard-coded `.codex` or
`.claude` path. Repository profile skills are the exception to step scope: they are
ambient implementation guidance and are installed for both providers in the managed
worktree. A missing step skill fails closed before provider invocation.

Repository-specific operational skills belong in the profile's `step-skills`, not its
ambient `skills`. This keeps instructions such as localization conventions always
available while a review/publish/tracker skill remains invisible until a registered
block explicitly selects it.

A package that invokes another package declares logical names in `dependencies.json`.
The provider adapter resolves that transitive set before either CLI starts. Dependencies
do not grant graph effects: selecting a legacy macro such as `pr-finalize` is still
invalid as a replacement for typed PR/Jira integration blocks.

Keep three scopes distinct:

- **repository guidance** is present for every agent working in that repository
  (`localization`, state/data conventions, UI-kit rules);
- **step skills** are selected by one immutable agent-step binding (`playwright-demo` for
  reproduction/visual verification, CI readers for CI analysis);
- **integration effects** are performed only by typed Activities (`pr.prepare@1`, Jira
  mutation, publication), never by a catch-all skill.

The old `pr-finalize` skill is therefore migration input, not the Tasker execution model:
it combines several remote effects and approval points which Temporal must persist and
reconcile separately. Conversely, `playwright-demo` is a valid reusable skill but does
not itself make visual verification part of every graph.

Use prompts for judgment and implementation guidance. Use deterministic obligations
for requirements that must always hold, such as CI before PR review or before/after
reproduction for a bug.

## 5. Project policy

Project policy describes workflow peculiarities, not source architecture. Good facts:

- translations are inline JSON, or require extract -> external translation wait -> pull;
- changed CSS/visual surfaces require screenshot verification;
- changes in a specific package require build A and tests B/C;
- final publication is human-owned;
- a repository consumes packages from another repository;
- permitted dev-publish and remote-effect capabilities.

FSD, reducer patterns, React conventions, and implementation style belong in repository
instructions or skills. They guide an agent Activity but do not create graph nodes or
grant permissions.

Unknown projects receive conservative defaults. Tasker never guesses an external
translation/publish process from a repository name alone.

## 6. Company-global policy

Use global policy for reusable workflow knowledge, for example:

- frontend `@ott` packages live in a known repository family;
- dev publish may be automatic while final publish is human-only;
- every PR observes Jenkins and human Bitbucket review;
- provider/concurrency quotas;
- default effect restrictions and retrospective thresholds.

Do not encode a full graph in company policy. It contributes facts, block availability,
and obligations; the task analyzer still assembles the graph specifically for the task.

For example, the company-wide `ai-assistance` requirement is the file-backed
`harness/policies/ai-assistance.json` pack, not kernel behavior. It exposes blocks such
as:

- `ai.assistance.initialize@1` to create the task README;
- `ai.assistance.record_plan@1` to persist the accepted plan before implementation;
- `ai.assistance.finalize@1` to write result/verification evidence and the PR section;
- `ai.assistance.validate@1` as the deterministic pre-PR gate.

When the policy is enabled, the analyzer selects those ordinary blocks and the
validator enforces its exact per-path sequence. Step manifests additionally declare
`artifactContracts` and `requiredArtifactContracts`, so a consumer cannot precede its
producer. A policy-owned step declares its policy ID in the manifest; disabled-policy
steps are removed from the analyzer catalog. Disabling the policy and restarting Tasker
makes future task graphs omit its blocks; snapshotted running graphs remain unchanged. The generic `pr.describe@1` and
`pr.prepare@1` blocks do not require AI policy artifacts. No Temporal Workflow, API
route, or Bitbucket adapter changes when this policy is removed.

The current file-backed manifest vocabulary deliberately reuses named runtime schemas
(`task_input`, `pull_request_input`, `agent_output`, and so on). Add a schema name in
TypeScript only when the data shape is new; adding another prompt, skill selection,
adapter binding, effect declaration, retry budget, or artifact dependency is JSON-only.

## 7. Worktree harness bootstrap

Tasker must not call the personal `/Users/dzhabrail/Projects/harness/work/bootstrap` or
create nested `work` overlays. That command discovers and mutates every worktree under
`~/Projects/work`; Tasker owns a different managed clone.

The built-in pack lives in `harness/workspace`. It contains portable integration/shared
skills and repository profiles imported from the personal harness, but excludes its
symlink machinery and secrets. `manifest.json` maps repository aliases to profiles, so
adding another repository does not require an application-code branch.

The repository Activity:

1. allocates a managed task worktree under Tasker's application-data path;
2. pins the current workspace-pack content hash in application data;
3. materializes the resolved profile into that exact worktree;
4. persists profile/version/receipt and resulting instruction/skill hashes;
5. reconciles the receipt on Activity retry;
6. keeps the same worktree across questions, waits, worker restarts, and plan revisions.

The built-in adapter is the default. `TASKER_WORKSPACE_HARNESS_PATH` can select another
pack and `TASKER_HARNESS_SNAPSHOT_STORE` can relocate immutable snapshots. A company can
replace the adapter entirely with a target-aware command: Tasker invokes
`<command> inspect` or `<command> apply` in the managed worktree and sends a versioned
JSON request on stdin containing `operationId` and the complete workspace locator. It
must return JSON with either `{ "status": "absent" }` or
`{ "status": "ready", "receipt": ... }`. `apply` must return `ready`; `inspect`
must discover an already-applied result so a lost process response does not duplicate
bootstrap effects. Configure that optional executable with
`TASKER_WORKSPACE_BOOTSTRAP_COMMAND`.

Replacing the bootstrap tool changes one Activity adapter. It does not change the graph
interpreter or workflow history model.

There is no normal-path worktree script to remember to run. The Temporal repository
Activity owns setup and reconciliation. The old `harness-wt-hook` was intentionally not
imported because it scans and mutates `~/Projects/work`, while Tasker operates only on
its managed application-data clone. A standalone adapter command remains optional for a
future company-specific setup implementation.

## 8. Add or replace an integration

An integration adapter has read and mutation surfaces. Read-only intake normalizes
vendor data. Mutation Activities additionally implement prepare/execute/reconcile and
stable operation IDs.

Choose Activity delivery from evidence, not convenience:

- use `single_attempt` when the effect has no safe remote proof yet;
- use `remote_reconciled` only when the adapter persists intent, probes the exact remote
  identity before writing, reconciles ambiguous responses, records an applied receipt,
  and returns `unknown_outcome` instead of blindly repeating.

The generic external-effect journal is reusable, but reconciliation remains
effect-specific. A Git ref, Jira comment, package version, and PR thread have different
proof surfaces; do not hide them behind a generic “exactly once” claim.

Moving to GitLab Issues and GitLab CI should require:

1. a tracker adapter that produces the normalized task snapshot;
2. SCM/CI adapters bound to existing integration block contracts or new versioned
   blocks where behavior truly differs;
3. company/project policy and prompts;
4. mapping remote events to the existing typed Signal/Update contracts;
5. adapter and effect crash-matrix tests.

It should not require changing the Temporal interpreter, Workflow messaging model,
generic IR, plan/question semantics, or retrospective model. If `JiraIssue` or a
Bitbucket response shape appears in Workflow input, the boundary is broken.

## 9. Add another agent provider

Implement the provider Activity binding:

- capability discovery and subscription authentication;
- non-interactive invocation and structured output;
- streaming/transcript capture;
- timeout, heartbeat, cancellation, and session-resume hint;
- usage measurement and shadow cost evidence;
- mapping of logical skills/tools;
- error classification.

Provider session resumption is an optimization. Temporal Activity/workflow state plus
Tasker artifacts are the durable recovery source. A provider that cannot resume starts
a new attempt with bounded persisted context.

Codex is the currently selected worker runner. Claude is already a first-class provider
layout for every workspace skill package; wiring its stream parser, usage receipt, and
tool policy is a provider-Activity addition, not a skill migration or workflow change.

## 10. Late discoveries

Reproduction or implementation may discover a shared component, translation process,
or additional verification requirement. The Activity returns
`workflow_change_required`; it does not edit Workflow state itself.

Tasker asks the analyzer for a validated continuation and starts the accepted graph as
a Child Workflow. The parent keeps its completed prefix immutable and waits on a typed
join. A different repository may additionally require its own managed worktree and
publication lifecycle, but does not change this control-flow rule.

During the pilot every revision is reviewable. Later known low-risk classes may be
auto-accepted by policy, but deterministic validation never becomes optional.

## 11. When interpreter changes are justified

Change the generic interpreter only for a new domain-independent control-flow semantic,
for example a formally specified parallel join mode that cannot be represented by
existing sequence/branch/loop/wait/child concepts.

Do not change it to add:

- a Jira field;
- another prompt or skill;
- a build command;
- translation policy;
- a provider;
- a repository family;
- a CI classifier;
- a new agent task such as filling TestOps.

Those are blocks, policies, adapters, or obligations.

## 12. Extension checklist

Before accepting customization:

- is it a block/policy/adapter/obligation instead of a hidden workflow template?
- is every untyped boundary validated?
- are effects, idempotency, reconciliation, retries, timeouts, and cancellation explicit?
- can the operator read the prompt and see why the graph contains the block?
- does Temporal history stay small and secret-free?
- does recovery resume the failed boundary without discarding earlier work?
- does the change affect only future immutable snapshots/attempts?
- can another company replace vendor adapters/config without interpreter changes?
- did tests cover worker failure and duplicate external delivery where relevant?
