import { z } from 'zod';

export const PullRequestDraftArtifactPathSchema = z
  .string()
  .min(1)
  .refine((value) => !value.startsWith('/') && !value.split('/').includes('..'), {
    message: 'Expected a path relative to the managed worktree',
  });

export const PullRequestDraftSchema = z
  .object({
    title: z.string().trim().min(1),
    description: z.string().trim().min(1),
    branchArtifacts: z.array(PullRequestDraftArtifactPathSchema).default([]),
  })
  .strict()
  .refine((value) => new Set(value.branchArtifacts).size === value.branchArtifacts.length, {
    message: 'Pull-request branch artifact paths must be unique',
    path: ['branchArtifacts'],
  });

export type PullRequestDraft = z.infer<typeof PullRequestDraftSchema>;
