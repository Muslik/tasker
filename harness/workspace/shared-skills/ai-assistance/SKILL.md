---
name: ai-assistance
description: Company regulation on agent-assisted development — every pull request carries an `## AI assistance` section, and at any level above None the same branch carries `.ai/workspace/<JIRA-KEY>/` with README, plan, result and verification. Use at the START of any task that will end in a pull request (the plan artifact has to exist before implementation ends) and again when finalizing it.
---

# ai-assistance — artifacts of agent-assisted development

Two obligations, both checked at review:

| | When | Where |
|---|---|---|
| **`## AI assistance` section** | every PR, exceptions included | PR description |
| **Artifacts** | level above `None` | `.ai/workspace/<JIRA-KEY>/` in the same branch |

A PR missing either is not accepted. The author answers for the result whatever the level
says, and an agent never merges its own PR.

## 0. At the start of the task

Create the directory and `README.md` as soon as the ticket key is known, and `plan.md` the
moment the plan is agreed with the human — **before** implementation is finished, not after.

```
.ai/workspace/AVIA-13209/
├── README.md
├── plan.md
├── result.md         ← filled at finalization
└── verification.md   ← filled at finalization
```

Reconstructing `plan.md` at the end out of the diff is a forgery of a dated artifact. There
genuinely was no plan → say that in `result.md` instead of inventing one.

The plan may change afterwards; substantial deviations get explained in `result.md`.

## 1. The level — exactly one, chosen honestly

The percentage measures the **substantive contribution to the result** — research, design,
implementation, testing, documentation — not generated lines.

| Level | Who did what |
|---|---|
| `None` | no agent, or only typos / formatting / autocomplete |
| `Minor Assistance (<25%)` | agent researched a part, suggested an option, diagnosed an error, pre-reviewed |
| `Co-Pilot (25-50%)` | shared work; the human drove the solution and wrote a substantial part |
| `Major Contributor (50-80%)` | agent did most of it; the human verified, corrected, ran the checks |
| `Full Generation (>80%)` | agent studied the ticket, researched the code, planned, implemented, verified, described it; the human checked and corrected its decisions, ran the mandatory checks, opened the PR |

A session run through the skills in this harness — ticket read, code researched, plan agreed,
change implemented, tests run, PR drafted — **is** the `Full Generation` definition. Go lower
only where the human actually performed that share themselves, and be able to name what they
did.

The opposite error is as bad: `None` because the change is small. The §4 exceptions are about
changes not worth an agent process at all — a typo, a mechanical config edit, a routine
dependency bump, a `revert`, an urgent production hotfix. A three-line change the agent
researched and wrote is not one of them.

**The level describes the finished work, so it may be revised.** `README.md` is written as soon
as the ticket key is known — long before it is known how the work will actually split. If the
balance moves afterwards — the human designs a core piece, takes the implementation over, or the
agent ends up carrying more than planned — change the level. That is ordinary bookkeeping, not a
confession; what the audit reads is the finished pair, so `README.md` and the PR section have to
be changed together. Never keep the first choice merely because it was written first — and when
the level is lowered, the `Human contribution` section has to name the share that justifies it.

## 2. The artifacts are harvested, not composed

Each file already exists as a by-product of the work; this step is transcription, not a
second write-up.

- **`plan.md`** ← the plan agreed with the human before implementation.
  Understanding of the task and the expected result; components researched; intended changes;
  risks and open questions; the testing plan.
- **`result.md`** ← the substance of the PR description.
  What actually changed; the key technical decisions; deviations from the plan and why; what
  the agent did; what the human substantially changed or added.
- **`verification.md`** ← the checks that were actually run.
  Every check with its concrete command, CI job or scenario **and its outcome**; what was
  **not** checked; known limitations and risks. "Tests pass" on its own is grounds for
  rejecting the PR.

What must **not** go in (§6): the dialogue transcript, the prompts, the model's reasoning,
minor intermediate attempts, a log of every agent action.

## 3. Templates

The artifacts and the PR section are written in the team's language (Russian here), as in the
regulation.

`README.md` — identification plus the split of labour:

```markdown
# AVIA-13209

- Jira: AVIA-13209
- Epic: AVIA-13100
- AI assistance: Major Contributor (50-80%)
- Tools: Claude Code, Codex
- Author: dzhabrail.markhiev
- Started: 2026-08-03

## Agent contribution

Агент исследовал обработку бронирования, подготовил план, реализовал
изменение и добавил интеграционные тесты.

## Human contribution

Автор проверил архитектурные решения, скорректировал обработку ошибок
и подтвердил результаты тестирования.
```

- **`Epic`** is the epic's **key**, never its name — the whole point is that
  `grep -R "AVIA-13100" .ai/workspace/` finds the related tasks. No epic → `Epic: none`.
- **`Author`** is the human, not the agent. **`Tools`** lists the agents actually used.
- **`Started`** is the real date from the environment, ISO — never guessed.

The PR section:

```markdown
## AI assistance

- AI assistance: None | Minor Assistance (<25%) | Co-Pilot (25-50%) | Major Contributor (50-80%) | Full Generation (>80%)
- Tools: Claude Code, Codex | none

### Summary

Кратко — роль агента в задаче.
```

At `None` the summary carries a short **reason** (that is exactly what the audit looks for),
and no artifacts are required.

## 4. Traps

- **Stage the exact path**: `git add .ai/workspace/<KEY>`. Never `git add .ai` — part of
  `.ai/` in these repositories is personal symlinks into `harness`, hidden from git by
  `skip-worktree` / `.git/info/exclude`, and a blind add fights that machinery.
- **The artifacts belong to the same branch and the same PR as the code.** A follow-up
  "artifacts" PR does not count — the reviewer checks them against the diff.
- **Forbidden data** — secrets, tokens, passwords, keys, personal data, production data.
  `verification.md` is where this leaks: the urge is to paste the raw API response or the
  session log. Paste the command and the verdict, not the raw output. What lands in the
  repository stays forever, and rotating a token afterwards does not undo the commit.
- **Written for a stranger a year from now**, not for today's reviewer: why it was done this
  way, not a line-by-line retelling. Short is fine — vague is not.
- **One level, exactly one.**
- **No ticket key** → no directory, but the PR section is still mandatory, with a reason.

## 5. Where this is checked

`pr-finalize` will not draft a PR without the section, and refuses to push when the level is
above `None` and the artifacts are not in the branch.
