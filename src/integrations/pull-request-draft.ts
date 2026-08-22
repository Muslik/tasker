import { z } from 'zod';

export const PullRequestDraftArtifactPathSchema = z
  .string()
  .min(1)
  .refine((value) => !value.startsWith('/') && !value.split('/').includes('..'), {
    message: 'Expected a path relative to the managed worktree',
  })
  .refine((value) => !/^(?:\.\/)*\.tasker(?:\/|$)/u.test(value), {
    message: 'Tasker control-plane files cannot be published as branch artifacts',
  });

export const GitCommitDraftSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('subject'),
      subject: z.string().trim().min(1).max(200),
    })
    .strict(),
  z
    .object({
      kind: z.literal('conventional'),
      type: z.string().regex(/^[a-z][a-z0-9-]*$/u),
      scope: z
        .string()
        .trim()
        .regex(/^[a-z0-9@/._-]+$/u)
        .nullable(),
      subject: z.string().trim().min(1).max(200),
    })
    .strict(),
]);

export const PullRequestDraftSchema = z
  .object({
    title: z.string().trim().min(1),
    description: z.string().trim().min(1),
    commit: GitCommitDraftSchema,
    branchArtifacts: z.array(PullRequestDraftArtifactPathSchema).default([]),
  })
  .strict()
  .refine((value) => new Set(value.branchArtifacts).size === value.branchArtifacts.length, {
    message: 'Pull-request branch artifact paths must be unique',
    path: ['branchArtifacts'],
  });

export type PullRequestDraft = z.infer<typeof PullRequestDraftSchema>;
export type GitCommitDraft = z.infer<typeof GitCommitDraftSchema>;
