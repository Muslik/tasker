import type {
  EvaluatePredicateInput,
  ExecuteTaskStepInput,
  ExecuteTaskStepResult,
  TaskWorkflowActivities,
} from '../contracts.js';

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

export const stubTaskWorkflowActivities = {
  executeStep,
  evaluatePredicate,
} satisfies TaskWorkflowActivities;
