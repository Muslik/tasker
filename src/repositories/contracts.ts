import { z } from 'zod';

export const RepositoryReferenceSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9._-]+(?:\/[a-z0-9._-]+)?$/iu);

export const RepositoryCheckoutSchema = z
  .object({
    runnerId: z.string().min(1),
    path: z.string().min(1),
  })
  .strict();

export const RepositoryCatalogEntrySchema = z
  .object({
    repositoryId: z.string().min(1),
    remoteUrl: z.string().min(1).nullable(),
    checkout: RepositoryCheckoutSchema,
    checkoutPaths: z.array(z.string().min(1)).min(1),
    aliases: z.array(z.string().min(1)).min(1),
  })
  .strict();

export const RepositoryCatalogResponseSchema = z
  .object({
    repositories: z.array(RepositoryCatalogEntrySchema),
  })
  .strict();

export const RepositoryCandidateSchema = z
  .object({
    repositoryId: z.string().min(1),
    projectKey: z.string().min(1),
    reference: RepositoryReferenceSchema,
    remoteUrl: z.string().min(1),
  })
  .strict();

export const RepositoryProvisionProblemSchema = z
  .object({
    kind: z.enum([
      'bitbucket_not_configured',
      'auth_failed',
      'access_blocked',
      'unavailable',
      'invalid_response',
      'clone_failed',
      'destination_conflict',
    ]),
    message: z.string().min(1),
    retryable: z.boolean(),
    httpStatus: z.number().int().optional(),
  })
  .strict();

export const RepositoryBindingSourceSchema = z.enum(['jira_description', 'intake_fallback']);

const RepositoryBindingBaseSchema = z.object({
  issueKey: z.string().min(1),
  recordedAt: z.iso.datetime(),
});

export const JiraRepositoryBindingSchema = z.discriminatedUnion('status', [
  RepositoryBindingBaseSchema.extend({
    status: z.literal('resolved'),
    source: RepositoryBindingSourceSchema,
    reference: RepositoryReferenceSchema,
    repository: RepositoryCatalogEntrySchema,
  }).strict(),
  RepositoryBindingBaseSchema.extend({
    status: z.literal('missing'),
  }).strict(),
  RepositoryBindingBaseSchema.extend({
    status: z.literal('not_found'),
    source: RepositoryBindingSourceSchema,
    reference: RepositoryReferenceSchema,
  }).strict(),
  RepositoryBindingBaseSchema.extend({
    status: z.literal('ambiguous'),
    source: RepositoryBindingSourceSchema,
    reference: RepositoryReferenceSchema,
    candidates: z.array(RepositoryCandidateSchema).min(2),
  }).strict(),
  RepositoryBindingBaseSchema.extend({
    status: z.literal('unavailable'),
    source: RepositoryBindingSourceSchema,
    reference: RepositoryReferenceSchema,
    problem: RepositoryProvisionProblemSchema,
  }).strict(),
  RepositoryBindingBaseSchema.extend({
    status: z.literal('invalid'),
    source: RepositoryBindingSourceSchema,
    references: z.array(z.string()).min(1),
  }).strict(),
]);

export type RepositoryCatalogEntry = z.infer<typeof RepositoryCatalogEntrySchema>;
export type RepositoryCandidate = z.infer<typeof RepositoryCandidateSchema>;
export type RepositoryProvisionProblem = z.infer<typeof RepositoryProvisionProblemSchema>;
export type RepositoryBindingSource = z.infer<typeof RepositoryBindingSourceSchema>;
export type JiraRepositoryBinding = z.infer<typeof JiraRepositoryBindingSchema>;
