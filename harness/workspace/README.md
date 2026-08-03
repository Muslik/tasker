# Workspace harness pack

This directory is the versioned source of truth for agent configuration materialized
into Tasker-managed worktrees. It was seeded from
`/Users/dzhabrail/Projects/harness/work` on 2026-08-04, but it is not a copy of that
bootstrap program.

## What moved

| Old location                 | New form                         | Runtime destination                                                  |
| ---------------------------- | -------------------------------- | -------------------------------------------------------------------- |
| `work/skills/*`              | `integration-skills/*`           | `.<provider>/skills/*`                                               |
| `work/shared/*`              | `shared-skills/*`                | `.<provider>/skills/*`                                               |
| `work/<profile>/skills/*`    | `profiles/<profile>/skills/*`    | `.<provider>/skills/*`, overriding a common skill with the same name |
| `work/<profile>/overrides/*` | `profiles/<profile>/overrides/*` | repository-relative files                                            |
| `work/lib/*`                 | `lib/*`                          | `.<provider>/lib/*` for integration skill scripts                    |
| `work/bin/with-env`          | portable `bin/with-env`          | `.<provider>/bin/with-env`                                           |

The initial manifest declares seven repositories: `front-avia`, `front-backoffice`,
`front-bus`, `front-core-packages`, `front-index`, `front-railways`, and
`notifications`. Empty profiles are intentional: they receive common skills today and
can gain project rules without changing TypeScript application code.

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
4. Common, integration, and profile skills are copied into `.codex` and `.claude`.
   Profile overrides are copied to repository paths. No symlink points back here.
5. Generated untracked files are placed in the managed clone's Git exclude file;
   tracked overrides use that worktree's `skip-worktree` bit. The task branch therefore
   contains code and task artifacts, not operator configuration.
6. The durable receipt records the profile, pack hash, and hash of every materialized
   file. `inspect` can reconcile a lost Activity response without redoing completed
   work.

There is deliberately no standalone `wt` hook in the normal path. Temporal creates the
managed worktree and invokes the bootstrap Activity before repository analysis or
planning. A worker crash, VPN outage, or lost Activity response retries `inspect` and
continues from the same pinned selection. `TASKER_WORKSPACE_BOOTSTRAP_COMMAND` exists
only as an adapter escape hatch for another company; it is not required for this pack.

## Skills are not workflow steps

There are three independent decisions which must not be collapsed into one:

| Question                                   | Owner                  | Example                                     |
| ------------------------------------------ | ---------------------- | ------------------------------------------- |
| Is guidance installed for this repository? | workspace profile      | `localization`, `state-data`, `ui-kit`      |
| Does this task need an operation?          | analyzer + validator   | add `bug.reproduce@1` or omit it            |
| Which guidance may that operation use?     | versioned step binding | `bug.reproduce@1` selects `playwright-demo` |

Installing a `SKILL.md` never adds a graph node and never authorizes a remote effect.
The block catalog does that. In particular:

- `playwright-demo` is reusable execution guidance. It is selected by
  `bug.reproduce@1` and `verify.visual@1`; an ordinary non-visual feature does not gain a
  video step merely because the package exists.
- `pr-finalize` is retained from the old harness as migration/reference material, not as
  Tasker's final PR executor. It combines commit, push, PR creation, Jira mutation, and
  human confirmation in one imperative skill, which conflicts with durable recovery.
  Its useful rules must be split between `pr.prepare@1`, CI/review waits, Jira integration
  blocks, and deterministic pre-PR obligations.
- read/write integrations are typed Activities. A prompt or skill can draft input and
  interpret evidence; it cannot grant itself `git.write`, `jira.write`, or another
  outward-facing capability.

The initial compatibility bootstrap exposes the imported common skill catalog inside
the managed worktree so Codex and Claude can discover it while execution is brought up.
That is not the final authorization boundary. Before remote writes are enabled, the
provider adapter must materialize only the skills named by the immutable step snapshot
into the isolated provider home. Until then, integration blocks remain blocked and
human-reviewed. This limitation is explicit so “available” is never mistaken for
“allowed”.

## Setup lifecycle

For a new task the durable order is:

1. Jira intake resolves an explicit `repo:<name>` (or a future typed Jira field).
2. Tasker prepares its application-data clone, branch, and managed worktree.
3. The bootstrap Activity resolves the repository alias in `manifest.json`.
4. The complete pack is content-addressed and pinned for the run.
5. Repository overrides and skills are materialized; credentials stay in the external
   environment file.
6. Only then do repository analysis, workflow assembly, optional plan review, and block
   execution begin.

The worktree is therefore created before planning, but the branch is still empty of task
changes. Planning reads the same configured filesystem that later execution uses.

## Maintenance

- Edit a prompt/skill/override here and bump the human-readable `version` in
  `manifest.json` for a semantic change. The content hash is computed automatically.
- The change affects newly bootstrapped runs only. Existing worktrees keep their pinned
  snapshot until their run finishes.
- Add a project by creating `profiles/<id>/skills` and `profiles/<id>/overrides`, then
  add its repository aliases to `manifest.json`. No orchestrator or Temporal code
  changes are required.
- Add a common skill under `shared-skills`; add an API/tool skill under
  `integration-skills`; add repository-specific implementation knowledge under that
  profile's `skills` directory.
- Prefer improving an existing skill over adding a near-duplicate. For a new reusable
  operation, add the skill package here and bind its logical name in a versioned step;
  do not encode graph order in `SKILL.md`.
- To replace a skill for one repository, create a skill with the same name under
  `profiles/<id>/skills`. The profile copy wins only in that repository. To change a
  company-wide rule, edit the shared package or company policy instead.
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
that subsequent source edits cannot alter the active worktree.
