---
name: grill-me
description: Adversarial interrogation of the task before planning. Hunt for contradictions, ambiguities, and unstated decisions in the task and evidence; when a real one is found, return needs_clarification with hard, discriminating questions instead of planning on top of a guess.
---

# Grill Me — adversarial task interrogation

## Goal

Refuse to plan on top of guesses. A plan built on an unstated assumption fails late and
expensively — during verification, review, or human code review. Interrogate the task
first; make the operator decide the things only the operator can decide.

## When to apply

During implementation planning, after reading the task snapshot and the evidence
bundle, **before** committing to a `ready` decision. This skill governs when to return
`needs_clarification` and how to write its questions.

## Interrogation checklist

Scan the task and evidence for these defect classes. Every hit is a candidate question:

1. **Contradiction** — description, comments, linked pages, and design disagree with
   each other or with the current code behavior.
2. **Multiple plausible readings** — two or more implementations would each satisfy the
   text; the choice between them changes user-visible behavior.
3. **Undefined edge behavior** — empty states, errors, concurrency, locale/currency,
   permissions — anything the acceptance verdict will hinge on but the task never states.
4. **Scope boundary** — it is unclear what must NOT change (adjacent features, shared
   components, public contracts).
5. **Hidden dependency** — the work seems to require an unpublished package, another
   team's change, a feature flag, or an external configuration the task does not mention.
6. **Unverifiable acceptance** — the task gives no observable way to tell "done" from
   "not done"; you cannot write an honest acceptance criterion for it.
7. **Silent irreversible decision** — the plan would silently commit to something hard
   to undo or highly user-visible (data migration, tracking events, pricing/copy changes).

## Rules for questions

- Ask **only** questions whose answer changes the plan. If every answer leads to the
  same plan, do not ask.
- **Never ask what the evidence already answers.** Check the task snapshot, comments,
  attachments, and evidence bundle first; if the answer is derivable, derive it and move on.
- Make each question **discriminating**: name the concrete options you see and the
  consequence of each, so the operator picks instead of writing an essay. State the
  reading you consider most likely — the operator confirms or corrects.
- Put the option analysis and the "what breaks if guessed wrong" into the `reason`
  field; keep `question` itself short and answerable.
- Rank by impact, cap at the schema limit of 10; if you found more, ask the top ones
  and fold the rest into the plan as explicit assumptions.
- **One grill round.** After answers arrive (operator guidance / clarification answers
  in your context), plan. Re-grill only if the answers themselves introduce a new
  contradiction — never to re-ask old ground in new words.
- Never fabricate an answer to your own question and proceed as if it were given.

## Output

Return the planner decision `needs_clarification` per the planner output schema:
each question is `{id, question, reason}` with a kebab-case `id`, `question` and
`reason` up to 2000 characters, at most 10 questions. If nothing on the checklist
fires, do not force questions — proceed to a `ready` decision with the assumptions
you did make listed explicitly in the plan.
