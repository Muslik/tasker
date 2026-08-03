---
name: system-analysis
description: Run the system analysis (СА / SA) for an epic before anyone breaks it into tasks — establish the current state by measuring it in the running app, work out what exactly has to change and what it costs, prove the UI with screenshots, and publish a Confluence page that a manager can read and a stranger could implement from, ending with the questions that are still open. Use when handed an epic that needs СА (status "Ready for SA"), asked to «сделать СА / системную аналитику», or given an existing SA page to extend with a Frontend section.
user-invocable: true
argument-hint: EPIC-KEY | Confluence URL
---

# system-analysis — measure, decide, publish

Input: an epic that says what hurts and asks a question. Output: a Confluence page that
answers the question with evidence, lists what would have to change and what it costs, and
names what is still unknown — plus, in chat, a proposed ticket breakdown.

SA happens **before** the task exists, when it is not yet clear what to build. The
deliverable is therefore a **conclusion**, not a survey: a page that describes the code back
to the reader without concluding anything has failed even if every sentence in it is true.
But the conclusion is about what is possible and what it costs — see step 0 for the line
between that and the product decisions that are not yours to make.

The page is written in **Russian** (this skill is in English; the artefact is not).

## Prerequisites
- `confluence` (read) and `confluence-edit` (write) — same token. The storage-format
  cheatsheet in `confluence-edit/references/storage-format.md` is the reference for every
  macro; do not hand-guess Confluence XML.
- `jira` for the epic and its linked issues.
- `playwright-demo` for screenshots and video.
- The project's app runbook (`.ai/app-runbook.md` or wherever it lives): how to start the
  app, reach a state, log in. If there is none and the setup isn't obvious, say so in your
  output rather than guessing.
- `references/page-anatomy.md` in this skill — the section-by-section contract for the page,
  the destination table, and the title convention. Read it before assembling the body.

## 0. Know what is yours to decide
SA establishes **what is possible and what it costs**. What the product should do is not
yours: it belongs to product, design and whoever owns the copy. Confusing the two produces a
section called «Что делаем» in a research document, and a reasonable reader will ask by what
authority you decided.

So: when the epic already specifies a behaviour, quote it and say it came from there. When
the measurement rules a branch out, say what it rules out — that is a finding, not a
decision. Everything left over goes to Открытые вопросы addressed to the person who owns it.
The strongest shape is «эту ветку выбрал не я: в эпике описаны обе, измерение показало, что
первая невозможна».

## 1. Read the input to the bottom
The epic (`jira`), **and** everything it hangs off: linked issues, the Loop thread, the
attachments, any Confluence page it points at. Linked bugs matter most — they are the
evidence the problem is real and they usually contain the reproduction you would otherwise
have to invent.

Pull out three things and keep them separate:
- **The question SA must answer.** Often literally in the epic («Можем ли мы скрывать на
  поиске места для пассажиров с детьми?»). Put it on the page verbatim.
- **Decisions product already made.** Not yours to relitigate. If one looks wrong, it goes
  to Открытые вопросы, addressed to the person who owns it.
- **Acceptance criteria.** They are the spec of the section «Что тестировать».

If the epic asks a yes/no question, the page must answer it in one sentence somewhere near
the top, and the whole body must be the reasoning that supports that sentence.

## 2. Pick the mode and the destination
- **The page does not exist** → new page from `assets/sa-page.template.xml`. Destination
  space, parent page and title convention: `references/page-anatomy.md`.
- **The page exists** (an analyst or the backend already wrote it) → read its storage body
  first, keep its terminology and its section names, and add **one** section of your own:
  `<h1>Frontend</h1>` with your sub-headings under it. Precedent on this instance: the Дет5
  page carries `<h1>Бекенд</h1>` next to the FE part.

State which mode you're in before doing the work — it changes what you're allowed to touch.

## 3. Measure the current state, don't recall it
«Как сейчас» is the section reviewers trust least and lean on most, so it has to be fact.

Reach the state the way the **project's own tests** do: deep-link → deep-link + API mocks →
walking the live flow. Walk it live only when the steps are themselves the story. A step that
failed twice ends the guessing — `rg` through the specs for how that exact step is performed
and copy it.

Then read the target with the machine, not the eye: `getComputedStyle`,
`getBoundingClientRect`, the response field, the URL, storage. Print `KEY=value` pairs so the
finding can be compared later instead of retold.

Capture a **control** — the neighbouring case that works. It is what separates "bug" from
"by design", and it is the strongest section of a good SA page: the order-based page carries
«Почему на вебе "Мой заказ" работает», and that comparison is what made the solution obvious.

The control is also your harness check, so **put it in the same batch as the real cases**. A
harness that is quietly broken reports the same thing as a bug: an empty screen, a missing
element, a zero. If the case you *know* renders comes back empty too, the batch is invalid —
fix the harness, don't write down the finding. Gate every probe on something that proves the
page actually got there (the mounted form, not a fixed `waitForTimeout`) and report
"not mounted" as its own outcome, never as "nothing was there".

Prefer evidence the build cannot rename. Class names are hashed in a production bundle, so
"element not found by `[class*="lock"]`" proves nothing; a pixel diff, a computed style or a
`getBoundingClientRect` does. Before presenting two artefacts as different evidence, check
that they actually differ — two screenshots of "before" and "after" that hash the same are
either a mix-up or a finding, and you need to know which.

If the epic or a linked issue quantifies the pain (error counts, Kibana/Grafana numbers),
carry the number onto the page. «Массовость: >7200 ошибок за 2 недели» is what gets an SA
prioritised; «часто ломается» is not.

## 4. Read the code down to the line
Where exactly is the behaviour decided: the file, the condition, the state that feeds it.
Reference as `path/to/file.ts:120`, and quote only the deciding lines.

Before any claim about what is or isn't in the main branch — `git fetch`. A stale `origin/*`
turns into a confident false statement about a regression.

Trace the change end to end and write down every point that has to move — but record each one
as **an observable difference**, not as a module or an architectural layer. "query parse →
state → request builder" is where you will type; it is not something a reader can picture.
This list becomes the ticket breakdown, so a needed change must not be silently absent.

**Reading code is not evidence about how easy something is.** "The mechanism already exists,
we only need to route into it" is a claim about behaviour, and it needs the same proof as
«как сейчас». That exact sentence was once written here about a ready-made "seat
visible but locked" state — and the prototype showed the state blocks selection but renders
nothing at all, which changed the estimate from "fix two conditions" to "build a visual state
from scratch". Verify reuse by running it, or write it as a hypothesis.

## 5. Prototype until the behaviour in question actually changes
If the epic leaves a UI choice unresolved (hide the class vs. explain it), don't describe the
alternatives in prose — build it locally and screenshot it.

"Cheap" is about effort, not about stopping early. A prototype that only proves the element
reappears answers a question nobody asked; the question is whether the **user's experience**
changes. Carry it to the point where the thing under discussion is visibly different — the
communication, the block, the message — and then look for what still does not work by itself.

That second half is the valuable half. The list of "what the prototype did not give for free"
is the real estimate, and it is usually where the design work, the missing copy and the dead
code hide. Put that list on the page; keep the prototype's screenshot for what it genuinely
shows.

Never publish a screenshot of a prototype whose layout is broken by your own hack (an alert
overlapping a button, a stray debug element). It reads as a design proposal. Describe the
finding in words instead.

## 6. Screens and video are mandatory when there is visible UI
Attach «как сейчас» for the broken/current behaviour, and «как будет» when you prototyped it.
Use `playwright-demo` when the story is a sequence rather than a state.

A text-only SA is allowed **only** for pure data/contract work (a backend field, a mapping,
an API shape) — and the page must say why there is nothing to show.

Media and any code block over ~15 lines go inside an `expand`. The page must stay skimmable
at full length: headings, short paragraphs, tables.

## 7. Write for someone who will never open the repo
Managers and analysts read this page. Every heading, every bullet, every table key must make
sense to them; identifiers belong **inside** the explanation, never in place of it. A row
keyed `prepareFreeSeats.ts:169` says where you will type. A row keyed «Класс перестаёт
пропадать с экрана», with the file in a side column, says what changes — and the reader who
needs the file still gets it.

Same test for the whole page: if a section can only be parsed by someone holding the
codebase, either lead it with a plain sentence or move it into an `expand`.

**The page carries results, not your working process.** No "правка откачена", no "src/
чистый", no account of what you disabled to take a screenshot, no narration of which branch
you rebuilt. That belongs in chat, to the person who asked. On the page it is noise at best,
and at worst it reads as if unfinished work were shipped.

## 8. Draft → STOP → publish
1. Assemble the full storage-format body into a local file — `.omc/sa/<EPIC-KEY>.xml`.
2. Show, in chat: the destination (space, parent page, title), the heading outline, the
   one-sentence answer to the epic's question, and the list of Открытые вопросы.
3. **Wait for an explicit yes.** A Confluence page mails every watcher of the space.
4. Publish: `confluence-edit --create`, then `--attach` the media, then re-read the body and
   confirm no macro rendered as an error box.
5. Later edits go through the same file → `--update`, never by retyping the body.

## 9. Hand off
Report the page URL. Then, **as text in chat**, propose the ticket breakdown cut from the
layers in step 4: one line per ticket, what it does, what blocks what.

Do not create Jira tickets, and do not fill the `Links` / `Release` panels with keys you
invented — leave the SA-ticket cell as a placeholder and ask which key to put there. Offer:
"создать эти задачи?" — on agreement, hand over to `jira-issue`.

## Invariants
- **Never state current behaviour from reading code alone** when the app can be run. This
  covers claims about how easy a change will be, not just claims about what happens today.
- **Never leave an unknown implicit.** Anything you could not determine is a line in
  Открытые вопросы, addressed to a named person or team. An SA with no open questions is
  usually one that didn't look hard enough.
- **An open question addressed to your own audience is unfinished work.** Before writing one,
  ask who answers it — if the answer is "the team that owns this page", it is a task for you:
  go and find out. Questions qualify only when they need a decision or information from
  someone else. «Это баг или так задумано?» about your own code is you not having checked.
- **A report you cannot reproduce is not a wrong report.** When someone describes a symptom
  your measurement doesn't produce, the default is that you haven't found their path yet —
  not that they misremembered. Look at the screenshots in the original ticket, and check
  `git log -S` for when the behaviour changed: the difference is often that the report
  predates a fix. Correct someone's account only after you can explain what they saw.
- **Never invent requirements.** A good idea that product didn't ask for is a proposal in
  Открытые вопросы, not a requirement in Требования.
- **Never restructure someone else's page.** Add your section; leave theirs alone.
- «Нельзя / не надо это делать» is a valid outcome. An SA that concludes the change is not
  worth it, with the measurement to back that up, has done its job.
- No estimates unless asked. SA sizes the work by listing it, not by putting hours on it.
