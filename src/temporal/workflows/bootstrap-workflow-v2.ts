import {
  ApplicationFailure,
  condition,
  isCancellation,
  proxyActivities,
  setHandler,
  startChild,
  workflowInfo,
} from '@temporalio/workflow';

import type { JsonValue } from '../../workflow/index.js';
import type {
  BootstrapExecutionContext,
  BootstrapPlanningState,
  BootstrapStageStatus,
  BootstrapWorkflowActivities,
  BootstrapWorkflowInput,
  BootstrapWorkflowPublicState,
  BootstrapWorkflowResult,
  PlanningActivityCommand,
  ResolveBootstrapWaitCommand,
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

const STAGES = ['workspace', 'planning', 'plan_review', 'freeze'] as const;
const MAX_AUTOMATIC_DRAFT_REVISIONS = 3;

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

export async function bootstrapWorkflowV2(
  input: BootstrapWorkflowInput,
): Promise<BootstrapWorkflowResult> {
  const execution = workflowInfo();
  let activeGraph = input.graph;
  let activeWorkflowHash = input.workflowHash;
  let executionContext: BootstrapExecutionContext | null = null;
  let planning: BootstrapPlanningState | null = null;
  let pendingResolution: ResolveBootstrapWaitCommand | null = null;
  let planningCommandSequence = 0;
  let draftRevisionSequence = 0;
  const nodeStates: Record<string, BootstrapStageStatus> = Object.fromEntries(
    STAGES.map((stage) => [stage, 'planned' as const]),
  );
  const attempts: Record<string, number> = {};
  const currentPlanning = (): BootstrapPlanningState | null => planning;
  const currentExecutionContext = (): BootstrapExecutionContext | null => executionContext;
  let state: AvailableBootstrapState = {
    runtime: 'bootstrap',
    schemaVersion: 2,
    taskReference: input.taskReference,
    workflowId: execution.workflowId,
    runId: execution.runId,
    workflowHash: activeWorkflowHash,
    settings: input.settings,
    phase: 'workspace',
    executionContext: null,
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

  const markRunning = (
    stage: (typeof STAGES)[number],
    phase: AvailableBootstrapState['phase'],
  ): void => {
    nodeStates[stage] = 'running';
    state = {
      ...state,
      workflowHash: activeWorkflowHash,
      phase,
      executionContext,
      planning,
      status: 'running',
      currentNodeId: stage,
      wait: null,
      outcome: null,
    };
  };

  const openWait = async (
    stage: (typeof STAGES)[number],
    waitKind: string,
    reason?: string,
  ): Promise<JsonValue> => {
    nodeStates[stage] = 'waiting';
    state = {
      ...state,
      workflowHash: activeWorkflowHash,
      executionContext,
      planning,
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

  const prepareWorkspace = async (): Promise<void> => {
    for (;;) {
      markRunning('workspace', 'workspace');
      attempts.workspace = (attempts.workspace ?? 0) + 1;
      try {
        executionContext = await activities.prepareTaskWorkspace({
          taskReference: input.taskReference,
          workflowId: execution.workflowId,
          workflowRunId: execution.runId,
          workflowHash: activeWorkflowHash,
        });
        nodeStates.workspace = 'succeeded';
        return;
      } catch (error) {
        if (isCancellation(error)) throw error;
        await openWait('workspace', 'workspace.retry@1', 'Workspace preparation failed');
      }
    }
  };

  const runPlanning = async (initialCommand: PlanningActivityCommand): Promise<void> => {
    let command = initialCommand;
    let automaticRevisionCount = 0;
    for (;;) {
      if (executionContext === null) {
        throw ApplicationFailure.nonRetryable('Planning has no prepared workspace');
      }
      planningCommandSequence += 1;
      const commandId = `${execution.workflowId}:${execution.runId}:planning:${String(planningCommandSequence)}`;
      let result: BootstrapPlanningState;
      for (;;) {
        markRunning('planning', 'planning');
        attempts.planning = (attempts.planning ?? 0) + 1;
        try {
          result = await activities.planTaskImplementation({
            taskReference: input.taskReference,
            workflowHash: activeWorkflowHash,
            planningSnapshot: executionContext.planningSnapshot,
            commandId,
            requestedStrategy: input.settings.planningStrategy,
            command,
          });
          break;
        } catch (error) {
          if (isCancellation(error)) throw error;
          await openWait('planning', 'planning.retry@1', 'Implementation planning failed');
        }
      }
      planning = result;
      state = { ...state, planning };
      if (result.status === 'ready') {
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
      if (automaticRevisionCount >= MAX_AUTOMATIC_DRAFT_REVISIONS) {
        const resolution = await openWait(
          'planning',
          'draft_revision.guidance@1',
          'Automatic draft revision budget exhausted',
        );
        const guidance = retryGuidanceFrom(resolution);
        if (guidance === null) {
          throw ApplicationFailure.nonRetryable('Draft revision requires operator guidance');
        }
        automaticRevisionCount = 0;
        command = { kind: 'revision', sourceAttempt: result.attempt, guidance };
        continue;
      }
      draftRevisionSequence += 1;
      try {
        const revised = await activities.reviseTaskWorkflowDraft({
          taskReference: input.taskReference,
          workflowId: execution.workflowId,
          workflowRunId: execution.runId,
          currentWorkflowHash: activeWorkflowHash,
          operationId: `${execution.workflowId}:${execution.runId}:draft-revision:${String(draftRevisionSequence)}`,
          request: result.request,
          workspace: executionContext.workspace,
        });
        activeGraph = revised.graph;
        activeWorkflowHash = revised.workflowHash;
        executionContext = {
          ...executionContext,
          planningSnapshot: revised.planningSnapshot,
        };
        automaticRevisionCount += 1;
        command = {
          kind: 'revision',
          sourceAttempt: result.attempt,
          guidance:
            'The requested workflow change was recompiled and validated. Verify the revised draft.',
        };
      } catch (error) {
        if (isCancellation(error)) throw error;
        const resolution = await openWait(
          'planning',
          'draft_revision.guidance@1',
          'Draft revision failed',
        );
        const guidance = retryGuidanceFrom(resolution);
        if (guidance === null) {
          throw ApplicationFailure.nonRetryable('Draft revision requires operator guidance');
        }
        automaticRevisionCount = 0;
        command = { kind: 'revision', sourceAttempt: result.attempt, guidance };
      }
    }
  };

  await prepareWorkspace();
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

  const acceptedExecutionContext = currentExecutionContext();
  const acceptedPlanning = currentPlanning();
  if (acceptedExecutionContext === null || acceptedPlanning?.status !== 'ready') {
    throw ApplicationFailure.nonRetryable('Workflow freeze has no accepted planning state');
  }
  let freezeReceipt;
  for (;;) {
    markRunning('freeze', 'freezing');
    attempts.freeze = (attempts.freeze ?? 0) + 1;
    try {
      freezeReceipt = await activities.freezeTaskWorkflow({
        taskReference: input.taskReference,
        workflowId: execution.workflowId,
        workflowRunId: execution.runId,
        workflowHash: activeWorkflowHash,
        planningAttempt: acceptedPlanning.attempt,
        planningArtifactId: acceptedPlanning.artifactId,
        planningSnapshot: acceptedExecutionContext.planningSnapshot,
        evidenceBundle: acceptedPlanning.evidenceBundle,
        approval,
      });
      nodeStates.freeze = 'succeeded';
      break;
    } catch (error) {
      if (isCancellation(error)) throw error;
      await openWait('freeze', 'workflow_freeze.retry@1', 'Workflow freeze failed');
    }
  }

  const executionWorkflowId = `tasker:execution:v2:${input.taskReference}`;
  const child = await startChild(executionWorkflowV2, {
    workflowId: executionWorkflowId,
    args: [
      {
        schemaVersion: 2,
        taskReference: input.taskReference,
        workflowHash: activeWorkflowHash,
        graph: activeGraph,
        contextReferences: [
          {
            kind: 'workspace',
            reference: acceptedExecutionContext.workspace.workspaceId,
            hash: acceptedExecutionContext.workspace.repository.baseCommit,
          },
          {
            kind: 'planning_snapshot',
            reference: acceptedExecutionContext.planningSnapshot.artifactId,
            hash: acceptedExecutionContext.planningSnapshot.checksum,
          },
        ],
      },
    ],
    memo: {
      taskerExecution: {
        schemaVersion: 2,
        taskReference: input.taskReference,
        workflowHash: activeWorkflowHash,
      },
    },
  });
  state = {
    ...state,
    workflowHash: activeWorkflowHash,
    phase: 'execution',
    executionContext: acceptedExecutionContext,
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
    workflowHash: activeWorkflowHash,
    outcome: result.outcome,
  };
}
