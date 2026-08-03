---
name: playwright
description: Apply the user's Playwright conventions — page objects own interaction, locators built from role and accessible name, web-first assertions, test.step instead of comments, describe per state. Use when writing, reviewing, or debugging Playwright end-to-end tests.
metadata:
  short-description: Playwright test structure and locator conventions
---

# Playwright

Use this skill when authoring or reviewing Playwright tests, page objects, and fixtures.

## Page Objects Own the Interaction

- Selectors, actions, and waits live in the page object. A test reads as a scenario:
  open, act, expect — not as markup.
- A page object exposes locators and performs actions. It does not assert; a page object
  that decides what is correct cannot be reused by a test that expects something else.
- Reuse the existing page object instead of re-deriving a selector inside a test. Two
  definitions of the same element drift, and the test that owns a copy breaks alone.
- When a step already exists in a page object, call it rather than repeating its action
  sequence — the order of interactions is part of what the object encodes.

## Locators Describe What the User Sees

- Default to role and accessible name: `getByRole('button', { name: 'Submit' })`. It is
  what the user perceives, and it fails loudly when the control stops being a button.
- Then content and labels: `getByLabel`, `getByText`, `getByPlaceholder`.
- Then the project's stable test attribute, when the element has no meaningful role.
- Structural locators — CSS classes, DOM paths, `nth-child` — are not an option. They
  break on any markup change and assert nothing about behaviour.
- A locator must resolve to exactly one element. Narrow with `exact: true`, `filter`, or
  a scoped container rather than reaching for `.first()`; an index hides the day a second
  match appears.

## Assertions Are Web-First

- `await expect(locator).toBeVisible()` retries until the timeout. It is the default form.
- Never assert on a snapshot of state: `expect(await locator.isVisible()).toBe(true)`
  samples once and flakes.
- Do not paper over timing with `waitForTimeout`. Wait for the condition that proves the
  action landed — a request, a URL, an element — with an explicit short timeout.
- **A retrying assertion is also the synchronisation point.** Put the one that proves the
  flow finished FIRST, then state the negative fact. `await expect(error).toHaveText(…)`
  followed by `expect(requests).toHaveLength(0)` needs no timeout of its own — the error
  appearing is what makes "no request was sent" a claim about a settled page.
- **Do not invent a timeout to express a negative.** A hand-picked
  `waitForRequest(url, { timeout: 5000 })` buys nothing over the ordering above: it is a
  magic number, and in the passing case the test simply sits there. Numbers in a test
  should come from the app's contract, not from a guess.

## Assert the Whole Object, at the Right Unit

- Pin the shape, not one field at a time. `expect(payload).toEqual({…})` states what the
  app sends AND proves that nothing else is there; a missing key is caught for free.
- Loose matchers hide bugs. `toBeFalsy()` passes for `''`, `null`, `0` and `undefined` —
  four different contracts, one green test. Reach for it only when the distinction genuinely
  does not exist.
- Choose the unit deliberately: the object the test is about (the card in the payment
  request), not the whole envelope — ids, totals and timestamps churn and turn an exact
  assertion into a maintenance tax.
- The same applies to errors: `toBeVisible()` on an error element passes when a DIFFERENT
  error appears. Assert the message.

## Assertions Live in Tests

- Helpers and fixtures return data and locators; the test decides what is correct. An
  `expect` inside a helper hides the claim from the file that is supposed to state it, and
  the failure points at the helper instead of the scenario.
- A helper that both acts and asserts cannot be reused by the next test, which needs the
  same action and a different expectation.

## Prove the Test Can Fail

- A green test proves nothing until you have seen it red for the right reason. Break the
  behaviour under test — invert the flag, stub the condition — and confirm that exactly the
  relevant test fails and the rest stay green.
- Do this whenever the assertion is a negative ("no request", "no error"): those pass just
  as happily when the page never loaded at all.

## Steps Are Named, Not Commented

- Wrap a meaningful phase in `test.step('...')`. The name reaches the report and the
  trace, so a failure points at the phase that broke.
- A comment above a block does neither. If a step is worth explaining, it is worth naming.

## Group by State, Not by Convenience

- `describe` collects the checks that share one arrangement; the shared setup goes to
  `beforeEach`.
- Inside the group, each test asserts one invariant of that state, so a failure names the
  invariant that broke rather than the scenario that contained it.
- Nest a further `describe` when a sub-state needs its own arrangement; do not reuse one
  block for two unrelated states because the setup happens to be similar.
