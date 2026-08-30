import {
  ActivityFailure,
  ApplicationFailure,
  condition,
  proxyActivities,
  rootCause,
  setHandler,
  workflowInfo,
} from '@temporalio/workflow';

import type { CompiledWorkflowNode, JsonValue } from '../../graph/index.js';
import { isRecord } from '../../shared/is-record.js';
import type {
  ExecutionBlockResult,
  ExecutionContinuationState,
  ExecutionWorkflowActivities,
  ExecutionWorkflowInput,
  ExecutionWorkflowPublicState,
  ExecutionWorkflowResult,
  ResolveExecutionWaitCommand,
} from '../../kernel/execution-kernel/contracts.js';
import { createExecutionNodeStates } from '../../kernel/execution-kernel/graph-state.js';
import {
  executionWorkflowStateQuery,
  resolveExecutionWaitUpdate,
} from '../../kernel/execution-kernel/messages.js';

const singleDeliveryActivities = proxyActivities<ExecutionWorkflowActivities>({
  startToCloseTimeout: '45 minutes',
  scheduleToCloseTimeout: '3 hours',
  heartbeatTimeout: '30 seconds',
  retry: { maximumAttempts: 1 },
});

const recoverableDeliveryActivities = proxyActivities<ExecutionWorkflowActivities>({
  startToCloseTimeout: '45 minutes',
  scheduleToCloseTimeout: '3 hours',
  heartbeatTimeout: '30 seconds',
  retry: {
    initialInterval: '1 second',
    maximumInterval: '30 seconds',
    maximumAttempts: 3,
  },
});

type AvailableExecutionState = Extract<
  ExecutionWorkflowPublicState,
  { readonly status: 'running' | 'waiting' | 'completed' }
>;
type Traversal =
  { readonly kind: 'continue' } | { readonly kind: 'finalized'; readonly outcome: string };

const unexpectedNodeKind = (node: never): never => {
  const invalidNode = node as { readonly kind: string; readonly id: string };
  throw ApplicationFailure.nonRetryable(
    `Unknown execution node kind "${invalidNode.kind}" for node "${invalidNode.id}"`,
  );
};

const guidanceFrom = (resolution: JsonValue): string | null =>
  isRecord(resolution) &&
  typeof resolution.guidance === 'string' &&
  resolution.guidance.trim().length > 0
    ? resolution.guidance.trim()
    : null;

const dismissesWorkflowChange = (resolution: JsonValue): boolean =>
  isRecord(resolution) && resolution.decision === 'dismiss_workflow_change';

const hasFalsePredicateFact = (facts: Readonly<Record<string, boolean>>): boolean =>
  Object.values(facts).some((value) => !value);

const continuationReviewFrom = (
  resolution: JsonValue,
  continuationId: string,
):
  | { readonly decision: 'accept' }
  | { readonly decision: 'reject'; readonly guidance: string }
  | null => {
  if (!isRecord(resolution) || resolution.continuationId !== continuationId) return null;
  if (resolution.decision === 'accept') return { decision: 'accept' };
  if (
    resolution.decision === 'reject' &&
    typeof resolution.guidance === 'string' &&
    resolution.guidance.trim().length > 0
  ) {
    return { decision: 'reject', guidance: resolution.guidance.trim() };
  }
  return null;
};

export async function executionWorkflowV2(
  input: ExecutionWorkflowInput,
): Promise<ExecutionWorkflowResult> {
  const execution = workflowInfo();
  const nodeStates = createExecutionNodeStates(input.graph.root);
  const blockRuns: Record<string, number> = {};
  const loopIterations: Record<string, number> = {};
  const predicateFacts: Record<string, boolean> = {};
  const continuations: ExecutionContinuationState[] = [];
  let pendingResolution: ResolveExecutionWaitCommand | null = null;
  let queuedGuidance: string | null = null;
  let state: AvailableExecutionState = {
    runtime: 'execution',
    schemaVersion: 2,
    taskReference: input.taskReference,
    workflowId: execution.workflowId,
    runId: execution.runId,
    workflowHash: input.workflowHash,
    nodeStates,
    blockRuns,
    loopIterations,
    continuations,
    retrospective: input.retrospectiveEnabled ? 'pending' : 'disabled',
    status: 'running',
    currentNodeId: input.graph.root.id,
    wait: null,
    outcome: null,
  };

  setHandler(executionWorkflowStateQuery, () => state);
  setHandler(resolveExecutionWaitUpdate, async (command) => {
    await condition(() => state.status === 'waiting' || state.status === 'completed');
    if (state.status !== 'waiting') {
      throw ApplicationFailure.nonRetryable('Execution workflow is not waiting');
    }
    if (pendingResolution !== null) {
      throw ApplicationFailure.nonRetryable('Execution workflow already has a pending resolution');
    }
    if (state.wait.nodeId !== command.nodeId || state.wait.waitKind !== command.waitKind) {
      throw ApplicationFailure.nonRetryable('Wait resolution does not match the active wait');
    }
    pendingResolution = command;
    return { nodeId: command.nodeId, waitKind: command.waitKind, accepted: true };
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
  ): Promise<JsonValue> => {
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

  const evaluate = (reference: string): boolean => {
    const known = predicateFacts[reference];
    if (known !== undefined) return known;
    return false;
  };

  const runBlock = async (
    node: Extract<CompiledWorkflowNode, { readonly kind: 'step' }>,
    operatorGuidance: string | null,
    waitResolution: JsonValue | null,
  ): Promise<ExecutionBlockResult> => {
    blockRuns[node.id] = (blockRuns[node.id] ?? 0) + 1;
    const activities =
      node.activityDelivery.kind === 'single_attempt'
        ? singleDeliveryActivities
        : recoverableDeliveryActivities;
    try {
      return await activities.runExecutionBlock({
        schemaVersion: 2,
        taskReference: input.taskReference,
        workflowId: execution.workflowId,
        workflowRunId: execution.runId,
        workflowHash: input.workflowHash,
        nodeId: node.id,
        blockRun: blockRuns[node.id] ?? 1,
        uses: node.uses,
        activityDelivery: node.activityDelivery,
        contextReferences: input.contextReferences,
        operatorGuidance,
        waitResolution,
        input: node.with,
      });
    } catch (error) {
      if (!(error instanceof ActivityFailure)) throw error;
      return {
        status: 'needs_input',
        summary: `Execution activity for ${node.uses} failed after retries: ${rootCause(error) ?? error.message}`,
        waitKind: `${node.uses}.activity-failed@1`,
      };
    }
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
        let operatorGuidance = queuedGuidance;
        let waitResolution: JsonValue | null = null;
        queuedGuidance = null;
        for (;;) {
          const result = await runBlock(node, operatorGuidance, waitResolution);
          if (result.status === 'completed') {
            Object.assign(predicateFacts, result.predicateFacts);
            if (
              operatorGuidance !== null &&
              waitResolution !== null &&
              hasFalsePredicateFact(result.predicateFacts)
            ) {
              queuedGuidance = operatorGuidance;
            }
            nodeStates[node.id] = 'succeeded';
            return { kind: 'continue' };
          }
          if (result.status === 'continuation_required') {
            const planningReference = input.contextReferences.find(
              ({ kind }) => kind === 'planning_snapshot',
            );
            if (planningReference?.hash === undefined) {
              throw ApplicationFailure.nonRetryable(
                'Execution continuation has no planning snapshot reference',
              );
            }
            let continuationAttempt = 1;
            let continuationGuidance: string | null = null;
            for (;;) {
              const continuationId = `${execution.runId}:continuation-${String(continuationAttempt)}`;
              continuations.push({
                continuationId,
                attempt: continuationAttempt,
                parentNodeId: node.id,
                requestReference: result.requestReference,
                reason: result.summary,
                transcriptOperationId: `${continuationId}:planner`,
                status: 'planning',
              });
              state = { ...state, continuations: [...continuations] };
              const candidate = await recoverableDeliveryActivities.planExecutionContinuation({
                taskReference: input.taskReference,
                workflowId: execution.workflowId,
                workflowRunId: execution.runId,
                parentNodeId: node.id,
                attempt: continuationAttempt,
                requestReference: result.requestReference,
                planningSnapshot: {
                  artifactId: planningReference.reference,
                  checksum: planningReference.hash,
                },
                guidance: continuationGuidance,
              });
              if (candidate.status === 'needs_input') {
                continuations[continuations.length - 1] = {
                  continuationId,
                  attempt: continuationAttempt,
                  parentNodeId: node.id,
                  requestReference: result.requestReference,
                  reason: candidate.summary,
                  transcriptOperationId: `${continuationId}:planner`,
                  status: 'needs_input',
                };
                state = { ...state, continuations: [...continuations] };
                const resolution = await openWait(node.id, candidate.waitKind, candidate.summary);
                if (dismissesWorkflowChange(resolution)) {
                  continuations[continuations.length - 1] = {
                    continuationId,
                    attempt: continuationAttempt,
                    parentNodeId: node.id,
                    requestReference: result.requestReference,
                    reason: guidanceFrom(resolution) ?? candidate.summary,
                    transcriptOperationId: `${continuationId}:planner`,
                    status: 'dismissed',
                  };
                  state = { ...state, continuations: [...continuations] };
                  nodeStates[node.id] = 'succeeded';
                  return { kind: 'continue' };
                }
                continuationGuidance = guidanceFrom(resolution);
                continuationAttempt += 1;
                markRunning(node.id);
                continue;
              }
              const continuation: ExecutionContinuationState = {
                ...candidate,
                status: 'awaiting_review',
              };
              continuations[continuations.length - 1] = continuation;
              state = { ...state, continuations: [...continuations] };
              const resolution = await openWait(
                node.id,
                'workflow_change.review@1',
                `Review continuation ${candidate.continuationId}`,
              );
              const review = continuationReviewFrom(resolution, candidate.continuationId);
              if (review === null) {
                throw ApplicationFailure.nonRetryable(
                  'Workflow continuation review payload is invalid',
                );
              }
              if (review.decision === 'reject') {
                continuations[continuations.length - 1] = {
                  ...continuation,
                  status: 'rejected',
                };
                state = { ...state, continuations: [...continuations] };
                continuationGuidance = review.guidance;
                continuationAttempt += 1;
                markRunning(node.id);
                continue;
              }
              continuations[continuations.length - 1] = {
                ...continuation,
                status: 'running',
              };
              Object.assign(nodeStates, createExecutionNodeStates(candidate.graph.root));
              state = { ...state, continuations: [...continuations] };
              const traversal = await executeNode(candidate.graph.root);
              if (traversal.kind !== 'finalized') {
                throw ApplicationFailure.nonRetryable(
                  `Continuation ${candidate.continuationId} completed without a terminal outcome`,
                );
              }
              continuations[continuations.length - 1] = {
                ...continuation,
                status: 'completed',
              };
              state = { ...state, continuations: [...continuations] };
              nodeStates[node.id] = 'succeeded';
              return { kind: 'continue' };
            }
          }
          const resolution = await openWait(node.id, result.waitKind, result.summary);
          waitResolution = resolution;
          operatorGuidance = guidanceFrom(resolution);
          markRunning(node.id);
        }
      }
      case 'bounded_loop': {
        for (;;) {
          for (let iteration = 1; iteration <= node.maxAttempts; iteration += 1) {
            loopIterations[node.id] = iteration;
            const traversal = await executeNode(node.body);
            if (traversal.kind === 'finalized') {
              nodeStates[node.id] = 'succeeded';
              return traversal;
            }
            if (evaluate(node.until)) {
              nodeStates[node.id] = 'succeeded';
              return { kind: 'continue' };
            }
          }
          if (node.exhaustedWait === undefined) {
            nodeStates[node.id] = 'failed';
            throw ApplicationFailure.nonRetryable(
              `Bounded loop ${node.id} exhausted ${String(node.maxAttempts)} iterations`,
            );
          }
          const resolution = await openWait(node.id, node.exhaustedWait);
          const guidance = guidanceFrom(resolution);
          if (guidance === null) {
            throw ApplicationFailure.nonRetryable(
              `Exhausted loop ${node.id} requires operator guidance`,
            );
          }
          queuedGuidance = guidance;
        }
      }
      case 'finalize':
        nodeStates[node.id] = 'succeeded';
        return { kind: 'finalized', outcome: node.outcome };
    }
    return unexpectedNodeKind(node);
  };

  const traversal = await executeNode(input.graph.root);
  if (traversal.kind !== 'finalized') {
    throw ApplicationFailure.nonRetryable('Execution graph completed without a terminal outcome');
  }
  state = {
    ...state,
    status: 'completed',
    currentNodeId: null,
    wait: null,
    outcome: traversal.outcome,
  };
  if (input.retrospectiveEnabled) {
    state = { ...state, retrospective: 'running' };
    try {
      await recoverableDeliveryActivities.runExecutionRetrospective({
        taskReference: input.taskReference,
        workflowId: execution.workflowId,
        workflowRunId: execution.runId,
        outcome: traversal.outcome,
      });
      state = { ...state, retrospective: 'succeeded' };
    } catch {
      state = { ...state, retrospective: 'failed' };
    }
  }
  return {
    taskReference: input.taskReference,
    workflowHash: input.workflowHash,
    outcome: traversal.outcome,
  };
}
