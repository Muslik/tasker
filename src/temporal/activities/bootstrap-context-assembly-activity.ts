import { Context } from '@temporalio/activity';

import type { BootstrapContextAssembler } from '../../control-plane/bootstrap-context-assembly.js';
import {
  AssembleTaskPlanningContextInputSchema,
  AssembleTaskPlanningContextResultSchema,
  type BootstrapWorkflowActivities,
} from '../bootstrap-kernel/contracts.js';

export const createBootstrapContextAssemblyActivity = (
  assembler: BootstrapContextAssembler,
): Pick<BootstrapWorkflowActivities, 'assembleTaskPlanningContext'> => ({
  assembleTaskPlanningContext: async (inputValue) => {
    const input = AssembleTaskPlanningContextInputSchema.parse(inputValue);
    const context = Context.current();
    context.cancellationSignal.throwIfAborted();
    context.heartbeat({ phase: 'assemble_planning_context', operationId: input.operationId });

    const assembled = await assembler.assemble(input);
    if (!assembled.ok) {
      throw new Error(`Planning context assembly failed: ${assembled.error.kind}`);
    }
    return AssembleTaskPlanningContextResultSchema.parse(assembled.value);
  },
});
