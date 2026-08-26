import { z } from 'zod';

import { getHarnessPack, type LoadedHarnessPack } from '../harness/index.js';

const TranslationPolicySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }).strict(),
  z.object({ kind: z.literal('human_handoff') }).strict(),
]);

export const ProjectWorkflowProfileSchema = z
  .object({
    repository: z.string().min(1),
    repositoryKind: z.enum(['frontend', 'generic']),
    source: z.enum(['configured', 'default']),
    translations: TranslationPolicySchema,
  })
  .strict();

export type ProjectWorkflowProfile = z.infer<typeof ProjectWorkflowProfileSchema>;

export interface ProjectPolicyResolver {
  resolveProjectWorkflowProfile(repository: string): ProjectWorkflowProfile;
}

export const createProjectPolicyResolver = (pack: LoadedHarnessPack): ProjectPolicyResolver => {
  const profiles = new Map(
    pack.projects.map((project) => {
      const profile = ProjectWorkflowProfileSchema.parse({
        repository: project.repository,
        repositoryKind: project.repositoryKind,
        source: 'configured',
        translations: project.translations,
      });
      return [profile.repository, profile] as const;
    }),
  );

  const resolveProjectWorkflowProfile = (repository: string): ProjectWorkflowProfile =>
    profiles.get(repository) ??
    ProjectWorkflowProfileSchema.parse({
      repository,
      repositoryKind: 'generic',
      source: 'default',
      translations: { kind: 'none' },
    });

  return Object.freeze({ resolveProjectWorkflowProfile });
};

const defaultResolver = createProjectPolicyResolver(getHarnessPack());

export const resolveProjectWorkflowProfile = (repository: string): ProjectWorkflowProfile =>
  defaultResolver.resolveProjectWorkflowProfile(repository);
