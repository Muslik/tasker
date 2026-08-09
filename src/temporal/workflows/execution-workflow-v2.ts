import {
  ApplicationFailure,
  condition,
  proxyActivities,
  setHandler,
  workflowInfo,
} from '@temporalio/workflow';

import type { CompiledWorkflowNode, JsonValue } from '../../workflow/index.js';
import type {
  ExecutionBlockResult,
  ExecutionWorkflowActivities,
  ExecutionWorkflowInput,
  ExecutionWorkflowPublicState,
  ExecutionWorkflowResult,
  ResolveExecutionWaitCommand,
} from '../execution-kernel/contracts.js';
import {
  createExecutionNodeStates,
  setExecutionSubtreeStatus,
} from '../execution-kernel/graph-state.js';
import {
  executionWorkflowStateQuery,
  resolveExecutionWaitUpdate,
} from '../execution-kernel/messages.js';

const singleDeliveryActivities = proxyActivities<ExecutionWorkflowActivities>({
  startToCloseTimeout: '35 minutes',
  scheduleToCloseTimeout: '2 hours',
  heartbeatTimeout: '30 seconds',
  retry: { maximumAttempts: 1 },
});

const recoverableDeliveryActivities = proxyActivities<ExecutionWorkflowActivities>({
  startToCloseTimeout: '35 minutes',
  scheduleToCloseTimeout: '2 hours',
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

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const guidanceFrom = (resolution: JsonValue): string | null =>
  isRecord(resolution) &&
  typeof resolution.guidance === 'string' &&
  resolution.guidance.trim().length > 0
    ? resolution.guidance.trim()
    : null;

export async function executionWorkflowV2(
  input: ExecutionWorkflowInput,
): Promise<ExecutionWorkflowResult> {
  const execution = workflowInfo();
  const nodeStates = createExecutionNodeStates(input.graph.root);
  const blockRuns: Record<string, number> = {};
  const loopIterations: Record<string, number> = {};
  const predicateFacts: Record<string, boolean> = {};
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
    status: 'running',
    currentNodeId: null,
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

  const evaluate = async (reference: string): Promise<boolean> => {
    const known = predicateFacts[reference];
    if (known !== undefined) return known;
    return recoverableDeliveryActivities.evaluateExecutionPredicate({
      schemaVersion: 2,
      taskReference: input.taskReference,
      reference,
      facts: { ...predicateFacts },
      contextReferences: input.contextReferences,
    });
  };

  const applyWaitResolution = (
    node: Extract<CompiledWorkflowNode, { readonly kind: 'wait' }>,
    resolution: JsonValue,
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

  const runBlock = async (
    node: Extract<CompiledWorkflowNode, { readonly kind: 'step' }>,
    operatorGuidance: string | null,
  ): Promise<ExecutionBlockResult> => {
    blockRuns[node.id] = (blockRuns[node.id] ?? 0) + 1;
    const activities =
      node.activityDelivery.kind === 'single_attempt'
        ? singleDeliveryActivities
        : recoverableDeliveryActivities;
    return activities.runExecutionBlock({
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
      input: node.with,
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
        let operatorGuidance = queuedGuidance;
        queuedGuidance = null;
        for (;;) {
          const result = await runBlock(node, operatorGuidance);
          if (result.status === 'completed') {
            Object.assign(predicateFacts, result.predicateFacts);
            nodeStates[node.id] = 'succeeded';
            return { kind: 'continue' };
          }
          const resolution = await openWait(node.id, result.waitKind, result.summary);
          operatorGuidance = guidanceFrom(resolution);
          markRunning(node.id);
        }
      }
      case 'branch': {
        const takeThen = await evaluate(node.when);
        const selected = takeThen ? node.then : node.otherwise;
        const skipped = takeThen ? node.otherwise : node.then;
        setExecutionSubtreeStatus(skipped, 'skipped', nodeStates);
        const traversal = await executeNode(selected);
        nodeStates[node.id] = 'succeeded';
        return traversal;
      }
      case 'bounded_loop': {
        if (node.checkBefore && (await evaluate(node.until))) {
          nodeStates[node.id] = 'succeeded';
          return { kind: 'continue' };
        }
        for (;;) {
          for (let iteration = 1; iteration <= node.maxAttempts; iteration += 1) {
            loopIterations[node.id] = iteration;
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
      case 'wait': {
        const resolution = await openWait(node.id, node.for);
        applyWaitResolution(node, resolution);
        return { kind: 'continue' };
      }
      case 'gate':
        await openWait(node.id, node.resumeWhen, node.reason);
        return { kind: 'continue' };
      case 'finalize':
        nodeStates[node.id] = 'succeeded';
        return { kind: 'finalized', outcome: node.outcome };
    }
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
  return {
    taskReference: input.taskReference,
    workflowHash: input.workflowHash,
    outcome: traversal.outcome,
  };
}
