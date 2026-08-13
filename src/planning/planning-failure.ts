import { z } from 'zod';

export const ImplementationPlanningFailureSchema = z
  .object({
    kind: z.enum([
      'invalid_skill_selection',
      'invalid_skill_package',
      'skill_unavailable',
      'skill_materialization_failed',
      'provider_unavailable',
      'provider_timed_out',
      'provider_failed',
      'invalid_event_stream',
      'invalid_planner_output',
    ]),
    message: z.string().min(1),
    retryable: z.boolean(),
  })
  .strict();

export type ImplementationPlanningFailure = z.infer<typeof ImplementationPlanningFailureSchema>;
