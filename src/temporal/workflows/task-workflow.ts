import {
  ApplicationFailure,
  condition,
  proxyActivities,
  setHandler,
  workflowInfo,
} from '@temporalio/workflow';

import type { CompiledWorkflowNode } from '../../workflow/index.js';
import type {
  ResolveTaskWaitCommand,
  TaskWorkflowActivities,
  TaskWorkflowInput,
  TaskWorkflowPublicState,
  TaskWorkflowResult,
  TemporalNodeStatus,
} from '../contracts.js';
import { resolveTaskWaitUpdate, taskWorkflowStateQuery } from './messages.js';

const activities = proxyActivities<TaskWorkflowActivities>({
  startToCloseTimeout: '1 minute',
  retry: {
    initialInterval: '100 milliseconds',
    maximumAttempts: 2,
  },
});

type MutableNodeStates = Record<string, TemporalNodeStatus>;
type MutableAttempts = Record<string, number>;
type PredicateFacts = Record<string, boolean>;
type Traversal =
  { readonly kind: 'continue' } | { readonly kind: 'finalized'; readonly outcome: string };

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
  const execution = workflowInfo();
  let state: TaskWorkflowPublicState = {
    schemaVersion: 1,
    taskReference: input.taskReference,
    workflowId: execution.workflowId,
    runId: execution.runId,
    workflowHash: input.workflowHash,
    settings: input.settings,
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

  const openWait = async (nodeId: string, waitKind: string): Promise<void> => {
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
    pendingResolution = null;
    nodeStates[nodeId] = 'succeeded';
    state = {
      ...state,
      status: 'running',
      currentNodeId: null,
      wait: null,
      outcome: null,
    };
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
      case 'gate':
        if (node.resumeWhen === 'plan.approved@1' && input.settings.planApproval === 'automatic') {
          nodeStates[node.id] = 'skipped';
          return { kind: 'continue' };
        }
        await openWait(node.id, node.resumeWhen);
        return { kind: 'continue' };
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
