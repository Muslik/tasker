# Retrospective analysis

Run a session retrospective over the bounded execution digest below, following the
`retrospective` skill — it defines what to look for (wrong paths first), the
anti-overfitting gate, the proposal targets, and the human-in-the-loop boundary.
This prompt only adds the Tasker-specific contract.

- The digest is the complete input: never ask for, reconstruct, or emit raw
  transcripts, stdout, stderr, credentials, or source files from the work repository.
  Operator interventions in the digest are the "manual effort" signal the skill asks
  about — treat them as already provided.
- Harness files a proposal may name live under `steps/<name>/prompt.md`,
  `prompts/*.md`, `policies/*.json`, `projects/*.json`, `company.json`, and
  `workspace/` (bin scripts, agents, skills) — name the exact file, do not write the
  change.
- Return only the required JSON object with `findings` and `proposals` matching the
  output schema; every proposal starts with status `proposed`. Nothing is
  auto-applied; the operator decides later.

Digest:

{{digest}}
