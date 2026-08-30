Investigate the task as input to a system-analysis page draft.

Read the Jira task, linked Confluence pages, the product's Confluence pages, Loop
discussions, the current checked-out repository state on `master`, and any referenced
Figma mockups. Measure the current behavior when evidence allows it; do not guess.
When a mockup exists, use `figma-inspector` and `figma-parity` instead of describing
the screen from memory.

Use the `research_input.product` payload as the source of truth for the SA destination
and related repositories. Do not invent product metadata beyond that contract.

Return `completed` only with an output object matching `research_investigation_output`:

- `findings`: an array of grounded findings.
- Every finding must include `sources`.
- `sources` must point to concrete evidence such as `file.ts:line`, a page URL, or a
  dated measurement note.

Do not draft or publish the SA page here. Do not create Jira tasks here.

Связные компоненты: исходники доступны в read-only путях `/workspace-linked/<repo>`, перечисленных в Execution context.
