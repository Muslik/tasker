import { blockReceiptId, type BlockReceipt, type BlockReceiptStore } from '../blocks/index.js';
import { getHarnessStepDefinition, M1_WORKFLOW_CONTRACTS } from '../planning/index.js';
import type { RunPlanningSnapshot } from '../planning/run-planning-snapshot.js';
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
  OperatorWorkflowStepSchema,
  type BlockReceiptSummary,
  type OperatorWorkflowProjection,
  type OperatorWorkflowStage,
  type OperatorWorkflowStep,
  type WorkflowNodeStatus,
} from './m1-contracts.js';

type BlockReceiptReader = Pick<BlockReceiptStore, 'read'>;
type ExecutionSnapshotReader = (lifecycle: TaskRunLifecycle) => RunPlanningSnapshot | null;

const titleCaseIdentifier = (value: string): string =>
  value
    .split(/[-_]+/u)
    .filter(Boolean)
    .map((word, index) => {
      const normalized = ['ai', 'ci', 'pr', 'jira'].includes(word.toLowerCase())
        ? word.toUpperCase().replace('JIRA', 'Jira')
        : word.toLowerCase();
      return index === 0 && !['AI', 'CI', 'PR', 'Jira'].includes(normalized)
        ? normalized.replace(/^\w/u, (character) => character.toUpperCase())
        : normalized;
    })
    .join(' ');

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
    if (!stored.ok) throw new Error(`Cannot read block receipt ${receiptId}: ${stored.error.kind}`);
    if (stored.value !== null) summaries.push(receiptSummary(stored.value));
  }
  return summaries;
};

const aggregateStatus = (statuses: readonly WorkflowNodeStatus[]): WorkflowNodeStatus => {
  if (statuses.includes('failed')) return 'failed';
  if (statuses.includes('waiting')) return 'waiting';
  if (statuses.includes('running')) return 'running';
  if (statuses.includes('succeeded')) return 'succeeded';
  if (statuses.length > 0 && statuses.every((status) => status === 'skipped')) return 'skipped';
  return 'planned';
};

const bootstrapAttemptCount = (lifecycle: TaskRunLifecycle, nodeId: string): number => {
  if (nodeId !== 'investigation') return lifecycle.bootstrap.attempts[nodeId] ?? 0;
  return Object.entries(lifecycle.bootstrap.attempts)
    .filter(([key]) => key.startsWith('investigation:'))
    .reduce((total, [, attempts]) => total + attempts, 0);
};

const bootstrapStatus = (
  lifecycle: TaskRunLifecycle,
  nodeIds: readonly string[],
): WorkflowNodeStatus =>
  aggregateStatus(nodeIds.map((id) => lifecycle.bootstrap.nodeStates[id] ?? 'planned'));

const createBootstrapStages = (lifecycle: TaskRunLifecycle): readonly OperatorWorkflowStage[] => {
  const investigationStatus = lifecycle.bootstrap.nodeStates.investigation ?? 'planned';
  const planningStatus = lifecycle.bootstrap.nodeStates.planning ?? 'planned';
  const planReviewStatus = lifecycle.bootstrap.nodeStates.plan_review ?? 'planned';
  const investigationAttempts = bootstrapAttemptCount(lifecycle, 'investigation');
  const planningAttempts = bootstrapAttemptCount(lifecycle, 'planning');
  const investigationSteps: OperatorWorkflowStep[] =
    investigationStatus === 'planned' || investigationStatus === 'skipped'
      ? []
      : [
          OperatorWorkflowStepSchema.parse({
            kind: 'agent',
            id: 'bootstrap:investigation',
            label: 'Investigate task',
            status: investigationStatus,
            reference: 'bootstrap.investigation',
            profile: 'investigation',
            skills: [],
            attempts: investigationAttempts,
            receipts: [],
          }),
        ];
  const planningSteps: OperatorWorkflowStep[] = [];
  if (planningStatus !== 'planned' && planningStatus !== 'skipped') {
    planningSteps.push(
      OperatorWorkflowStepSchema.parse({
        kind: 'agent',
        id: 'bootstrap:planning',
        label: 'Build implementation plan',
        status: planningStatus,
        reference: 'bootstrap.planning',
        profile: lifecycle.bootstrap.planning?.selectedStrategy ?? 'planner',
        skills: [],
        attempts: planningAttempts,
        receipts: [],
      }),
    );
  }
  if (planReviewStatus === 'waiting' || planReviewStatus === 'succeeded') {
    planningSteps.push(
      OperatorWorkflowStepSchema.parse({
        kind: 'wait',
        id: 'bootstrap:plan-review',
        label: 'Review plan',
        status: planReviewStatus,
        reference: 'plan_approval@1',
      }),
    );
  }

  return [
    OperatorWorkflowStageSchema.parse({
      key: 'bootstrap:workspace:1',
      id: 'workspace',
      label: 'Workspace',
      status: bootstrapStatus(lifecycle, ['workspace']),
      steps: [],
    }),
    OperatorWorkflowStageSchema.parse({
      key: 'bootstrap:investigation:2',
      id: 'investigation',
      label: 'Investigate',
      status: bootstrapStatus(lifecycle, ['context', 'investigation']),
      steps: investigationSteps,
    }),
    OperatorWorkflowStageSchema.parse({
      key: 'bootstrap:planning:3',
      id: 'planning',
      label: 'Plan',
      status: bootstrapStatus(lifecycle, ['planning', 'plan_review', 'freeze']),
      steps: planningSteps,
    }),
  ];
};

interface ExecutionStageBuilder {
  readonly id: string;
  readonly label: string;
  readonly statuses: WorkflowNodeStatus[];
  readonly steps: OperatorWorkflowStep[];
}

const executionNodeStatus = (
  execution: ExecutionWorkflowPublicState | null,
  nodeId: string,
): WorkflowNodeStatus => execution?.nodeStates[nodeId] ?? 'planned';

const executionStageDescriptor = (
  node: CompiledWorkflowNode,
  snapshot: RunPlanningSnapshot | null,
): WorkflowStageDescriptor | null => {
  if (node.kind === 'step') {
    const snapshotted = snapshot?.harness.steps.find(({ reference }) => reference === node.uses);
    if (snapshotted !== undefined) return snapshotted.block.stage;
    const definition = getHarnessStepDefinition(node.uses);
    if (definition === undefined) {
      throw new Error(`Compiled workflow references unregistered harness block ${node.uses}`);
    }
    return definition.block.stage;
  }
  if (node.kind === 'wait') {
    const contract = M1_WORKFLOW_CONTRACTS.waits.get(node.for);
    if (contract === undefined)
      throw new Error(`Compiled workflow references unregistered wait ${node.for}`);
    return contract.stage;
  }
  if (node.kind === 'finalize') return { id: 'complete', label: 'Complete' };
  return null;
};

const firstDescendantStage = (
  node: CompiledWorkflowNode,
  snapshot: RunPlanningSnapshot | null,
): WorkflowStageDescriptor | null => {
  const direct = executionStageDescriptor(node, snapshot);
  if (direct !== null) return direct;
  for (const child of childrenFor(node)) {
    const stage: WorkflowStageDescriptor | null = firstDescendantStage(child, snapshot);
    if (stage !== null) return stage;
  }
  return null;
};

const createExecutionStages = (
  graph: CompiledWorkflow,
  execution: ExecutionWorkflowPublicState | null,
  receipts: BlockReceiptReader,
  snapshot: RunPlanningSnapshot | null,
): readonly OperatorWorkflowStage[] => {
  const stages = new Map<string, ExecutionStageBuilder>();
  const ensureStage = (id: string, label: string): ExecutionStageBuilder => {
    const existing = stages.get(id);
    if (existing !== undefined) return existing;
    const created = { id, label, statuses: [], steps: [] };
    stages.set(id, created);
    return created;
  };

  const visit = (node: CompiledWorkflowNode): void => {
    const descriptor = executionStageDescriptor(node, snapshot);
    if (descriptor !== null) {
      const stage = ensureStage(descriptor.id, descriptor.label);
      const status = executionNodeStatus(execution, node.id);
      stage.statuses.push(status);
      const showConfigurableStep = status !== 'planned' && status !== 'skipped';
      if (node.kind === 'step') {
        const definition = getHarnessStepDefinition(node.uses);
        const snapshotted = snapshot?.harness.steps.find(
          ({ reference }) => reference === node.uses,
        );
        const block = snapshotted?.block ?? definition?.block;
        if (block?.executor.kind === 'agent' && showConfigurableStep) {
          const attempts = execution?.blockRuns[node.id] ?? 0;
          stage.steps.push(
            OperatorWorkflowStepSchema.parse({
              kind: 'agent',
              id: node.id,
              label: titleCaseIdentifier(node.id),
              status,
              reference: node.uses,
              profile: snapshotted?.executionProfile?.name ?? block.executor.profile,
              skills: block.executor.skills,
              attempts,
              receipts:
                execution === null ? [] : receiptsFor(node.id, attempts, execution, receipts),
            }),
          );
        } else if (block?.executor.kind === 'process' && showConfigurableStep) {
          const attempts = execution?.blockRuns[node.id] ?? 0;
          stage.steps.push(
            OperatorWorkflowStepSchema.parse({
              kind: 'process',
              id: node.id,
              label: titleCaseIdentifier(node.id),
              status,
              reference: node.uses,
              executor: snapshotted?.resolvedCommand ?? block.executor.executor,
              attempts,
              receipts:
                execution === null ? [] : receiptsFor(node.id, attempts, execution, receipts),
            }),
          );
        }
      } else if (node.kind === 'wait' && showConfigurableStep) {
        stage.steps.push(
          OperatorWorkflowStepSchema.parse({
            kind: 'wait',
            id: node.id,
            label: titleCaseIdentifier(node.id),
            status,
            reference: node.for,
          }),
        );
      }
    }
    for (const child of childrenFor(node)) visit(child);
  };
  visit(graph.root);

  const currentNode =
    execution?.currentNodeId === null || execution?.currentNodeId === undefined
      ? null
      : findNode(graph.root, execution.currentNodeId);
  const currentStageId =
    currentNode === null ? null : (firstDescendantStage(currentNode, snapshot)?.id ?? null);

  return [...stages.values()].map((stage, index) => {
    const status =
      stage.id === currentStageId && execution !== null
        ? execution.status === 'waiting'
          ? 'waiting'
          : 'running'
        : aggregateStatus(stage.statuses);
    return OperatorWorkflowStageSchema.parse({
      key: `execution:${stage.id}:${String(index + 1)}`,
      id: stage.id,
      label: stage.id === 'preparation' ? 'Start work' : stage.label,
      status,
      steps: stage.steps,
    });
  });
};

const findNode = (node: CompiledWorkflowNode, nodeId: string): CompiledWorkflowNode | null => {
  if (node.id === nodeId) return node;
  for (const child of childrenFor(node)) {
    const found = findNode(child, nodeId);
    if (found !== null) return found;
  }
  return null;
};

export const createOperatorWorkflowProjection = (
  taskReference: string,
  lifecycle: TaskRunLifecycle | null,
  receipts: BlockReceiptReader,
  readSnapshot: ExecutionSnapshotReader = () => null,
): OperatorWorkflowProjection => {
  if (lifecycle === null) {
    return OperatorWorkflowProjectionSchema.parse({
      schemaVersion: 3,
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
  const snapshot = graph === null ? null : readSnapshot(lifecycle);
  return OperatorWorkflowProjectionSchema.parse({
    schemaVersion: 3,
    taskReference,
    status: active.status,
    activeRuntime: execution === null ? 'bootstrap' : 'execution',
    graphHash: lifecycle.bootstrap.workflowHash,
    stages: [
      ...createBootstrapStages(lifecycle),
      ...(graph === null ? [] : createExecutionStages(graph, execution, receipts, snapshot)),
    ],
  });
};
