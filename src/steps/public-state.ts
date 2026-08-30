import { z } from 'zod';

import { BootstrapWorkflowPublicStateSchema } from '../kernel/bootstrap-kernel/contracts.js';
import { ExecutionWorkflowPublicStateSchema } from '../kernel/execution-kernel/contracts.js';

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
