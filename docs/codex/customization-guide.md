# Customizing Tasker

Status: canonical semantic-workflow cutover guide, 2026-08-24

Tasker has no reusable task-family workflow templates. Every initial semantic workflow
is assembled from an empty source for one task. Reuse exists below that source:
versioned semantic blocks, internal operation protocols, prompts, skills, policies,
obligations, and adapters. Deterministic compilation may lower a selected block to a
larger executable IR, but that IR is not planner-authored or operator-facing work.

Temporal is replaceable infrastructure at the execution boundary, not the place where
company workflow knowledge is encoded. Most customization must not touch Temporal
Workflow code.

## 1. Ownership boundaries

| Surface | Target/current location | Change it for |
|---|---|---|
| Semantic workflow/compiler/validator | `src/workflow/` | semantic source, executable IR lowering, hashes, ABI, deterministic invariants |
| Temporal interpreter | `src/temporal/workflows/` | genuinely new generic control-flow semantics only |
| Semantic block catalog | `harness/steps/<step>/step.json` | versioned task capabilities, internal operation protocols, and Activity bindings |
| Typed block ABI | `src/harness/step-contracts.ts` | runtime validation for named manifest input/output contracts |
| Activities/executors | `src/temporal/activities/` | provider, process, or integration execution |
| Agent prompts | `harness/prompts/` and `harness/steps/*/prompt.md` | global planner/analyzer prompts and colocated step instructions |
| Company policy | `harness/company.json` | reusable organization-wide workflow facts and API price table |
| Project workflow policy | `harness/projects/*/project.json` | repository-specific runtime, Git, CI, translation, and validation facts |
| Workspace guidance | `harness/workspace/profiles/*/guidance` | pinned `.ai`, `AGENTS.md`, and `CLAUDE.md` rules for agent work |
| Mandatory obligations | `src/planning/obligations.ts` | safety/semantic rules an analyzer cannot waive |
| Integrations/repositories | `src/integrations/`, `src/repositories/` | Jira/Bitbucket/Jenkins today, alternatives later |
| Operator UI/API | `src/control-plane/` and UI modules | presentation and operator commands |

The compiler and Temporal Workflow know none of Twiket, Jira, Bitbucket, Jenkins,
translations, or `@ott`. Vendor payloads terminate at adapters. Company policy affects
analyzer input and block availability, not interpreter code.

### 1.1 Concrete harness map

The editable source pack is [`harness/`](../../harness). Its current ownership is:

| Path | Authority |
|---|---|
| [`company.json`](../../harness/company.json) | company capabilities, Docker runtime, provider/model profiles, API price table, planner routing, global process and package rules |
| [`projects/*/project.json`](../../harness/projects) | repository-specific bootstrap, services, Git policy, CI kind, translation mode, and typed validation processes |
| [`policies/*.json`](../../harness/policies) | optional company overlays, required graph ordering, and skills added to existing agent blocks |
| [`steps/*/step.json`](../../harness/steps) | complete block catalog: stage, executor, skills, completion, effects, artifacts, and recovery boundary |
| [`steps/*/prompt.md`](../../harness/steps) | readable instruction colocated with each agent block |
| [`prompts/implementation-planner.md`](../../harness/prompts/implementation-planner.md) | mandatory initial planner and workflow-composer instructions |
| [`prompts/workflow-analyzer.md`](../../harness/prompts/workflow-analyzer.md) | continuation-workflow analyzer instructions |
| [`workspace/manifest.json`](../../harness/workspace/manifest.json) | scoped skill sources, project step bindings, profiles, and pinned guidance |
| [`workspace/shared-skills`](../../harness/workspace/shared-skills) | reusable logical agent skills |
| [`workspace/integration-skills`](../../harness/workspace/integration-skills) | read/write system skills available for explicit planner or step selection |
| [`workspace/profiles`](../../harness/workspace/profiles) | repository-specific skill packages and pinned guidance files |

`loadHarnessPack` in
[`src/harness/loader.ts`](../../src/harness/loader.ts) validates these files, loads prompt
content and hashes, resolves enabled policies, applies project configuration, and produces one
  immutable catalog. The exact semantic catalog exposed to the planner is assembled by
[`src/planning/analyzer-context.ts`](../../src/planning/analyzer-context.ts):

- policy-owned blocks are absent when their policy does not apply to the task origin;
- process blocks are absent when neither company nor project policy binds their executor to a
  command;
- each remaining block includes its description, stage, input/output contract, effects,
  capabilities, artifacts, completion evaluator, execution profile, prompt path/hash,
  logical skills, and internal operation protocol;
- the planner selects only from this catalog and semantic sequence/loop/step primitives.
  It cannot invent a step, prompt, model, effect, shell command, or recovery tree.

`harness/steps/<step>/step.json` is the only production block catalog. Agent prompts are local
paths inside the same atomic step package. There is no built-in fallback in TypeScript: removing
a step directory removes that capability from future run snapshots. Named Zod schemas in
[`src/harness/step-contracts.ts`](../../src/harness/step-contracts.ts) are the typed ABI used to
reject invalid runtime input and output; they do not register steps. Wait contracts live in
[`src/harness/wait-contracts.ts`](../../src/harness/wait-contracts.ts); predicate contracts are
derived from loaded step manifests. Test builders and invalid test blocks stay under `test/`
and cannot enter the production catalog or operator queue.

### 1.2 What an agent actually receives

There is no ambient access to the whole harness:

1. The mandatory planner receives its own system prompt, the frozen task/Evidence Bundle,
   repository and company/project policy, the filtered block catalog, global/project ambient
   skills, and the read-only skills listed by `company.systemPrompts.implementationPlannerSkills`.
2. A selected agent block receives the full snapshotted step prompt, typed step input, current
   run evidence, operator guidance when resuming, the resolved provider/model profile, and only
   global/project ambient skills plus that block's base, project-step, and policy bindings.
3. A Verify block receives exact process/runtime operations already bound by
   company/project policy. Each operation has its own receipt; no shell string is emitted
   by the planner.
4. A Delivery block receives typed Git/tracker/SCM/CI adapters and durable
   effect/reconciliation boundaries. An LLM may draft content but cannot perform the
   remote mutation directly.

[`src/providers/agent-skills.ts`](../../src/providers/agent-skills.ts) materializes the selected
skill subset into an isolated Codex or Claude provider home. The agent runner in
[`src/temporal/activities/block-execution.ts`](../../src/temporal/activities/block-execution.ts)
uses only the prompt, profile, and skill selection frozen for that run. Editing the source pack
therefore changes future runs, never another active run with the same Jira task identity.

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
       implementation plan + semantic workflow candidate
                         |
                         v
        validate -> compile executable IR -> optional review
                         |
        frozen semantic hash + executable hash
                         |
                         v
     generic Temporal Workflow interprets executable IR
                         |
                         v
       semantic blocks execute observable operations
```

Context discovery gathers a bounded starting evidence set without creating a graph.
The mandatory planner decides whether it needs a blocking answer, a registered
investigation block, or can return the plan and first complete semantic workflow candidate. The
validator decides whether each candidate is safe and complete. The interpreter sees only
the frozen executable IR and semantic reference and records execution progress.
Activities perform I/O. Keeping these
roles separate is what lets a new company or process replace one layer without rewriting
the application. See
[`planning-lifecycle.md`](planning-lifecycle.md) for the complete lifecycle.

## 3. Add a workflow block

A semantic block has a stable reference such as `test_ops.fill_plan@1` and one primary
execution protocol:

- `agent`: invokes one provider episode with a versioned prompt and logical skills;
- `verification`: executes exact policy-owned commands and optional runtime/visual agent
  judgment;
- `delivery`: invokes typed Git/tracker/SCM/CI operations with external-effect
  reconciliation;
- a task-specific human/external protocol such as translation or package publication.

Waits are typed states owned by the active semantic block or a real task-specific human
boundary. Potential recovery waits are not predeclared sibling nodes.

To add `fill-test-ops-plan`:

1. add `harness/steps/<step>/step.json` with `schemaVersion: 2`, a stable reference,
   macro stage, allowed outcomes, completion evaluator, and executor profile or adapter;
2. reuse a named input/output contract; add a Zod schema to `step-contracts.ts` only when
   the step introduces a genuinely new typed payload;
3. declare capabilities, effects, artifacts, timeout, heartbeat, retry, cancellation,
   idempotency/reconciliation, and allowed outcomes;
4. add a colocated `prompt.md` for an agent block, or bind a registered
   process/integration Activity;
5. expose the block to the relevant company/project policy;
6. add a public test proving a task graph can contain it and invalid use is rejected;
7. add an Activity contract test for execution/recovery;
8. rebuild the worker/application.

This must not require changes to the generic interpreter, task queue, Temporal Client,
operator layout, or another block. If it does, first prove that the behavior is a new
generic control-flow concept rather than an ordinary task step.

For a verification operation, add its executor key and typed execution plan to the relevant
`processCommands` map in company or project policy. A plan contains one or more ordered
`{ command, args }` invocations and an optional timeout. The analyzer sees the available
Verify profile; execution uses the whole plan captured in that run's immutable snapshot
and stops at the first failing invocation. Commands appear in the owning attempt log, not
as task workflow nodes. Do not add shell composition or step-name branching to an Activity.

Project validation is a concrete example. Each project binds only supported targeted,
full, build, or visual operation keys to exact commands in its `processCommands` map. The
planner selects a Verify profile; it never emits shell. A non-zero command exit remains a
completed, receipted diagnostic result and a failed Verify domain verdict, so the visible
Development loop starts another Implement attempt. Visual verification is deliberately
absent from profiles whose
repository scripts run broad Playwright suites. It becomes available only after the
contract can carry and validate a task-specific selector.

Project process declarations are executable policy, not documentation guesses. Run
`pnpm harness:smoke` to bootstrap the Tasker Docker runtime and execute every registered process
against a clean, Tasker-owned worktree. Use `TASKER_SMOKE_PROJECTS=front-avia,front-bus` to limit a
diagnostic run. Reports live under the OS application-data `Tasker/smoke/reports` directory. A
command that fails on clean master must be fixed upstream or removed from the available block
catalog; do not teach the planner to ignore it.

Profile names are contracts. A project `full` profile includes every check the project claims as
its complete local boundary; do not bind it to only one suite. Keep a cheaper `targeted` profile
for bounded changes and instruct the planner to select the least expensive profile that honestly
covers the accepted risk.

### Git and base-branch policy

`projects/*/project.json.git` owns the exact remote base branch, task-branch format, and
commit-subject grammar. Workspace preparation fetches and pins the remote base before planning.
The PR adapter uses the same frozen policy, checks collisions before work starts, and validates the
actual commit after hooks. Change these rules in project policy; do not add repository-name
branches in Temporal or an integration adapter.

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

### Provider usage and shadow pricing

`company.json.apiPricing` maps exact configured model names to per-million input, cached-input, and
output rates, plus optional long-context multipliers. Its version and source URLs are harness
policy. Profile resolution freezes the matching row into the run snapshot, so a later price edit
cannot rewrite historical cost.

Agent Activities persist measured tokens and one explicit cost state: `price_table`,
`provider_reported`, or `unrated`. The cockpit aggregates receipts by workflow and step. The amount
is an API-equivalent estimate for subscription use, not money charged. Unknown models stay visible
as unrated rather than borrowing another model's price.

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

The workspace manifest lists every package in an explicit `skillSources` entry with one
scope: `global_ambient`, `project_ambient`, `step_bound`, or `policy_bound`. Directory
placement has no authorization meaning. Bootstrap creates a pinned hidden catalog under
`.tasker/harness/skills`; it never installs profile packages into repository
`.codex/skills` or `.claude/skills`. At each analyzer, planner, or step attempt the
provider adapter combines ambient scopes with the exact bound selection:

- Codex: `<isolated CODEX_HOME>/skills/<name>`;
- Claude: `<temporary directory>/.claude/skills/<name>` with `--add-dir`.

Supporting scripts and assets travel with the package. `TASKER_SKILLS_ROOT` points to
the selected provider view, so a skill must never depend on a hard-coded `.codex` or
`.claude` path. A missing package, duplicate logical name, invalid dependency scope, or
unknown project binding fails closed before provider invocation.

Repository-specific operational skills may be `project_ambient` like the interactive harness or
connected through `profiles[].stepBindings`. `front-avia` currently installs its reviewed project
skills as ambient repository guidance. Integration packages remain invisible until a compatible
registered block selects them.

Reusable personal sources come from the interactive harness without making a run depend on a live
symlink. `pnpm harness:setup` links global skills/rules, selected shared skills/rules, and project
skills/overrides under `harness/workspace/imports`; the manifest allowlists the imported names.
Bootstrap copies their content into the immutable run snapshot. A live edit therefore changes a
later run, not the active run being resumed.

A package that invokes another package declares logical names in `dependencies.json`.
The provider adapter resolves that transitive set before either CLI starts. Dependencies
do not grant graph effects. End-to-end macros such as `fix-bug` and `pr-finalize` are not in the
Tasker catalog; only their stable requirements are carried into relevant prompts and adapters.

Keep these boundaries distinct:

- **repository guidance** in `.ai`, `AGENTS.md`, and `CLAUDE.md` is present for every
  agent working in that repository;
- **ambient skills** are explicitly declared global or project scope;
- **step skills** are selected by one immutable agent-step binding (`playwright-demo` for
  reproduction/visual verification, CI readers for CI analysis);
- **integration effects** are performed only by typed internal Delivery operations (Git
  push, PR, Jira mutation, publication), never by a catch-all skill.

`pr-finalize` is therefore design input, not a Tasker skill: it combines several remote effects
which Temporal must persist and reconcile separately. Conversely, `playwright-demo` is a valid
reusable skill but does
not itself make visual verification part of every graph.

Use prompts for judgment and implementation guidance. Use generic compiler obligations
for structural safety, and file-backed company policies for company requirements such
as validation after a write or CI before human PR review. Whether a bug needs visual,
automated, or manual reproduction is selected from task/project evidence rather than a
universal before/after recipe.

Policy `path_sequence` obligations accept `direction: "before"` and
`direction: "after"`. Use `before` for prerequisites such as evidence required before
PR publication. Use `after` for semantic continuations such as revision -> Delivery ->
human review. Internal PR update, CI, and thread acknowledgement operations remain
independently receipted without becoming planner-authored nodes.

A policy may declare `appliesTo.taskOrigins` and task-evidence selectors, so Jira-only
blocks are absent from test inputs or a future GitLab Issue analyzer context, while
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

- `translations.kind = none`: Tasker adds no special translation workflow; locale files and
  ordinary repository commands remain implementation details;
- `translations.kind = human_handoff`: the repository has a proven extract -> human wait -> pull
  process and explicitly binds the corresponding semantic protocol operations;
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

For example, `ai-assistance` is deliberately not a Tasker policy or kernel feature. The selected
shared rule is composed into both `AGENTS.md` and `CLAUDE.md`, while the corresponding shared skill
is ambient in the provider view. Implementation creates only start-of-task identity/plan artifacts
required by those ordinary instructions. After accepted Verify and Review receipts exist, the
generic `prepare.delivery@1` agent transcribes the actual result, verification, and PR section.
Removing the imported rule/skill changes the next harness snapshot without changing Temporal,
compiler, or adapter logic.

Delivery preparation maintains the generic internal `.tasker/pull-request/draft.json` with a
mandatory typed commit description and tracked `branchArtifacts`. Deterministic Delivery validates
and consumes that draft; it does not rebuild company prose from the plan. For a bug, the latest
accepted Verify attempt creates exactly one current `*-fixed` image or video and Jira Delivery
uploads it idempotently before updating the single managed fix comment. Private investigation and
source-comparison media are never selected for publication.

The current file-backed manifest vocabulary deliberately reuses named runtime schemas
(`task_input`, `pull_request_input`, `agent_output`, and so on). Add a schema name in
TypeScript only when the data shape is new; adding another prompt, skill selection,
adapter binding, effect declaration, semantic loop policy, or artifact dependency is JSON-only.

## 7. Worktree harness bootstrap

Tasker must not call the personal `/Users/dzhabrail/Projects/harness/work/bootstrap` or
create nested `work` overlays. That command discovers and mutates every worktree under
`~/Projects/work`; Tasker owns a different managed clone.

The built-in pack lives in `harness/workspace`. `pnpm harness:setup` creates ignored authoring
symlinks to global skills/rules, selected `work/shared` skills/rules, and project skills/overrides
under `/Users/dzhabrail/Projects/harness`. `manifest.json` allowlists the exact logical packages;
`fix-bug` and `pr-finalize` are not imported as end-to-end macros. Their stable ideas live in the
relevant Tasker prompts and Delivery behavior. Every run copies ordinary bytes into a
content-addressed snapshot, so live symlinks never participate in resume.

Repository rules and Tasker rules have different owners:

- a declared project override replaces the corresponding repository `AGENTS.md`, `CLAUDE.md`, or
  `.ai/*.md` content for that worktree;
- without a declared override, tracked repository guidance remains the base;
- global/shared/project Markdown rules are rebuilt between harness rule markers in both root
  guidance files;
- Tasker may add only Markdown under `.ai/`, `AGENTS.md`, or `CLAUDE.md`; another
  destination makes the workspace pack invalid;
- `.ai/tasker.md` contains the managed-run boundary and is an ignored worktree file;
- Tasker appends only its execution overlay between explicit `tasker managed guidance` markers;
  that final overlay wins over interactive worktree/finalization mechanics because Tasker already
  prepared and owns those boundaries;
- when a root guidance file does not exist, the profile file becomes its complete
  ignored content;
- composed tracked guidance is marked `skip-worktree`, so it guides the agent but cannot
  enter the product diff.

This is explicit composition with optional replacement. Project overrides remain owned by the
interactive harness; Tasker-specific operational delta alone belongs in
`workspace/profiles/<id>/guidance`. The frozen content hash makes the exact result reviewable.

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

Execution mounts are effect-derived, not prompt-derived. Every agent container receives
separate run/step-scoped surfaces:

```text
/workspace         product worktree
<worktree>/.tasker/scratch/<operation>  disposable project-local temporary files
/tasker/artifacts  durable evidence pending import
/tasker/cache      project/provider caches
```

A block without `workspace.write` receives the worktree read-only, with a nested writable scratch
mount. Scratch is the only
place for temporary reproduction specs; durable evidence is registered from the artifact
root. Neither location relies on `.gitignore` or filename conventions for isolation.

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
When repository commands must discover an existing app on localhost, bind
`commandNetworkService` to that declared service; Tasker then shares its network namespace with
ephemeral command containers instead of teaching agents an alternative start command.
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

Human waits may expose a provider-neutral resolution mapping that turns a small typed
decision into semantic-block state. A bounded Development loop can open operator
guidance after its budget. Bitbucket parsing and reply APIs stay in the adapter, while
actual revision evidence materializes one implementation continuation only after real
comments exist.

For Jenkins, project manifests configure only the replaceable provider mapping:

```json
{ "ci": { "kind": "jenkins", "job": "front-avia" } }
```

CI observation is an internal, independently receipted Delivery operation. Moving to
GitLab CI means binding the same operation contract to another read adapter and changing project/company policy;
it does not require a Temporal Workflow branch.

Delivery control flow consumes provider-neutral CI facts. The observation contract maps
every terminal result to one typed outcome so a later observation replaces, rather than
leaks, the previous verdict. Task-caused failure returns `repair_required` evidence and
repeats the frozen Delivery feedback loop; flaky, infrastructure, and unknown outcomes
remain typed states of the active Delivery block. The semantic validator rejects PR
delivery outside a bounded `delivery.accepted@1` loop containing Implement, Verify, and
Review feedback. A provider-specific retry mutation needs its own reconciled internal
operation; it must not be hidden inside the read observer.

Review-ready Jira effects run only before the first `code_review@1` wait. Resolving that wait as
approved or changes-requested is local workflow input and must not replay Jira transitions,
comments, or attachments. In particular, `Mark done` never advances Jira beyond `Code Review`.

The post-run retrospective is evidence-only. It may propose edits to harness prompts, project
runtime policy, or infrastructure, but applying any proposal remains a separate reviewed change.
Archiving disposable Temporal history does not remove the completed workflow or Agent log from the
operator console: those views are reconstructed from immutable ledger artifacts. Do not add a
provider- or company-specific completion cache to preserve them.

An Allure `flaky` label is evidence, not the final CI decision. A terminal visual diff is
repair evidence even when the test carries that label: the observer persists its expected,
actual, and diff images and returns a task-repair outcome. Only failures whose available
evidence is exclusively flaky remain on the `ci_retry@1` boundary.

Jenkins merge builds may report both the target-branch revision and the task revision. Exact-commit
observation accepts the build when any declared revision equals the prepared task commit; it never
assumes the first `lastBuiltRevision` action is the branch under test.

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
their source of truth: before an Implement-admission or Delivery-review-ready operation mutates an
issue, the adapter reads the selected transition metadata and current issue values. If
a required value such as Development estimate is absent, the run names the exact Jira
field and waits. Fill it in Jira and press Resume; Tasker re-runs only that operation and
preserves the already completed workflow prefix. It does not guess or write business
estimates on the operator's behalf.

Local development reads optional non-secret write authorization from `.tasker/local.env` before
starting the worker. A pilot run should enable `TASKER_ENABLE_JIRA_EFFECTS` and
`TASKER_ENABLE_BITBUCKET_PR_EFFECTS`, set Git author identity, and allowlist the exact
`jira:<KEY>` through `TASKER_EXTERNAL_EFFECT_TASKS`. The file is ignored with the rest of
`.tasker`; credentials continue to come from the external interactive-harness `.env`. Shell
environment values remain available for CI/VPS configuration.

## 9. Configure provider and model selection

Execution profiles live in `harness/company.json`. A profile is a complete executable
choice, not a loose model alias. Codex profiles declare `provider`, `command`, `model`,
`effort`, `timeoutMs`, and `serviceTier`; Claude profiles declare the same fields except
the Codex-specific service tier. `executionProfileRouting` selects profiles for workflow
analysis and implementation-planning strategies. Task execution additionally resolves a
registered `simple`, `standard`, or `complex` strategy to logical context,
implementation, verification, and review profiles.

Agent step manifests reference logical profiles such as `investigation`,
`implementation`, `verification`, `documentation`, or `review`. A planner may choose a
strategy enum but never a raw provider/model. To use Claude for deep
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

Resolution order is explicit run override, project strategy/profile redirect, then
company strategy route or the logical profile named by a step. Every referenced profile is validated when the harness
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

Editing a prompt, skill, policy, or block affects future snapshots, not an already frozen
execution graph. During pre-pilot development, if an unfinished run must consume the new harness,
use the cockpit's confirmed `Restart from scratch` action. This preserves the abandoned Temporal
history but intentionally creates a new run, worktree, planning episode, evidence scope, graph,
review scope, and execution identity. The replacement cannot read mutable artifacts from the
abandoned run. Do not use restart for ordinary retries: fix the prerequisite and `Resume` the same
run so completed work is retained.

Wait UI is driven by the operator projection's typed intervention action. Agent retries use
`operator_guidance`; deterministic integration, process, workspace, and external handoff waits use
`external_prerequisite`; exhausted provider-contract retries use `retry_step`; plan/questions/review
use `typed_resolution`. Do not add a Cockpit regex over wait text. An external prerequisite never
receives free-form guidance: repair the source system and resume the same block. A retry-step action
also has no guidance editor because malformed provider output is not a task decision.

Codex and Claude are current first-class subscription-CLI adapters for analysis,
planning, and agent steps. Adding another provider means implementing this same adapter
contract and registering profiles. It is not a skill migration or workflow change.

## 11. Late discoveries

Reproduction or implementation may discover a shared component, translation process,
or additional verification requirement. The Activity returns
`workflow_change_required`; it does not edit Workflow state itself.

Tasker asks the analyzer for a validated semantic continuation, compiles it, and records
the review decision against the current Execution `runId`. An accepted same-repository
suffix runs through namespaced nodes in the same Temporal Workflow and workspace. The
parent graph and completed prefix remain immutable. A different repository requires a
separately prepared child workspace and remains a typed prerequisite until that
lifecycle is implemented.

During the pilot every revision is reviewable. Later known low-risk classes may be
auto-accepted by policy, but deterministic validation never becomes optional.

## 12. When interpreter changes are justified

Change the generic interpreter only for a new domain-independent executable-control-flow semantic,
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
- can the operator read the prompt and see why the semantic workflow contains the block?
- do every command, integration, commit, artifact and verdict remain inspectable without
  becoming task workflow nodes?
- is read-only access enforced by container mounts?
- does Temporal history stay small and secret-free?
- does recovery resume the failed boundary without discarding earlier work?
- does the change affect only future immutable snapshots/attempts?
- can another company replace vendor adapters/config without interpreter changes?
- did tests cover worker failure and duplicate external delivery where relevant?
