import { Context } from '@temporalio/activity';

import type { PlanningSnapshotSource } from '../../planning/run-planning-snapshot.js';
import type { Outcome } from '../../shared/outcome.js';
import type {
  PrepareWorkspaceRequest,
  WorkspaceLocator,
  WorkspacePreparationError,
  WorkspaceBootstrapper,
} from '../../workspaces/index.js';
import {
  PrepareTaskWorkspaceInputSchema,
  PrepareTaskWorkspaceResultSchema,
  type PrepareTaskWorkspaceInput,
  type TaskWorkflowActivities,
} from '../contracts.js';

interface WorkspaceSubject {
  readonly repositoryPath: string;
  readonly task: { readonly repository: string };
}

export interface TemporalWorkspaceSubjectSource {
  resolve(taskReference: string): Outcome<WorkspaceSubject, { readonly kind: string }>;
}

export interface TemporalManagedWorkspacePreparer {
  prepare(
    request: PrepareWorkspaceRequest,
  ): Promise<Outcome<WorkspaceLocator, WorkspacePreparationError>>;
}

const failure = (phase: string, kind: string): Error =>
  new Error(`Task workspace ${phase} failed: ${kind}`);

export const createWorkspaceActivity = (
  subjects: TemporalWorkspaceSubjectSource,
  workspaces: TemporalManagedWorkspacePreparer,
  bootstrap: WorkspaceBootstrapper,
  snapshots: PlanningSnapshotSource,
): Pick<TaskWorkflowActivities, 'prepareTaskWorkspace'> => ({
  prepareTaskWorkspace: async (inputValue: PrepareTaskWorkspaceInput) => {
    const input = PrepareTaskWorkspaceInputSchema.parse(inputValue);
    const context = Context.current();
    context.heartbeat({ phase: 'resolve_repository' });

    const subject = subjects.resolve(input.taskReference);
    if (!subject.ok) throw failure('repository resolution', subject.error.kind);

    context.heartbeat({ phase: 'prepare_worktree' });
    const prepared = await workspaces.prepare({
      taskReference: input.taskReference,
      workflowId: input.workflowId,
      workflowRunId: input.workflowRunId,
      workflowHash: input.workflowHash,
      repositoryReference: subject.value.task.repository,
      repositoryPath: subject.value.repositoryPath,
    });
    if (!prepared.ok) throw failure('preparation', prepared.error.kind);

    context.cancellationSignal.throwIfAborted();
    context.heartbeat({ phase: 'bootstrap_harness' });
    const bootstrapped = await bootstrap.prepare(prepared.value);
    if (!bootstrapped.ok) throw failure('bootstrap', bootstrapped.error.kind);

    context.cancellationSignal.throwIfAborted();
    context.heartbeat({ phase: 'snapshot_planning_input' });
    const planningSnapshot = snapshots.createRunSnapshot(input.taskReference, input.workflowHash, {
      workspaceId: prepared.value.workspaceId,
      reference: prepared.value.repository.reference,
      path: prepared.value.path,
    });
    if (!planningSnapshot.ok) {
      throw failure('planning snapshot', planningSnapshot.error.kind);
    }

    return PrepareTaskWorkspaceResultSchema.parse({
      workspace: prepared.value,
      bootstrap: bootstrapped.value,
      planningSnapshot: planningSnapshot.value,
    });
  },
});
