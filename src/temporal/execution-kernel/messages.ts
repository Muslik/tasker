import { defineQuery, defineUpdate } from '@temporalio/workflow';

import type {
  ExecutionWorkflowPublicState,
  ResolveExecutionWaitCommand,
  ResolveExecutionWaitReceipt,
} from './contracts.js';

export const executionWorkflowStateQuery = defineQuery<ExecutionWorkflowPublicState>(
  'tasker.executionWorkflowV2.state',
);

export const resolveExecutionWaitUpdate = defineUpdate<
  ResolveExecutionWaitReceipt,
  [ResolveExecutionWaitCommand]
>('tasker.executionWorkflowV2.resolveWait');
