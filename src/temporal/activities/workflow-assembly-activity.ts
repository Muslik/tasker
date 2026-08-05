import { ApplicationFailure, Context } from '@temporalio/activity';

import type { WorkflowGenerator } from '../../control-plane/workflow-generator.js';
import {
  TaskBootstrapWorkflowInputSchema,
  TaskDraftAssemblyResultSchema,
  type TaskBootstrapActivities,
  type TaskBootstrapWorkflowInput,
} from '../contracts.js';

const NON_RETRYABLE_GENERATION_FAILURES = new Set([
  'fixture_not_found',
  'task_not_found',
  'generation_blocked',
  'planner_contract_failure',
  'non_json_artifact',
]);

export const createWorkflowAssemblyActivity = (
  generator: WorkflowGenerator,
): TaskBootstrapActivities => ({
  assembleTaskWorkflowDraft: async (inputValue: TaskBootstrapWorkflowInput) => {
    const input = TaskBootstrapWorkflowInputSchema.parse(inputValue);
    const context = Context.current();
    const reportProgress = (): void => {
      context.heartbeat({ phase: 'context_discovery_and_draft_assembly' });
    };
    const heartbeatTimer = setInterval(reportProgress, 10_000);
    heartbeatTimer.unref();

    try {
      reportProgress();
      const generated = await generator.generate(input.taskReference);
      context.cancellationSignal.throwIfAborted();
      if (!generated.ok) {
        throw ApplicationFailure.create({
          message: `Workflow draft assembly stopped: ${generated.error.kind}`,
          type: `workflow_generation.${generated.error.kind}`,
          nonRetryable: NON_RETRYABLE_GENERATION_FAILURES.has(generated.error.kind),
        });
      }

      return TaskDraftAssemblyResultSchema.parse({
        status: generated.value.status,
        taskReference: input.taskReference,
        workflowHash: generated.value.view.workflow.graphHash,
      });
    } finally {
      clearInterval(heartbeatTimer);
    }
  },
});
