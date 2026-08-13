# Workflow steps

This directory is the complete production catalog of capabilities that the planner may
use to assemble a task-specific workflow. One directory declares one versioned step:

```text
steps/
  code-implement/
    step.json
    prompt.md
  validate-targeted/
    step.json
```

There is no default workflow and no second built-in step catalog in TypeScript.

An agent step declares:

- `reference`: stable `name@version` selected by the planner;
- `stage`: the operator-facing macro stage;
- `executor.profile`: a registered provider/model profile;
- `executor.prompt`: the readable instruction file relative to this step directory;
- `executor.skills`: the logical skills exposed only to this invocation;
- `completion`: the evidence that lets Tasker, rather than the agent, accept completion;
- effects, capabilities, artifacts, retry/resume, and reconciliation boundaries.

A process step replaces the provider fields with a registered `executor` command key. An
integration step uses a typed `adapter`. Neither invokes an LLM.

Input and output names reference runtime Zod schemas in
`src/harness/step-contracts.ts`. That file validates payloads but cannot register a step.
Add TypeScript only for a genuinely new payload shape or executor implementation; changing
the prompt, skills, model profile, completion rule, or recovery contract belongs here.

Removing a step directory removes that capability from future run snapshots. Existing frozen
runs keep their immutable snapshot and do not observe later harness edits.
