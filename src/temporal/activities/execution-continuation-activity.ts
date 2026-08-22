import { Context } from '@temporalio/activity';

import { z } from 'zod';

import type { ContextDiscoveryService } from '../../control-plane/evidence-bundle.js';
import type { ImplementationPlanningStore } from '../../control-plane/implementation-planning.js';
import type { WorkflowAnalyzer } from '../../control-plane/workflow-generator.js';
import type { LedgerRepository } from '../../ledger/repository.js';
import type { JsonValue } from '../../ledger/types.js';
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
} from '../../workflow/index.js';
import {
  ExecutionContinuationCandidateSchema,
  PlanExecutionContinuationInputSchema,
  PlanExecutionContinuationResultSchema,
  type ExecutionWorkflowActivities,
} from '../execution-kernel/contracts.js';

const ContinuationRequestArtifactSchema = TaskStepOutputArtifactSchema.extend({
  details: z.object({ request: WorkflowChangeRequestSchema }).loose(),
});

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

export const createExecutionContinuationActivity = (
  ledger: LedgerRepository,
  clock: Clock,
  snapshots: Pick<ImplementationPlanningStore, 'readRunSnapshot'>,
  analyzer: WorkflowAnalyzer,
  contextDiscovery: ContextDiscoveryService,
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
    if (
      request.data.details.request.changes.some(
        (change) => change.kind === 'cross_repository_dependency',
      )
    ) {
      return unavailable(
        'workflow_change.cross-repository@1',
        'Cross-repository continuation requires a separately prepared child workspace',
      );
    }

    const snapshot = snapshots.readRunSnapshot(input.planningSnapshot);
    if (!snapshot.ok || snapshot.value.kind !== 'execution') {
      return unavailable(
        'workflow_change.snapshot-required@1',
        'The parent execution snapshot is unavailable',
      );
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
