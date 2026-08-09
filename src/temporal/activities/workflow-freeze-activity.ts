import { ApplicationFailure, Context } from '@temporalio/activity';

import type { WorkflowFreezeStore } from '../../control-plane/workflow-freeze.js';
import {
  FreezeTaskWorkflowInputSchema,
  WorkflowFreezeReceiptSchema,
  type FreezeTaskWorkflowInput,
} from '../freeze-contracts.js';
import type { BootstrapWorkflowActivities } from '../bootstrap-kernel/contracts.js';

export const createWorkflowFreezeActivity = (
  freezes: Pick<WorkflowFreezeStore, 'record'>,
): Pick<BootstrapWorkflowActivities, 'freezeTaskWorkflow'> => ({
  freezeTaskWorkflow: (inputValue: FreezeTaskWorkflowInput) => {
    const input = FreezeTaskWorkflowInputSchema.parse(inputValue);
    Context.current().heartbeat({ phase: 'freeze_workflow', workflowHash: input.workflowHash });
    const frozen = freezes.record(input);
    if (!frozen.ok) {
      throw ApplicationFailure.create({
        message: `Workflow freeze failed: ${frozen.error.kind}`,
        type: `workflow_freeze.${frozen.error.kind}`,
        nonRetryable: frozen.error.kind !== 'ledger_conflict',
      });
    }
    return Promise.resolve(WorkflowFreezeReceiptSchema.parse(frozen.value));
  },
});
