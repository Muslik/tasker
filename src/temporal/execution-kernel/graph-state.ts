import type { CompiledWorkflowNode } from '../../workflow/index.js';
import type { ExecutionNodeStatus } from './contracts.js';

export type MutableExecutionNodeStates = Record<string, ExecutionNodeStatus>;

export const collectExecutionNodeIds = (node: CompiledWorkflowNode): readonly string[] => {
  const ids: string[] = [];
  const visit = (current: CompiledWorkflowNode): void => {
    ids.push(current.id);
    switch (current.kind) {
      case 'sequence':
        for (const child of current.children) visit(child);
        return;
      case 'branch':
        visit(current.then);
        visit(current.otherwise);
        return;
      case 'bounded_loop':
        visit(current.body);
        return;
      case 'step':
      case 'wait':
      case 'gate':
      case 'finalize':
        return;
    }
  };
  visit(node);
  return ids;
};

export const createExecutionNodeStates = (node: CompiledWorkflowNode): MutableExecutionNodeStates =>
  Object.fromEntries(collectExecutionNodeIds(node).map((nodeId) => [nodeId, 'planned' as const]));

export const setExecutionSubtreeStatus = (
  node: CompiledWorkflowNode,
  status: ExecutionNodeStatus,
  nodeStates: MutableExecutionNodeStates,
): void => {
  nodeStates[node.id] = status;
  switch (node.kind) {
    case 'sequence':
      for (const child of node.children) setExecutionSubtreeStatus(child, status, nodeStates);
      return;
    case 'branch':
      setExecutionSubtreeStatus(node.then, status, nodeStates);
      setExecutionSubtreeStatus(node.otherwise, status, nodeStates);
      return;
    case 'bounded_loop':
      setExecutionSubtreeStatus(node.body, status, nodeStates);
      return;
    case 'step':
    case 'wait':
    case 'gate':
    case 'finalize':
      return;
  }
};
