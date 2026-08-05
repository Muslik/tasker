import { proxyActivities } from '@temporalio/workflow';

import type {
  TaskBootstrapActivities,
  TaskBootstrapWorkflowInput,
  TaskDraftAssemblyResult,
} from '../contracts.js';

const bootstrapActivities = proxyActivities<TaskBootstrapActivities>({
  startToCloseTimeout: '35 minutes',
  scheduleToCloseTimeout: '2 hours',
  heartbeatTimeout: '30 seconds',
  retry: {
    initialInterval: '1 second',
    maximumInterval: '30 seconds',
    maximumAttempts: 3,
  },
});

export const taskBootstrapWorkflow = (
  input: TaskBootstrapWorkflowInput,
): Promise<TaskDraftAssemblyResult> => bootstrapActivities.assembleTaskWorkflowDraft(input);
