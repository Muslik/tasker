import {
  ApplicationFailure,
  condition,
  isCancellation,
  patched,
  proxyActivities,
  rootCause,
  setHandler,
  startChild,
  workflowInfo,
} from '@temporalio/workflow';

import type { JsonValue } from '../../workflow/index.js';
import type {
  BootstrapDraftState,
  BootstrapContextState,
  BootstrapPlanningState,
  BootstrapStageStatus,
  BootstrapWorkflowActivities,
  BootstrapWorkflowInput,
  BootstrapWorkflowPublicState,
  BootstrapWorkflowResult,
  BootstrapWorkspaceContext,
  PlanningActivityCommand,
  ResolveBootstrapWaitCommand,
  WorkflowFreezeReceipt,
} from '../bootstrap-kernel/contracts.js';
import {
  bootstrapWorkflowStateQuery,
  resolveBootstrapWaitUpdate,
} from '../bootstrap-kernel/messages.js';
import { executionWorkflowV2 } from './execution-workflow-v2.js';

const activities = proxyActivities<BootstrapWorkflowActivities>({
  startToCloseTimeout: '35 minutes',
  scheduleToCloseTimeout: '2 hours',
  heartbeatTimeout: '30 seconds',
  retry: {
    initialInterval: '1 second',
    maximumInterval: '30 seconds',
    maximumAttempts: 3,
  },
});

const STAGES = [
  'workspace',
  'context',
  'investigation',
  'planning',
  'plan_review',
  'freeze',
  'execution_start',
] as const;
const MAX_INVESTIGATION_ROUNDS = 3;

type Stage = (typeof STAGES)[number];
type AvailableBootstrapState = Extract<
  BootstrapWorkflowPublicState,
  { readonly status: 'running' | 'waiting' | 'completed' }
>;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const retryGuidanceFrom = (resolution: JsonValue): string | null =>
  isRecord(resolution) &&
  typeof resolution.guidance === 'string' &&
  resolution.guidance.trim().length > 0
    ? resolution.guidance.trim()
    : null;

const activityFailureReason = (summary: string, error: unknown): string =>
  `${summary}: ${rootCause(error) ?? (error instanceof Error ? error.message : 'Unknown failure')}`.slice(
    0,
    4_000,
  );

const planningBlockedReason = (planning: Extract<BootstrapPlanningState, { status: 'blocked' }>) =>
  (planning.failure.kind === 'invalid_planner_output'
    ? `Workflow candidate rejected after automatic correction: ${planning.failure.message}`
    : `Implementation planning blocked: ${planning.failure.message}`
  ).slice(0, 4_000);

const planningRevisionGuidance = (
  planning: Extract<BootstrapPlanningState, { status: 'blocked' }>,
  operatorGuidance: string | null,
): string =>
  [
    'Revise the preserved planning decision instead of restarting task analysis.',
    `Previous planning failure: ${planning.failure.message}`,
    planning.validationFeedback.length === 0
      ? null
      : `Deterministic validation feedback:\n${planning.validationFeedback.join('\n')}`,
    operatorGuidance === null ? null : `Operator guidance:\n${operatorGuidance}`,
  ]
    .filter((part): part is string => part !== null)
    .join('\n\n')
    .slice(0, 10_000);

const planReviewFrom = (
  resolution: JsonValue,
):
  | { readonly decision: 'approve' }
  | { readonly decision: 'request_changes'; readonly guidance: string }
  | null => {
  if (!isRecord(resolution)) return null;
  if (resolution.decision === 'approve') return { decision: 'approve' };
  if (
    resolution.decision === 'request_changes' &&
    typeof resolution.guidance === 'string' &&
    resolution.guidance.trim().length > 0
  ) {
    return { decision: 'request_changes', guidance: resolution.guidance.trim() };
  }
  return null;
};

const clarificationAnswersFrom = (
  resolution: JsonValue,
): { readonly questionId: string; readonly answer: string }[] | null => {
  if (!isRecord(resolution) || !Array.isArray(resolution.answers)) return null;
  const answers = resolution.answers.flatMap((answer) =>
    isRecord(answer) &&
    typeof answer.questionId === 'string' &&
    typeof answer.answer === 'string' &&
    answer.questionId.length > 0 &&
    answer.answer.trim().length > 0
      ? [{ questionId: answer.questionId, answer: answer.answer.trim() }]
      : [],
  );
  return answers.length === resolution.answers.length && answers.length > 0 ? answers : null;
};

export async function bootstrapWorkflowV3(
  input: BootstrapWorkflowInput,
): Promise<BootstrapWorkflowResult> {
  const execution = workflowInfo();
  let workspaceContext: BootstrapWorkspaceContext | null = null;
  let planningContext: BootstrapContextState | null = null;
  let draft: BootstrapDraftState | null = null;
  let planning: BootstrapPlanningState | null = null;
  let freezeReceipt: WorkflowFreezeReceipt | null = null;
  let pendingResolution: ResolveBootstrapWaitCommand | null = null;
  let planningCommandSequence = 0;
  const nodeStates: Record<string, BootstrapStageStatus> = Object.fromEntries(
    STAGES.map((stage) => [stage, 'planned' as const]),
  );
  const attempts: Record<string, number> = {};
  const currentWorkspaceContext = (): BootstrapWorkspaceContext | null => workspaceContext;
  const currentContext = (): BootstrapContextState | null => planningContext;
  const currentDraft = (): BootstrapDraftState | null => draft;
  const currentPlanning = (): BootstrapPlanningState | null => planning;
  let state: AvailableBootstrapState = {
    runtime: 'bootstrap',
    schemaVersion: 3,
    taskReference: input.taskReference,
    workflowId: execution.workflowId,
    runId: execution.runId,
    workflowHash: null,
    settings: input.settings,
    phase: 'workspace',
    workspaceContext: null,
    context: null,
    draft: null,
    planning: null,
    freezeReceipt: null,
    executionWorkflowId: null,
    nodeStates,
    attempts,
    status: 'running',
    currentNodeId: 'workspace',
    wait: null,
    outcome: null,
  };

  setHandler(bootstrapWorkflowStateQuery, () => state);
  setHandler(resolveBootstrapWaitUpdate, async (command) => {
    await condition(() => state.status === 'waiting' || state.status === 'completed');
    if (state.status !== 'waiting') {
      throw ApplicationFailure.nonRetryable('Bootstrap workflow is not waiting');
    }
    if (pendingResolution !== null) {
      throw ApplicationFailure.nonRetryable('Bootstrap workflow already has a pending resolution');
    }
    if (state.wait.nodeId !== command.nodeId || state.wait.waitKind !== command.waitKind) {
      throw ApplicationFailure.nonRetryable('Wait resolution does not match the active wait');
    }
    pendingResolution = command;
    return { nodeId: command.nodeId, waitKind: command.waitKind, accepted: true };
  });

  const markRunning = (stage: Stage, phase: AvailableBootstrapState['phase']): void => {
    nodeStates[stage] = 'running';
    state = {
      ...state,
      workflowHash: draft?.workflowHash ?? null,
      phase,
      workspaceContext,
      context: planningContext,
      draft,
      planning,
      freezeReceipt,
      status: 'running',
      currentNodeId: stage,
      wait: null,
      outcome: null,
    };
  };

  const openWait = async (stage: Stage, waitKind: string, reason?: string): Promise<JsonValue> => {
    nodeStates[stage] = 'waiting';
    state = {
      ...state,
      workflowHash: draft?.workflowHash ?? null,
      workspaceContext,
      context: planningContext,
      draft,
      planning,
      freezeReceipt,
      status: 'waiting',
      currentNodeId: stage,
      wait: { nodeId: stage, waitKind, ...(reason === undefined ? {} : { reason }) },
      outcome: null,
    };
    await condition(
      () => pendingResolution?.nodeId === stage && pendingResolution.waitKind === waitKind,
    );
    const resolution = pendingResolution?.resolution;
    if (resolution === undefined) {
      throw ApplicationFailure.nonRetryable('Resolved bootstrap wait has no payload');
    }
    pendingResolution = null;
    nodeStates[stage] = 'succeeded';
    return resolution;
  };

  for (;;) {
    markRunning('workspace', 'workspace');
    attempts.workspace = (attempts.workspace ?? 0) + 1;
    try {
      workspaceContext = await activities.prepareTaskWorkspace({
        taskReference: input.taskReference,
        workflowId: execution.workflowId,
        workflowRunId: execution.runId,
      });
      nodeStates.workspace = 'succeeded';
      break;
    } catch (error) {
      if (isCancellation(error)) throw error;
      await openWait(
        'workspace',
        'workspace.retry@1',
        activityFailureReason('Workspace preparation failed', error),
      );
    }
  }

  for (;;) {
    markRunning('context', 'context');
    attempts.context = (attempts.context ?? 0) + 1;
    try {
      planningContext = await activities.assembleTaskPlanningContext({
        taskReference: input.taskReference,
        workflowId: execution.workflowId,
        workflowRunId: execution.runId,
        operationId: `${execution.workflowId}:${execution.runId}:context:initial`,
        workspace: workspaceContext.workspace,
      });
      nodeStates.context = 'succeeded';
      break;
    } catch (error) {
      if (isCancellation(error)) throw error;
      await openWait(
        'context',
        'context.retry@1',
        activityFailureReason('Context discovery failed', error),
      );
    }
  }

  const preparedWorkspaceContext = workspaceContext;
  let activeContext: BootstrapContextState = planningContext;
  const runPlanning = async (initialCommand: PlanningActivityCommand): Promise<void> => {
    let command = initialCommand;
    let investigationRounds = 0;
    for (;;) {
      planningCommandSequence += 1;
      const commandId = `${execution.workflowId}:${execution.runId}:planning:${String(planningCommandSequence)}`;
      let result: BootstrapPlanningState;
      for (;;) {
        markRunning('planning', 'planning');
        attempts.planning = (attempts.planning ?? 0) + 1;
        try {
          result = await activities.planTaskImplementation({
            taskReference: input.taskReference,
            planningSnapshot: activeContext.planningSnapshot,
            evidenceBundle: activeContext.evidenceBundle,
            commandId,
            requestedStrategy: input.settings.planningStrategy,
            command,
          });
          break;
        } catch (error) {
          if (isCancellation(error)) throw error;
          await openWait(
            'planning',
            'planning.retry@1',
            activityFailureReason('Implementation planning failed', error),
          );
        }
      }
      planning = result;
      activeContext = { ...activeContext, evidenceBundle: result.evidenceBundle };
      planningContext = activeContext;
      state = { ...state, planning, context: activeContext };
      if (result.status === 'blocked') {
        const resolution = await openWait(
          'planning',
          result.failure.kind === 'invalid_planner_output'
            ? 'planning.candidate-guidance@1'
            : 'planning.guidance@1',
          planningBlockedReason(result),
        );
        command = {
          kind: 'revision',
          sourceAttempt: result.attempt,
          guidance: planningRevisionGuidance(result, retryGuidanceFrom(resolution)),
        };
        continue;
      }
      if (result.status === 'ready') {
        draft = result.draft;
        if (investigationRounds === 0) nodeStates.investigation = 'skipped';
        nodeStates.planning = 'succeeded';
        return;
      }
      if (result.status === 'needs_clarification') {
        const resolution = await openWait(
          'planning',
          'human_clarification',
          'Planning needs operator answers',
        );
        const answers = clarificationAnswersFrom(resolution);
        if (answers === null) {
          throw ApplicationFailure.nonRetryable('Planning clarification payload is invalid');
        }
        command = { kind: 'clarification', sourceAttempt: result.attempt, answers };
        continue;
      }
      investigationRounds += 1;
      if (investigationRounds > MAX_INVESTIGATION_ROUNDS) {
        const resolution = await openWait(
          'investigation',
          'investigation.guidance@1',
          'Pre-plan investigation budget exhausted',
        );
        const guidance = retryGuidanceFrom(resolution);
        if (guidance === null) {
          throw ApplicationFailure.nonRetryable('Investigation retry requires guidance');
        }
        investigationRounds = 0;
        command = { kind: 'revision', sourceAttempt: result.attempt, guidance };
        continue;
      }
      markRunning('investigation', 'investigation');
      for (const step of result.request.steps) {
        let operatorGuidance: string | null = null;
        const attemptKey = `investigation:${step.id}`;
        attempts[attemptKey] = (attempts[attemptKey] ?? 0) + 1;
        for (;;) {
          let investigated;
          try {
            investigated = await activities.runBootstrapInvestigation({
              taskReference: input.taskReference,
              workflowId: execution.workflowId,
              workflowRunId: execution.runId,
              contextHash: activeContext.contextHash,
              planningSnapshot: activeContext.planningSnapshot,
              workspace: preparedWorkspaceContext.workspace,
              step,
              blockRun: attempts[attemptKey] ?? 1,
              operatorGuidance,
            });
          } catch (error) {
            if (isCancellation(error)) throw error;
            const resolution = await openWait(
              'investigation',
              'investigation.retry@1',
              activityFailureReason(`Pre-plan investigation ${step.id} failed`, error),
            );
            operatorGuidance = retryGuidanceFrom(resolution);
            markRunning('investigation', 'investigation');
            continue;
          }
          if (investigated.status !== 'needs_input') {
            activeContext = {
              ...activeContext,
              evidenceBundle: investigated.evidenceBundle,
            };
            planningContext = activeContext;
            break;
          }
          const resolution = await openWait(
            'investigation',
            investigated.waitKind,
            investigated.summary,
          );
          operatorGuidance = retryGuidanceFrom(resolution);
          attempts[attemptKey] = (attempts[attemptKey] ?? 0) + 1;
          markRunning('investigation', 'investigation');
        }
      }
      nodeStates.investigation = 'succeeded';
      command = { kind: 'investigation_completed', sourceAttempt: result.attempt };
    }
  };

  await runPlanning({ kind: 'initial' });

  let approval: { readonly kind: 'automatic' | 'operator_approved' };
  if (input.settings.planReview === 'automatic') {
    nodeStates.plan_review = 'skipped';
    approval = { kind: 'automatic' };
  } else {
    for (;;) {
      markRunning('plan_review', 'plan_review');
      const resolution = await openWait('plan_review', 'plan.approved@1', 'Plan review required');
      const review = planReviewFrom(resolution);
      if (review === null) {
        throw ApplicationFailure.nonRetryable('Plan review payload is invalid');
      }
      if (review.decision === 'approve') {
        nodeStates.plan_review = 'succeeded';
        approval = { kind: 'operator_approved' };
        break;
      }
      const acceptedPlanning = currentPlanning();
      if (acceptedPlanning?.status !== 'ready') {
        throw ApplicationFailure.nonRetryable('Plan revision has no accepted source plan');
      }
      await runPlanning({
        kind: 'revision',
        sourceAttempt: acceptedPlanning.attempt,
        guidance: review.guidance,
      });
    }
  }

  const acceptedWorkspaceContext = currentWorkspaceContext();
  const acceptedContext = currentContext();
  const acceptedDraft = currentDraft();
  const acceptedPlanning = currentPlanning();
  if (
    acceptedWorkspaceContext === null ||
    acceptedContext === null ||
    acceptedDraft === null ||
    acceptedPlanning?.status !== 'ready'
  ) {
    throw ApplicationFailure.nonRetryable('Workflow freeze has no accepted candidate and plan');
  }
  for (;;) {
    markRunning('freeze', 'freezing');
    attempts.freeze = (attempts.freeze ?? 0) + 1;
    try {
      freezeReceipt = await activities.freezeTaskWorkflow({
        taskReference: input.taskReference,
        workflowId: execution.workflowId,
        workflowRunId: execution.runId,
        workflowHash: acceptedDraft.workflowHash,
        planningAttempt: acceptedPlanning.attempt,
        planningArtifactId: acceptedPlanning.artifactId,
        planningSnapshot: acceptedDraft.planningSnapshot,
        evidenceBundle: acceptedPlanning.evidenceBundle,
        approval,
      });
      nodeStates.freeze = 'succeeded';
      break;
    } catch (error) {
      if (isCancellation(error)) throw error;
      await openWait(
        'freeze',
        'workflow_freeze.retry@1',
        activityFailureReason('Workflow freeze failed', error),
      );
    }
  }

  if (
    !patched('bootstrap-auto-execution-after-freeze') &&
    input.settings.executionStart === 'manual'
  ) {
    await openWait(
      'execution_start',
      'execution.start@1',
      'Workflow and plan are ready for execution',
    );
  } else {
    nodeStates.execution_start = 'skipped';
  }

  const executionWorkflowId = patched('bootstrap-execution-id-by-bootstrap-run')
    ? `tasker:execution:v2:${input.taskReference}:${execution.runId}`
    : `tasker:execution:v2:${input.taskReference}`;
  const child = await startChild(executionWorkflowV2, {
    workflowId: executionWorkflowId,
    args: [
      {
        schemaVersion: 2,
        taskReference: input.taskReference,
        workflowHash: acceptedDraft.workflowHash,
        graph: acceptedDraft.graph,
        contextReferences: [
          {
            kind: 'workspace',
            reference: acceptedWorkspaceContext.workspace.workspaceId,
            hash: acceptedWorkspaceContext.workspace.repository.baseCommit,
          },
          {
            kind: 'planning_snapshot',
            reference: acceptedDraft.planningSnapshot.artifactId,
            hash: acceptedDraft.planningSnapshot.checksum,
          },
        ],
      },
    ],
    memo: {
      taskerExecution: {
        schemaVersion: 2,
        taskReference: input.taskReference,
        workflowHash: acceptedDraft.workflowHash,
      },
    },
  });
  state = {
    ...state,
    workflowHash: acceptedDraft.workflowHash,
    phase: 'execution',
    workspaceContext: acceptedWorkspaceContext,
    context: acceptedContext,
    draft: acceptedDraft,
    planning: acceptedPlanning,
    freezeReceipt,
    executionWorkflowId,
    status: 'running',
    currentNodeId: null,
    wait: null,
    outcome: null,
  };
  const result = await child.result();
  state = {
    ...state,
    phase: 'execution',
    executionWorkflowId,
    status: 'completed',
    currentNodeId: null,
    wait: null,
    outcome: result.outcome,
  };
  return {
    taskReference: input.taskReference,
    workflowHash: acceptedDraft.workflowHash,
    outcome: result.outcome,
  };
}
