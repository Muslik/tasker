---
name: test-ops-planning
description: Prepare a concise test-operations plan from task, repository, and workflow evidence. Use only when the compiled workflow contains the explicit fill-test-ops-plan step.
metadata:
  short-description: Test-operations planning guidance
---

# Test operations planning

Turn the immutable task snapshot, accepted implementation plan, repository test inventory,
and project workflow policy into an operational verification plan.

The plan must identify:

- observable checks and the behavior each check proves;
- required environments, fixtures, accounts, and feature flags;
- which checks are automated and which require a human;
- ownership and durable wait points for external work;
- open questions that block a safe decision;
- risks, likely flaky surfaces, and evidence that must be retained.

Do not edit the repository or any external system. Do not invent environments or test cases
that are unsupported by the available evidence. Return a blocking question when required
information is missing.
