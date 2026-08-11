import { z } from 'zod';

import { loadHarnessEnvironmentDefaults } from '../../shared/env-file.js';

const SingleLineValueSchema = z
  .string()
  .trim()
  .min(1)
  .max(320)
  .refine((value) => !/[\r\n]/u.test(value));

const GitCommitIdentitySchema = z
  .object({
    name: SingleLineValueSchema,
    email: SingleLineValueSchema.refine((value) => value.includes('@')),
  })
  .strict();

export type GitCommitIdentity = z.infer<typeof GitCommitIdentitySchema>;

export const loadGitCommitIdentity = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
): GitCommitIdentity | null => {
  const defaults = loadHarnessEnvironmentDefaults(environment);
  const parsed = GitCommitIdentitySchema.safeParse({
    name: environment.TASKER_GIT_AUTHOR_NAME ?? defaults.TASKER_GIT_AUTHOR_NAME,
    email: environment.TASKER_GIT_AUTHOR_EMAIL ?? defaults.TASKER_GIT_AUTHOR_EMAIL,
  });
  return parsed.success ? parsed.data : null;
};
