import { blockReceiptId, type BlockReceipt, type BlockReceiptStore } from '../steps/index.js';
import { processExecutionPlanFor } from '../harness/index.js';
import type { DependencyDeclaration } from './dependency-declaration.js';
import { getHarnessStepDefinition } from '../planning/index.js';
import type { RunPlanningSnapshot } from '../planning/run-planning-snapshot.js';
import type { ExecutionWorkflowPublicState, TaskRunLifecycle } from '../kernel/index.js';
import type { PlanningTranscriptView } from './planning-transcript.js';
import type {
  CompiledWorkflow,
  CompiledWorkflowNode,
  WorkflowStageDescriptor,
} from '../graph/index.js';
import {
  BlockReceiptSummarySchema,
  OperatorWorkflowProjectionSchema,
  OperatorWorkflowStageSchema,
  OperatorWorkflowStepSchema,
  type BlockReceiptSummary,
  type OperatorInterventionAction,
  type OperatorWorkflowProjection,
  type OperatorWorkflowStage,
  type OperatorWorkflowStep,
  type WorkflowNodeStatus,
} from './operator-contracts.js';
import type { CurrentAgentInvocationSummary } from './agent-invocation-reader.js';
import {
  describeDependencyAvailableWait,
  describeDependencyDiscoveryWait,
} from './dependency-operator-service.js';
import type { VerifiedPackagePublication } from './verified-package-publication.js';

type BlockReceiptReader = Pick<BlockReceiptStore, 'read'>;
type ExecutionSnapshotReader = (lifecycle: TaskRunLifecycle) => RunPlanningSnapshot | null;
type ExecutionTranscriptReader = (
  execution: ExecutionWorkflowPublicState,
) => PlanningTranscriptView | null;
type ContinuationTranscriptReader = (operationId: string) => PlanningTranscriptView | null;
type ProjectionArtifactRecord = { readonly payload: unknown };
type ProjectionDependencySummary = {
  readonly declarationId: string;
  readonly revision: number;
  readonly producerTaskReference: string;
  readonly producerRepository: string;
  readonly packages: readonly string[];
  readonly mode: 'final_only' | 'validate_dev_then_final';
  readonly source: DependencyDeclaration['source'];
  readonly createdAt: string;
};
interface DependencyProjectionReaders {
  readonly listDeclarations: (taskReference: string) => readonly ProjectionDependencySummary[];
  readonly readDeclaration: (declarationId: string) => DependencyDeclaration | null;
  readonly readPublication: (observationId: string) => VerifiedPackagePublication | null;
  readonly readArtifact: (artifactId: string) => ProjectionArtifactRecord | null;
}

interface ProjectionInvocationReaders {
  readonly readLatestExecutionInvocation: (input: {
    readonly taskReference: string;
    readonly workflowId: string;
    readonly runId: string;
    readonly nodeId: string;
    readonly blockRun: number;
  }) => CurrentAgentInvocationSummary | null;
  readonly readLatestPlanningInvocation: (input: {
    readonly taskReference: string;
    readonly planningEpisodeId: string;
    readonly planningAttempt: number;
  }) => CurrentAgentInvocationSummary | null;
}

const TYPED_RESOLUTION_WAITS = new Set([
  'code_review@1',
  'dependency.available@1',
  'dependency.discovery@1',
  'human_clarification',
  'plan.approved@1',
  'workflow_change.review@1',
]);

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
    case 'bounded_loop':
      return [node.body];
    case 'finalize':
    case 'step':
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
    ...('category' in receipt.claim ? { category: receipt.claim.category } : {}),
    ...('retryable' in receipt.claim ? { retryable: receipt.claim.retryable } : {}),
    evidence: receipt.evidence,
    transcriptReference: receipt.transcriptReference,
    usageReference: receipt.usageReference,
    usage: receipt.usage,
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
      status: bootstrapStatus(lifecycle, ['planning', 'plan_review', 'admission', 'freeze']),
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
          const resolvedProcess =
            snapshotted?.resolvedProcess === null || snapshotted?.resolvedProcess === undefined
              ? null
              : processExecutionPlanFor(snapshotted.resolvedProcess, node.with);
          stage.steps.push(
            OperatorWorkflowStepSchema.parse({
              kind: 'process',
              id: node.id,
              label: titleCaseIdentifier(node.id),
              status,
              reference: node.uses,
              executor:
                resolvedProcess?.commands
                  .map(({ command, args }) => [command, ...args].join(' '))
                  .join(' → ') ?? block.executor.executor,
              attempts,
              receipts:
                execution === null ? [] : receiptsFor(node.id, attempts, execution, receipts),
            }),
          );
        }
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
      label: stage.label,
      status,
      steps: stage.steps,
    });
  });
};

const createRetrospectiveStage = (
  execution: ExecutionWorkflowPublicState | null,
): readonly OperatorWorkflowStage[] => {
  if (execution === null || execution.retrospective === 'disabled') return [];
  const status: WorkflowNodeStatus =
    execution.retrospective === 'pending'
      ? 'planned'
      : execution.retrospective === 'running'
        ? 'running'
        : execution.retrospective === 'succeeded'
          ? 'succeeded'
          : 'failed';
  return [
    OperatorWorkflowStageSchema.parse({
      key: 'system:retrospective',
      id: 'retrospective',
      label: 'Retrospective',
      status,
      steps: [],
    }),
  ];
};

const findNode = (node: CompiledWorkflowNode, nodeId: string): CompiledWorkflowNode | null => {
  if (node.id === nodeId) return node;
  for (const child of childrenFor(node)) {
    const found = findNode(child, nodeId);
    if (found !== null) return found;
  }
  return null;
};

const interventionFor = (
  taskReference: string,
  lifecycle: TaskRunLifecycle,
  runtime: 'bootstrap' | 'execution',
  nodeId: string,
  waitKind: string,
  executionNode: CompiledWorkflowNode | null,
  snapshot: RunPlanningSnapshot | null,
  dependencyReaders: DependencyProjectionReaders,
): OperatorInterventionAction => {
  if (waitKind === 'dependency.available@1') {
    return {
      kind: 'typed_resolution',
      waitKind,
      details:
        runtime !== 'execution'
          ? null
          : describeDependencyAvailableWait(lifecycle, nodeId, dependencyReaders.readPublication),
    };
  }
  if (waitKind === 'dependency.discovery@1') {
    const executionRun =
      runtime === 'execution' && lifecycle.execution?.status === 'waiting'
        ? lifecycle.execution
        : null;
    return {
      kind: 'typed_resolution',
      waitKind,
      details:
        executionRun === null
          ? null
          : describeDependencyDiscoveryWait(
              taskReference,
              executionRun,
              dependencyReaders.readDeclaration,
              (artifactId) => dependencyReaders.readArtifact(artifactId),
            ),
    };
  }
  if (TYPED_RESOLUTION_WAITS.has(waitKind)) {
    return { kind: 'typed_resolution', waitKind, details: null };
  }
  if (waitKind === 'operator_guidance@1') return { kind: 'operator_guidance' };
  if (waitKind.endsWith('.activity-failed@1')) return { kind: 'retry_step' };
  if (runtime === 'bootstrap') {
    return nodeId === 'investigation' || nodeId === 'planning'
      ? { kind: 'operator_guidance' }
      : { kind: 'external_prerequisite' };
  }
  if (executionNode?.kind !== 'step') return { kind: 'external_prerequisite' };
  const snapshotted = snapshot?.harness.steps.find(
    ({ reference }) => reference === executionNode.uses,
  );
  const block = snapshotted?.block ?? getHarnessStepDefinition(executionNode.uses)?.block;
  return block?.executor.kind === 'agent'
    ? { kind: 'operator_guidance' }
    : { kind: 'external_prerequisite' };
};

export const createOperatorWorkflowProjection = (
  taskReference: string,
  lifecycle: TaskRunLifecycle | null,
  receipts: BlockReceiptReader,
  readSnapshot: ExecutionSnapshotReader = () => null,
  readExecutionTranscript: ExecutionTranscriptReader = () => null,
  readContinuationTranscript: ContinuationTranscriptReader = () => null,
  dependencyReaders: DependencyProjectionReaders = {
    listDeclarations: () => [],
    readDeclaration: () => null,
    readPublication: () => null,
    readArtifact: () => null,
  },
  invocationReaders: ProjectionInvocationReaders = {
    readLatestExecutionInvocation: () => null,
    readLatestPlanningInvocation: () => null,
  },
): OperatorWorkflowProjection => {
  if (lifecycle === null) {
    return OperatorWorkflowProjectionSchema.parse({
      schemaVersion: 9,
      taskReference,
      status: 'not_started',
      activeRuntime: null,
      activeRunId: null,
      graphHash: null,
      current: null,
      currentAttempt: null,
      dependencies: dependencyReaders.listDeclarations(taskReference),
      stages: [],
      continuations: [],
    });
  }

  const execution = lifecycle.execution;
  const active = execution ?? lifecycle.bootstrap;
  const graph = lifecycle.bootstrap.draft?.graph ?? null;
  const visibleContinuations =
    execution?.continuations.flatMap((continuation) =>
      'graph' in continuation && continuation.status !== 'rejected' ? [continuation] : [],
    ) ?? [];
  const executionGraphs = [
    ...(graph === null ? [] : [graph]),
    ...visibleContinuations.map(({ graph: continuationGraph }) => continuationGraph),
  ];
  const snapshot = graph === null ? null : readSnapshot(lifecycle);
  const executionNodeId =
    execution === null || execution.status === 'completed'
      ? null
      : (execution.currentNodeId ?? graph?.root.id ?? null);
  const executionNode =
    executionNodeId === null
      ? null
      : (executionGraphs
          .map((candidate) => findNode(candidate.root, executionNodeId))
          .find((candidate) => candidate !== null) ?? null);
  const activeNodeId =
    execution === null
      ? lifecycle.bootstrap.status === 'completed'
        ? null
        : lifecycle.bootstrap.currentNodeId
      : executionNodeId;
  const currentRuntime = execution === null ? ('bootstrap' as const) : ('execution' as const);
  const activeContinuation = execution?.continuations.findLast(
    ({ status }) =>
      status === 'planning' || status === 'needs_input' || status === 'awaiting_review',
  );
  const currentInvocation =
    execution !== null && executionNodeId !== null
      ? invocationReaders.readLatestExecutionInvocation({
          taskReference,
          workflowId: execution.workflowId,
          runId: execution.runId,
          nodeId: executionNodeId,
          blockRun: execution.blockRuns[executionNodeId] ?? 0,
        })
      : lifecycle.bootstrap.status !== 'completed' &&
          lifecycle.bootstrap.currentNodeId === 'planning' &&
          lifecycle.bootstrap.planning !== null
        ? invocationReaders.readLatestPlanningInvocation({
            taskReference,
            planningEpisodeId: lifecycle.bootstrap.planning.planningEpisodeId,
            planningAttempt: lifecycle.bootstrap.planning.attempt,
          })
        : null;
  const currentAttempt =
    currentInvocation === null
      ? null
      : {
          latestInvocationId: currentInvocation.invocationId,
          nodeId: activeNodeId ?? 'planning',
          blockRun: currentInvocation.blockRun,
          startedAt: currentInvocation.startedAt,
          waitingSince:
            active.status === 'waiting'
              ? (currentInvocation.finishedAt ?? currentInvocation.startedAt)
              : null,
        };
  const current =
    activeNodeId === null || active.status === 'completed'
      ? null
      : {
          runtime: currentRuntime,
          nodeId: activeNodeId,
          reference: executionNode?.kind === 'step' ? executionNode.uses : null,
          status: active.status,
          blockRun:
            execution === null || executionNodeId === null
              ? null
              : (execution.blockRuns[executionNodeId] ?? null),
          waitKind: active.status === 'waiting' ? active.wait.waitKind : null,
          reason: active.status === 'waiting' ? (active.wait.reason ?? null) : null,
          intervention:
            active.status === 'waiting'
              ? interventionFor(
                  taskReference,
                  lifecycle,
                  currentRuntime,
                  activeNodeId,
                  active.wait.waitKind,
                  executionNode,
                  snapshot,
                  dependencyReaders,
                )
              : null,
          transcript:
            activeContinuation === undefined
              ? execution === null
                ? lifecycle.bootstrap.activeTranscriptOperationId === null
                  ? null
                  : readContinuationTranscript(lifecycle.bootstrap.activeTranscriptOperationId)
                : readExecutionTranscript(execution)
              : readContinuationTranscript(activeContinuation.transcriptOperationId),
        };
  return OperatorWorkflowProjectionSchema.parse({
    schemaVersion: 9,
    taskReference,
    status: active.status,
    activeRuntime: execution === null ? 'bootstrap' : 'execution',
    activeRunId: active.runId,
    graphHash: lifecycle.bootstrap.workflowHash,
    current,
    currentAttempt,
    dependencies: dependencyReaders.listDeclarations(taskReference),
    stages: [
      ...createBootstrapStages(lifecycle),
      ...(graph === null ? [] : createExecutionStages(graph, execution, receipts, snapshot)),
      ...visibleContinuations.flatMap((continuation) =>
        createExecutionStages(continuation.graph, execution, receipts, snapshot).map((stage) => ({
          ...stage,
          key: `continuation:${continuation.continuationId}:${stage.key}`,
        })),
      ),
      ...createRetrospectiveStage(execution),
    ],
    continuations:
      execution?.continuations.map((continuation) =>
        'graph' in continuation
          ? {
              continuationId: continuation.continuationId,
              attempt: continuation.attempt,
              parentNodeId: continuation.parentNodeId,
              reason: continuation.reason,
              transcriptOperationId: continuation.transcriptOperationId,
              usage: continuation.usage,
              semanticHash: continuation.semanticHash,
              workflowHash: continuation.workflowHash,
              status: continuation.status,
            }
          : {
              continuationId: continuation.continuationId,
              attempt: continuation.attempt,
              parentNodeId: continuation.parentNodeId,
              reason: continuation.reason,
              transcriptOperationId: continuation.transcriptOperationId,
              status: continuation.status,
            },
      ) ?? [],
  });
};
