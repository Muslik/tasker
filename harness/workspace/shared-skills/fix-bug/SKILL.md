---
name: fix-bug
description: Take an existing bug ticket to review-ready — reproduce it yourself first, attach the missing proof to the ticket, fix the cause, cover it with a test named after system behaviour (not after the incident), record the fix on video, then commit, push, open the PR and move the ticket to review. Use when given a bug ticket key or link and asked to fix it.
---

# fix-bug — from ticket to code review

## 0. Read the ticket
`jira` or equivalent: steps, actual/expected result, attachments. Do not invent what is
missing — ask.

## 1. Reproduce it yourself
Do not take the description on faith: steps go stale and "actual result" is a retelling.
Reach the state per the runbook and take a **measurement** of the target fact plus a
**control** — the neighbouring case that must keep working (see `investigate-bug`, steps 2-3).

**Cannot reproduce → STOP.** Write into the ticket what you checked and what is missing.
Fixing blind is the worst outcome: the change ships with nothing proving it was needed.

## 2. Put the proof into the ticket
No video or screenshots attached → record them (`playwright-demo`, `PHASE=before`) and
attach. This happens **before** the fix — afterwards the "before" no longer exists.

## 3. Fix
The code is written in a worktree, never in the main checkout: `wt -b <TICKET-branch>`
creates the branch and the worktree off `master` (the post-create hook installs deps and
relinks the skills), `wt path <branch>` prints where it landed. Already in the worktree for
this ticket — stay there. Half-written fix sitting in the main checkout — move it before
committing, not "just this once".

The smallest change that removes the **cause**, not the symptom. Check what else flows
through that spot: the control from step 1 must come out unchanged.

## 4. Test the system's behaviour, not the incident
What deserves a test and what it asserts — see `test-design`. What gets violated most
often is the **name**.

Bad (named after the incident — legible only to whoever read the ticket):
- `if backend sent errors: { true: true }, frontend will fail`
- `correctly work with { a: b } and { a: c }`

Good (named after system behaviour):
- `correctly handles a malformed backend response`
- `supports the RT variant with many seats`

Name check: would it make sense to someone who has never heard of this bug? If it only
makes sense next to the ticket link, rename it.

- **Fixtures**: the state that broke is usually absent from the project's fixtures — which
  is why the bug survived. Add it to the fixtures instead of patching data inside the test.
- **A test is impossible** (pure cosmetics, no observation point) — say so explicitly and
  why. Never skip it silently.

## 5. Verify
- The new test: **red before the fix, green after**. Check both directions — a test that
  has never failed guards nothing.
- Run the neighbouring tests of the area, and snapshots per the project's rules (where and
  how to run them is in the runbook; running snapshots locally may lie).
- Repeat the measurement from step 1: the target changed, the control did not.

## 6. The "after" video
`playwright-demo`, `PHASE=after`, **the same script** — only the captions differ. This is
the video that goes into the ticket comment.

- The scenes cover what the TICKET named as affected — the shared spot, the neighbouring
  branches — not only the case that broke. A ticket saying "this touches Book/Pay" against
  an "after" video showing just the fixed screen is half the job.
- A unit test does not stand in for a scene the ticket named. If the state genuinely cannot
  be reached for a recording, say which check covers it instead — in the report, not only
  to yourself.

## 7. Finalize
Use `pr-finalize` (a profile-specific one overrides the shared one): drafts → stop →
commit, push, PR, comment, status. The fix comment follows the template there: the "after"
video plus the PR link, with no retelling of the change.

## Invariants
- Never start fixing before reproducing.
- The "before" video stays an attachment of the ticket; the fix comment carries the
  "after" video.
- Never commit throwaway scripts or recording artifacts — keep them in scratch directories
  listed in `.git/info/exclude`.
