# Workspace harness pack

This directory is the versioned source of truth for agent configuration materialized
into Tasker-managed worktrees. It was seeded from
`/Users/dzhabrail/Projects/harness/work` on 2026-08-04, but it is not a copy of that
bootstrap program.

## What moved

| Old location                 | New form                         | Runtime destination                                      |
| ---------------------------- | -------------------------------- | -------------------------------------------------------- |
| `work/skills/*`              | `integration-skills/*`           | pinned hidden catalog; explicit step/planner selection   |
| `work/shared/*`              | `shared-skills/*`                | pinned hidden catalog; scope declared in `manifest.json` |
| `work/<profile>/skills/*`    | `profiles/<profile>/skills/*`    | pinned hidden catalog; project step binding              |
| profile operational skills   | `profiles/<profile>/step-skills` | pinned hidden catalog; project step binding              |
| `work/<profile>/overrides/*` | `profiles/<profile>/guidance/*`  | pinned `.ai/**`, `AGENTS.md`, `CLAUDE.md` rules          |
| `work/lib/*`                 | `lib/*`                          | `.tasker/harness/lib/*` for integration skill scripts    |
| `work/bin/with-env`          | portable `bin/with-env`          | `.tasker/harness/bin/with-env`                           |

The initial manifest declares six repositories: `front-avia`, `front-backoffice`,
`front-bus`, `front-components`, `front-core-packages`, and `front-railways`.

Project-owned `.ai` files arrive with the managed clone and remain the repository's
source of truth. Tasker adds only `.ai/tasker.md`; it does not duplicate a repository's
architecture documents into this pack. Every profile also declares an `AGENTS.md` and
`CLAUDE.md` managed-run delta so Codex and Claude receive equivalent boundaries.

When the repository already tracks one of those root files, bootstrap composes
`repository file at the pinned base commit + Tasker delta` between explicit markers,
hashes the result, and marks it `skip-worktree`. When the file does not exist, the delta
is materialized as the complete file. This keeps repository rules and Tasker rules
simultaneously, without adding either to the task diff. `front-components` has no
repository architecture guidance, so its profile states that fact instead of borrowing
rules from another project.

## Initial project validation

Commands below were resolved from the current `package.json` files. They are stored as
ordered `{ command, args }` invocations; Tasker does not parse shell strings. A sequence
stops at its first non-zero result.

| Project               | Targeted validation                                              | Full validation                  | Build                      | Visual      |
| --------------------- | ---------------------------------------------------------------- | -------------------------------- | -------------------------- | ----------- |
| `front-railways`      | `pnpm run typecheck`                                             | unavailable                      | `pnpm run build`           | unavailable |
| `front-bus`           | unavailable                                                      | unavailable                      | `pnpm run build`           | unavailable |
| `front-avia`          | `typecheck` → `lint:eslint` → `lint:stylelint` → `lint:circular` | targeted → `test:unit` → build   | `pnpm run build`           | unavailable |
| `front-core-packages` | `node type-check.mjs` → `pnpm run linters`                       | `pnpm run test:unit --runInBand` | `pnpm run build-packages`  | unavailable |
| `front-components`    | `pnpm run lint-no-fix`                                           | `pnpm run test:unit --runInBand` | `pnpm run storybook:build` | unavailable |
| `front-backoffice`    | unavailable                                                      | unavailable                      | `pnpm run build`           | unavailable |

`test:ui` is deliberately not registered for any project. Today the process ABI has no
typed Playwright selector, so exposing it would let an ordinary validation node launch
the complete visual suite. Likewise `front-backoffice`'s
`agent:eslint-for-changed` is excluded because it runs `eslint --fix` and mutates the
workspace. Missing categories stay unavailable to the planner instead of falling back
to an expensive or mutating command.

These declarations are executable policy. `pnpm harness:smoke` runs them in the same Docker
runtime used by task Activities against disposable Tasker-owned worktrees. Five profiles currently
pass every registered command on a clean base. `front-bus` full validation was removed because its
test command finds no tests; `front-backoffice` targeted validation was removed because clean
master currently reports TypeScript failures. `front-components` remains unverified while its
Bitbucket lookup returns VPN/authorization `403`.

```sh
pnpm harness:smoke
TASKER_SMOKE_PROJECTS=front-components pnpm harness:smoke
```

Clones, worktrees, Docker runtimes, and JSON reports live under
`~/Library/Application Support/Tasker/smoke`. The runner never reads or writes
`~/Projects/work`. Any non-zero command or dirty worktree fails the profile.

`front-avia` full validation is deliberately the union of its targeted checks, unit suite, and
production build. The planner should select targeted validation for a bounded change and reserve
full validation for a risk that justifies the additional time; the name `full` never means
"unit tests only."

## Git policy

Every project manifest declares its base branch, branch format, and commit-message contract.
Workspace preparation fetches the configured remote base, pins that exact revision, and blocks on
an existing local or remote task branch. Application repositories use `TASK-123 subject`; package
repositories use the declared conventional type and optional scope. PR publication targets the
same configured base and verifies the actual commit subject after Git hooks run. A title with no
ASCII slug falls back to the Jira key.

## Usage and API-equivalent cost

Every successful subscription-agent invocation persists provider, profile hash, model, effort,
session, duration, measured token classes, and an API-cost result in its output artifact and Block
Receipt. `company.json.apiPricing` is a versioned, source-linked table resolved into the immutable
run snapshot. A known model produces a `price_table` estimate with the exact table version; a
provider-reported amount is retained when no row exists; otherwise the receipt is explicitly
`unrated`. These are hypothetical API equivalents, never claims about subscription charges.

All six profiles currently use `translations.kind = none`. This does not say that the
repository has no localized text; it says Tasker has no special human translation
handoff for that project. Ordinary locale-file edits remain implementation work. A
future proven extract → human wait → pull process uses `human_handoff` plus explicit
`translations.extract@1` and `translations.pull@1` process bindings.

The old `bootstrap`, `config`, `harness-wt-hook`, generated Loop output, `.DS_Store`,
and `.env` did not move. They are operator-machine mechanics or runtime data, not
company/project policy. In particular, credentials remain in the external file selected
by `TASKER_HARNESS_ENV_FILE` (by default `../harness/work/.env`) and are never copied to
a worktree or content snapshot.

## Runtime model

1. `manifest.json` resolves the managed repository reference to one profile.
2. Tasker hashes every declared pack file and stores an immutable copy under the
   application-data `harness-snapshots/<sha256>` directory.
3. The managed worktree pins that hash in `.tasker/harness-bootstrap.json` before files
   are applied. A retry after process/worker failure therefore resumes from the pinned
   snapshot even if this source directory has changed.
4. Every declared skill package is copied into a hidden, provider-neutral catalog at
   `.tasker/harness/skills`. The resolved manifest is pinned beside it. Nothing is
   installed in repository `.codex/skills` or `.claude/skills`: each analyzer, planner,
   or step attempt receives only its resolved ambient and bound packages in a temporary
   provider home. A declared project override replaces the matching repository guidance;
   otherwise the repository file remains the base. Global/shared/project rules and the
   Tasker execution overlay are then composed on top. No managed worktree symlink points
   back to a live source.
5. Generated untracked files are placed in the managed clone's Git exclude file;
   tracked guidance uses that worktree's `skip-worktree` bit. The task branch therefore
   contains code and task artifacts, not operator configuration.
6. The durable receipt records the profile, pack hash, and hash of every materialized
   file. `inspect` can reconcile a lost Activity response without redoing completed
   work.

Every task step container also receives isolated runtime surfaces. `/workspace` is the
product worktree and is mounted read-only unless the frozen semantic block owns
`workspace.write`. `<worktree>/.tasker/scratch/<operation>` is a nested writable,
disposable step-scoped mount so generated project scripts resolve project dependencies,
`/tasker/artifacts` is durable evidence pending import, and `/tasker/cache` owns writable
tool caches. Prompt wording and `.gitignore` are not security boundaries.

There is deliberately no standalone `wt` hook in the normal path. Temporal creates the
managed worktree and invokes the bootstrap Activity before repository analysis or
planning. A worker crash, VPN outage, or lost Activity response retries `inspect` and
continues from the same pinned selection. Project executable bootstrap is a separate,
Docker-only `workspaceRuntime` policy; there is no host command escape hatch.

## Skills are not workflow steps

There are three independent decisions which must not be collapsed into one:

| Question                                   | Owner                  | Example                                          |
| ------------------------------------------ | ---------------------- | ------------------------------------------------ |
| Is guidance installed for this repository? | workspace profile      | `localization`, `state-data`, `ui-kit`           |
| Does this task need an operation?          | planner + validator    | bind runtime bug evidence into Verify or omit it |
| Which guidance may that operation use?     | versioned step binding | `verify.acceptance@1` selects `playwright-demo`  |

Installing a `SKILL.md` never adds a graph node and never authorizes a remote effect.
The block catalog does that. In particular:

- `playwright-demo` is reusable execution guidance. It is selected by a Verify block
  only when accepted criteria require runtime/visual evidence. Exact project commands
  are internal Verify operations and do not gain agent skills. An ordinary non-visual
  feature gains neither behavior merely because the package exists.
- `fix-bug` and `pr-finalize` are not imported as end-to-end Tasker skills. Their stable
  requirements are distributed into investigation, implementation, verification, and Delivery;
  interactive worktree/finalization mechanics do not become a second orchestration layer.
- read/write integrations are typed Activities. A prompt or skill can draft input and
  interpret evidence; it cannot grant itself `git.write`, `jira.write`, or another
  outward-facing capability.

The hidden catalog is storage, not provider discovery and not authorization. For every
agent attempt, Tasker combines explicit scopes and copies only the resulting packages
into an isolated provider view:

- Codex receives `<isolated CODEX_HOME>/skills/<name>`;
- Claude receives `<temporary directory>/.claude/skills/<name>` and that directory is
  supplied through `--add-dir`.

Both views originate from the same `SKILL.md` package and supporting files. Scripts use
`TASKER_SKILLS_ROOT`, which points at the selected provider view instead of a hard-coded
`.codex` or `.claude` path. The manifest's `supportFiles` directory is copied beside that provider
view once, so shared script imports such as `harness_env` resolve identically for Codex and Claude.
A missing logical package or support directory blocks before the subscription CLI starts.

The four scopes have distinct selection rules:

- `global_ambient` is added to every analyzer, planner, and step attempt;
- `project_ambient` is added only for the resolved repository profile;
- `step_bound` requires a base step/planner selection or a profile `stepBindings` entry;
- `policy_bound` can only be named by an enabled company policy.

Duplicate logical names and scope-incompatible dependencies fail pack loading. A
project binding cannot remove a global or policy skill. `front-avia` installs its reviewed project
skills as project-ambient guidance, matching the interactive harness.

## Local imports from the interactive harness

Run `pnpm harness:setup` once per machine. It creates ignored authoring symlinks for global
skills/rules, selected `work/shared` skills/rules, and available project skills/overrides (override
the source with `TASKER_INTERACTIVE_HARNESS_PATH`). The manifest allowlists all global skills,
only `ai-assistance`, `playwright-demo`, `playwright`, and `review-process` from shared, and the
declared project packages.

The symlink is an authoring input, never a run dependency. Bootstrap follows the
allowlisted source once, rejects nested symlinks and secrets, copies ordinary files into
the content-addressed snapshot, and materializes that snapshot into the managed
worktree. Rules are rebuilt into both `AGENTS.md` and `CLAUDE.md`; a declared project override is
the base, and the Tasker execution overlay is appended last. Changing an interactive source affects
a later run but cannot change resume/retry of an existing run.

## Setup lifecycle

For a new task the durable order is:

1. Jira intake resolves an explicit `repo:<name>` (or a future typed Jira field).
2. Tasker prepares its application-data clone, branch, and managed worktree.
3. The bootstrap Activity resolves the repository alias in `manifest.json`.
4. The complete pack is content-addressed and pinned for the run.
5. Repository guidance and the hidden effective skill catalog are materialized;
   credentials stay in the external environment file.
6. Only then do repository analysis, workflow assembly, optional plan review, and block
   execution begin.

The worktree is therefore created before planning, but the branch is still empty of task
changes. Planning reads the same configured filesystem that later execution uses.

## Maintenance

- Edit a prompt, skill, or guidance file here and bump the human-readable `version` in
  `manifest.json` for a semantic change. The content hash is computed automatically.
- The change affects newly bootstrapped runs only. Existing worktrees keep their pinned
  snapshot until their run finishes.
- Add a project by creating its guidance and optional skill packages, then declare
  repository aliases, scoped `skillSources`, and `stepBindings` in `manifest.json`. No
  orchestrator or Temporal code changes are required.
- Put Tasker-only operational rules in `.ai/tasker.md`. Keep repository architecture in
  the repository's own `.ai`. Imported project overrides own the complete base content
  of `AGENTS.md`, `CLAUDE.md`, and matching `.ai/*.md`; profile guidance contains only
  the managed-run delta appended after that base.
- Add a package under `shared-skills`, `integration-skills`, or a profile directory and
  explicitly list its logical name in one `skillSources` entry. Directory placement
  alone grants no visibility.
- Bind repository-specific operational knowledge with `profiles[].stepBindings`.
  `feature-review` remains unbound because its current package can publish Bitbucket
  state, which is incompatible with the read-only `review.change@1` effect boundary.
- Keep portable packages in the Agent Skills common subset: a directory named after
  the logical skill, a `SKILL.md` with `name` and `description`, and optional files
  referenced relative to that directory. Never put provider CLI flags or provider-home
  paths in the package.
- If a package directly invokes another skill package, declare those logical names in
  its `dependencies.json`. Tasker resolves the transitive set before invocation and
  fails closed when a dependency is missing; both provider views receive the same set.
- Prefer improving an existing skill over adding a near-duplicate. For a new reusable
  operation, add the skill package here and bind its logical name in a versioned step;
  do not encode graph order in `SKILL.md`.
- Duplicate logical skill names are rejected. A future replacement mechanism must be
  explicit in the manifest; directory precedence is not an override contract.
- To change future workflows, edit `harness/company.json`, the relevant
  `harness/projects/*` policy, step prompt, or step definition. A pinned active run keeps
  its snapshot; new runs receive the change.
- A retrospective may propose a patch to these files, but it does not mutate the active
  harness automatically during the pilot.
- Workflow peculiarities such as translations, required builds, publication waits, or
  visual verification belong in `harness/projects/*` and company workflow policy, not
  in this workspace bootstrap manifest.
- Secrets stay outside Git. Skill scripts receive `TASKER_SKILLS_ROOT`,
  `TASKER_HARNESS_BIN`, and `TASKER_HARNESS_ENV_FILE` from the provider adapter.

Run `pnpm verify` after a change. The workspace bootstrap unit suite loads the real pack,
materializes it into a disposable Git repository, checks Git cleanliness, and proves
that every declared guidance file is materialized, repository-owned `.ai` remains intact,
and subsequent source edits cannot alter the active worktree.
