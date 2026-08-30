import { z } from 'zod';

import { VALIDATION_PROCESS_COMMAND_REFERENCES } from '../harness/contracts.js';

const ProviderPlanningFailureSchema = z
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

const ValidationCommandReferenceSchema = z.enum(VALIDATION_PROCESS_COMMAND_REFERENCES);

export const ProjectValidationMissingFailureSchema = z
  .object({
    kind: z.literal('project_validation_missing'),
    message: z.string().min(1),
    retryable: z.literal(false),
    repositoryReference: z.string().min(1),
    expectedKeys: z.tuple([
      z.literal(VALIDATION_PROCESS_COMMAND_REFERENCES[0]),
      z.literal(VALIDATION_PROCESS_COMMAND_REFERENCES[1]),
      z.literal(VALIDATION_PROCESS_COMMAND_REFERENCES[2]),
    ]),
    missingKeys: z
      .array(ValidationCommandReferenceSchema)
      .min(1)
      .max(3)
      .refine((keys) => new Set(keys).size === keys.length, 'Missing keys must be unique'),
  })
  .strict();

export const ProductNotMappedFailureSchema = z
  .object({
    kind: z.literal('product_not_mapped'),
    message: z.string().min(1),
    retryable: z.literal(false),
    taskId: z.string().min(1),
    jiraProjectKey: z.string().min(1),
    repositoryReference: z.string().min(1),
    availableProjectKeys: z
      .array(z.string().min(1))
      .max(50)
      .refine(
        (keys) => new Set(keys).size === keys.length,
        'Available project keys must be unique',
      ),
  })
  .strict();

export const ImplementationPlanningFailureSchema = z.discriminatedUnion('kind', [
  ProviderPlanningFailureSchema,
  ProjectValidationMissingFailureSchema,
  ProductNotMappedFailureSchema,
]);

export type ImplementationPlanningFailure = z.infer<typeof ImplementationPlanningFailureSchema>;
