import {
  getHarnessStepDefinition,
  M1_WORKFLOW_CONTRACTS,
  type PresentationNode,
  type WorkflowPresentationTree,
} from '../planning/index.js';
import type { WorkflowStageDescriptor } from '../workflow/index.js';
import {
  OperatorWorkflowStageSchema,
  WorkflowTechnicalNodeSchema,
  type OperatorWorkflowStage,
  type WorkflowNodeStatus,
  type WorkflowTechnicalNode,
} from './m1-contracts.js';

const fallbackStage = { id: 'workflow', label: 'Workflow' } as const;

const childrenFor = (node: PresentationNode): readonly string[] => {
  switch (node.kind) {
    case 'sequence':
      return node.childIds;
    case 'branch':
      return [node.thenId, node.otherwiseId];
    case 'bounded_loop':
      return [node.bodyId];
    case 'finalize':
    case 'gate':
    case 'step':
    case 'wait':
      return [];
  }
};

const nodeLabel = (node: PresentationNode): string => {
  switch (node.kind) {
    case 'step':
      return `${node.id} · ${node.uses}`;
    case 'bounded_loop':
      return `${node.id} · max ${String(node.maxAttempts)}`;
    case 'wait':
      return `${node.id} · ${node.waitKind}`;
    case 'gate':
      return `${node.id} · ${node.reason}`;
    case 'finalize':
      return `${node.id} · ${node.outcome}`;
    case 'branch':
      return `${node.id} · ${node.when}`;
    case 'sequence':
      return node.id;
  }
};

const requireNode = (presentation: WorkflowPresentationTree, nodeId: string): PresentationNode => {
  const node = presentation.nodes[nodeId];
  if (node === undefined) {
    throw new Error(`Presentation references missing node ${nodeId}`);
  }
  return node;
};

const stageForLeaf = (node: PresentationNode): WorkflowStageDescriptor | null => {
  switch (node.kind) {
    case 'step': {
      const definition = getHarnessStepDefinition(node.uses);
      if (definition === undefined) {
        throw new Error(`Presentation references unregistered harness block ${node.uses}`);
      }
      return definition.block.stage;
    }
    case 'wait': {
      const contract = M1_WORKFLOW_CONTRACTS.waits.get(node.waitKind);
      if (contract === undefined) {
        throw new Error(`Presentation references unregistered wait ${node.waitKind}`);
      }
      return contract.stage;
    }
    case 'branch':
    case 'bounded_loop':
    case 'finalize':
    case 'gate':
    case 'sequence':
      return null;
  }
};

const firstDescendantStage = (
  presentation: WorkflowPresentationTree,
  nodeId: string,
  ancestors: ReadonlySet<string>,
): WorkflowStageDescriptor | null => {
  if (ancestors.has(nodeId)) {
    throw new Error(`Presentation contains a cycle at ${nodeId}`);
  }

  const node = requireNode(presentation, nodeId);
  const direct = stageForLeaf(node);
  if (direct !== null) return direct;

  const nextAncestors = new Set(ancestors).add(nodeId);
  for (const childId of childrenFor(node)) {
    const stage = firstDescendantStage(presentation, childId, nextAncestors);
    if (stage !== null) return stage;
  }
  return null;
};

const toTechnicalNode = (
  presentation: WorkflowPresentationTree,
  nodeId: string,
  ancestors: ReadonlySet<string>,
): WorkflowTechnicalNode => {
  if (ancestors.has(nodeId)) {
    throw new Error(`Presentation contains a cycle at ${nodeId}`);
  }

  const node = requireNode(presentation, nodeId);
  const nextAncestors = new Set(ancestors).add(nodeId);
  return WorkflowTechnicalNodeSchema.parse({
    id: node.id,
    kind: node.kind,
    label: nodeLabel(node),
    status: node.status,
    ...(node.kind === 'wait' ? { waitKind: node.waitKind } : {}),
    children: childrenFor(node).map((childId) =>
      toTechnicalNode(presentation, childId, nextAncestors),
    ),
  });
};

const collectStatuses = (nodes: readonly WorkflowTechnicalNode[]): readonly WorkflowNodeStatus[] =>
  nodes.flatMap((node) => [node.status, ...collectStatuses(node.children)]);

export const aggregateWorkflowStageStatus = (
  nodes: readonly WorkflowTechnicalNode[],
): WorkflowNodeStatus => {
  const statuses = collectStatuses(nodes);
  if (statuses.includes('failed')) return 'failed';
  if (statuses.includes('waiting')) return 'waiting';
  if (statuses.includes('running')) return 'running';
  if (statuses.every((status) => status === 'skipped')) return 'skipped';
  if (statuses.every((status) => status === 'succeeded' || status === 'skipped')) {
    return 'succeeded';
  }
  return 'planned';
};

export const createOperatorWorkflowStages = (
  presentation: WorkflowPresentationTree,
): readonly OperatorWorkflowStage[] => {
  const root = requireNode(presentation, presentation.rootId);
  const roots = root.kind === 'sequence' ? root.childIds : [root.id];
  const candidates = roots.map((nodeId) => ({
    node: toTechnicalNode(presentation, nodeId, new Set()),
    stage: firstDescendantStage(presentation, nodeId, new Set()),
  }));
  const stages: OperatorWorkflowStage[] = [];

  for (const [index, candidate] of candidates.entries()) {
    const previous = stages.at(-1);
    const next = candidates.slice(index + 1).find(({ stage }) => stage !== null)?.stage;
    const descriptor = candidate.stage ?? previous ?? next ?? fallbackStage;

    if (previous?.id === descriptor.id) {
      const nodes = [...previous.nodes, candidate.node];
      stages[stages.length - 1] = OperatorWorkflowStageSchema.parse({
        ...previous,
        nodes,
        status: aggregateWorkflowStageStatus(nodes),
      });
      continue;
    }

    stages.push(
      OperatorWorkflowStageSchema.parse({
        key: `${descriptor.id}:${String(stages.length + 1)}`,
        id: descriptor.id,
        label: descriptor.label,
        status: aggregateWorkflowStageStatus([candidate.node]),
        nodes: [candidate.node],
      }),
    );
  }

  return stages;
};

const applyNodeStatuses = (
  node: WorkflowTechnicalNode,
  nodeStates: Readonly<Record<string, WorkflowNodeStatus>>,
): WorkflowTechnicalNode =>
  WorkflowTechnicalNodeSchema.parse({
    ...node,
    status: nodeStates[node.id] ?? node.status,
    children: node.children.map((child) => applyNodeStatuses(child, nodeStates)),
  });

export const applyWorkflowNodeStatuses = (
  stages: readonly OperatorWorkflowStage[],
  nodeStates: Readonly<Record<string, WorkflowNodeStatus>>,
): readonly OperatorWorkflowStage[] =>
  stages.map((stage) => {
    const nodes = stage.nodes.map((node) => applyNodeStatuses(node, nodeStates));
    return OperatorWorkflowStageSchema.parse({
      ...stage,
      nodes,
      status: aggregateWorkflowStageStatus(nodes),
    });
  });
