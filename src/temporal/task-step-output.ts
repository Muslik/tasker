import { z } from 'zod';

import { JsonValueSchema } from '../workflow/schema.js';
import { ExecuteTaskStepResultSchema } from './contracts.js';

export const TaskStepOutputArtifactSchema = z
  .object({
    schemaVersion: z.literal(2),
    operationId: z.string().min(1),
    workflowId: z.string().min(1),
    workflowRunId: z.string().min(1),
    nodeId: z.string().min(1),
    stepReference: z.string().min(1),
    stepAttempt: z.number().int().positive(),
    runner: z.enum(['agent', 'integration', 'process', 'system']),
    command: z.string().nullable(),
    args: z.array(z.string()),
    cwd: z.string().min(1),
    exitCode: z.number().int().nullable(),
    status: z.enum(['completed', 'blocked', 'workflow_change_required']),
    stdout: z.string(),
    stderr: z.string(),
    details: JsonValueSchema,
    result: ExecuteTaskStepResultSchema.nullable(),
    recordedAt: z.iso.datetime(),
  })
  .strict();

export type TaskStepOutputArtifact = z.infer<typeof TaskStepOutputArtifactSchema>;
