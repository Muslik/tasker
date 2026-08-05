import { ApplicationFailure, Context } from '@temporalio/activity';

import type { WorkflowDraftRevisionCoordinator } from '../../control-plane/workflow-draft-revision.js';
import type { PlanningSnapshotSource } from '../../planning/index.js';
import {
  ReviseTaskWorkflowDraftInputSchema,
  ReviseTaskWorkflowDraftResultSchema,
  type ReviseTaskWorkflowDraftInput,
  type TaskWorkflowActivities,
} from '../contracts.js';

export const createWorkflowDraftRevisionActivity = (
  revisions: Pick<WorkflowDraftRevisionCoordinator, 'revise'>,
  snapshots: PlanningSnapshotSource,
): Pick<TaskWorkflowActivities, 'reviseTaskWorkflowDraft'> => ({
  reviseTaskWorkflowDraft: async (inputValue: ReviseTaskWorkflowDraftInput) => {
    const input = ReviseTaskWorkflowDraftInputSchema.parse(inputValue);
    const context = Context.current();
    context.heartbeat({ phase: 'revise_workflow_draft', operationId: input.operationId });
    const revised = await revisions.revise({
      taskReference: input.taskReference,
      expectedWorkflowHash: input.currentWorkflowHash,
      request: input.request,
      operationId: input.operationId,
    });
    context.cancellationSignal.throwIfAborted();
    if (!revised.ok) {
      throw ApplicationFailure.create({
        message: revised.error.message,
        type: `workflow_draft_revision.${revised.error.kind}`,
        nonRetryable: !revised.error.retryable,
      });
    }
    const planningSnapshot = snapshots.createRunSnapshot(
      input.taskReference,
      revised.value.workflowHash,
      {
        workspaceId: input.workspace.workspaceId,
        reference: input.workspace.repository.reference,
        path: input.workspace.path,
      },
    );
    if (!planningSnapshot.ok) {
      throw new Error(`Revised planning snapshot failed: ${planningSnapshot.error.kind}`);
    }
    return ReviseTaskWorkflowDraftResultSchema.parse({
      ...revised.value,
      planningSnapshot: planningSnapshot.value,
    });
  },
});
