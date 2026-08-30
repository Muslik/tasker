import type { TaskRunEvidence, TaskRunStepEvidence } from '../../integrations/index.js';

import type { TaskStepRecoveryContext } from './workspace-mutation-recovery.js';

const HISTORY_INDEX_LIMIT = 10;
const REVIEW_INPUTS_LIMIT = 5;

interface CappedEntries<T> {
  readonly entries: readonly T[];
  readonly omittedCount: number;
}

const capEntries = <T>(items: readonly T[], limit: number): CappedEntries<T> => ({
  entries: items.slice(-limit),
  omittedCount: Math.max(0, items.length - limit),
});

export const runHistoryIndex = (steps: readonly TaskRunStepEvidence[]) =>
  capEntries(
    steps.map(
      ({ operationId, nodeId, stepReference, status, summary, artifactIds, recordedAt }) => ({
        operationId,
        nodeId,
        stepReference,
        status,
        summary,
        artifactIds,
        recordedAt,
      }),
    ),
    HISTORY_INDEX_LIMIT,
  );

export const selectAgentRunEvidence = (evidence: TaskRunEvidence): TaskRunEvidence => {
  const selected = new Set<string>();
  const byNode = new Map<string, TaskRunStepEvidence[]>();
  for (const step of evidence.completedSteps) {
    const steps = byNode.get(step.nodeId) ?? [];
    steps.push(step);
    byNode.set(step.nodeId, steps);
  }
  for (const steps of byNode.values()) {
    const latest = steps.at(-1);
    const completed = steps.findLast(({ status }) => status === 'completed');
    const interrupted = steps.findLast(({ status }) => status !== 'completed');
    if (latest !== undefined) selected.add(latest.operationId);
    if (completed !== undefined) selected.add(completed.operationId);
    if (interrupted !== undefined) selected.add(interrupted.operationId);
  }
  return {
    acceptedPlan: evidence.acceptedPlan,
    completedSteps: evidence.completedSteps.filter(({ operationId }) => selected.has(operationId)),
    reviewInputs: evidence.reviewInputs,
  };
};

export const promptForAgentStep = (input: {
  readonly snapshottedPrompt: string;
  readonly taskReference: string;
  readonly nodeId: string;
  readonly stepAttempt: number;
  readonly uses: string;
  readonly workspacePath: string;
  readonly taskSnapshot: unknown;
  readonly stepInput: unknown;
  readonly requiredCapabilities: readonly string[];
  readonly allowedEffects: readonly string[];
  readonly workflowChanges: readonly string[];
  readonly stepOutputContract: unknown;
  readonly workflowChangeRequestContract: unknown;
  readonly skills: readonly string[];
  readonly recovery: TaskStepRecoveryContext;
  readonly operatorGuidance: string | null;
  readonly evidence: TaskRunEvidence;
  readonly historyIndex: ReturnType<typeof runHistoryIndex>;
}): string => {
  const runEvidence = {
    acceptedPlan: input.evidence.acceptedPlan,
    completedSteps: input.evidence.completedSteps,
    reviewInputs: capEntries(input.evidence.reviewInputs, REVIEW_INPUTS_LIMIT),
  };
  return [
    input.snapshottedPrompt.trim(),
    '',
    'Execution context:',
    JSON.stringify(
      {
        taskReference: input.taskReference,
        nodeId: input.nodeId,
        stepAttempt: input.stepAttempt,
        stepReference: input.uses,
        workspacePath: input.workspacePath,
        taskSnapshot: input.taskSnapshot,
        stepInput: input.stepInput,
        requiredCapabilities: input.requiredCapabilities,
        allowedEffects: input.allowedEffects,
        workflowChanges: input.workflowChanges,
        stepOutputContract: input.stepOutputContract,
        workflowChangeRequestContract: input.workflowChangeRequestContract,
        preferredSkills: input.skills,
        activityRecovery: input.recovery,
        operatorGuidance: input.operatorGuidance,
        runEvidence,
        runHistoryIndex: input.historyIndex,
      },
      null,
      2,
    ),
    '',
    'Operate only inside the prepared worktree. Return one JSON object matching the provided schema.',
    'For a completed step, return {"status":"completed","output":{...}}. output must be a real JSON object matching stepOutputContract, never a JSON string.',
    'For a wait, return {"status":"waiting","waitKind":"...","reason":"...","resumeHint":"...","category":"...","retryable":true}. resumeHint is optional.',
    'For a terminal step failure, return {"status":"failed","category":"...","detail":"...","retryable":false}.',
    'For a workflow change, return {"status":"workflow_change","request":{...}}. request must be a real JSON object matching workflowChangeRequestContract and a declared workflowChanges kind, never a JSON string.',
    'category must be one of authorization, infrastructure, task_ambiguity, dependency, or agent_contract. Declare category and retryable directly; they are never inferred from prose.',
    'Do not encode infrastructure failures as workflow changes.',
    'runEvidence contains the bounded causal frontier; reviewInputs is capped to the most recent entries. runHistoryIndex lists the most recent prior attempts; older entries are counted, not listed. Full immutable receipt files are mounted for on-demand inspection.',
  ].join('\n');
};
