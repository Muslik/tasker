# Workflow steps

This directory is the complete production catalog of semantic capabilities that the
planner may use to assemble a task-specific workflow. One directory declares one
versioned semantic block:

```text
steps/
  implement-change/
    step.json
    prompt.md
  verify-acceptance/
    step.json
```

There is no default workflow and no second built-in step catalog in TypeScript.

A semantic block declares:

- `reference`: stable `name@version` selected by the planner;
- `stage`: the operator-facing semantic stage;
- `executor.profile`: a registered provider/model profile;
- `executor.prompt`: the readable instruction file relative to this step directory;
- `executor.skills`: the logical skills exposed only to this invocation;
- `completion`: the evidence that lets Tasker, rather than the agent, accept completion;
- effects, capabilities, artifacts, retry/resume, reconciliation boundaries, and any
  internal operation protocol.

A Verify block resolves registered project command/runtime operations; a Delivery-preparation
agent finalizes reviewed artifacts and the typed PR draft; deterministic Delivery resolves typed
Git/tracker/SCM/CI adapters. Every internal operation has its own durable
receipt and Run Inspector event, but is not a task workflow node merely because it is
mechanically separate.

The planner produces a small Semantic Workflow Source. Deterministic compilation may
lower a selected block to a larger executable Temporal IR. That IR is diagnostic and is
never used as the operator workflow or fed back to the planner as task structure.

Input and output names reference runtime Zod schemas in
`src/harness/step-contracts.ts`. That file validates payloads but cannot register a step.
Add TypeScript only for a genuinely new payload shape or executor implementation; changing
the prompt, skills, model profile, completion rule, or recovery contract belongs here.

Removing a step directory removes that capability from future run snapshots. Existing
frozen runs keep their immutable snapshot and do not observe later harness edits. There
is no compatibility catalog for removed pre-pilot expanded-recovery steps.
