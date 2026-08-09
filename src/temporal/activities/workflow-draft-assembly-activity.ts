import { Context } from '@temporalio/activity';

import type { WorkflowDraftAssembler } from '../../control-plane/workflow-draft-assembly.js';
import {
  AssembleTaskWorkflowDraftInputSchema,
  AssembleTaskWorkflowDraftResultSchema,
  type BootstrapWorkflowActivities,
} from '../bootstrap-kernel/contracts.js';

export const createWorkflowDraftAssemblyActivity = (
  assembler: WorkflowDraftAssembler,
): Pick<BootstrapWorkflowActivities, 'assembleTaskWorkflowDraft'> => ({
  assembleTaskWorkflowDraft: async (inputValue) => {
    const input = AssembleTaskWorkflowDraftInputSchema.parse(inputValue);
    const context = Context.current();
    context.cancellationSignal.throwIfAborted();
    context.heartbeat({ phase: 'assemble_workflow_draft', operationId: input.operationId });

    const assembled = await assembler.assemble(input);
    if (!assembled.ok) {
      throw new Error(`Workflow draft assembly failed: ${assembled.error.kind}`);
    }
    return AssembleTaskWorkflowDraftResultSchema.parse(assembled.value);
  },
});
