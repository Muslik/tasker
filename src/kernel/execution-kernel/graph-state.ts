import type { CompiledWorkflowNode } from '../../graph/index.js';
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
      case 'bounded_loop':
        visit(current.body);
        return;
      case 'step':
      case 'finalize':
        return;
    }
  };
  visit(node);
  return ids;
};

export const createExecutionNodeStates = (node: CompiledWorkflowNode): MutableExecutionNodeStates =>
  Object.fromEntries(collectExecutionNodeIds(node).map((nodeId) => [nodeId, 'planned' as const]));
