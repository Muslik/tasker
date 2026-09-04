import { z } from 'zod';

import { HarnessGitPolicySchema } from '../harness/contracts.js';
import { GitBranchNameSchema } from '../shared/git-branch.js';

const ContentHashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const GitObjectIdSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u);

export const PrepareWorkspaceRequestSchema = z
  .object({
    taskReference: z.string().min(1),
    taskKey: z.string().regex(/^[A-Za-z][A-Za-z0-9]*-\d+$/u),
    taskTitle: z.string().trim().min(1),
    branchName: GitBranchNameSchema.optional(),
    workflowId: z.string().min(1),
    workflowRunId: z.string().min(1),
    repositoryReference: z.string().min(1),
    repositoryPath: z.string().min(1),
    gitPolicy: HarnessGitPolicySchema,
  })
  .strict()
  .superRefine((request, context) => {
    if (request.branchName === undefined) return;
    const taskKey = request.taskKey.toLocaleUpperCase('en-US');
    if (
      request.branchName.length > request.gitPolicy.branch.maxLength ||
      (request.branchName !== taskKey && !request.branchName.startsWith(`${taskKey}-`))
    ) {
      context.addIssue({
        code: 'custom',
        path: ['branchName'],
        message: `Branch must start with ${taskKey} and fit the project branch policy`,
      });
    }
  })
  .readonly();

export const WorkspaceLocatorSchema = z
  .object({
    schemaVersion: z.literal(1),
    workspaceId: z.string().regex(/^[a-f0-9]{24}$/u),
    taskReference: z.string().min(1),
    workflowId: z.string().min(1),
    workflowRunId: z.string().min(1),
    repository: z
      .object({
        reference: z.string().min(1),
        sourcePath: z.string().min(1),
        baseBranch: z.string().min(1),
        baseCommit: GitObjectIdSchema,
      })
      .strict(),
    runnerId: z.string().min(1),
    path: z.string().min(1),
    branch: z.string().min(1),
    preparedAt: z.iso.datetime(),
  })
  .strict()
  .readonly();

export const WorkspaceBootstrapReceiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    operationId: z.string().min(1),
    workspaceId: z.string().regex(/^[a-f0-9]{24}$/u),
    adapterId: z.string().min(1),
    adapterVersion: z.string().min(1),
    profile: z.string().min(1),
    files: z.array(
      z
        .object({
          relativePath: z
            .string()
            .min(1)
            .refine((value) => !value.startsWith('/') && !value.split('/').includes('..')),
          sha256: ContentHashSchema,
        })
        .strict(),
    ),
    completedAt: z.iso.datetime(),
  })
  .strict()
  .readonly();

export type PrepareWorkspaceRequest = z.infer<typeof PrepareWorkspaceRequestSchema>;
export type WorkspaceLocator = z.infer<typeof WorkspaceLocatorSchema>;
export type WorkspaceBootstrapReceipt = z.infer<typeof WorkspaceBootstrapReceiptSchema>;

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
