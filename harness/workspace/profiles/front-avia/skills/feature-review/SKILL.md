---
name: feature-review
description: "Deep review of a feature's branch/commits for a Jira task in front-avia — requirements-first, shared-flow isolation touchpoints, a mandatory simplification pass, QA-case coverage matrix, quiet-trap hunting; findings labeled blocker/question/nit with the fix shown as code; can publish findings as a pending (draft) Bitbucket review. Use when asked to review a feature, branch, PR, or a task's commits («ревью фичи/задачи»)."
---

# Feature review

`.ai/REVIEW.md` is the base checklist. This skill is the method around it and the traps the checklist won't catch.

## Scope and requirements first

- The branch may sit on top of another unmerged feature branch. Review only the task's commits (`git log --all --grep=<KEY>`); the parent branch is context, not scope.
- Read the real requirements before judging code: the Jira issue (`jira` skill), the SA doc and QA cases in Confluence (`confluence` skill). Tiny links (`/x/…`) resolve via `curl -sL -o /dev/null -w '%{url_effective}'`; credentials load themselves (scripts read $TASKER_HARNESS_ENV_FILE); for ad-hoc curl use `"${TASKER_HARNESS_BIN}/with-env" <cmd>`.
- SA and QA cases can contradict each other (QA expects a UI element the SA never mentions; QA phrasing implies an earlier trigger than the SA's condition). Surface every contradiction as a question to PO/QA with both sources quoted — never silently pick a side.
- A deviation from the SA sketch is often an improvement (SA marks its code non-binding). When it is — say so explicitly. When it drops something QA will test — that's a finding.

## Verify claims by reading source

Never trust a name; before writing (or dismissing) a finding, read:

- the actual prop/return types of the ui-kit or shared helper involved — e.g. a `message: string` prop that happily renders ReactNode means the fix is an upstream type PR, not component surgery;
- the semantics of the infra being leaned on: `createDataLoader().error` resets `data` to initial (an API failure silently clears a "forbidden" flag — fail-open); `TAKE_LAST` aborts the previous request only on a NEW dispatch of the same thunk — a separate reset action does NOT cancel an in-flight request, so a late `fulfilled` overwrites the reset; `dispatch(someFx(...))` returns a promise of the `Either` — awaiting it in a handler is always available;
- whether cached state is keyed by ids that travel with the data (form values) or by render position — index-keyed caches desync when a middle slot is removed.

Run `pnpm typecheck` and the new unit tests; report results as evidence, not adjectives.

## The simplification pass

Run this as a separate pass after correctness. The highest-value findings are deletions: a refactor that removes a hook, two effects, and a flag outranks any number of nits — lead the review with it. A review that only polishes the code that exists has failed if a third of that code didn't need to exist. "No useless effects" is not enough — an effect can be working, guarded, and correct, and still be the wrong shape.

Tells that machinery is emulating simpler control flow:

- **A one-shot effect guarded by a ref** (`hasFiredRef`-style) — an event continuation spread across the render cycle. Name the user event that starts the chain and move the code into its handler; await the dispatch inline.
- **An `isSettled`/`isReady` boolean whose only consumer is an effect's guard** — an `await` flattened into flags. It dies together with the effect.
- **`useEffect` that resets local state when a prop changes** — that is `key={...}` on the component; remount is the reset.
- **A returned function that silently no-ops based on selector state read from the render closure** ("fetch that may not fetch") — caching policy living at the call site. Move it into a conditional thunk (`fetchSomethingIfNeeded` reading `getState()`): the policy lands in one file, every future caller gets it for free, and the stale-closure double-dispatch race disappears.
- **An effect with a long deps array where only one transition actually matters** — the array is simulating "when X completes", and every extra dep is a future spurious re-fire.

The litmus test: rewrite the scenario as top-to-bottom imperative code in the event handler, early returns allowed. Whatever flags, refs, and derived booleans the rewrite doesn't need were accidental complexity. One thing the effect version got implicitly that the imperative version must do explicitly: after an `await`, re-check that the world hasn't shifted (the slot still holds the same id) before writing into shared state.

## Isolation from the shared flow

Enumerate every point where the feature's commits change shared-flow behavior: schema loosening, shared error handlers, fields added to shared form types, shared buttons reading new state. Each is a finding until named and shown deliberate — "state stays initial → props are no-ops for other flows" is the argument that allows it, not a reason to omit it from the review. Feature-namespaced l10n keys reached from shared code paths get renamed to neutral keys — otherwise a future "clean up feature keys" pass breaks the main flow.

## State placement

- Raw API results stay private to `model/`. Consumers get narrow selectors: exactly the fields they use, defaults (`?? false`) applied inside the model. A page component digging into `result?.someFlag` is the model's shape leaking out.
- Per-item consumers (a card in a list) select their own slice via a parametric selector (`createParametricSelectorHook` in `src/shared/lib/redux`) instead of a Map built at the top and drilled down. A prop a component only forwards is the tell — including props derivable from the store in one line where they're used.
- UI props typed as `api.*` mean the API layer leaked into UI — the model re-exports the domain type.
- Not everything goes deep: a single-instance cache (message-listener lookup maps) belongs to the one component that owns the subscription lifecycle.

## Component structure

- Component folders are flat: subcomponents one level under `ui/`, both directions of a message protocol side by side in `hooks/`, shared `lib/`/`constants.ts`/`types.ts` at the top. Organism-inside-organism nesting expresses in folders what JSX already expresses — flatten it.
- A thin container is not a useless wrapper when it owns something that must exist once (a listener, a cache, a lazy boundary). A 25-line component wrapping one ternary usually is.
- Lazy chunks: the skeleton/fallback must stay out of the lazy import graph. The clean shape is the organism's own `index.tsx` as the lazy boundary (`lazyWithRetry` + fallback live there); never re-export chunk internals from that entry — one static import through it drags the whole graph into the main bundle and kills the split with zero failing tests.

## Typing at boundaries

- `postMessage` payloads are external input exactly like API responses: `JSON.parse(x) as T` is a finding; the fix is a zod schema + `safeParse` + `logError` on mismatch. The schema doubles as executable documentation of the host-frame contract.
- When the contract documents an enum (`'OK' | 'FORBIDDEN' | …`), `z.string()` plus a literal comparison downstream is silent drift waiting to happen — `unionOfLiterals` from `src/shared/lib/zod`.
- `as unknown as X` never merges as-is: fix the upstream type (ui-kit PR), keep one isolated, commented cast with a ticket reference until it lands.
- `FixMeAny` propagated from an already-untyped legacy store slice is tolerable debt; introducing it in a NEW contract without a comment naming the source and the ticket is not.

## Tests

- Build a case-by-case matrix against the QA cases, not "tests exist". Two adjacent cases can differ only in which side of an assertion flips (soft violation → warning shown vs approval-without-violation → warning absent) — the absence case needs its own mock and test.
- The mock-tautology trap: a test asserting behavior implemented inside its own fixture (the fake host auto-answers) pins the fixture, not the app. Name what the test REALLY verifies (e.g. two rapid sequential messages) and flag the contract that stays unverified against the real host.
- Outgoing contracts need assertions too: record messages sent to the host in the fixture (`window.__outgoing ||= []`) and assert payloads (dedup lists, allowed types) — the UI effect lives on the other side, so nothing else catches a regression.
- Any code branch that never rendered in any test is the first place to look (the zero-documents / admin-vs-not fork; a select whose mock offers only one option can never exercise its onChange).
- Error paths: what does the UI do when the request fails? Fail-open vs fail-closed must be a stated decision with a test, not an accident of the loader's reset semantics.
- Reusable e2e fixtures live in `spec/mocks/`, one copy — a snapshot spec re-implementing the logic spec's host mock is a finding.
- Date-dependent UI (an "expiring soon" label) gets a unit test on the boundary, not a brittle e2e with a fixed date.

## Findings vocabulary

No traffic-light emojis. Prefix every finding:

- `blocker:` — must be resolved before merge (bugs, requirement gaps, type-safety violations).
- `question:` — needs the author's answer or a recorded decision; a change is not necessarily required (an accidental fail-open, a suspected deliberate descope).
- `nit:` — optional polish; always labeled so the author can skip it guilt-free.
- No prefix — a normal finding: should be fixed, with the better code shown inline.

## Publishing to Bitbucket as a draft review

Findings go to the PR as pending comments the requester reads and publishes themselves («start review»). The MCP comment tool has no state parameter and publishes instantly — never use it for review comments. Use REST directly:

- `POST https://bitbucket.twiket.com/rest/api/latest/projects/{KEY}/repos/{slug}/pull-requests/{id}/comments`, Bearer `BITBUCKET_TOKEN` from `$TASKER_HARNESS_ENV_FILE`, body: `{ "text": "…", "state": "PENDING", "anchor": { "diffType": "EFFECTIVE", "path": "…", "line": N, "lineType": "ADDED", "fileType": "TO" } }`; omit `anchor` for the general comment.
- Post ONE comment first and check the response says `"state": "PENDING"` before sending the rest; if it comes back `OPEN`, delete it immediately and stop — the instance doesn't support drafts.
- Take line numbers from `git show <commit>:<path> | grep -n '…'`, never from diff-hunk arithmetic; the anchored line must be part of the PR diff.
- One finding — one comment, anchored at the most telling line. Every comment self-contained: no references to other tasks, other reviews, or the conversation that produced it.
- Plus one general comment: two-line verdict, what is done well, and non-code notes (QA wording to fix, contract questions).

## Report

Verdict first, in chat as well as in the PR: what blocks merge, what can ride a follow-up. Findings use the same vocabulary as PR comments (blocker / question / nit / unprefixed). For anything code-shaped show the better code inline. Acknowledge what's done well — improvements over the SA sketch, prior remarks addressed proactively.

Language: match the audience (this team reads Russian). Never write English terms in Cyrillic transliteration («флашатся», «специфисити») — use the English term as-is (flush, specificity) or a real Russian phrase; if a sentence only parses for someone who knows the English original, rewrite it.
