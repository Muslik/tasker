import { createWorkflowAnalyzerContext } from '../planning/index.js';
import type { PlanningSnapshotSource } from '../planning/run-planning-snapshot.js';
import type { WorkspaceLocator } from '../workspaces/contracts.js';
import { CompiledWorkflowSchema, type CompiledWorkflow } from '../workflow/index.js';
import { err, ok, type Outcome } from '../shared/outcome.js';
import type { EvidenceBundleReference } from '../planning/evidence-bundle.js';
import type { M1ServiceError, M1WorkflowService } from './m1-service.js';
import type { EvidenceBundleStore, EvidenceBundleStoreError } from './evidence-bundle.js';
import type {
  WorkflowAnalyzer,
  WorkflowContextDiscovery,
  WorkflowGenerationSubjectSource,
} from './workflow-generator.js';
import type { PlanningSnapshotReference } from '../planning/run-planning-snapshot.js';

export interface TaskWorkflowDraft {
  readonly workflowHash: string;
  readonly graph: CompiledWorkflow;
  readonly planningSnapshot: PlanningSnapshotReference;
  readonly evidenceBundle: EvidenceBundleReference;
}

export type WorkflowDraftAssemblyError =
  | { readonly kind: 'subject_unavailable'; readonly error: M1ServiceError }
  | { readonly kind: 'workspace_mismatch'; readonly expected: string; readonly actual: string }
  | { readonly kind: 'context_discovery_failed'; readonly error: EvidenceBundleStoreError }
  | { readonly kind: 'analyzer_failed'; readonly message: string }
  | { readonly kind: 'workflow_failed'; readonly error: M1ServiceError }
  | { readonly kind: 'workflow_rejected'; readonly issues: readonly string[] }
  | { readonly kind: 'evidence_unavailable'; readonly error: EvidenceBundleStoreError }
  | { readonly kind: 'snapshot_failed'; readonly reason: string };

const draftFrom = (
  response: NonNullable<
    ReturnType<M1WorkflowService['read']> extends Outcome<infer V, unknown> ? V : never
  >,
  planningSnapshot: PlanningSnapshotReference,
  evidenceBundle: EvidenceBundleReference,
): Outcome<TaskWorkflowDraft, WorkflowDraftAssemblyError> => {
  if (response.status !== 'ready') {
    return err({
      kind: 'workflow_rejected',
      issues: response.view.workflow.validatorReport.issues.map((issue) => issue.message),
    });
  }
  const workflowHash = response.view.workflow.graphHash;
  const graph = CompiledWorkflowSchema.safeParse(response.view.workflow.graph);
  if (workflowHash === null || !graph.success) {
    return err({ kind: 'workflow_rejected', issues: ['Compiled workflow projection is corrupt'] });
  }
  return ok({ workflowHash, graph: graph.data, planningSnapshot, evidenceBundle });
};

export class WorkflowDraftAssembler {
  public constructor(
    private readonly workflows: M1WorkflowService,
    private readonly subjects: WorkflowGenerationSubjectSource,
    private readonly analyzer: WorkflowAnalyzer | undefined,
    private readonly contextDiscovery: WorkflowContextDiscovery,
    private readonly evidenceBundles: EvidenceBundleStore,
    private readonly snapshots: PlanningSnapshotSource,
  ) {}

  public async assemble(input: {
    readonly taskReference: string;
    readonly operationId: string;
    readonly workspace: WorkspaceLocator;
  }): Promise<Outcome<TaskWorkflowDraft, WorkflowDraftAssemblyError>> {
    const subject = this.subjects.resolve(input.taskReference);
    if (!subject.ok) return err({ kind: 'subject_unavailable', error: subject.error });
    if (subject.value.task.repository !== input.workspace.repository.reference) {
      return err({
        kind: 'workspace_mismatch',
        expected: subject.value.task.repository,
        actual: input.workspace.repository.reference,
      });
    }

    const completed = this.workflows.readPlanningOperation(input.taskReference, input.operationId);
    if (!completed.ok) return err({ kind: 'workflow_failed', error: completed.error });

    let workflow = completed.value;
    if (workflow === null) {
      const analyzerContext = createWorkflowAnalyzerContext(
        subject.value.task,
        subject.value.taskSnapshot,
      );
      const evidence = await this.contextDiscovery.discover({
        taskReference: input.taskReference,
        operationId: input.operationId,
        taskSnapshot: subject.value.taskSnapshot,
        plannerContext: analyzerContext.plannerContext,
        repositoryReference: subject.value.task.repository,
        repositoryPath: input.workspace.path,
      });
      if (!evidence.ok) return err({ kind: 'context_discovery_failed', error: evidence.error });

      if (this.analyzer === undefined) {
        const assembled = this.workflows.assembleTaskAtOperation(
          subject.value.task,
          input.operationId,
        );
        if (!assembled.ok) return err({ kind: 'workflow_failed', error: assembled.error });
        workflow = assembled.value;
      } else {
        const analyzed = await this.analyzer.analyze({
          ...analyzerContext,
          repositoryPath: input.workspace.path,
          repositoryReference: subject.value.task.repository,
          evidenceBundle: evidence.value.bundle,
        });
        if (!analyzed.ok) {
          return err({ kind: 'analyzer_failed', message: analyzed.error.kind });
        }
        const assembled = this.workflows.assembleFromAnalyzerOutputAtOperation(
          subject.value.task,
          analyzed.value.output,
          analyzed.value.receipt,
          input.operationId,
        );
        if (!assembled.ok) return err({ kind: 'workflow_failed', error: assembled.error });
        workflow = assembled.value;
      }
    }

    if (workflow.status !== 'ready' || workflow.view.workflow.graphHash === null) {
      return err({
        kind: 'workflow_rejected',
        issues: workflow.view.workflow.validatorReport.issues.map((issue) => issue.message),
      });
    }
    const evidence = this.evidenceBundles.readLatest(input.taskReference);
    if (!evidence.ok || evidence.value === null) {
      return err({
        kind: 'evidence_unavailable',
        error: evidence.ok
          ? { kind: 'bundle_not_found', artifactId: input.taskReference }
          : evidence.error,
      });
    }
    const snapshot = this.snapshots.createRunSnapshot(
      input.taskReference,
      workflow.view.workflow.graphHash,
      {
        workspaceId: input.workspace.workspaceId,
        reference: input.workspace.repository.reference,
        path: input.workspace.path,
      },
    );
    if (!snapshot.ok) return err({ kind: 'snapshot_failed', reason: snapshot.error.kind });

    return draftFrom(workflow, snapshot.value, evidence.value.reference);
  }
}
