import {
  ApplicationFailure,
  condition,
  isCancellation,
  patched,
  proxyActivities,
  setHandler,
  startChild,
  workflowInfo,
} from '@temporalio/workflow';

import type { CompiledWorkflow, CompiledWorkflowNode } from '../../workflow/index.js';
import type { WorkflowFreezeApproval } from '../freeze-contracts.js';
import type {
  PlanningActivityCommand,
  ResolveTaskWaitCommand,
  TaskWorkflowActivities,
  TaskWorkflowInput,
  TaskWorkflowPlanningState,
  TaskWorkflowPublicState,
  TaskWorkflowResult,
  TaskWaitResolution,
  TemporalNodeStatus,
  WorkflowContinuationAcceptance,
} from '../contracts.js';
import { resolveTaskWaitUpdate, taskWorkflowStateQuery } from './messages.js';

export { taskBootstrapWorkflow } from './task-bootstrap-workflow.js';

const predicateActivities = proxyActivities<Pick<TaskWorkflowActivities, 'evaluatePredicate'>>({
  startToCloseTimeout: '1 minute',
  retry: {
    initialInterval: '100 milliseconds',
    maximumAttempts: 2,
  },
});

const executionActivities = proxyActivities<Pick<TaskWorkflowActivities, 'executeStep'>>({
  startToCloseTimeout: '35 minutes',
  scheduleToCloseTimeout: '2 hours',
  heartbeatTimeout: '30 seconds',
  retry: {
    maximumAttempts: 1,
  },
});

const readOnlyExecutionActivities = proxyActivities<
  Pick<TaskWorkflowActivities, 'executeReadOnlyStep'>
>({
  startToCloseTimeout: '35 minutes',
  scheduleToCloseTimeout: '2 hours',
  heartbeatTimeout: '30 seconds',
  retry: {
    initialInterval: '1 second',
    maximumInterval: '30 seconds',
    maximumAttempts: 3,
  },
});

const workspaceReconciledExecutionActivities = proxyActivities<
  Pick<TaskWorkflowActivities, 'executeWorkspaceReconciledStep'>
>({
  startToCloseTimeout: '35 minutes',
  scheduleToCloseTimeout: '2 hours',
  heartbeatTimeout: '30 seconds',
  retry: {
    initialInterval: '1 second',
    maximumInterval: '30 seconds',
    maximumAttempts: 3,
  },
});

const remoteReconciledExecutionActivities = proxyActivities<
  Pick<TaskWorkflowActivities, 'executeRemoteReconciledStep'>
>({
  startToCloseTimeout: '35 minutes',
  scheduleToCloseTimeout: '2 hours',
  heartbeatTimeout: '30 seconds',
  retry: {
    initialInterval: '1 second',
    maximumInterval: '30 seconds',
    maximumAttempts: 3,
  },
});

const planningActivities = proxyActivities<Pick<TaskWorkflowActivities, 'planTaskImplementation'>>({
  startToCloseTimeout: '35 minutes',
  scheduleToCloseTimeout: '2 hours',
  heartbeatTimeout: '30 seconds',
  retry: {
    initialInterval: '1 second',
    maximumInterval: '30 seconds',
    maximumAttempts: 3,
  },
});

const draftRevisionActivities = proxyActivities<
  Pick<TaskWorkflowActivities, 'reviseTaskWorkflowDraft'>
>({
  startToCloseTimeout: '35 minutes',
  scheduleToCloseTimeout: '2 hours',
  heartbeatTimeout: '30 seconds',
  retry: {
    initialInterval: '1 second',
    maximumInterval: '30 seconds',
    maximumAttempts: 3,
  },
});

const freezeActivities = proxyActivities<Pick<TaskWorkflowActivities, 'freezeTaskWorkflow'>>({
  startToCloseTimeout: '1 minute',
  retry: {
    initialInterval: '1 second',
    maximumInterval: '10 seconds',
    maximumAttempts: 3,
  },
});

const workspaceActivities = proxyActivities<
  Pick<TaskWorkflowActivities, 'prepareTaskWorkspace' | 'prepareTaskDockerRuntime'>
>({
  startToCloseTimeout: '5 minutes',
  scheduleToCloseTimeout: '30 minutes',
  heartbeatTimeout: '30 seconds',
  retry: {
    initialInterval: '1 second',
    maximumInterval: '30 seconds',
    maximumAttempts: 3,
  },
});

const continuationActivities = proxyActivities<
  Pick<TaskWorkflowActivities, 'linkWorkflowContinuation'>
>({
  startToCloseTimeout: '1 minute',
  retry: { maximumAttempts: 3 },
});

type MutableNodeStates = Record<string, TemporalNodeStatus>;
type MutableAttempts = Record<string, number>;
type PredicateFacts = Record<string, boolean>;
type AvailableTaskWorkflowPublicState = Exclude<
  TaskWorkflowPublicState,
  { readonly status: 'unavailable' }
>;
type Traversal =
  { readonly kind: 'continue' } | { readonly kind: 'finalized'; readonly outcome: string };

type PlanningStepNode = Extract<CompiledWorkflowNode, { readonly kind: 'step' }>;
type PlanningGateNode = Extract<CompiledWorkflowNode, { readonly kind: 'gate' }>;
type PlanningLifecycle = {
  readonly step: PlanningStepNode;
  readonly gate: PlanningGateNode;
};

const MAX_AUTOMATIC_DRAFT_REVISIONS = 3;
const DOCKER_RUNTIME_RECOVERY_PATCH = 'docker-runtime-recovery-after-wait-v1';
const DOCKER_RUNTIME_ACTIVITY_PATCH = 'docker-runtime-only-recovery-v1';
const DOCKER_RUNTIME_WAIT_ESCAPE_PATCH = 'docker-runtime-only-after-workspace-wait-v1';
const DOCKER_RUNTIME_RECONCILIATION_PATCH = 'docker-runtime-reconcile-before-attempt-v1';

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const clarificationAnswersFrom = (
  resolution: TaskWaitResolution,
): { questionId: string; answer: string }[] | null => {
  if (!isRecord(resolution) || !Array.isArray(resolution.answers)) return null;
  const answers = resolution.answers;
  if (answers.length === 0 || answers.length > 10) return null;
  const parsed: { questionId: string; answer: string }[] = [];
  for (const answer of answers) {
    if (
      !isRecord(answer) ||
      typeof answer.questionId !== 'string' ||
      !/^[a-z][a-z0-9-]*$/u.test(answer.questionId) ||
      typeof answer.answer !== 'string' ||
      answer.answer.trim().length === 0
    ) {
      return null;
    }
    parsed.push({ questionId: answer.questionId, answer: answer.answer.trim() });
  }
  return parsed;
};

const planReviewFrom = (
  resolution: TaskWaitResolution,
):
  | { readonly decision: 'approve' }
  | { readonly decision: 'request_changes'; guidance: string }
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

const retryResolution = (resolution: TaskWaitResolution): boolean =>
  isRecord(resolution) && resolution.decision === 'resume';

const operatorGuidanceFrom = (resolution: TaskWaitResolution): string | null =>
  isRecord(resolution) &&
  resolution.decision === 'resume' &&
  typeof resolution.guidance === 'string' &&
  resolution.guidance.trim().length > 0
    ? resolution.guidance.trim()
    : null;

const continuationAcceptanceFrom = (
  resolution: TaskWaitResolution,
): WorkflowContinuationAcceptance | null => {
  if (
    !isRecord(resolution) ||
    resolution.decision !== 'accept' ||
    typeof resolution.continuationId !== 'string' ||
    typeof resolution.taskReference !== 'string' ||
    typeof resolution.workflowHash !== 'string' ||
    !isRecord(resolution.graph) ||
    !isRecord(resolution.settings) ||
    (resolution.settings.planApproval !== 'required' &&
      resolution.settings.planApproval !== 'automatic') ||
    (resolution.settings.planningStrategy !== 'auto' &&
      resolution.settings.planningStrategy !== 'fast' &&
      resolution.settings.planningStrategy !== 'ralplan')
  ) {
    return null;
  }
  return resolution as unknown as WorkflowContinuationAcceptance;
};

const collectNodeIds = (node: CompiledWorkflowNode, ids: string[]): void => {
  ids.push(node.id);

  switch (node.kind) {
    case 'sequence':
      for (const child of node.children) collectNodeIds(child, ids);
      return;
    case 'branch':
      collectNodeIds(node.then, ids);
      collectNodeIds(node.otherwise, ids);
      return;
    case 'bounded_loop':
      collectNodeIds(node.body, ids);
      return;
    case 'step':
    case 'wait':
    case 'gate':
    case 'finalize':
      return;
  }
};

const setSubtreeStatus = (
  node: CompiledWorkflowNode,
  status: TemporalNodeStatus,
  nodeStates: MutableNodeStates,
): void => {
  nodeStates[node.id] = status;

  switch (node.kind) {
    case 'sequence':
      for (const child of node.children) setSubtreeStatus(child, status, nodeStates);
      return;
    case 'branch':
      setSubtreeStatus(node.then, status, nodeStates);
      setSubtreeStatus(node.otherwise, status, nodeStates);
      return;
    case 'bounded_loop':
      setSubtreeStatus(node.body, status, nodeStates);
      return;
    case 'step':
    case 'wait':
    case 'gate':
    case 'finalize':
      return;
  }
};

const findPlanningLifecycle = (graph: CompiledWorkflow): PlanningLifecycle => {
  const steps: PlanningStepNode[] = [];
  const gates: PlanningGateNode[] = [];
  const visit = (node: CompiledWorkflowNode): void => {
    switch (node.kind) {
      case 'sequence':
        for (const child of node.children) visit(child);
        return;
      case 'branch':
        visit(node.then);
        visit(node.otherwise);
        return;
      case 'bounded_loop':
        visit(node.body);
        return;
      case 'step':
        if (node.uses === 'task.analyze@1') steps.push(node);
        return;
      case 'gate':
        if (node.resumeWhen === 'plan.approved@1') gates.push(node);
        return;
      case 'wait':
      case 'finalize':
        return;
    }
  };
  visit(graph.root);
  if (steps.length !== 1 || gates.length !== 1) {
    throw ApplicationFailure.nonRetryable(
      'Validated workflow must contain one implementation planning lifecycle',
    );
  }
  return { step: steps[0] as PlanningStepNode, gate: gates[0] as PlanningGateNode };
};

export async function taskWorkflow(rawInput: TaskWorkflowInput): Promise<TaskWorkflowResult> {
  // The Client validates the serialized boundary before start. Importing Zod or the
  // compiler here would pull Node-only code into Temporal's deterministic sandbox.
  const input = rawInput;
  let activeGraph = input.graph;
  let activeWorkflowHash = input.workflowHash;
  const nodeIds: string[] = [];
  collectNodeIds(activeGraph.root, nodeIds);

  let nodeStates: MutableNodeStates = Object.fromEntries(
    nodeIds.map((nodeId) => [nodeId, 'planned' as const]),
  );
  const attempts: MutableAttempts = {};
  const predicateFacts: PredicateFacts = {};
  let queuedOperatorGuidance: string | null = null;
  let pendingResolution: ResolveTaskWaitCommand | null = null;
  let planningCommandSequence = 0;
  let draftRevisionSequence = 0;
  const completedLifecycleNodeIds = new Set<string>();
  const execution = workflowInfo();
  let state: AvailableTaskWorkflowPublicState = {
    schemaVersion: 1,
    taskReference: input.taskReference,
    workflowId: execution.workflowId,
    runId: execution.runId,
    workflowHash: activeWorkflowHash,
    settings: input.settings,
    lifecycle: { phase: 'draft' },
    executionContext: { status: 'preparing' },
    planning: null,
    workflowChange: null,
    status: 'running',
    currentNodeId: null,
    wait: null,
    outcome: null,
    nodeStates,
    attempts,
  };

  setHandler(taskWorkflowStateQuery, () => state);
  setHandler(resolveTaskWaitUpdate, async (command) => {
    // On a cold worker the Update can be delivered in the same activation that
    // replays the history. Let the main Workflow restore its durable wait before
    // validating state that is derived from that replay.
    await condition(() => state.status === 'waiting' || state.status === 'completed');
    if (state.status !== 'waiting') {
      throw ApplicationFailure.nonRetryable('Task workflow is not waiting');
    }
    if (pendingResolution !== null) {
      throw ApplicationFailure.nonRetryable('Task workflow already has a pending resolution');
    }
    if (state.wait.nodeId !== command.nodeId || state.wait.waitKind !== command.waitKind) {
      throw ApplicationFailure.nonRetryable('Wait resolution does not match the active wait');
    }
    const validResolution = (() => {
      if (state.wait.waitKind === 'human_clarification') {
        return clarificationAnswersFrom(command.resolution) !== null;
      }
      if (state.wait.waitKind === 'plan.approved@1') {
        return planReviewFrom(command.resolution) !== null;
      }
      if (state.wait.waitKind === 'planning.retry@1') {
        return retryResolution(command.resolution);
      }
      if (state.wait.waitKind === 'workspace.retry@1') {
        return retryResolution(command.resolution);
      }
      if (state.wait.waitKind === 'draft_revision.guidance@1') {
        return retryResolution(command.resolution);
      }
      if (state.wait.waitKind === 'workflow_freeze.retry@1') {
        return retryResolution(command.resolution);
      }
      if (state.wait.waitKind === 'workflow_change.review@1') {
        const review = planReviewFrom(command.resolution);
        return (
          review?.decision === 'request_changes' ||
          continuationAcceptanceFrom(command.resolution) !== null
        );
      }
      return true;
    })();
    if (!validResolution) {
      throw ApplicationFailure.nonRetryable('Wait resolution payload is invalid');
    }

    pendingResolution = command;
    return {
      nodeId: command.nodeId,
      waitKind: command.waitKind,
      accepted: true,
    };
  });

  const markRunning = (nodeId: string): void => {
    nodeStates[nodeId] = 'running';
    state = {
      ...state,
      status: 'running',
      currentNodeId: nodeId,
      wait: null,
      outcome: null,
    };
  };

  const openWait = async (
    nodeId: string,
    waitKind: string,
    reason?: string,
  ): Promise<TaskWaitResolution> => {
    nodeStates[nodeId] = 'waiting';
    state = {
      ...state,
      status: 'waiting',
      currentNodeId: nodeId,
      wait: { nodeId, waitKind, ...(reason === undefined ? {} : { reason }) },
      outcome: null,
    };

    await condition(
      () => pendingResolution?.nodeId === nodeId && pendingResolution.waitKind === waitKind,
    );
    const resolution = pendingResolution?.resolution;
    if (resolution === undefined) {
      throw ApplicationFailure.nonRetryable('Resolved wait has no payload');
    }
    pendingResolution = null;
    nodeStates[nodeId] = 'succeeded';
    state = {
      ...state,
      status: 'running',
      currentNodeId: null,
      wait: null,
      outcome: null,
    };
    return resolution;
  };

  const executeContinuation = async (
    nodeId: string,
    continuation: WorkflowContinuationAcceptance,
  ): Promise<Traversal> => {
    markRunning(nodeId);
    const childMemo = {
      schemaVersion: input.schemaVersion,
      taskReference: continuation.taskReference,
      workflowHash: continuation.workflowHash,
      settings: continuation.settings,
    } as const;
    const child = await startChild(taskWorkflow, {
      workflowId: `tasker:${continuation.taskReference}`,
      args: [
        {
          schemaVersion: input.schemaVersion,
          taskReference: continuation.taskReference,
          workflowHash: continuation.workflowHash,
          graph: continuation.graph,
          settings: continuation.settings,
        },
      ],
      memo: { tasker: childMemo },
    });
    await continuationActivities.linkWorkflowContinuation({
      parentTaskReference: input.taskReference,
      childTaskReference: continuation.taskReference,
      childRunId: child.firstExecutionRunId,
    });
    const result = await child.result();
    nodeStates[nodeId] = 'succeeded';
    return { kind: 'finalized', outcome: result.outcome };
  };

  const installRevisedDraft = (
    revised: Awaited<ReturnType<typeof draftRevisionActivities.reviseTaskWorkflowDraft>>,
  ): void => {
    if (state.executionContext.status !== 'ready') {
      throw ApplicationFailure.nonRetryable('Draft revision has no prepared execution context');
    }
    activeGraph = revised.graph;
    activeWorkflowHash = revised.workflowHash;
    const revisedNodeIds: string[] = [];
    collectNodeIds(activeGraph.root, revisedNodeIds);
    nodeStates = Object.fromEntries(revisedNodeIds.map((nodeId) => [nodeId, 'planned' as const]));
    state = {
      ...state,
      workflowHash: activeWorkflowHash,
      executionContext: {
        ...state.executionContext,
        planningSnapshot: revised.planningSnapshot,
      },
      workflowChange: null,
      status: 'running',
      currentNodeId: null,
      wait: null,
      outcome: null,
      nodeStates,
    };
  };

  const executePlanning = async (initialCommand: PlanningActivityCommand): Promise<void> => {
    let command = initialCommand;
    let automaticRevisionCount = 0;

    for (;;) {
      const node = findPlanningLifecycle(activeGraph).step;
      if (state.executionContext.status !== 'ready') {
        throw ApplicationFailure.nonRetryable('Planning has no prepared execution context');
      }
      const readyContext = state.executionContext;
      planningCommandSequence += 1;
      const commandId = `${execution.workflowId}:${execution.runId}:planning:${String(planningCommandSequence)}`;
      let result: TaskWorkflowPlanningState;
      for (;;) {
        markRunning(node.id);
        if (patched(DOCKER_RUNTIME_RECONCILIATION_PATCH)) {
          await prepareDockerExecutionContext(node.id);
        }
        attempts[node.id] = (attempts[node.id] ?? 0) + 1;
        try {
          result = await planningActivities.planTaskImplementation({
            taskReference: input.taskReference,
            workflowHash: activeWorkflowHash,
            planningSnapshot: readyContext.planningSnapshot,
            nodeId: node.id,
            commandId,
            requestedStrategy: input.settings.planningStrategy,
            command,
          });
          break;
        } catch (error) {
          if (isCancellation(error)) throw error;
          const retry = await openWait(node.id, 'planning.retry@1');
          if (!retryResolution(retry)) {
            throw ApplicationFailure.nonRetryable('Planning retry wait received invalid payload');
          }
        }
      }

      state = { ...state, planning: result };
      if (result.status === 'ready') {
        state = { ...state, workflowChange: null };
        nodeStates[node.id] = 'succeeded';
        return;
      }
      if (result.status === 'needs_clarification') {
        const resolution = await openWait(node.id, 'human_clarification');
        const answers = clarificationAnswersFrom(resolution);
        if (answers === null) {
          throw ApplicationFailure.nonRetryable('Planning clarification payload is invalid');
        }
        command = { kind: 'clarification', sourceAttempt: result.attempt, answers };
        continue;
      }

      state = {
        ...state,
        workflowChange: {
          nodeId: node.id,
          attempt: result.attempt,
          artifactId: result.artifactId,
          request: result.request,
        },
      };

      if (automaticRevisionCount >= MAX_AUTOMATIC_DRAFT_REVISIONS) {
        const resolution = await openWait(node.id, 'draft_revision.guidance@1');
        const guidance = operatorGuidanceFrom(resolution);
        if (guidance === null) {
          throw ApplicationFailure.nonRetryable('Draft revision requires operator guidance');
        }
        automaticRevisionCount = 0;
        state = { ...state, workflowChange: null };
        command = { kind: 'revision', sourceAttempt: result.attempt, guidance };
        continue;
      }

      draftRevisionSequence += 1;
      try {
        const revised = await draftRevisionActivities.reviseTaskWorkflowDraft({
          taskReference: input.taskReference,
          workflowId: execution.workflowId,
          workflowRunId: execution.runId,
          currentWorkflowHash: activeWorkflowHash,
          operationId: `${execution.workflowId}:${execution.runId}:draft-revision:${String(draftRevisionSequence)}`,
          request: result.request,
          workspace: readyContext.workspace,
        });
        installRevisedDraft(revised);
        automaticRevisionCount += 1;
        command = {
          kind: 'revision',
          sourceAttempt: result.attempt,
          guidance:
            'The requested workflow change was recompiled and validated. Verify the revised draft and implementation plan.',
        };
      } catch (error) {
        if (isCancellation(error)) throw error;
        const resolution = await openWait(node.id, 'draft_revision.guidance@1');
        const guidance = operatorGuidanceFrom(resolution);
        if (guidance === null) {
          throw ApplicationFailure.nonRetryable('Draft revision requires operator guidance');
        }
        automaticRevisionCount = 0;
        state = { ...state, workflowChange: null };
        command = { kind: 'revision', sourceAttempt: result.attempt, guidance };
      }
    }
  };

  const prepareDockerExecutionContext = async (nodeId: string): Promise<void> => {
    for (;;) {
      const context = state.executionContext;
      if (context.status !== 'ready' && context.status !== 'runtime_preparation_required') {
        throw ApplicationFailure.nonRetryable(
          'Docker runtime recovery has no prepared workspace context',
        );
      }
      markRunning(nodeId);
      try {
        const runtime = await workspaceActivities.prepareTaskDockerRuntime({
          workspace: context.workspace,
        });
        state = {
          ...state,
          executionContext: {
            status: 'ready',
            workspace: context.workspace,
            bootstrap: context.bootstrap,
            runtime,
            planningSnapshot: context.planningSnapshot,
          },
        };
        return;
      } catch (error) {
        if (isCancellation(error)) throw error;
        const retry = await openWait(nodeId, 'workspace.retry@1');
        if (!retryResolution(retry)) {
          throw ApplicationFailure.nonRetryable('Workspace retry wait received invalid payload');
        }
      }
    }
  };

  const prepareExecutionContext = async (nodeId: string): Promise<void> => {
    for (;;) {
      markRunning(nodeId);
      try {
        const prepared = await workspaceActivities.prepareTaskWorkspace({
          taskReference: input.taskReference,
          workflowId: execution.workflowId,
          workflowRunId: execution.runId,
          workflowHash: activeWorkflowHash,
        });
        state = {
          ...state,
          executionContext: {
            status: 'ready',
            workspace: prepared.workspace,
            bootstrap: prepared.bootstrap,
            runtime: prepared.runtime,
            planningSnapshot: prepared.planningSnapshot,
          },
        };
        return;
      } catch (error) {
        if (isCancellation(error)) throw error;
        const retry = await openWait(nodeId, 'workspace.retry@1');
        if (!retryResolution(retry)) {
          throw ApplicationFailure.nonRetryable('Workspace retry wait received invalid payload');
        }
        if (
          (state.executionContext.status === 'ready' ||
            state.executionContext.status === 'runtime_preparation_required') &&
          patched(DOCKER_RUNTIME_WAIT_ESCAPE_PATCH)
        ) {
          await prepareDockerExecutionContext(nodeId);
          return;
        }
      }
    }
  };

  const ensureExecutionContext = async (nodeId: string): Promise<void> => {
    if (
      state.executionContext.status === 'ready' ||
      state.executionContext.status === 'runtime_preparation_required'
    ) {
      return;
    }
    await prepareExecutionContext(nodeId);
  };

  const ensureDockerExecutionContext = async (nodeId: string): Promise<void> => {
    if (state.executionContext.status === 'ready' && isRecord(state.executionContext.runtime)) {
      return;
    }
    if (!patched(DOCKER_RUNTIME_ACTIVITY_PATCH)) {
      await prepareExecutionContext(nodeId);
      return;
    }
    await prepareDockerExecutionContext(nodeId);
  };

  const reconcileDockerExecutionContext = async (nodeId: string): Promise<void> => {
    if (!patched(DOCKER_RUNTIME_RECONCILIATION_PATCH)) {
      await ensureDockerExecutionContext(nodeId);
      return;
    }
    await prepareDockerExecutionContext(nodeId);
  };

  const completePlanningLifecycle = async (): Promise<void> => {
    const initialLifecycle = findPlanningLifecycle(activeGraph);
    await ensureExecutionContext(initialLifecycle.step.id);
    await executePlanning({ kind: 'initial' });

    let approval: WorkflowFreezeApproval;
    for (;;) {
      const lifecycle = findPlanningLifecycle(activeGraph);
      nodeStates[lifecycle.step.id] = 'succeeded';
      if (input.settings.planApproval === 'automatic') {
        nodeStates[lifecycle.gate.id] = 'skipped';
        approval = { kind: 'automatic' };
        break;
      }
      const resolution = await openWait(lifecycle.gate.id, lifecycle.gate.resumeWhen);
      const review = planReviewFrom(resolution);
      if (review === null) {
        throw ApplicationFailure.nonRetryable('Plan review payload is invalid');
      }
      if (review.decision === 'approve') {
        nodeStates[lifecycle.gate.id] = 'succeeded';
        approval = { kind: 'operator_approved' };
        break;
      }
      if (state.planning?.status !== 'ready') {
        throw ApplicationFailure.nonRetryable('Plan revision has no accepted source plan');
      }
      await executePlanning({
        kind: 'revision',
        sourceAttempt: state.planning.attempt,
        guidance: review.guidance,
      });
    }

    const lifecycle = findPlanningLifecycle(activeGraph);
    if (state.executionContext.status !== 'ready' || state.planning?.status !== 'ready') {
      throw ApplicationFailure.nonRetryable('Workflow freeze has no accepted planning state');
    }
    const acceptedPlanning = state.planning;
    const readyContext = state.executionContext;
    for (;;) {
      try {
        const receipt = await freezeActivities.freezeTaskWorkflow({
          taskReference: input.taskReference,
          workflowId: execution.workflowId,
          workflowRunId: execution.runId,
          workflowHash: activeWorkflowHash,
          planningAttempt: acceptedPlanning.attempt,
          planningArtifactId: acceptedPlanning.artifactId,
          planningSnapshot: readyContext.planningSnapshot,
          evidenceBundle: acceptedPlanning.evidenceBundle,
          approval,
        });
        state = { ...state, lifecycle: { phase: 'frozen', receipt } };
        nodeStates[lifecycle.gate.id] = approval.kind === 'automatic' ? 'skipped' : 'succeeded';
        completedLifecycleNodeIds.add(lifecycle.step.id);
        completedLifecycleNodeIds.add(lifecycle.gate.id);
        return;
      } catch (error) {
        if (isCancellation(error)) throw error;
        const retry = await openWait(lifecycle.gate.id, 'workflow_freeze.retry@1');
        if (!retryResolution(retry)) {
          throw ApplicationFailure.nonRetryable('Workflow freeze retry payload is invalid');
        }
      }
    }
  };

  const evaluate = async (reference: string): Promise<boolean> => {
    const known = predicateFacts[reference];
    if (known !== undefined) return known;

    return predicateActivities.evaluatePredicate({
      taskReference: input.taskReference,
      reference,
      facts: { ...predicateFacts },
    });
  };

  const applyWaitResolution = (
    node: Extract<CompiledWorkflowNode, { readonly kind: 'wait' }>,
    resolution: TaskWaitResolution,
  ): void => {
    const mapping = node.resolutionMapping;
    if (mapping === undefined) return;
    if (!isRecord(resolution)) {
      throw ApplicationFailure.nonRetryable(`Wait ${node.id} received a non-object resolution`);
    }
    const outcome = resolution[mapping.discriminator];
    if (typeof outcome !== 'string') {
      throw ApplicationFailure.nonRetryable(
        `Wait ${node.id} resolution has no ${mapping.discriminator} outcome`,
      );
    }
    const facts = mapping.cases[outcome];
    if (facts === undefined) {
      throw ApplicationFailure.nonRetryable(
        `Wait ${node.id} received unsupported outcome ${outcome}`,
      );
    }
    Object.assign(predicateFacts, facts);
  };

  const executeNode = async (node: CompiledWorkflowNode): Promise<Traversal> => {
    if (completedLifecycleNodeIds.has(node.id)) return { kind: 'continue' };
    markRunning(node.id);

    switch (node.kind) {
      case 'sequence': {
        for (const child of node.children) {
          const traversal = await executeNode(child);
          if (traversal.kind === 'finalized') {
            nodeStates[node.id] = 'succeeded';
            return traversal;
          }
        }
        nodeStates[node.id] = 'succeeded';
        return { kind: 'continue' };
      }
      case 'step': {
        await ensureExecutionContext(node.id);
        if (
          state.executionContext.status !== 'ready' &&
          state.executionContext.status !== 'runtime_preparation_required'
        ) {
          throw ApplicationFailure.nonRetryable('Execution step has no prepared execution context');
        }
        let operatorGuidance = queuedOperatorGuidance;
        queuedOperatorGuidance = null;
        for (;;) {
          if (patched(DOCKER_RUNTIME_RECOVERY_PATCH)) {
            await reconcileDockerExecutionContext(node.id);
          }
          const readyContext = state.executionContext;
          if (
            readyContext.status !== 'ready' &&
            readyContext.status !== 'runtime_preparation_required'
          ) {
            throw ApplicationFailure.nonRetryable(
              'Execution step lost its prepared execution context',
            );
          }
          attempts[node.id] = (attempts[node.id] ?? 0) + 1;
          const execute = (() => {
            switch (node.activityDelivery.kind) {
              case 'single_attempt':
                return executionActivities.executeStep;
              case 'read_only':
                return readOnlyExecutionActivities.executeReadOnlyStep;
              case 'workspace_reconciled':
                return workspaceReconciledExecutionActivities.executeWorkspaceReconciledStep;
              case 'remote_reconciled':
                return remoteReconciledExecutionActivities.executeRemoteReconciledStep;
            }
          })();
          const result = await execute({
            taskReference: input.taskReference,
            workflowId: execution.workflowId,
            workflowRunId: execution.runId,
            workflowHash: activeWorkflowHash,
            nodeId: node.id,
            stepAttempt: attempts[node.id] ?? 1,
            uses: node.uses,
            activityDelivery: node.activityDelivery,
            workspace: readyContext.workspace,
            planningSnapshot: readyContext.planningSnapshot,
            operatorGuidance,
            input: node.with,
          });
          if (result.status === 'completed') {
            Object.assign(predicateFacts, result.predicateResults);
            nodeStates[node.id] = 'succeeded';
            return { kind: 'continue' };
          }
          if (result.status === 'workflow_change_required') {
            const artifactId = result.artifactIds[0];
            if (artifactId === undefined) {
              throw ApplicationFailure.nonRetryable(
                'Workflow change request has no durable evidence artifact',
              );
            }
            state = {
              ...state,
              workflowChange: {
                nodeId: node.id,
                attempt: attempts[node.id] ?? 1,
                artifactId,
                request: result.request,
              },
            };
            const resolution = await openWait(node.id, 'workflow_change.review@1');
            const continuation = continuationAcceptanceFrom(resolution);
            if (continuation !== null) return executeContinuation(node.id, continuation);
            const review = planReviewFrom(resolution);
            if (review?.decision !== 'request_changes') {
              throw ApplicationFailure.nonRetryable(
                'Workflow change requires continuation acceptance or revision guidance',
              );
            }
            operatorGuidance = review.guidance;
            state = { ...state, workflowChange: null };
          } else {
            const resolution = await openWait(node.id, result.waitKind, result.summary);
            operatorGuidance = operatorGuidanceFrom(resolution);
          }
          markRunning(node.id);
        }
      }
      case 'branch': {
        const takeThen = await evaluate(node.when);
        const selected = takeThen ? node.then : node.otherwise;
        const skipped = takeThen ? node.otherwise : node.then;
        setSubtreeStatus(skipped, 'skipped', nodeStates);
        const traversal = await executeNode(selected);
        nodeStates[node.id] = 'succeeded';
        return traversal;
      }
      case 'bounded_loop': {
        for (;;) {
          if (node.checkBefore && (await evaluate(node.until))) {
            nodeStates[node.id] = 'succeeded';
            return { kind: 'continue' };
          }
          for (let attempt = 1; attempt <= node.maxAttempts; attempt += 1) {
            attempts[node.id] = attempt;
            const traversal = await executeNode(node.body);
            if (traversal.kind === 'finalized') {
              nodeStates[node.id] = 'succeeded';
              return traversal;
            }
            if (await evaluate(node.until)) {
              nodeStates[node.id] = 'succeeded';
              return { kind: 'continue' };
            }
          }
          if (node.exhaustedWait === undefined) {
            nodeStates[node.id] = 'failed';
            throw new Error(
              `Bounded loop ${node.id} exhausted ${String(node.maxAttempts)} attempts`,
            );
          }
          const resolution = await openWait(node.id, node.exhaustedWait);
          const guidance = operatorGuidanceFrom(resolution);
          if (guidance === null) {
            throw ApplicationFailure.nonRetryable(
              `Exhausted loop ${node.id} requires operator guidance`,
            );
          }
          queuedOperatorGuidance = guidance;
        }
      }
      case 'wait': {
        const resolution = await openWait(node.id, node.for);
        applyWaitResolution(node, resolution);
        return { kind: 'continue' };
      }
      case 'gate': {
        await openWait(node.id, node.resumeWhen);
        return { kind: 'continue' };
      }
      case 'finalize':
        nodeStates[node.id] = 'succeeded';
        return { kind: 'finalized', outcome: node.outcome };
    }
  };

  await completePlanningLifecycle();
  const traversal = await executeNode(activeGraph.root);
  if (traversal.kind !== 'finalized') {
    throw new Error('Validated workflow completed without a terminal outcome');
  }
  const terminalOutcome = traversal.outcome;
  if (state.lifecycle.phase !== 'frozen') {
    throw ApplicationFailure.nonRetryable('Execution completed without a workflow freeze receipt');
  }
  const frozenLifecycle = state.lifecycle;

  state = {
    ...state,
    lifecycle: frozenLifecycle,
    status: 'completed',
    currentNodeId: null,
    wait: null,
    outcome: terminalOutcome,
  };

  return {
    taskReference: input.taskReference,
    workflowHash: activeWorkflowHash,
    outcome: terminalOutcome,
  };
}
