import type {
  EvaluatePredicateInput,
  ExecuteTaskStepInput,
  ExecuteTaskStepResult,
  TaskWorkflowActivities,
} from '../contracts.js';

const STUB_PROMPT_HASH = '0'.repeat(64);

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
  executeStep,
  evaluatePredicate,
  planTaskImplementation,
} satisfies TaskWorkflowActivities;
