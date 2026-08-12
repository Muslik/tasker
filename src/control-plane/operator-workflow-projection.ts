import { blockReceiptId, type BlockReceipt, type BlockReceiptStore } from '../blocks/index.js';
import { getHarnessStepDefinition, M1_WORKFLOW_CONTRACTS } from '../planning/index.js';
import type { ExecutionWorkflowPublicState, TaskRunLifecycle } from '../temporal/index.js';
import type {
  CompiledWorkflow,
  CompiledWorkflowNode,
  WorkflowStageDescriptor,
} from '../workflow/index.js';
import {
  BlockReceiptSummarySchema,
  OperatorWorkflowProjectionSchema,
  OperatorWorkflowStageSchema,
  WorkflowTechnicalNodeSchema,
  type BlockReceiptSummary,
  type OperatorWorkflowProjection,
  type OperatorWorkflowStage,
  type WorkflowNodeStatus,
  type WorkflowTechnicalNode,
} from './m1-contracts.js';

type BlockReceiptReader = Pick<BlockReceiptStore, 'read'>;

const fallbackStage = { id: 'workflow', label: 'Workflow' } as const;

const titleCaseIdentifier = (value: string): string => {
  const words = value.split(/[-_]+/u).filter(Boolean);
  return words
    .map((word, index) => {
      const normalized =
        word.toLowerCase() === 'ci'
          ? 'CI'
          : word.toLowerCase() === 'pr'
            ? 'PR'
            : word.toLowerCase() === 'ai'
              ? 'AI'
              : word.toLowerCase() === 'jira'
                ? 'Jira'
                : word.toLowerCase();
      return index === 0 && !['AI', 'CI', 'PR', 'Jira'].includes(normalized)
        ? normalized.replace(/^\w/u, (character) => character.toUpperCase())
        : normalized;
    })
    .join(' ');
};

const bootstrapGroups = [
  {
    stage: { id: 'workspace', label: 'Workspace' },
    nodes: [{ id: 'workspace', label: 'Prepare workspace' }],
  },
  {
    stage: { id: 'investigation', label: 'Investigate' },
    nodes: [
      { id: 'context', label: 'Collect task context' },
      { id: 'investigation', label: 'Run pre-plan investigation' },
    ],
  },
  {
    stage: { id: 'planning', label: 'Plan' },
    nodes: [
      { id: 'planning', label: 'Build implementation plan' },
      { id: 'plan_review', label: 'Review plan' },
      { id: 'freeze', label: 'Freeze workflow' },
      { id: 'execution_start', label: 'Start execution' },
    ],
  },
] as const satisfies readonly {
  readonly stage: WorkflowStageDescriptor;
  readonly nodes: readonly { readonly id: string; readonly label: string }[];
}[];

const childrenFor = (node: CompiledWorkflowNode): readonly CompiledWorkflowNode[] => {
  switch (node.kind) {
    case 'sequence':
      return node.children;
    case 'branch':
      return [node.then, node.otherwise];
    case 'bounded_loop':
      return [node.body];
    case 'finalize':
    case 'gate':
    case 'step':
    case 'wait':
      return [];
  }
};

const nodeLabel = (node: CompiledWorkflowNode): string => {
  switch (node.kind) {
    case 'step':
      return titleCaseIdentifier(node.id);
    case 'bounded_loop':
      return titleCaseIdentifier(node.id);
    case 'wait':
      return titleCaseIdentifier(node.id);
    case 'gate':
      return titleCaseIdentifier(node.id);
    case 'finalize':
      return titleCaseIdentifier(node.id);
    case 'branch':
      return titleCaseIdentifier(node.id);
    case 'sequence':
      return titleCaseIdentifier(node.id);
  }
};

const stageForLeaf = (node: CompiledWorkflowNode): WorkflowStageDescriptor | null => {
  switch (node.kind) {
    case 'step': {
      const definition = getHarnessStepDefinition(node.uses);
      if (definition === undefined) {
        throw new Error(`Compiled workflow references unregistered harness block ${node.uses}`);
      }
      return definition.block.stage;
    }
    case 'wait': {
      const contract = M1_WORKFLOW_CONTRACTS.waits.get(node.for);
      if (contract === undefined) {
        throw new Error(`Compiled workflow references unregistered wait ${node.for}`);
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
  node: CompiledWorkflowNode,
  ancestors: ReadonlySet<string>,
): WorkflowStageDescriptor | null => {
  if (ancestors.has(node.id)) throw new Error(`Compiled workflow contains a cycle at ${node.id}`);
  const direct = stageForLeaf(node);
  if (direct !== null) return direct;

  const nextAncestors = new Set(ancestors).add(node.id);
  for (const child of childrenFor(node)) {
    const stage = firstDescendantStage(child, nextAncestors);
    if (stage !== null) return stage;
  }
  return null;
};

const receiptSummary = (receipt: BlockReceipt): BlockReceiptSummary =>
  BlockReceiptSummarySchema.parse({
    receiptId: receipt.receiptId,
    blockRun: receipt.blockRun,
    claimStatus: receipt.claim.status,
    verdict: receipt.verdict.status,
    summary: receipt.claim.summary,
    evidence: receipt.evidence,
    transcriptReference: receipt.transcriptReference,
    usageReference: receipt.usageReference,
    completedAt: receipt.completedAt,
  });

const receiptsFor = (
  nodeId: string,
  attempts: number,
  execution: ExecutionWorkflowPublicState,
  receipts: BlockReceiptReader,
): readonly BlockReceiptSummary[] => {
  const summaries: BlockReceiptSummary[] = [];
  for (let blockRun = 1; blockRun <= attempts; blockRun += 1) {
    const receiptId = blockReceiptId({
      workflowId: execution.workflowId,
      workflowRunId: execution.runId,
      nodeId,
      blockRun,
    });
    const stored = receipts.read(receiptId);
    if (!stored.ok) {
      throw new Error(`Cannot read block receipt ${receiptId}: ${stored.error.kind}`);
    }
    if (stored.value !== null) summaries.push(receiptSummary(stored.value));
  }
  return summaries;
};

const toTechnicalNode = (
  node: CompiledWorkflowNode,
  execution: ExecutionWorkflowPublicState | null,
  receipts: BlockReceiptReader,
  ancestors: ReadonlySet<string>,
): WorkflowTechnicalNode => {
  if (ancestors.has(node.id)) throw new Error(`Compiled workflow contains a cycle at ${node.id}`);
  const nextAncestors = new Set(ancestors).add(node.id);
  const attempts = node.kind === 'step' ? (execution?.blockRuns[node.id] ?? 0) : 0;

  return WorkflowTechnicalNodeSchema.parse({
    id: node.id,
    kind: node.kind,
    label: nodeLabel(node),
    status: execution?.nodeStates[node.id] ?? 'planned',
    ...(node.kind === 'wait' ? { waitKind: node.for } : {}),
    details:
      node.kind === 'step'
        ? {
            kind: 'block',
            blockReference: node.uses,
            attempts,
            receipts: execution === null ? [] : receiptsFor(node.id, attempts, execution, receipts),
          }
        : node.kind === 'bounded_loop'
          ? {
              kind: 'loop',
              maxAttempts: node.maxAttempts,
              completedIterations: execution?.loopIterations[node.id] ?? 0,
              until: node.until,
            }
          : { kind: 'none' },
    children: childrenFor(node).map((child) =>
      toTechnicalNode(child, execution, receipts, nextAncestors),
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

const bootstrapAttempts = (lifecycle: TaskRunLifecycle, nodeId: string): number => {
  if (nodeId !== 'investigation') return lifecycle.bootstrap.attempts[nodeId] ?? 0;
  return Object.entries(lifecycle.bootstrap.attempts)
    .filter(([key]) => key.startsWith('investigation:'))
    .reduce((total, [, attempts]) => total + attempts, 0);
};

const createBootstrapStages = (lifecycle: TaskRunLifecycle): readonly OperatorWorkflowStage[] =>
  bootstrapGroups.map(({ stage, nodes }, index) => {
    const technicalNodes = nodes.map(({ id, label }) =>
      WorkflowTechnicalNodeSchema.parse({
        id: `bootstrap:${id}`,
        kind: 'bootstrap',
        label,
        status: lifecycle.bootstrap.nodeStates[id] ?? 'planned',
        details: { kind: 'bootstrap', attempts: bootstrapAttempts(lifecycle, id) },
        children: [],
      }),
    );
    return OperatorWorkflowStageSchema.parse({
      key: `bootstrap:${stage.id}:${String(index + 1)}`,
      ...stage,
      status: aggregateWorkflowStageStatus(technicalNodes),
      presentation: { kind: 'phase' },
      nodes: technicalNodes,
    });
  });

const executionStageFor = (
  node: CompiledWorkflowNode,
  execution: ExecutionWorkflowPublicState | null,
  fallback: WorkflowStageDescriptor,
  previousStage: WorkflowStageDescriptor | null,
  nextStage: WorkflowStageDescriptor | null,
) => {
  if (node.kind === 'bounded_loop') {
    const belongsToSurroundingPhase =
      previousStage !== null &&
      ((nextStage !== null && previousStage.id === nextStage.id) ||
        previousStage.id === fallback.id);
    if (belongsToSurroundingPhase) {
      return {
        descriptor: previousStage,
        presentation: { kind: 'phase' as const },
      };
    }
    return {
      descriptor: { id: `loop:${node.id}`, label: titleCaseIdentifier(node.id) },
      presentation: {
        kind: 'loop' as const,
        maxAttempts: node.maxAttempts,
        completedIterations: execution?.loopIterations[node.id] ?? 0,
        until: node.until,
      },
    };
  }
  if (fallback.id === 'preparation') {
    return {
      descriptor: { ...fallback, label: 'Start work' },
      presentation: { kind: 'phase' as const },
    };
  }
  if (node.kind === 'finalize') {
    return {
      descriptor: { id: `finalize:${node.id}`, label: 'Complete' },
      presentation: { kind: 'phase' as const },
    };
  }
  return { descriptor: fallback, presentation: { kind: 'phase' as const } };
};

const createExecutionStages = (
  graph: CompiledWorkflow,
  execution: ExecutionWorkflowPublicState | null,
  receipts: BlockReceiptReader,
): readonly OperatorWorkflowStage[] => {
  const roots = graph.root.kind === 'sequence' ? graph.root.children : [graph.root];
  const candidates = roots.map((node) => {
    const descendantStage = firstDescendantStage(node, new Set());
    return {
      source: node,
      node: toTechnicalNode(node, execution, receipts, new Set()),
      stage: descendantStage,
    };
  });
  const stages: OperatorWorkflowStage[] = [];

  for (const [index, candidate] of candidates.entries()) {
    const previous = stages.at(-1);
    const previousCandidate = candidates
      .slice(0, index)
      .reverse()
      .find(({ stage }) => stage !== null)?.stage;
    const nextCandidate = candidates.slice(index + 1).find(({ stage }) => stage !== null)?.stage;
    const fallback = candidate.stage ?? previousCandidate ?? nextCandidate ?? fallbackStage;
    const { descriptor, presentation } = executionStageFor(
      candidate.source,
      execution,
      fallback,
      previousCandidate ?? null,
      nextCandidate ?? null,
    );

    if (presentation.kind === 'phase' && previous?.id === descriptor.id) {
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
        key: `execution:${descriptor.id}:${String(stages.length + 1)}`,
        id: descriptor.id,
        label: descriptor.label,
        status: aggregateWorkflowStageStatus([candidate.node]),
        presentation,
        nodes: [candidate.node],
      }),
    );
  }

  return stages;
};

export const createOperatorWorkflowProjection = (
  taskReference: string,
  lifecycle: TaskRunLifecycle | null,
  receipts: BlockReceiptReader,
): OperatorWorkflowProjection => {
  if (lifecycle === null) {
    return OperatorWorkflowProjectionSchema.parse({
      schemaVersion: 2,
      taskReference,
      status: 'not_started',
      activeRuntime: null,
      graphHash: null,
      stages: [],
    });
  }

  const execution = lifecycle.execution;
  const active = execution ?? lifecycle.bootstrap;
  const graph = lifecycle.bootstrap.draft?.graph ?? null;
  return OperatorWorkflowProjectionSchema.parse({
    schemaVersion: 2,
    taskReference,
    status: active.status,
    activeRuntime: execution === null ? 'bootstrap' : 'execution',
    graphHash: lifecycle.bootstrap.workflowHash,
    stages: [
      ...createBootstrapStages(lifecycle),
      ...(graph === null ? [] : createExecutionStages(graph, execution, receipts)),
    ],
  });
};
