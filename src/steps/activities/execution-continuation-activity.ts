import { Context } from '@temporalio/activity';

import { z } from 'zod';

import type { ContextDiscoveryService } from '../../server/evidence-bundle.js';
import {
  dependencyDeclarationIdFor,
  type DependencyDeclaration,
  type DependencyDeclarationStore,
} from '../../server/dependency-declaration.js';
import type { ImplementationPlanningStore } from '../../server/implementation-planning.js';
import type { WorkflowAnalyzer } from '../../server/workflow-generator.js';
import type { LedgerRepository } from '../../store/repository.js';
import type { JsonValue } from '../../store/types.js';
import {
  createWorkflowAnalyzerContext,
  createWorkflowProposalFromAnalyzerOutput,
  planWorkflowProposal,
  type PlanningTaskSnapshot,
} from '../../planning/index.js';
import type { Clock } from '../../shared/clock.js';
import { TaskStepOutputArtifactSchema } from '../task-step-output.js';
import {
  JsonValueSchema,
  SemanticWorkflowSourceSchema,
  WorkflowChangeRequestSchema,
  type SemanticNodeSource,
  type SemanticWorkflowSource,
} from '../../graph/index.js';
import {
  ExecutionContinuationCandidateSchema,
  PlanExecutionContinuationInputSchema,
  PlanExecutionContinuationResultSchema,
  type ExecutionWorkflowActivities,
} from '../../kernel/execution-kernel/contracts.js';

const ContinuationRequestArtifactSchema = TaskStepOutputArtifactSchema.extend({
  details: z.object({ request: WorkflowChangeRequestSchema }).loose(),
});

type CrossRepositoryDependencyChange = Extract<
  z.infer<typeof WorkflowChangeRequestSchema>['changes'][number],
  { readonly kind: 'cross_repository_dependency' }
>;

type DependencyDiscoveryResolution =
  | { readonly kind: 'not_applicable' }
  | {
      readonly kind: 'needs_input';
      readonly result: z.infer<typeof PlanExecutionContinuationResultSchema>;
    }
  | {
      readonly kind: 'ready';
      readonly change: CrossRepositoryDependencyChange;
      readonly declaration: DependencyDeclaration;
    };

const asJson = (value: unknown): JsonValue => JsonValueSchema.parse(value);

const namespaceNode = (node: SemanticNodeSource, prefix: string): SemanticNodeSource => {
  switch (node.kind) {
    case 'step':
      return { ...node, id: `${prefix}${node.id}` };
    case 'sequence':
      return {
        ...node,
        id: `${prefix}${node.id}`,
        children: node.children.map((child) => namespaceNode(child, prefix)),
      };
    case 'bounded_loop':
      return {
        ...node,
        id: `${prefix}${node.id}`,
        body: namespaceNode(node.body, prefix) as typeof node.body,
      };
  }
};

const namespaceSource = (
  source: SemanticWorkflowSource,
  continuationId: string,
  attempt: number,
): SemanticWorkflowSource => {
  const prefix = `continuation-${String(attempt)}--`;
  return SemanticWorkflowSourceSchema.parse({
    ...source,
    id: continuationId,
    root: namespaceNode(source.root, prefix),
  });
};

const continuationTask = (
  task: PlanningTaskSnapshot,
  continuationId: string,
  summary: string,
): PlanningTaskSnapshot => ({
  ...task,
  origin: 'workflow_continuation',
  reference: continuationId,
  description: `${task.description}\n\nContinuation evidence: ${summary}`,
});

const unavailable = (waitKind: string, summary: string) =>
  PlanExecutionContinuationResultSchema.parse({ status: 'needs_input', waitKind, summary });

const crossRepositoryDeclarationIdFor = (
  consumerTaskReference: string,
  workflowRunId: string,
  requestArtifactId: string,
): string =>
  dependencyDeclarationIdFor(consumerTaskReference, {
    kind: 'runtime_discovery',
    workflowRunId,
    requestArtifactId,
  });

const packageNameForComponentPath = (componentPath: string): string | null => {
  const segments = componentPath.split('/').filter((segment) => segment.length > 0);
  if (segments[0] !== 'packages') return null;
  const packageRoot = segments[1];
  if (packageRoot === undefined) return null;
  if (packageRoot.startsWith('@')) {
    const packageName = segments[2];
    return packageName === undefined ? null : `${packageRoot}/${packageName}`;
  }
  return packageRoot;
};

const declarationMatchesRequestBoundary = (
  declaration: DependencyDeclaration,
  change: CrossRepositoryDependencyChange,
): { readonly ok: true } | { readonly ok: false; readonly reason: string } => {
  if (declaration.producerRepository !== change.repository) {
    return {
      ok: false,
      reason: `requested repository ${change.repository} but declaration targets ${declaration.producerRepository}`,
    };
  }
  if (change.componentPath === undefined) return { ok: true };

  const expectedPackage = packageNameForComponentPath(change.componentPath);
  if (expectedPackage === null) {
    return {
      ok: false,
      reason: `component path ${change.componentPath} is not a package boundary Tasker can map to an exact dependency package`,
    };
  }
  if (!declaration.packages.includes(expectedPackage)) {
    return {
      ok: false,
      reason: `component path ${change.componentPath} maps to package ${expectedPackage}, but declaration packages are ${declaration.packages.join(', ')}`,
    };
  }
  return { ok: true };
};

const dependencyDiscoverySummary = (input: {
  readonly requestArtifactId: string;
  readonly consumerTaskReference: string;
  readonly requestedRepository: string;
  readonly requestedOutcome: string;
  readonly componentPath?: string;
  readonly declarationId: string;
  readonly declaration: DependencyDeclaration | null;
  readonly mismatchReason?: string;
}): string => {
  const boundary = [
    `request ${input.requestArtifactId}`,
    `consumer ${input.consumerTaskReference}`,
    `repository ${input.requestedRepository}`,
    `outcome ${JSON.stringify(input.requestedOutcome)}`,
    ...(input.componentPath === undefined ? [] : [`component ${input.componentPath}`]),
  ].join('; ');
  if (input.declaration === null) {
    return `Dependency discovery is waiting for a declaration: ${boundary}; declarationId ${input.declarationId}`;
  }
  return [
    `Dependency discovery requires a matching declaration: ${boundary}`,
    `declarationId ${input.declaration.declarationId}`,
    `revision ${String(input.declaration.revision)}`,
    `hash ${input.declaration.hash}`,
    `packages ${input.declaration.packages.join(', ')}`,
    `mode ${input.declaration.mode}`,
    input.mismatchReason === undefined ? null : `mismatch ${input.mismatchReason}`,
  ]
    .filter((part): part is string => part !== null)
    .join('; ');
};

const resolveDependencyDiscovery = (
  changeRequest: z.infer<typeof WorkflowChangeRequestSchema>,
  consumerTaskReference: string,
  workflowRunId: string,
  requestArtifactId: string,
  dependencyDeclarations: Pick<DependencyDeclarationStore, 'readLatest'>,
): DependencyDiscoveryResolution => {
  const crossRepositoryChange = changeRequest.changes.find(
    (change): change is CrossRepositoryDependencyChange =>
      change.kind === 'cross_repository_dependency',
  );
  if (crossRepositoryChange === undefined) {
    return { kind: 'not_applicable' };
  }

  const declarationId = crossRepositoryDeclarationIdFor(
    consumerTaskReference,
    workflowRunId,
    requestArtifactId,
  );
  const declaration = dependencyDeclarations.readLatest(declarationId);
  if (!declaration.ok) {
    return {
      kind: 'needs_input',
      result: unavailable(
        'workflow_change.dependency-declaration-unavailable@1',
        `Dependency declaration ${declarationId} could not be read: ${declaration.error.kind}`,
      ),
    };
  }

  const matches =
    declaration.value === null
      ? null
      : declarationMatchesRequestBoundary(declaration.value, crossRepositoryChange);
  if (declaration.value === null || (matches !== null && !matches.ok)) {
    return {
      kind: 'needs_input',
      result: unavailable(
        'dependency.discovery@1',
        dependencyDiscoverySummary({
          requestArtifactId,
          consumerTaskReference,
          requestedRepository: crossRepositoryChange.repository,
          requestedOutcome: crossRepositoryChange.requestedOutcome,
          ...(crossRepositoryChange.componentPath === undefined
            ? {}
            : { componentPath: crossRepositoryChange.componentPath }),
          declarationId,
          declaration: declaration.value,
          ...(matches?.ok === false ? { mismatchReason: matches.reason } : {}),
        }),
      ),
    };
  }

  return {
    kind: 'ready',
    change: crossRepositoryChange,
    declaration: declaration.value,
  };
};

export const createExecutionContinuationActivity = (
  ledger: LedgerRepository,
  clock: Clock,
  snapshots: Pick<ImplementationPlanningStore, 'readRunSnapshot'>,
  analyzer: WorkflowAnalyzer,
  contextDiscovery: ContextDiscoveryService,
  dependencyDeclarations: Pick<DependencyDeclarationStore, 'readLatest'>,
): Pick<ExecutionWorkflowActivities, 'planExecutionContinuation'> => ({
  planExecutionContinuation: async (inputValue) => {
    const input = PlanExecutionContinuationInputSchema.parse(inputValue);
    const continuationId = `${input.workflowRunId}:continuation-${String(input.attempt)}`;
    const artifactId = `execution-continuation:${continuationId}`;
    const existing = ledger.readArtifact(artifactId);
    if (existing !== null) {
      const restored = ExecutionContinuationCandidateSchema.safeParse(existing.payload);
      return restored.success
        ? PlanExecutionContinuationResultSchema.parse({ status: 'ready', ...restored.data })
        : unavailable(
            'workflow_change.candidate-corrupt@1',
            'The persisted continuation candidate is corrupt',
          );
    }

    const requestArtifact = ledger.readArtifact(input.requestReference);
    const request = ContinuationRequestArtifactSchema.safeParse(requestArtifact?.payload);
    if (!request.success) {
      return unavailable(
        'workflow_change.request-required@1',
        'The continuation request evidence is unavailable or corrupt',
      );
    }

    const snapshot = snapshots.readRunSnapshot(input.planningSnapshot);
    if (!snapshot.ok || snapshot.value.kind !== 'execution') {
      return unavailable(
        'workflow_change.snapshot-required@1',
        'The parent execution snapshot is unavailable',
      );
    }
    const dependencyDiscovery = resolveDependencyDiscovery(
      request.data.details.request,
      snapshot.value.task.reference,
      input.workflowRunId,
      input.requestReference,
      dependencyDeclarations,
    );
    if (dependencyDiscovery.kind === 'needs_input') {
      return dependencyDiscovery.result;
    }
    const task = continuationTask(
      snapshot.value.task,
      continuationId,
      request.data.details.request.summary,
    );
    const taskSnapshot = JsonValueSchema.parse({
      parentTaskSnapshot: snapshot.value.taskSnapshot,
      workflowChange: request.data.details.request,
      operatorGuidance: input.guidance,
      ...(dependencyDiscovery.kind !== 'ready'
        ? {}
        : {
            dependencyDiscovery: {
              requestArtifactId: input.requestReference,
              consumerTaskReference: snapshot.value.task.reference,
              requestedRepository: dependencyDiscovery.change.repository,
              requestedOutcome: dependencyDiscovery.change.requestedOutcome,
              componentPath: dependencyDiscovery.change.componentPath ?? null,
              declarationId: dependencyDiscovery.declaration.declarationId,
              declarationRevision: dependencyDiscovery.declaration.revision,
              declarationHash: dependencyDiscovery.declaration.hash,
              producerTaskReference: dependencyDiscovery.declaration.producerTaskReference,
              producerRepository: dependencyDiscovery.declaration.producerRepository,
              packages: dependencyDiscovery.declaration.packages,
              mode: dependencyDiscovery.declaration.mode,
            },
          }),
    });
    const analyzerContext = createWorkflowAnalyzerContext(task, taskSnapshot);
    const evidence = await contextDiscovery.discover({
      taskReference: continuationId,
      operationId: `${continuationId}:context`,
      taskSnapshot,
      plannerContext: analyzerContext.plannerContext,
      repositoryReference: snapshot.value.repository.reference,
      repositoryPath: snapshot.value.repository.path,
    });
    if (!evidence.ok) {
      return unavailable(
        'workflow_change.context-required@1',
        `Continuation context discovery failed: ${evidence.error.kind}`,
      );
    }

    const context = Context.current();
    context.heartbeat({ phase: 'continuation_planning', continuationId });
    const transcriptOperationId = `${continuationId}:planner`;
    const analyzed = await analyzer.analyze({
      ...analyzerContext,
      operationId: transcriptOperationId,
      repositoryPath: snapshot.value.repository.path,
      repositoryReference: snapshot.value.repository.reference,
      evidenceBundle: evidence.value.bundle,
    });
    if (!analyzed.ok) {
      return unavailable(
        'workflow_change.planning-required@1',
        `Continuation analyzer failed: ${analyzed.error.kind}`,
      );
    }
    const namespacedOutput = {
      ...analyzed.value.output,
      source: namespaceSource(analyzed.value.output.source, continuationId, input.attempt),
    };
    const proposal = createWorkflowProposalFromAnalyzerOutput(
      task,
      analyzed.value.receipt.analyzerVersion,
      namespacedOutput,
    );
    if (!proposal.ok) {
      return unavailable(
        'workflow_change.candidate-invalid@1',
        'Continuation analyzer returned an invalid semantic proposal',
      );
    }
    const planned = planWorkflowProposal(proposal.value);
    if (!planned.ok) {
      return unavailable(
        'workflow_change.candidate-invalid@1',
        `Continuation candidate was rejected at ${planned.error.stage}`,
      );
    }
    const availableSteps = new Set(snapshot.value.harness.steps.map(({ reference }) => reference));
    const unavailableStep = planned.value.compiled.graph.metadata.references.stepTypes.find(
      (reference) => !availableSteps.has(reference),
    );
    if (unavailableStep !== undefined) {
      return unavailable(
        'workflow_change.snapshot-expansion-required@1',
        `Continuation requires ${unavailableStep}, which is absent from the frozen parent snapshot`,
      );
    }

    const candidate = ExecutionContinuationCandidateSchema.parse({
      continuationId,
      attempt: input.attempt,
      parentNodeId: input.parentNodeId,
      requestReference: input.requestReference,
      reason: request.data.details.request.summary,
      evidenceBundle: evidence.value.reference,
      transcriptOperationId,
      analyzerReceiptReference: `workflow-analyzer-receipt:${continuationId}`,
      usage: {
        provider: analyzed.value.receipt.provider === 'codex_cli' ? 'codex' : 'claude',
        profile: analyzed.value.receipt.profile,
        profileSha256: analyzed.value.receipt.profileSha256,
        model: analyzed.value.receipt.model,
        effort: analyzed.value.receipt.effort,
        serviceTier: analyzed.value.receipt.serviceTier,
        sessionId: analyzed.value.receipt.sessionId,
        durationMs: analyzed.value.receipt.durationMs,
        inputTokens: analyzed.value.receipt.usage.inputTokens,
        cachedInputTokens: analyzed.value.receipt.usage.cachedInputTokens,
        outputTokens: analyzed.value.receipt.usage.outputTokens,
        reasoningOutputTokens: analyzed.value.receipt.usage.reasoningOutputTokens,
        apiCost: analyzed.value.receipt.apiCost,
      },
      semanticHash: planned.value.semantic.semanticHash,
      workflowHash: planned.value.compiled.hash,
      graph: planned.value.compiled.graph,
    });
    const committed = ledger.transact({
      aggregate: {
        aggregateId: artifactId,
        expectedVersion: 0,
        events: [
          {
            eventId: `event:${artifactId}:1`,
            eventType: 'ExecutionContinuationPlanned',
            eventSchemaVersion: 1,
            payload: asJson({
              taskReference: input.taskReference,
              continuationId,
              semanticHash: candidate.semanticHash,
              workflowHash: candidate.workflowHash,
            }),
            actor: 'continuation_planner',
          },
        ],
      },
      artifacts: [
        {
          artifactId: candidate.analyzerReceiptReference,
          artifactKind: 'workflow_analyzer_receipt',
          storageUri: `ledger://artifacts/${candidate.analyzerReceiptReference}`,
          payload: asJson(analyzed.value.receipt),
          metadata: asJson({
            taskReference: input.taskReference,
            workflowId: input.workflowId,
            workflowRunId: input.workflowRunId,
            continuationId,
            transcriptOperationId,
          }),
          createdAt: clock.now(),
        },
        {
          artifactId,
          artifactKind: 'execution_continuation_candidate',
          storageUri: `ledger://artifacts/${artifactId}`,
          payload: asJson(candidate),
          metadata: asJson({
            taskReference: input.taskReference,
            workflowId: input.workflowId,
            workflowRunId: input.workflowRunId,
            parentNodeId: input.parentNodeId,
            requestReference: input.requestReference,
          }),
          createdAt: clock.now(),
        },
      ],
      timestamp: clock.now(),
    });
    if (!committed.ok) {
      return unavailable(
        'workflow_change.persistence-required@1',
        `Continuation candidate could not be persisted: ${committed.error.kind}`,
      );
    }
    return PlanExecutionContinuationResultSchema.parse({ status: 'ready', ...candidate });
  },
});
