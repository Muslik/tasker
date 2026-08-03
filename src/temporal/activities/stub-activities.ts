import type {
  EvaluatePredicateInput,
  ExecuteTaskStepInput,
  ExecuteTaskStepResult,
  PrepareTaskWorkspaceInput,
  PrepareTaskWorkspaceResult,
  TaskWorkflowActivities,
} from '../contracts.js';

const STUB_PROMPT_HASH = '0'.repeat(64);

const prepareTaskWorkspace = (
  input: PrepareTaskWorkspaceInput,
): Promise<PrepareTaskWorkspaceResult> =>
  Promise.resolve({
    workspace: {
      schemaVersion: 1,
      workspaceId: '0'.repeat(24),
      taskReference: input.taskReference,
      workflowId: input.workflowId,
      workflowRunId: input.workflowRunId,
      workflowHash: input.workflowHash,
      repository: {
        reference: 'fixture/repository',
        sourcePath: '/tasker/repositories/fixture',
        baseCommit: '0'.repeat(40),
      },
      runnerId: 'temporal-stub',
      path: '/tasker/worktrees/fixture',
      branch: `tasker/${input.taskReference}`,
      preparedAt: '2026-08-03T00:00:00.000Z',
    },
    bootstrap: {
      schemaVersion: 1,
      operationId: `workspace:${'0'.repeat(24)}:bootstrap@1`,
      workspaceId: '0'.repeat(24),
      adapterId: 'temporal-stub',
      adapterVersion: '1',
      profile: 'fixture',
      files: [],
      completedAt: '2026-08-03T00:00:00.000Z',
    },
    planningSnapshot: {
      artifactId: `planning-snapshot:${input.taskReference}:${input.workflowHash}`,
      checksum: STUB_PROMPT_HASH,
    },
  });

const executeStep = (input: ExecuteTaskStepInput): Promise<ExecuteTaskStepResult> =>
  Promise.resolve({
    summary: `${input.uses} completed by the T1 Temporal stub Activity`,
    predicateResults: {
      'attempt.succeeded@1': true,
    },
    artifactIds: [],
  });

const evaluatePredicate = (input: EvaluatePredicateInput): Promise<boolean> =>
  Promise.resolve(input.facts[input.reference] ?? true);

const planTaskImplementation: TaskWorkflowActivities['planTaskImplementation'] = (input) =>
  Promise.resolve({
    status: 'ready',
    commandId: input.commandId,
    transcriptId: `planning-transcript:${input.commandId}`,
    attempt: 1,
    artifactId: `stub-plan:${input.taskReference}`,
    requestedStrategy: input.requestedStrategy,
    selectedStrategy: input.requestedStrategy === 'ralplan' ? 'ralplan' : 'fast',
    receipt: {
      status: 'completed',
      provider: 'deterministic',
      plannerVersion: 'implementation-planner@1',
      cliVersion: 'temporal-stub@1',
      model: 'deterministic',
      serviceTier: 'fast',
      strategy: input.requestedStrategy === 'ralplan' ? 'ralplan' : 'fast',
      sessionId: `temporal-stub:${input.commandId}`,
      promptHash: STUB_PROMPT_HASH,
      durationMs: 0,
      usage: {
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
      },
      hypotheticalApiCostUsd: 0,
    },
  });

export const stubTaskWorkflowActivities = {
  prepareTaskWorkspace,
  executeStep,
  evaluatePredicate,
  planTaskImplementation,
} satisfies TaskWorkflowActivities;
