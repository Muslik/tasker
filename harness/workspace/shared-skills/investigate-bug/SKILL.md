---
name: investigate-bug
description: Confirm or refute a reported problem when no ticket exists yet — reach the broken state, MEASURE the wrong fact instead of eyeballing it, record proof on video, then file a tracker ticket with the cause and the fix path, or report that it does not reproduce. Use when someone reports something broken (a chat thread, a screenshot, a link, «глянь, тут криво») and it has to be confirmed before anyone spends time fixing it.
---

# investigate-bug — confirm, prove, file

Input: raw context — a thread, a screenshot, a link, "it doesn't work for me".
Output: **either** a ticket carrying proof and a fix path, **or** a "does not reproduce"
verdict listing what was checked. Both are valid endings; never file a ticket just to
have filed one.

## Prerequisites
- **The project's app runbook** (`.ai/app-runbook.md` or wherever it lives): how to start
  the app, how to reach a state, how to log in. No runbook and the setup isn't obvious →
  say so in your output instead of guessing.
- Tracker access (`jira` / `jira-issue`, or the project's equivalent).

## 1. Extract a checkable claim
What exactly should be different, and WHERE. "The arrow should match the seat back" is
checkable. "Looks off" is not — go back to the reporter.
Pin down the **target** right away: a selector, a response field, a URL param, a stored
value. That is what you will measure; everything else is context.

## 2. Reach the state
Order of preference: deep-link → deep-link + API mocks (the way the **project's own
tests** reach deep pages) → walking the live flow. Walk it live only when the steps
themselves are the story.

**A step that failed twice ends the guessing.** Do not hunt for coordinates: find how the
project's tests perform that exact step (`rg` through spec/tests) and copy it.

## 3. Measure it, don't look at it
Read the target property with the machine: `getComputedStyle`, `getBoundingClientRect`, a
field of the response, the URL, storage. Print `KEY=value` pairs so the result can be
compared later rather than retold.

Capture a **control** next to the target — the neighbouring case that is supposed to work.
It separates a bug from "by design", and later it catches a fix that overshoots.

A throwaway script is fine here (it dies with the task). It is not a test: tests belong to
`fix-bug`, once the cause is known.

## 4. The fork — the investigation may end here
- **Did not reproduce** → report what you did, what you measured, what was missing (data,
  access, environment, version). Do NOT file a ticket.
- **Reproduced differently** than reported → describe YOUR measurement, not the reporter's
  retelling.
- **Not our layer** (the backend returns garbage) → still file, but state the ownership
  boundary and include the response that proves it.

## 5. Record the proof
Use `playwright-demo`, phase `before`. What must be in frame is listed there under
"What MUST be on screen": the backend response when the bug is about data, the address bar
when a URL is involved, the magnifier when the difference is small.

## 6. Find the cause and the fix path
Before any claim about what is or is not in the main branch ("this is a regression from X",
"the fix never landed") — `git fetch`. A local origin/* goes stale silently, and the whole
causal story gets built on top of it.

A ticket without "where exactly" is expensive for whoever picks it up. Read down to the
line: the file, the condition, why the wrong branch is taken. Put into the description the
**cause**, the **proposed path**, and **what it risks** (what else flows through that spot).

## 7. Draft → STOP → create
Assemble the ticket from the tracker's template (`jira-issue` or equivalent), **show it and
wait for an explicit yes**. Creating, attaching, linking — only after that. Attach the
video and the frames.

## 8. Offer to fix
Close with one line: "fix it now?". On agreement, hand over to `fix-bug` with the key.

## Invariants
- Never file a ticket from someone else's description without seeing the problem yourself.
- Never edit source code to force a reproduction.
- Never pass "looked at it" off as a measurement.
