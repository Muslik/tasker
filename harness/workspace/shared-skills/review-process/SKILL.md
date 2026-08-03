---
name: review-process
description: Work through reviewer comments on a pull request — pull every thread, verify each claim BY RUNNING IT rather than taking it on trust, agree the fix list with the author, fix what is justified, decline the rest with a reason, and answer in the threads. Use when given a PR link and asked to address or close review comments, or when a reviewer asserts something about how the code behaves and that needs checking.
---

# Review process — comments are hypotheses, not facts

Input: a pull request. Output: an answer in every thread, backed by evidence.

A reviewer — especially an AI-assisted one — states a **hypothesis**: "this will not
work", "that flag became a no-op", "this test asserts nothing". Some are right, some are
wrong, and some are right about the mechanism while wrong about the consequence. Only
running something tells them apart. Never rewrite code from the wording of a comment, and
never dismiss a comment on intuition. Both mistakes have the same cure.

## 1. Pull the threads

Fetch every thread with its file and line anchors and the id of each comment. Drop
review-bot summaries unless asked otherwise — automated verdicts carry no findings.

Note which threads the author already answered; those need a reply only if something
changed since.

## 2. Verify every claim

For each comment, decide what you would have to observe in order to believe it, then go
observe it. Techniques, cheapest first:

**Read the implementation, not the documentation.** Docs lag and generalise. Read the
actual installed dependency, the actual config, the actual generated output. A claim about
a default value is answered by finding where the default is applied and checking whether
that code runs at all.

**Check whether the path is reachable.** Before fixing a failure mode, confirm it can
occur: how the CI environment is isolated, whether the script in question is even wired
into a pipeline, whether the branch of code is entered under the conditions described.
An unreachable problem needs an explanation, not a fix.

**Run it and observe.** Servers, routing, integrations: stand the thing up in a throwaway
script and drive it. The answer to "does it fail silently" is a table of what happened to
each input, not an argument about what should happen.

**Mutation-test a test.** To check "this test asserts nothing", break exactly what the
test claims to cover and confirm it goes red. If your new assertion fails on the mutation
while the neighbouring one stays green, the comment was right and is now closed.

**Measure, when the claim is about cost or speed.** Mandatory: a control arm, repeats, and
first a demonstration that the signal exists at all. If the two states you are comparing
do not differ measurably, the experiment cannot answer the question — scale up until they
do, or say the question stayed open. State what the measurement did not cover.

**Separate mechanism from consequence.** "These two share a resource" and "they corrupt
each other" are different claims; the first can hold while the second does not. Verify the
one the comment actually rests on, not the one that is easier to check.

Give every comment a verdict: confirmed / mechanism right but consequence not / does not
reproduce / unreachable in practice. State it with numbers, paths and commands, so the
reviewer can re-run it and disagree.

## 3. Agree the fix list before writing it

Show the author the verdicts and, against each, what you propose: fix it, answer it, or
take it to product. One message, before any implementation. This is the cheapest place to
lose an argument — a rejected fix costs a sentence here and the whole branch once it is
written, tested and rebuilt.

Assume the list will be cut. Anything you cannot defend in one line does not go on it.

## 4. Fix what is both cheap and justified

Cheap is a necessary condition, not a sufficient one. Every change needs a reason of its
own that survives being said out loud to the author: it fixes a defect you reproduced, or
it delivers something the task actually asks for. "It is small", "it is more correct in
principle" and "just in case" are not reasons. Cheap is also often not cosmetic:
verification regularly shows a "nit" is hiding a hard failure — that one has a reason.

Ask what stage the code is at before deciding. An MVP and a mature feature take opposite
answers to the same comment: hardening an external boundary, adding a signal to the UI,
covering a contract branch with fixtures are all right later and wrong now. If the stage
is not obvious from the repository or the task, ask the author in one question.

What not to do:

- **Do not defend against what the codebase does not defend against.** Before writing a
  runtime guard, find two comparable places in the same repository and match them. If
  nobody guards that boundary there, the finding is answered in prose — "this is not the
  practice here, we guarded the minimum we could" — and the general fix, an error boundary
  or a validation layer, is a separate task with its own decision. A guard earns its keep
  only when the error leaves the author's field of view: it passes locally and breaks for
  someone downstream. If whoever runs it sees the symptom immediately, prose is enough.
- **Do not add UI the task did not ask for.** A banner, a badge, an extra column is a
  product decision, not a fix. Say what the user cannot see today and let the author decide.
- **Do not widen the fix into adjacent rot.** Something that was already broken before
  this PR is separate work: report it, say it is pre-existing, and ask.
- **Do not add commentary to code that explains itself.** Comment only where the "why"
  is not recoverable from the code.

If a check disproves something — including your own earlier claim — say so plainly and
drop what you built on it. A removed unnecessary line beats one kept "just in case".

After the fixes: run the tests, run the formatter and linters on the touched files, leave
a clean working tree. Confirm that pre-existing lint or format problems are not being
attributed to your change by checking the same file before your edits.

### The bar for a new test

A test earns its place only if it can go red because of our code. Before writing one, name
the change to our sources that would break it; if the answer is "the library would have to
change" or "nothing, it restates what the code does", do not write it.

That rules out framework defaults (a modal closing on Escape, a control rendering all its
options), restatements of behaviour ("the modal makes no extra request", "the second row
shows the second row"), and one test per field. Prefer strengthening an assertion in an
existing test over adding a neighbour to it. Mutation-test whatever you add or rewrite:
break the line it claims to cover and confirm it goes red.

## 5. Answer

Draft replies for **every thread at once** and show them to the user before anything is
sent. Rules for the text:

- first person, the way a person writes and not the way an agent writes: no headings, no
  wall of bullets, no emoji, no "AI-assisted" framing
- short — one to three sentences for a simple comment
- a decline names the rule behind it — the practice of this repository, the stage of the
  product, the behaviour of the library — not just that it feels wrong
- "I measured it" says how, and with what numbers
- a confirmed finding says what it is now, with a number, path or command
- write in the language of the review

Send only after an explicit go-ahead: a posted comment is immediately visible to
colleagues. Order matters — the fixes should already be where the reviewer will look
before the replies point at them. Afterwards re-read the threads and confirm each reply
landed under the right parent.

## What not to do

- Do not take a comment's wording on trust, and do not trust intuition against it.
- Do not implement anything the author has not agreed to, however small it looks.
- Do not answer with code when the honest answer is "we do not do that here".
- Do not leave "I'll file a follow-up" / "I'll measure later" / "I'll do it next time I
  touch this file" for something that takes minutes now. Defer only what genuinely needs
  a separate decision.
- Do not post anything the user has not seen and approved.
