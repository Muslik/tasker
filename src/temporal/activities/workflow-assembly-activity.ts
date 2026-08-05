import { ApplicationFailure, Context } from '@temporalio/activity';

import type { WorkflowGenerator } from '../../control-plane/workflow-generator.js';
import { providerFailureSummary } from '../../control-plane/workflow-generator.js';
import type { M1ServiceError } from '../../control-plane/m1-service.js';
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

const failureMessage = (error: M1ServiceError): string => {
  switch (error.kind) {
    case 'provider_failure':
      return providerFailureSummary(error.failure);
    case 'generation_runtime_unavailable':
      return error.message;
    case 'generation_blocked':
      return error.reason;
    case 'fixture_not_found':
      return `Fixture ${error.fixtureId} does not exist`;
    case 'task_not_found':
      return `Task ${error.taskReference} does not exist`;
    case 'planner_contract_failure':
      return `Planner stopped at ${error.stage}`;
    case 'non_json_artifact':
      return `Planner produced non-JSON ${error.artifact}`;
    case 'store_failure':
      return `Ledger failed with ${error.error.kind}`;
  }
};

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
          message: `Workflow draft assembly stopped: ${generated.error.kind}: ${failureMessage(generated.error)}`,
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
