import { z } from 'zod';

import { BootstrapWorkflowPublicStateSchema } from './bootstrap-kernel/contracts.js';
import { ExecutionWorkflowPublicStateSchema } from './execution-kernel/contracts.js';

export const TaskRunPublicStateSchema = z.discriminatedUnion('runtime', [
  BootstrapWorkflowPublicStateSchema,
  ExecutionWorkflowPublicStateSchema,
]);

export type TaskRunPublicState = z.infer<typeof TaskRunPublicStateSchema>;
