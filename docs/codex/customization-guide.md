# Customizing Tasker

Status: canonical extension guide, Block Contract v3 revision, 2026-08-10

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
             append-only Evidence Bundle
                         |
                         v
       mandatory planner + selected read-only skills
                         |
       questions / selected investigation blocks
                         |
                         v
        appended investigation evidence, then re-plan
                         |
                         v
          implementation plan + workflow candidate
                         |
                         v
             compile -> validate -> optional review
                         |
                 frozen graph hash
                         |
                         v
     generic Temporal Workflow interprets the graph
                         |
                         v
       registered Activities execute individual blocks
```

Context discovery gathers a bounded starting evidence set without creating a graph.
The mandatory planner decides whether it needs a blocking answer, a registered
investigation block, or can return the plan and first complete workflow candidate. The
validator decides whether each candidate is safe and complete. The interpreter sees only
the frozen graph and records execution progress. Activities perform I/O. Keeping these
roles separate is what lets a new company or process replace one layer without rewriting
the application. See
[`planning-lifecycle.md`](planning-lifecycle.md) for the complete lifecycle.

## 3. Add a workflow block

A block has a stable reference such as `test_ops.fill_plan@1` and exactly one execution
kind:

- `agent`: invokes a provider with a versioned prompt and logical skills;
- `process`: invokes a registered policy-owned command/process adapter;
- `integration` in the file manifest, materialized as an `effect` executor in the
  immutable Block Definition: invokes a typed adapter with external-effect
  reconciliation.

Waits and gates are graph nodes/messages, not fake executors.

To add `fill-test-ops-plan`:

1. add a `schemaVersion: 2` manifest under `harness/steps/*.json` with a stable
   reference, macro stage, allowed outcomes, completion evaluator, and executor profile
   or adapter (use code only when introducing a genuinely new input/output contract);
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

Project validation is a concrete example. `validate.targeted@1`, `validate.full@1`,
`validate.build@1`, and `validate.visual@1` are reusable process contracts. Each project binds
only the supported executor keys to exact commands in its `processCommands` map. The planner
selects a registered block; it never emits shell. A non-zero command exit remains a completed,
receipted diagnostic result so the frozen graph can decide whether to run `code.repair@1`.

### Block completion contract

An agent block returns a typed claim:

- `candidate_complete` with small structured output and evidence references;
- `needs_input` with the exact human decision needed;
- `blocked` with a resumable external/infrastructure condition;
- `continuation_required` with discovery evidence and a proposed continuation request;
- `failed` with a non-retryable diagnostic reference.

The block runner, not the agent, decides completion. It resolves evidence independently,
executes the registered completion evaluator, reconciles external effects, and persists
an immutable Block Receipt before returning a `BlockOutcome` to Temporal. An identical
Activity redelivery restores the exact receipt; a conflicting redelivery fails closed.
Process and integration blocks use the same receipt boundary without pretending that an
agent performed their deterministic checks or writes.

When a block result controls a branch or loop, declare `outputPredicates` on the block contract.
The mapping selects a discriminator from schema-validated output and maps exact cases to
registered boolean predicate references. Optional `defaultFacts` handles results such as any
non-zero process exit. Tasker derives and persists these facts only after accepting completion
evidence. Do not add a generic success predicate and do not accept a predicate map from an agent.

For example, declared validation maps exit code `0` to `validation.passed@1=true` and any other
exit to `validation.failed@1=true`. Independent review maps its typed `decision` to either
`agent_review.accepted@1` or `agent_review.changes_requested@1`. Both blocks can therefore drive
bounded repair loops without teaching the Temporal interpreter their names.

Arbitrary natural-language text cannot secretly alter the graph or grant effects.

## 4. Prompts and skills

Prompts remain ordinary Markdown so the operator can inspect and change them. Each
planning/execution Activity receives an immutable snapshot reference and content hash.
A file edit affects future attempts/runs according to explicit run policy; it never
rewrites a completed Activity result or accepted history.

Logical skill names are provider-neutral. An adapter maps the same portable package to
Codex, Claude, or another subscription CLI discovery surface. The graph must not
contain provider-specific command syntax.

The mandatory planner has its own pinned read-only skill selection, snapshotted as
first-class Bootstrap Workflow configuration. Removing a skill from an execution block
must not accidentally remove the planner's ability to verify the draft. External
planner reads must pass through the evidence boundary and append provenance rather than
existing only in provider output.

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
for requirements that must always hold, such as validation after a write or CI before
human PR review. Whether a bug needs visual, automated, or manual reproduction is
selected from task/project evidence rather than a universal before/after recipe.

Policy `path_sequence` obligations accept `direction: "before"` and
`direction: "after"`. Use `before` for prerequisites such as evidence required before
PR publication. Use `after` for continuations such as revision -> PR update -> CI ->
thread acknowledgement -> review. This validates a dynamically assembled graph without
turning the sequence into a Temporal branch.

A policy may declare `appliesTo.taskOrigins` and task-evidence selectors, so Jira-only
blocks are absent from local fixtures or a future GitLab Issue analyzer context, while
bug investigation blocks are absent when task evidence does not require them. A marker with `kind: "effect"`
matches any registered step declaring that effect. The Jira admission policy therefore
protects new `workspace.write` and `command.run` blocks without listing every step name.
Use a step marker when exact ordering matters; use an effect marker for a capability
boundary that future blocks must not bypass. A step marker may include a partial
`with` object when one block has distinct semantic modes. The deterministic validator
uses the same selector as assembly, so a policy cannot claim a requirement the
generated graph interprets differently.

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

`jira-lifecycle.reviewReady.commentPrefix` is also the stable identity of Tasker's one
managed PR comment on an issue. Future runs update the matching comment. Changing the
prefix intentionally starts a new identity; migrate existing Jira comments first or
Tasker will not claim them. Multiple comments with the active prefix fail closed and
must be resolved explicitly.

For example, the company-wide `ai-assistance` requirement is the file-backed
`harness/policies/ai-assistance.json` pack, not kernel behavior. Its `agentSkills`
bindings add the logical `ai-assistance` skill to write-capable implementation,
repair/revision, and PR-description agents. Initial artifact materialization,
plan/result/verification maintenance, and the PR section happen inside those existing
agent invocations; they are not standalone workflow bookkeeping blocks.

When the policy is enabled, its bindings are included in future immutable harness
snapshots. Disabling it and restarting Tasker removes the skill from future runs;
snapshotted running work remains unchanged. A policy may still declare path obligations
or policy-owned blocks when it represents an independently recoverable external effect
or human wait. Do not use either merely to display an internal checklist item. The
generic `pr.prepare@1` integration remains unaware of AI policy. No Temporal Workflow,
API route, or Bitbucket adapter changes when this policy is removed.

The current file-backed manifest vocabulary deliberately reuses named runtime schemas
(`task_input`, `pull_request_input`, `agent_output`, and so on). Add a schema name in
TypeScript only when the data shape is new; adding another prompt, skill selection,
adapter binding, effect declaration, semantic loop policy, or artifact dependency is JSON-only.

## 7. Worktree harness bootstrap

Tasker must not call the personal `/Users/dzhabrail/Projects/harness/work/bootstrap` or
create nested `work` overlays. That command discovers and mutates every worktree under
`~/Projects/work`; Tasker owns a different managed clone.

The built-in pack lives in `harness/workspace`. It contains portable integration/shared
skills and repository profiles imported from the personal harness, but excludes its
symlink machinery and secrets. `manifest.json` maps repository aliases to profiles, so
adding another repository does not require an application-code branch.

The repository preparation Activity:

1. allocates a managed task worktree under Tasker's application-data path;
2. pins the current workspace-pack content hash in application data;
3. materializes the resolved profile into that exact worktree;
4. persists profile/version/receipt and resulting instruction/skill hashes;
5. resolves and pins `workspaceRuntime` from company plus project manifests;
6. prepares Docker image, caches, bootstrap commands, and declared services;
7. reconciles both receipts on Activity retry;
8. keeps the same worktree and runtime state across questions, waits, worker restarts,
   and plan revisions.

`TASKER_WORKSPACE_HARNESS_PATH` can select another portable pack and
`TASKER_HARNESS_SNAPSHOT_STORE` can relocate immutable snapshots. There is no external
host bootstrap command: project executable setup belongs to the Docker runtime policy,
so it cannot accidentally mutate `~/Projects/work` or inherit laptop PATH state.

There is no normal-path worktree script to remember to run. The Temporal repository
Activity owns setup and reconciliation. The old `harness-wt-hook` was intentionally not
imported because it scans and mutates `~/Projects/work`, while Tasker operates only on
its managed application-data clone. Add future company setup as data under
`workspaceRuntime.bootstrap` or as a versioned image change, not as a host-side hook.

### 7.1 Docker runtime policy

`harness/company.json` declares the default prebuilt image, environment and cache
volumes. `harness/projects/*/project.json` may extend bootstrap commands and services.
The resolved policy is pinned on first preparation, so editing it affects future runs
without changing or destabilizing an active run. See
[`docker-execution.md`](docker-execution.md) for the manifest behavior and recovery
model.

## 8. Add or replace an integration

An integration adapter has read and mutation surfaces. Read-only intake normalizes
vendor data. Mutation Activities additionally implement prepare/execute/reconcile and
stable operation IDs.

Choose Activity delivery from evidence, not convenience:

- use `single_attempt` when the effect has no safe remote proof yet;
- use `read_only` only for a side-effect-free observation that Temporal can safely
  repeat after Worker failure;
- use `remote_reconciled` only when the adapter persists intent, probes the exact remote
  identity before writing, reconciles ambiguous responses, records an applied receipt,
  and returns `unknown_outcome` instead of blindly repeating.

The generic external-effect journal is reusable, but reconciliation remains
effect-specific. A Git ref, Jira comment, package version, and PR thread have different
proof surfaces; do not hide them behind a generic “exactly once” claim.

Human waits may expose a provider-neutral `resolutionMapping` that turns a small typed
decision into predicate facts. Graphs can branch or loop on those facts without adding
vendor logic to Temporal. A bounded loop that cannot safely fail may declare an
`exhaustedWait`; after its attempt budget, Tasker asks the operator for guidance and
passes that text to the first step of the next cycle. Add these semantics only to the
workflow contract/catalog. Bitbucket parsing and reply APIs stay in the adapter, while
the actual revision instructions stay in an editable file-backed step prompt.

For Jenkins, project manifests configure only the replaceable provider mapping:

```json
{ "ci": { "kind": "jenkins", "job": "front-avia" } }
```

`ci.observe@1` remains a normal file-backed graph block. Moving to GitLab CI means
binding the same contract to another read adapter and changing project/company policy;
it does not require a Temporal Workflow branch.

CI control flow is assembled from provider-neutral facts and blocks. The observation contract
must map every terminal result to all registered CI predicates so a later observation replaces,
rather than leaks, the previous verdict. `ci.repair@1` is an editable agent block and prompt;
flaky, infrastructure, and unknown outcomes are durable wait contracts. The graph compiler accepts
provider-specific adapters but the obligation validator requires a `ci.passed@1` proof after
observation and before human review. A provider-specific retry mutation needs its own reconciled
effect block; it must not be added to the read-only observer.

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

The current Jira write adapter is opt-in with `TASKER_ENABLE_JIRA_EFFECTS=true`. Its
account, eligible issue types, excluded labels, admission/review status paths, and
compact review comment prefix live in
`harness/policies/jira-lifecycle.json`; changing those rules does not change adapter or
Temporal code. Optional final-demo upload is a delivery policy, not part of Jira
admission and not a required reproduction block. Tasker's private before evidence
remains in its artifact store. Keep any remote-media policy off until a selected pilot
task and its transition requirements have been inspected.

Required transition fields are not duplicated in Tasker configuration. Jira remains
their source of truth: before `jira.start-work@1` or `jira.review-ready@1` mutates an
issue, the adapter reads the selected transition metadata and current issue values. If
a required value such as Development estimate is absent, the run names the exact Jira
field and waits. Fill it in Jira and press Resume; Tasker re-runs only that block and
preserves the already completed workflow prefix. It does not guess or write business
estimates on the operator's behalf.

## 9. Configure provider and model selection

Execution profiles live in `harness/company.json`. A profile is a complete executable
choice, not a loose model alias. Codex profiles declare `provider`, `command`, `model`,
`effort`, `timeoutMs`, and `serviceTier`; Claude profiles declare the same fields except
the Codex-specific service tier. `executionProfileRouting` selects profiles for workflow
analysis and both implementation-planning strategies.

Agent step manifests reference logical profiles such as `investigation`,
`implementation`, `verification`, `documentation`, or `review`. To use Claude for deep
planning without changing a prompt, block, or Temporal module, register a Claude profile
and point `executionProfileRouting.implementationPlanner.ralplan` at it. To change only
one repository, set `executionProfileOverrides` in that project's manifest:

```json
{
  "executionProfileOverrides": {
    "implementationPlanner": { "ralplan": "claude-ralplan" },
    "agents": { "review": "claude-review" }
  }
}
```

Resolution order is explicit run override, project redirect, then company route or the
logical profile named by a step. Every referenced profile is validated when the harness
pack loads. Removing or misspelling one is a configuration error; there is no default
model and no compatibility mapping. A run records the resolved profile rather than
re-reading configuration during retry or resume.

## 10. Add another agent provider

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

Codex and Claude are current first-class subscription-CLI adapters for analysis,
planning, and agent steps. Adding another provider means implementing this same adapter
contract and registering profiles. It is not a skill migration or workflow change.

## 11. Late discoveries

Reproduction or implementation may discover a shared component, translation process,
or additional verification requirement. The Activity returns
`workflow_change_required`; it does not edit Workflow state itself.

Tasker asks the analyzer for a validated continuation and starts the accepted graph as
a Child Workflow. The parent keeps its completed prefix immutable and waits on a typed
join. A different repository may additionally require its own managed worktree and
publication lifecycle, but does not change this control-flow rule.

During the pilot every revision is reviewable. Later known low-risk classes may be
auto-accepted by policy, but deterministic validation never becomes optional.

## 12. When interpreter changes are justified

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

## 13. Extension checklist

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
