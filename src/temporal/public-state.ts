import { z } from 'zod';

import { BootstrapWorkflowPublicStateSchema } from './bootstrap-kernel/contracts.js';
import { ExecutionWorkflowPublicStateSchema } from './execution-kernel/contracts.js';

export const TaskRunPublicStateSchema = z.discriminatedUnion('runtime', [
  BootstrapWorkflowPublicStateSchema,
  ExecutionWorkflowPublicStateSchema,
]);

export const TaskRunLifecycleSchema = z
  .object({
    bootstrap: BootstrapWorkflowPublicStateSchema,
    execution: ExecutionWorkflowPublicStateSchema.nullable(),
  })
  .strict()
  .readonly();

export type TaskRunPublicState = z.infer<typeof TaskRunPublicStateSchema>;
export type TaskRunLifecycle = z.infer<typeof TaskRunLifecycleSchema>;
