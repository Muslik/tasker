import { z } from 'zod';

import { PlanningStrategyRequestSchema } from '../../planning/implementation-plan.js';
import { TrackerStatusUpdatesSchema } from '../../shared/task-run-settings.js';
import { GitBranchNameSchema } from '../../shared/git-branch.js';

export const TaskRunSettingsSchema = z
  .object({
    planReview: z.enum(['required', 'automatic']),
    planningStrategy: PlanningStrategyRequestSchema,
    trackerStatusUpdates: TrackerStatusUpdatesSchema.default('enabled'),
    branchName: GitBranchNameSchema.optional(),
    operatorBrief: z.string().max(10_000).optional(),
  })
  .strict()
  .readonly();

export type TaskRunSettings = z.infer<typeof TaskRunSettingsSchema>;
