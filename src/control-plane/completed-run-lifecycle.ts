import { z } from 'zod';

import type { ImplementationPlanningCoordinator } from './implementation-planning.js';
import type { WorkflowFreezeStore } from './workflow-freeze.js';
import type { RetrospectiveRunIndex, RetrospectiveStore } from '../retrospective/index.js';
import { err, ok, type Outcome } from '../shared/outcome.js';
import {
  BootstrapWorkflowPublicStateSchema,
  ExecutionWorkflowPublicStateSchema,
  TaskRunLifecycleSchema,
  type TaskRunLifecycle,
} from '../temporal/index.js';
import { CompiledWorkflowSchema, type CompiledWorkflowNode } from '../workflow/index.js';

const ArchivedWorkflowSnapshotSchema = z.object({ graph: CompiledWorkflowSchema }).loose();

export type CompletedRunLifecycleError =
  | { readonly kind: 'retrospective_corrupt' }
  | { readonly kind: 'freeze_receipt_corrupt' }
  | { readonly kind: 'planning_snapshot_unavailable' };

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

const completedNodeStates = (
  root: CompiledWorkflowNode,
  blockRuns: RetrospectiveRunIndex['blockRuns'],
): Readonly<Record<string, 'succeeded' | 'skipped'>> => {
  const states: Record<string, 'succeeded' | 'skipped'> = {};
  const visit = (node: CompiledWorkflowNode): boolean => {
    const childRan = childrenFor(node).map(visit).some(Boolean);
    const ran = node.kind === 'step' ? (blockRuns[node.id] ?? 0) > 0 : childRan;
    states[node.id] =
      node.kind === 'step'
        ? ran
          ? 'succeeded'
          : 'skipped'
        : node.kind === 'branch'
          ? ran
            ? 'succeeded'
            : 'skipped'
          : 'succeeded';
    return ran || node.kind === 'wait' || node.kind === 'gate' || node.kind === 'finalize';
  };
  visit(root);
  return states;
};

export class CompletedRunLifecycleReader {
  public constructor(
    private readonly retrospectives: Pick<RetrospectiveStore, 'readLatestRun'>,
    private readonly freezes: Pick<WorkflowFreezeStore, 'readLatest'>,
    private readonly planning: Pick<ImplementationPlanningCoordinator, 'readRunSnapshot'>,
  ) {}

  public read(taskReference: string): Outcome<TaskRunLifecycle | null, CompletedRunLifecycleError> {
    const indexed = this.retrospectives.readLatestRun(taskReference);
    if (!indexed.ok) return err({ kind: 'retrospective_corrupt' });
    if (indexed.value === null) return ok(null);
    const frozen = this.freezes.readLatest(taskReference);
    if (!frozen.ok) return err({ kind: 'freeze_receipt_corrupt' });
    if (frozen.value === null) return err({ kind: 'freeze_receipt_corrupt' });
    const snapshot = this.planning.readRunSnapshot(frozen.value.planningSnapshot);
    if (!snapshot.ok || snapshot.value.kind !== 'execution') {
      return err({ kind: 'planning_snapshot_unavailable' });
    }
    const graph = ArchivedWorkflowSnapshotSchema.parse(snapshot.value.workflow).graph;
    const execution = ExecutionWorkflowPublicStateSchema.parse({
      runtime: 'execution',
      schemaVersion: 2,
      taskReference,
      workflowId: indexed.value.report.workflowId,
      runId: indexed.value.report.workflowRunId,
      workflowHash: frozen.value.workflowHash,
      nodeStates: completedNodeStates(graph.root, indexed.value.blockRuns),
      blockRuns: indexed.value.blockRuns,
      loopIterations: {},
      continuations: [],
      retrospective: 'succeeded',
      status: 'completed',
      currentNodeId: null,
      wait: null,
      outcome: indexed.value.report.outcome,
    });
    const bootstrap = BootstrapWorkflowPublicStateSchema.parse({
      runtime: 'bootstrap',
      schemaVersion: 3,
      taskReference,
      workflowId: frozen.value.workflowId,
      runId: frozen.value.workflowRunId,
      workflowHash: frozen.value.workflowHash,
      settings: {
        planReview: frozen.value.approval.kind === 'operator_approved' ? 'required' : 'automatic',
        planningStrategy: 'auto',
      },
      phase: 'execution',
      workspaceContext: null,
      context: null,
      draft: {
        workflowHash: frozen.value.workflowHash,
        semanticHash: frozen.value.semanticHash,
        compilerVersion: frozen.value.compilerVersion,
        harnessSnapshotHash: frozen.value.harnessSnapshotHash,
        retrospectiveEnabled: snapshot.value.harness.company.retrospective.enabled,
        graph,
        planningSnapshot: frozen.value.planningSnapshot,
        evidenceBundle: frozen.value.evidenceBundle,
      },
      planning: null,
      activeTranscriptOperationId: null,
      freezeReceipt: frozen.value,
      executionWorkflowId: execution.workflowId,
      nodeStates: {
        workspace: 'succeeded',
        context: 'succeeded',
        investigation: 'skipped',
        planning: 'succeeded',
        plan_review: frozen.value.approval.kind === 'operator_approved' ? 'succeeded' : 'skipped',
        admission: 'succeeded',
        freeze: 'succeeded',
      },
      attempts: { planning: frozen.value.planningAttempt },
      status: 'completed',
      currentNodeId: null,
      wait: null,
      outcome: indexed.value.report.outcome,
    });
    return ok(TaskRunLifecycleSchema.parse({ bootstrap, execution }));
  }
}
