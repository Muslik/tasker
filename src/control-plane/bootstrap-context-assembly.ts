import { createWorkflowAnalyzerContext } from '../planning/index.js';
import type { EvidenceBundleReference } from '../planning/evidence-bundle.js';
import type {
  PlanningSnapshotReference,
  PlanningSnapshotSource,
} from '../planning/run-planning-snapshot.js';
import { err, ok, type Outcome } from '../shared/outcome.js';
import type { WorkspaceLocator } from '../workspaces/contracts.js';
import type { EvidenceBundleStoreError } from './evidence-bundle.js';
import type { M1ServiceError } from './m1-service.js';
import type {
  WorkflowContextDiscovery,
  WorkflowGenerationSubjectSource,
} from './workflow-generator.js';

export interface TaskPlanningContext {
  readonly contextHash: string;
  readonly planningSnapshot: PlanningSnapshotReference;
  readonly evidenceBundle: EvidenceBundleReference;
}

export type BootstrapContextAssemblyError =
  | { readonly kind: 'subject_unavailable'; readonly error: M1ServiceError }
  | { readonly kind: 'workspace_mismatch'; readonly expected: string; readonly actual: string }
  | { readonly kind: 'context_discovery_failed'; readonly error: EvidenceBundleStoreError }
  | { readonly kind: 'snapshot_failed'; readonly reason: string };

export class BootstrapContextAssembler {
  public constructor(
    private readonly subjects: WorkflowGenerationSubjectSource,
    private readonly contextDiscovery: WorkflowContextDiscovery,
    private readonly snapshots: PlanningSnapshotSource,
  ) {}

  public async assemble(input: {
    readonly taskReference: string;
    readonly operationId: string;
    readonly workspace: WorkspaceLocator;
  }): Promise<Outcome<TaskPlanningContext, BootstrapContextAssemblyError>> {
    const subject = this.subjects.resolve(input.taskReference);
    if (!subject.ok) return err({ kind: 'subject_unavailable', error: subject.error });
    if (subject.value.task.repository !== input.workspace.repository.reference) {
      return err({
        kind: 'workspace_mismatch',
        expected: subject.value.task.repository,
        actual: input.workspace.repository.reference,
      });
    }

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

    const snapshot = this.snapshots.createPlanningContextSnapshot(input.taskReference, {
      workspaceId: input.workspace.workspaceId,
      reference: input.workspace.repository.reference,
      path: input.workspace.path,
    });
    if (!snapshot.ok) return err({ kind: 'snapshot_failed', reason: snapshot.error.kind });

    return ok({
      contextHash: snapshot.value.contextHash,
      planningSnapshot: snapshot.value.reference,
      evidenceBundle: evidence.value.reference,
    });
  }
}
