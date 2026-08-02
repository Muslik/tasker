# Tasker customization guide

Status: file-backed harness pack implemented; real step executors and task-tracker
port remain later runtime boundaries

Audience: operator, harness author, repository maintainer

This guide explains how Tasker is meant to be extended without editing the kernel.
It separates:

- what the current code already implements;
- what the extension contract should be;
- where a kernel change is still required.

The current implementation has a typed workflow DSL and a checked-in, validated
[`harness/`](../../harness) pack. The pack contains readable prompts, versioned step
definitions, workflow templates, company rules, project policies, and worktree
overlays. See:

- [`src/workflow/dsl.ts`](../../src/workflow/dsl.ts)
- [`src/workflow/schema.ts`](../../src/workflow/schema.ts)
- [`src/planning/contracts.ts`](../../src/planning/contracts.ts)
- [`src/planning/templates.ts`](../../src/planning/templates.ts)
- [`src/planning/project-policies.ts`](../../src/planning/project-policies.ts)
- [`src/shared/env-file.ts`](../../src/shared/env-file.ts)
- [`src/harness/loader.ts`](../../src/harness/loader.ts)
- [`src/harness/materialize.ts`](../../src/harness/materialize.ts)

The compiler can accept a newly registered step without a kernel edit, and the pack
declares whether a step uses an agent prompt or a named system executor. The current
runtime still traverses later workflow steps as deterministic stubs: the generic
agent/system executor dispatch and `TaskTrackerPort` are the next runtime boundaries.

## Using the pack today

The default pack is [`harness/`](../../harness). To use another company pack, point
Tasker at a directory with the same manifest contract before starting the process:

```bash
TASKER_HARNESS_PATH=/absolute/path/to/company-harness pnpm demo:m1
```

Tasker validates the complete pack on startup and fails with the exact file and schema
path when it is invalid. The loaded pack is immutable for that process. After changing
a prompt, policy, step, or template, restart Tasker; the change affects newly created
runs and does not rewrite persisted runs.

Useful checks:

```bash
pnpm typecheck:server
pnpm vitest run --project unit test/unit/harness/pack.test.ts
pnpm verify
```

## Extension map

| Area | Already implemented today | Extension contract |
|---|---|---|
| Workflow authoring | `defineWorkflow`, `sequence`, `step`, `branch`, `bounded_loop`, `wait`, `gate`, `finalize` | Keep workflows JSON-serializable and versioned |
| Step/predicate/wait ABI | `harness/steps.json` feeds the versioned runtime registry | Add a compatible step definition and prompt without editing the compiler |
| Workflow templates | `harness/workflows/*.json` supplies analyzer base graphs | Add reusable JSON source; template-selection policy is still M1-specific |
| Project policy | `harness/projects/*/project.json` plus readable `workflow.md` | Layer company defaults and repository-specific operational rules |
| Worktree overlay | `harness/work` plus an optional project `work/` | Materialize idempotently and record per-file SHA-256 provenance |
| Tracker | Jira is wired directly today | Introduce `TaskTrackerPort` before adding GitLab Issues |

## Readable prompts

Readable prompt text lives in the harness pack, not in kernel code. System provider
prompts are Markdown templates; agent step prompts sit beside the step registry. The
loader records their SHA-256 hashes, and analyzer context exposes step description,
logical skills, prompt path, and prompt hash.

Implemented layout:

```text
harness/
  company.json
  steps.json
  prompts/
    workflow-analyzer.md
    implementation-planner.md
    steps/*.md
  workflows/*.json
  projects/<project-id>/
    project.json
    workflow.md
    work/
  work/
```

Rules:

- system prompts define shared analyzer/planner behavior;
- project `workflow.md` explains operational facts that the analyzer may use;
- step prompts stay close to the step definition they serve;
- the workflow compiler only needs the stable step reference and contract;
- the analyzer receives prompt provenance and project guidance, not hidden TypeScript
  constants.

## Workflow templates

The base workflow sources are regular JSON files under
[`harness/workflows`](../../harness/workflows):

- `short_bugfix`
- `feature_with_review`

They are loaded and validated through the same `WorkflowSourceSchema` as analyzer
output. Task-specific deterministic materialization for the three existing fixture
families still lives in [`src/planning/templates.ts`](../../src/planning/templates.ts);
the real analyzer may specialize a base graph using any registered step.

The important rule is that templates are source, not execution logic. They can choose
which registered steps, waits, gates, and loops to assemble, but they should not carry
arbitrary code or provider-specific behavior.

For new work:

- keep the reusable skeleton in a template;
- keep repository policy in the project harness pack;
- keep step-specific execution details in the step definition and executor;
- keep task-specific values in the materialized task workflow.

## StepDefinition and StepExecutor

Tasker already has a versioned step contract registry. In
[`src/planning/contracts.ts`](../../src/planning/contracts.ts), each registered step
declares:

- `id` and `version`;
- `inputSchema` and `outputSchema`;
- `allowedEffects` and `requiredCapabilities`;
- `resumeBoundary` and `idempotency`;
- `retryPolicy` and `waitKinds`;
- `artifactContracts`;
- `workflowChanges`;
- optional `reconciliation` metadata.

That is the part the kernel already understands.

Each entry in [`harness/steps.json`](../../harness/steps.json) now adds readable
metadata and an execution binding to that contract. Agent bindings identify a Markdown
prompt and provider-neutral `SkillRef` values. System bindings identify a stable
executor reference such as `command.run@1` or `bitbucket.prepare-pr@1`.

The remaining runtime boundary is `StepExecutor`: the adapter that turns the declared
binding into a concrete provider action or harness command. It will be responsible for:

- loading the readable prompt by `SkillRef`;
- preparing the step input;
- running the provider or local command;
- reconciling receipts, probes, and artifacts;
- returning a normalized step outcome.

Suggested division:

- `StepDefinition` is pure contract data;
- `StepExecutor` is the runtime adapter;
- the kernel compiles and validates references, but never embeds provider code in the
  workflow graph.

The contract registry is constructed from the loaded pack by
`createHarnessWorkflowContracts(...)`. Tests prove an external pack can add
`company.custom@1` and compile a graph without a workflow-compiler change. Until the
real executor dispatcher lands, new steps execute only through the deterministic stub
runner.

## Company and project harness packs

Use two layers.

### Company pack

The company pack is the shared default layer. It should hold:

- prompt language reused across repositories;
- shared skill mappings;
- shared step executors;
- cross-repo policy defaults;
- safety rules that apply everywhere.

### Project pack

The project pack is the repository-specific layer. It should hold:

- repo-specific prompt overrides;
- repo-specific step or verification policy;
- translation behavior;
- publication behavior;
- task-tracker binding;
- any repo-local exception to company defaults.

### Local override precedence

Use the narrowest override that can express the change:

1. kernel invariants and schema validation;
2. project pack overrides;
3. company pack defaults;
4. global fallback defaults;
5. analyzer suggestion only for fields still unset by policy.

The current code already demonstrates a simpler version of this pattern:

- project-specific workflow profiles in
  [`src/planning/project-policies.ts`](../../src/planning/project-policies.ts) win
  over the generic default profile;
- a global frontend publication rule applies only when the repository kind and path
  match;
- if nothing matches, the default is intentionally conservative.

## Provider-neutral SkillRef mapping

`SkillRef` should be a stable logical identifier that does not depend on the provider
surface. The kernel should never need to know whether the step is executed by a local
script, a Codex skill, a Claude prompt, or another provider.

Use this pattern:

- `SkillRef` names the capability, not the provider;
- the pack maps that ref to one provider-specific implementation per runtime;
- the workflow graph stores the logical ref plus a version;
- the runtime resolves the ref to a prompt body, script, or tool invocation.

Target mapping sketch:

```text
fill-test-ops-plan@1
  -> codex: skill or prompt bundle
  -> claude: prompt bundle
  -> local: script wrapper
```

The point is to keep the workflow source provider-neutral. A provider swap should
change the mapping table, not the workflow graph.

## Example: `fill-test-ops-plan@1`

This step is registered in [`harness/steps.json`](../../harness/steps.json), and its
readable prompt is
[`harness/prompts/steps/fill-test-ops-plan.md`](../../harness/prompts/steps/fill-test-ops-plan.md).
It proves that a compatible step is pack data, not a compiler switch branch.

Current contract, abbreviated:

```json
{
  "reference": "fill-test-ops-plan@1",
  "description": "Produce a read-only test-operations plan when delivery requires one.",
  "inputKind": "task",
  "allowedEffects": [],
  "requiredCapabilities": ["repository.read"],
  "resumeBoundary": "attempt",
  "idempotency": "none",
  "retryBudget": 1,
  "waitKinds": [],
  "artifactContracts": ["test-ops-plan"],
  "workflowChanges": ["verification_scope_changed"],
  "execution": {
    "kind": "agent",
    "prompt": "prompts/steps/fill-test-ops-plan.md",
    "skills": ["test-ops-planning@1"]
  }
}
```

Executor behavior:

- read the task snapshot and the current repo evidence;
- load the readable prompt by `SkillRef`;
- produce a test-ops plan artifact;
- validate that the artifact matches the declared output schema;
- return the plan path and summary without mutating unrelated repo state.

If the step must write a file into the task worktree, that write belongs to the
executor, but the workflow graph should still treat the step as a single typed node.

## Swapping Jira for GitLab Issues

Today Tasker is Jira-shaped. The code in `src/control-plane/*` and
`src/integrations/jira/*` wires Jira directly, so GitLab Issues is not a config-only
swap yet.

To support a tracker swap without editing the kernel again, introduce a narrow
`TaskTrackerPort` first. The port should own the tracker-specific operations that the
kernel actually needs, such as:

- read issue snapshot;
- sync or refresh issue state;
- read attachments;
- list operator-visible tasks;
- resolve workflow-planning source data.

Then implement adapters:

- Jira adapter for the current behavior;
- GitLab Issues adapter for the replacement behavior.

Mapping guidance:

- Jira issue key maps to a Jira snapshot and comments;
- GitLab Issues IID or URL maps to a GitLab snapshot and notes;
- attachment reads stay behind the port;
- tracker-specific auth and API shape stay inside the adapter.

Important distinction:

- if `TaskTrackerPort` does not exist yet, the swap requires a kernel change;
- once the port exists, adding GitLab is a config and adapter change, not a kernel
  rewrite.

## What needs kernel changes

Edit the kernel only when the change alters the deterministic contract.

Kernel changes are required for:

- new workflow node kinds;
- new validation rules;
- new persistence fields or schema versions;
- new effect classes;
- new provider-independent run-state semantics;
- a new port abstraction such as `TaskTrackerPort`;
- a new compilation or reconciliation rule.

## What should stay in config or plugins

Prefer config or pack changes when the behavior is repository- or provider-specific.

Config or plugin changes are enough for:

- new prompts;
- new `SkillRef` mappings;
- new step registrations that fit an existing contract shape;
- project policy overrides;
- company defaults;
- repository-specific verification commands;
- tracker adapter selection once the port exists.

## Validation, testing, and debugging

Use the existing contract boundaries to decide what to test.

For workflow and pack changes:

- validate the workflow source through `defineWorkflow(...)`;
- verify the step, predicate, and wait registries still accept all references;
- run the planning and workflow tests that touch `src/planning/*`;
- check the renderer or cockpit path if the workflow shape changed.

For tracker-adapter changes:

- exercise the adapter with recorded API responses;
- verify read-only snapshot behavior;
- check attachment and sync failures stay recoverable;
- confirm the kernel does not get tracker-specific types.

For debugging:

- inspect the materialized workflow source first;
- then inspect the compiled graph and validation report;
- then inspect the step contract registry and the resolved project policy;
- finally inspect the pack provenance and the runner/worktree state.

## Versioning and migration

Version every extension boundary explicitly.

Rules:

- bump the step version when the schema, effect, or reconciliation contract changes;
- bump the owning company or project pack version when prompt or guidance text changes
  in a way that matters to execution;
- bump the project pack version when policy changes should affect future runs only;
- never overwrite a retired contract in place;
- keep old references readable long enough to replay older runs.

Migration path from the current repo shape:

1. file-backed prompts, steps, templates, policies, and overlays — implemented;
2. persist company/project pack version and content hashes directly on every run;
3. call overlay materialization from the real `workspace.prepare` step;
4. dispatch agent and system execution bindings through the generic step runner;
5. introduce `TaskTrackerPort` before supporting a non-Jira tracker;
6. move tracker-specific code behind the port before switching adapters.

## Project harness copy and provenance

The materialization contract copies the project harness into the task worktree before
execution while preserving provenance.

Recommended flow:

1. resolve the company pack and the project pack;
2. copy or overlay them into the task worktree;
3. record the source repository, commit SHA, pack version, and content hash for each
   copied unit;
4. write a provenance manifest into the task artifact set;
5. treat the copied content as runtime input, not as the source of truth;
6. keep the original pack immutable.

Why this matters:

- the human can inspect the copied prompt or step body inside the task worktree;
- the kernel can still explain exactly which pack revision produced the run;
- older runs remain replayable even after the pack changes.

`materializeHarnessOverlay(...)` implements this copy boundary now. It rejects
symlinks, cannot escape the pack or target root, is idempotent when an existing file
has identical content, refuses to overwrite changed files, and returns a per-file
SHA-256 receipt. Wiring that service into the upcoming real `workspace.prepare` step
is the next execution milestone.
