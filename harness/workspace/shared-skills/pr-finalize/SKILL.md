---
name: pr-finalize
description: Finalize a task — commit, push, open the PR, comment in the tracker and move the status, following a strict protocol with a stop point before every outward-facing action. Runs ONLY on an explicit command ("finalize", "open the PR", "push it"). A profile-specific version of this skill, when the project has one, overrides this.
---

# pr-finalize — finalization (shared protocol)

Everything this skill does is **irreversible and visible to other people**. Hence the
protocol: drafts first, then one action at a time.

**Never run automatically** after writing code — only on an explicit command.

## Precondition
The project's self-check loop is green (typecheck / lint / tests). If it is not, go there
first.

## Protocol

### 1. Audit your own diff, then show the drafts and STOP

First read `git diff` and account for EVERY added comment and EVERY added test, one line
each:
- **comment** — delete it mentally: if the *why* is still answerable from the code, the
  comment goes. Restating the line below it is noise that ages into a lie.
- **test** — name the defect it would catch and the layer that owns it. Cannot name one, or
  a layer above already catches it → it does not go into the repository. Scratch checks
  written to convince yourself are not deliverables.

Whatever cannot be justified in one line is deleted before staging. Then assemble and show,
**executing nothing**:
1. **Commit message** — in the style of the repository's history (read recent commits
   instead of applying your favourite format).
2. **PR title and description**, carrying the mandatory `## AI assistance` section — see
   `ai-assistance` for the levels and the wording. Above `None` the branch must already
   contain `.ai/workspace/<KEY>/` with all four artifacts; missing or empty ones get written
   **now, before staging**, not after the PR is open.
3. **Tracker comment** — per the template below.
4. **The target status transition** — which transition exactly will be applied.

Wait for an explicit yes. Apply requested edits and show again.

### 2. Branch and commit
- Never commit on the main branch — create the task branch first (`wt -b <branch>` where the
  project uses worktrees).
- `git add` only the relevant files (never a blind `-A`). Throwaway scripts, videos and
  screenshots do not get committed.

### 3. Push
The first outward-facing action — only after confirmation.

### 4. PR
Create it with the project's tooling (`bitbucket` skill, `gh`, `glab`) from the branch into
the target branch. Reviewers only if the user named them. Return the link.

Do not repeat the tracker link in the PR description — the key is already in the branch name.

On Bitbucket Server (all ONETWOTRIP repos) the `onetwotrip` MCP is NOT available headless,
so create the PR over REST:
`POST $BITBUCKET_BASE_URL/rest/api/1.0/projects/ONETWOTRIP/repos/<repo>/pull-requests`
with `{title, description, fromRef:{id:"refs/heads/<branch>", repository:{slug, project:{key}}}, toRef:{…master…}}`.
Scripts read the token from $TASKER_HARNESS_ENV_FILE themselves; for ad-hoc curl use
`"${TASKER_HARNESS_BIN}/with-env"`.

### 5. Tracker
A comment with the PR link, then the approved status transition.
A transition may demand fields (estimate, reviewer) — ask the issue itself:
`GET .../issue/<KEY>/transitions?expand=transitions.fields`, rather than guessing. That call
shows field-level requirements ONLY; workflow validators (the DoD checklist, the parent
epic's status) are invisible in it and surface as a 400 at transition time — see below.

Read before asking. A question about a value that is already in the issue, or already
settled here, wastes the user's turn:
- **Reviewer** in front-avia, front-bus and front-railways is Dzhabrail Markhiev
  (`dzhabrail.markhiev@onetwotrip.com`). He is usually also the author — that is normal in
  these repositories and is **not** a reason to ask again.
- **DEV Estimate** — read `customfield_12213` first. Filled → no question. Empty → ask, it
  cannot be derived from the work.

**Jira at twiket (same workflow and field ids in every project).** The road to Code Review
is a chain; there is no direct transition:
`Backlog` --(511 Take from backlog)--> `Open` --(11 Start work)--> `In Progress` --(321 Code Review)--> `Code Review`

Fields that are mandatory along that road (otherwise 400):
- **DEV Estimate (h)** = `customfield_12213`, a number, and only via
  `--raw-field customfield_12213='1'` (through `--field` → "Operation value must be a
  number"). QA Estimate `customfield_12212` is not ours to fill.
- **Reviewer** = `customfield_10024` on transition `321`, as an **object**
  `{"name":"user@onetwotrip.com"}` (an array → "data was not an object").
- Time: the ordinary `POST /rest/api/2/issue/<KEY>/worklog` with `{"timeSpent":"1h"}`.

Two things that kill a transition without appearing in `?expand=transitions.fields`:

**The DoD checklist** — `customfield_12801` (`DoD Dev Field`, Okapya plugin). Transition `321`
returns 400 «Заполни все обязательные поля DoDа» until every mandatory item has
`checked: true`. An item that does not apply is `checked: true` **plus**
`"status": {"id": "notApplicable"}` — one ordinary `PUT /issue/<KEY>`, both keys together, no
reset and no second call.

**Read and write disagree on the key, and the wrong one fails silently.** GET returns
`statusId: "notApplicable"`; that key is read-only. Writing `statusId` answers `204` and
changes nothing — the request looks successful, so verify with a GET rather than trusting the
status code. What the parser accepts:

| Sent | Result |
|---|---|
| `"status": {"id": "notApplicable"}` | **works** |
| `"status": {"name": "notApplicable"}` | 204, ignored |
| `"statusId": "notApplicable"` | 204, ignored |
| `"status": "notApplicable"` | 400 «Could not process the JSON data to recreate a Checklist Item» |

Send every item back as GET returned it, changing only what you mean to change, and **keep
each item's `id`**: an item without `id` is recreated, so the whole checklist is renumbered.

The plugin's own REST (`/rest/com.okapya.jira.checklist/…`) answers a Bearer token with a 302
to the login page, so there is nothing to reach for there.

Ticking is a claim made to the team in the author's name. An item that is not true —
UI tests nobody wrote, a design-review that never happened — is marked `notApplicable`, never
ticked. Which items are true is the author's call, but the false ones are named out loud
rather than quietly closed.

**The parent epic** gates `11 Start work`: unless the epic is in `READY FOR DEV`,
`IN PROGRESS` or `PRODUCTION`, the transition 400s. Its own road there ends
`211 ready for dev` → `Ready for Dev` (then `51 to in progress`), but the id that reaches
`Discovery` depends on where the epic stands — `11` from `Backlog`, `191` from `DoR check`.
Ask the epic (`GET .../issue/<EPIC>/transitions`) instead of assuming; a wrong id answers
«you have tried to perform a workflow operation that is not valid for the current state».
The epic belongs to the team, not to the task — ask before moving it.

## Fix-comment template

Exactly ONE comment stating the fix. It answers a single question — "is it fixed?" — with
evidence, not with a retelling. The template text itself stays in the tracker's language:

```
Исправлено — видео: [^<feature>-fixed.mp4]

PR: [<N>|<url>]
```

- **The video is the recording AFTER the fix**, showing the corrected behaviour. The repro
  video ("how it breaks") belongs to the ticket's attachments, not to this comment. It is
  produced by the same demo script with `PHASE=after` — only the captions differ.
- Do not describe WHAT was changed (file, cause, diffs) — that lives in the PR.
- Do not name the branch or the commit hash — both are visible from the PR.
- Do not dump raw measurements or test runs — those belong to the bug description and the PR.
- Never add a second comment on the same subject — edit the existing one
  (in Jira: `PUT /rest/api/2/issue/<KEY>/comment/<ID>`).
- Reference attachments as links (`[^filename]`), not as plain text.
- Jira renders wiki markup, not markdown. A double hyphen (`--color-…`) is eaten as
  strikethrough EVEN inside `{{…}}` — escape it: `{{var(\-\-color-green-600)}}`.

## Invariants
- No action from steps 2-5 without the confirmation from step 1.
- No push while the PR description has no `## AI assistance` section, or the level is above
  `None` and `.ai/workspace/<KEY>/` is not staged alongside the code. A PR failing either is
  rejected by the reviewer anyway.
- One outward-facing action at a time, with the option to stop in between.
- Nothing irreversible beyond what was approved: do not merge the PR, delete branches, or
  change other people's settings.
- Report at the end: the PR link and the new status.
