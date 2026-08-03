import { defineQuery, defineUpdate } from '@temporalio/workflow';

import type {
  ResolveTaskWaitCommand,
  ResolveTaskWaitReceipt,
  TaskWorkflowPublicState,
} from '../contracts.js';

export const taskWorkflowStateQuery = defineQuery<TaskWorkflowPublicState>(
  'tasker.taskWorkflowState',
);

export const resolveTaskWaitUpdate = defineUpdate<ResolveTaskWaitReceipt, [ResolveTaskWaitCommand]>(
  'tasker.resolveTaskWait',
);
