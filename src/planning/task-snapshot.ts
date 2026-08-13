import { z } from 'zod';

export const PlanningTaskSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    origin: z.string().min(1),
    reference: z.string().min(1),
    taskId: z.string().min(1),
    title: z.string().min(1),
    description: z.string().min(1),
    repository: z.string().regex(/^[a-z0-9._-]+\/[a-z0-9._-]+$/u),
    kind: z.enum(['bug', 'feature', 'task', 'other']),
    labels: z.array(z.string().min(1)),
  })
  .strict()
  .readonly();

export type PlanningTaskSnapshot = z.infer<typeof PlanningTaskSnapshotSchema>;
