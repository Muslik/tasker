---
name: test-design
description: Apply the user's preferences for what deserves a test and what a test asserts — behaviour over incident, public surface over internals, no tests for plain data, one act per test, assertions only in tests. Use when writing, reviewing, or deciding against tests, in any language or runner.
metadata:
  short-description: What to test and what the test asserts
---

# Test Design

Use this skill when writing or reviewing tests, and when deciding whether a test is
warranted at all. It is runner-agnostic: it governs **what** a test covers and what it
claims, not how a particular framework is driven.

The question a test answers is "what should this do", never "what went wrong once".

## A Test States Expected Behaviour, Not the Incident

- A bug report supplies the *condition*, not the wording. Take the input; write the
  contract.
- `does not crash when the code is empty` is not a contract — it is a tombstone for one
  defect. `an empty error code shows the generic error` describes what the system owes
  the user and survives the refactor that removes the original crash.
- Name the test as a sentence about behaviour. If the name only makes sense to someone
  who read the bug ticket, rewrite it.
- Fixing a defect adds a test for the behaviour that was missing, not for the symptom
  that was reported.

## Test the Surface, Not the Internals

- Test what callers can call. Internal `prepare`, `format`, `normalize` helpers are
  implementation: a test on them pins the current shape of the code and breaks on any
  rewrite while proving nothing about the feature.
- Coverage of an internal helper is coverage of the public path that uses it. If the
  public path cannot reach a branch, the branch is dead or the helper deserves to be
  public — decide that, do not paper over it with a test.
- The urge to test a private function directly is a design signal, not a testing need.

## Do Not Test Data

- A map that returns literals verifies itself. A test over it restates the same
  literals, fails on every copy edit, and has never once caught a defect.
- Test where a decision happens: branching, parsing, state transitions, interaction
  between parts, error paths.
- Before writing a test, name the defect it would catch. If none can be named, do not
  write it.

## One Act per Test

- Arrange, act, assert — in that order and visibly separated.
- Two actions in one test means two tests. A test that fails should point at one cause.
- Shared setup belongs in the fixture or hook, not repeated in each test.

## Assertions Live in Tests

- A helper or page object containing an assertion hides the reason for the failure and
  cannot be reused: the same step means different expectations in different tests.
- Helpers reach state and return values. Tests decide what is correct.
