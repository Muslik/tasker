import type { RetrospectiveStore } from '../../retrospective/index.js';
import type {
  ExecutionWorkflowActivities,
  RunExecutionRetrospectiveInput,
} from '../execution-kernel/contracts.js';

export const createExecutionRetrospectiveActivity = (
  retrospectives: RetrospectiveStore,
): Pick<ExecutionWorkflowActivities, 'runExecutionRetrospective'> => ({
  runExecutionRetrospective: (input: RunExecutionRetrospectiveInput) => {
    const generated = retrospectives.generate(input);
    return Promise.resolve(
      generated.ok
        ? {
            status: 'ready' as const,
            artifactId: `retrospective:${input.workflowId}:${input.workflowRunId}`,
          }
        : { status: 'failed' as const, reason: generated.error.kind },
    );
  },
});
