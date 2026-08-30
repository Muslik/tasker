import { defineQuery, defineUpdate } from '@temporalio/workflow';

import type {
  BootstrapWorkflowPublicState,
  ResolveBootstrapWaitCommand,
  ResolveBootstrapWaitReceipt,
} from './contracts.js';

export const bootstrapWorkflowStateQuery = defineQuery<BootstrapWorkflowPublicState>(
  'tasker.bootstrapWorkflowV3.state',
);

export const resolveBootstrapWaitUpdate = defineUpdate<
  ResolveBootstrapWaitReceipt,
  [ResolveBootstrapWaitCommand]
>('tasker.bootstrapWorkflowV3.resolveWait');
