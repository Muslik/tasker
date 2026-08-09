import { Context } from '@temporalio/activity';

import type { BlockReceiptStore } from '../../blocks/index.js';
import type { EvidenceBundleStore } from '../../control-plane/evidence-bundle.js';
import type { ImplementationPlanningStore } from '../../control-plane/implementation-planning.js';
import type { ExecutionWorkflowActivities } from '../execution-kernel/contracts.js';
import {
  RunBootstrapInvestigationInputSchema,
  RunBootstrapInvestigationResultSchema,
  type BootstrapWorkflowActivities,
} from '../bootstrap-kernel/contracts.js';

export const createBootstrapInvestigationActivity = (
  execution: ExecutionWorkflowActivities,
  snapshots: ImplementationPlanningStore,
  receipts: BlockReceiptStore,
  evidenceBundles: EvidenceBundleStore,
): Pick<BootstrapWorkflowActivities, 'runBootstrapInvestigation'> => ({
  runBootstrapInvestigation: async (inputValue) => {
    const input = RunBootstrapInvestigationInputSchema.parse(inputValue);
    const context = Context.current();
    context.cancellationSignal.throwIfAborted();
    context.heartbeat({
      phase: 'bootstrap_investigation',
      step: input.step.uses,
      blockRun: input.blockRun,
    });

    const snapshot = snapshots.readRunSnapshot(input.planningSnapshot);
    if (!snapshot.ok || snapshot.value.kind !== 'planning_context') {
      throw new Error('Bootstrap investigation planning context is unavailable');
    }
    const registered = snapshot.value.harness.steps.find(
      ({ reference }) => reference === input.step.uses,
    );
    if (
      registered === undefined ||
      !registered.block.availableDuring.includes('bootstrap_investigation')
    ) {
      throw new Error(`Block ${input.step.uses} is not registered for bootstrap investigation`);
    }

    const result = await execution.runExecutionBlock({
      schemaVersion: 2,
      taskReference: input.taskReference,
      workflowId: input.workflowId,
      workflowRunId: input.workflowRunId,
      workflowHash: input.contextHash,
      nodeId: input.step.id,
      blockRun: input.blockRun,
      uses: input.step.uses,
      activityDelivery: registered.activityDelivery,
      contextReferences: [
        {
          kind: 'workspace',
          reference: input.workspace.workspaceId,
          hash: input.workspace.repository.baseCommit,
        },
        {
          kind: 'planning_snapshot',
          reference: input.planningSnapshot.artifactId,
          hash: input.planningSnapshot.checksum,
        },
      ],
      operatorGuidance: input.operatorGuidance,
      input: input.step.with,
    });
    if (result.status === 'needs_input') {
      return RunBootstrapInvestigationResultSchema.parse(result);
    }

    const receiptReference = result.receiptReference;
    const receipt = receipts.read(receiptReference);
    if (!receipt.ok || receipt.value === null) {
      throw new Error(`Investigation receipt ${receiptReference} is unavailable`);
    }
    const appended = evidenceBundles.appendInvestigationEvidence(
      input.taskReference,
      `${input.workflowId}:${input.step.id}:run-${String(input.blockRun)}`,
      [receipt.value],
    );
    if (!appended.ok) {
      throw new Error(`Investigation evidence could not be appended: ${appended.error.kind}`);
    }

    return RunBootstrapInvestigationResultSchema.parse({
      ...result,
      evidenceBundle: appended.value.reference,
    });
  },
});
