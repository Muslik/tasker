import {
  ApplicationFailure,
  condition,
  isCancellation,
  proxyActivities,
  setHandler,
  workflowInfo,
} from '@temporalio/workflow';

import type { CompiledWorkflowNode } from '../../workflow/index.js';
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
} from '../contracts.js';
import { resolveTaskWaitUpdate, taskWorkflowStateQuery } from './messages.js';

const activities = proxyActivities<
  Pick<TaskWorkflowActivities, 'executeStep' | 'evaluatePredicate'>
>({
  startToCloseTimeout: '1 minute',
  retry: {
    initialInterval: '100 milliseconds',
    maximumAttempts: 2,
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

type MutableNodeStates = Record<string, TemporalNodeStatus>;
type MutableAttempts = Record<string, number>;
type PredicateFacts = Record<string, boolean>;
type Traversal =
  { readonly kind: 'continue' } | { readonly kind: 'finalized'; readonly outcome: string };

type PlanningStepNode = Extract<CompiledWorkflowNode, { readonly kind: 'step' }>;

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

export async function taskWorkflow(rawInput: TaskWorkflowInput): Promise<TaskWorkflowResult> {
  // The Client validates the serialized boundary before start. Importing Zod or the
  // compiler here would pull Node-only code into Temporal's deterministic sandbox.
  const input = rawInput;
  const nodeIds: string[] = [];
  collectNodeIds(input.graph.root, nodeIds);

  const nodeStates: MutableNodeStates = Object.fromEntries(
    nodeIds.map((nodeId) => [nodeId, 'planned' as const]),
  );
  const attempts: MutableAttempts = {};
  const predicateFacts: PredicateFacts = {};
  let pendingResolution: ResolveTaskWaitCommand | null = null;
  let planningNode: PlanningStepNode | null = null;
  let planningCommandSequence = 0;
  const execution = workflowInfo();
  let state: TaskWorkflowPublicState = {
    schemaVersion: 1,
    taskReference: input.taskReference,
    workflowId: execution.workflowId,
    runId: execution.runId,
    workflowHash: input.workflowHash,
    settings: input.settings,
    planning: null,
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
      if (state.wait.waitKind === 'workflow_change.review@1') {
        const review = planReviewFrom(command.resolution);
        return review?.decision === 'request_changes';
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

  const openWait = async (nodeId: string, waitKind: string): Promise<TaskWaitResolution> => {
    nodeStates[nodeId] = 'waiting';
    state = {
      ...state,
      status: 'waiting',
      currentNodeId: nodeId,
      wait: { nodeId, waitKind },
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

  const executePlanning = async (
    node: PlanningStepNode,
    initialCommand: PlanningActivityCommand,
  ): Promise<void> => {
    let command = initialCommand;

    for (;;) {
      planningCommandSequence += 1;
      const commandId = `${execution.workflowId}:planning:${String(planningCommandSequence)}`;
      let result: TaskWorkflowPlanningState;
      for (;;) {
        markRunning(node.id);
        attempts[node.id] = (attempts[node.id] ?? 0) + 1;
        try {
          result = await planningActivities.planTaskImplementation({
            taskReference: input.taskReference,
            workflowHash: input.workflowHash,
            planningSnapshot: input.planningSnapshot,
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

      const resolution = await openWait(node.id, 'workflow_change.review@1');
      const review = planReviewFrom(resolution);
      if (review?.decision !== 'request_changes') {
        throw ApplicationFailure.nonRetryable('Workflow change requires revision guidance');
      }
      command = {
        kind: 'revision',
        sourceAttempt: result.attempt,
        guidance: review.guidance,
      };
    }
  };

  const evaluate = async (reference: string): Promise<boolean> => {
    const known = predicateFacts[reference];
    if (known !== undefined) return known;

    return activities.evaluatePredicate({
      taskReference: input.taskReference,
      reference,
      facts: { ...predicateFacts },
    });
  };

  const executeNode = async (node: CompiledWorkflowNode): Promise<Traversal> => {
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
        if (node.uses === 'task.analyze@1') {
          planningNode = node;
          await executePlanning(node, { kind: 'initial' });
          return { kind: 'continue' };
        }
        attempts[node.id] = (attempts[node.id] ?? 0) + 1;
        const result = await activities.executeStep({
          taskReference: input.taskReference,
          nodeId: node.id,
          uses: node.uses,
          input: node.with,
        });
        Object.assign(predicateFacts, result.predicateResults);
        nodeStates[node.id] = 'succeeded';
        return { kind: 'continue' };
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
        nodeStates[node.id] = 'failed';
        throw new Error(`Bounded loop ${node.id} exhausted ${String(node.maxAttempts)} attempts`);
      }
      case 'wait':
        await openWait(node.id, node.for);
        return { kind: 'continue' };
      case 'gate': {
        if (node.resumeWhen === 'plan.approved@1' && input.settings.planApproval === 'automatic') {
          nodeStates[node.id] = 'skipped';
          return { kind: 'continue' };
        }
        if (node.resumeWhen !== 'plan.approved@1') {
          await openWait(node.id, node.resumeWhen);
          return { kind: 'continue' };
        }
        if (planningNode === null || state.planning === null) {
          throw ApplicationFailure.nonRetryable('Plan review has no preceding planning result');
        }
        for (;;) {
          const resolution = await openWait(node.id, node.resumeWhen);
          const review = planReviewFrom(resolution);
          if (review === null) {
            throw ApplicationFailure.nonRetryable('Plan review payload is invalid');
          }
          if (review.decision === 'approve') return { kind: 'continue' };
          await executePlanning(planningNode, {
            kind: 'revision',
            sourceAttempt: state.planning.attempt,
            guidance: review.guidance,
          });
          markRunning(node.id);
        }
      }
      case 'finalize':
        nodeStates[node.id] = 'succeeded';
        return { kind: 'finalized', outcome: node.outcome };
    }
  };

  const traversal = await executeNode(input.graph.root);
  if (traversal.kind !== 'finalized') {
    throw new Error('Validated workflow completed without a terminal outcome');
  }
  const terminalOutcome = traversal.outcome;

  state = {
    ...state,
    status: 'completed',
    currentNodeId: null,
    wait: null,
    outcome: terminalOutcome,
  };

  return {
    taskReference: input.taskReference,
    workflowHash: input.workflowHash,
    outcome: terminalOutcome,
  };
}
