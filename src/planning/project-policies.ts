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

const GlobalPackageRuleSchema = z
  .object({
    id: z.string().min(1),
    repositoryKind: z.literal('frontend'),
    pathPrefix: z.string().min(1),
    publication: z
      .object({
        kind: z.literal('human_final'),
        developmentPublishCommand: z.string().min(1),
      })
      .strict(),
  })
  .strict();

export const ResolvedPackagePublicationPolicySchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('none'),
      source: z.literal('default'),
    })
    .strict(),
  z
    .object({
      kind: z.literal('human_final'),
      source: z.literal('global'),
      policyId: z.string().min(1),
      pathPrefix: z.string().min(1),
      developmentPublishCommand: z.string().min(1),
    })
    .strict(),
]);

export type ResolvedPackagePublicationPolicy = z.infer<
  typeof ResolvedPackagePublicationPolicySchema
>;

export interface ProjectPolicyResolver {
  resolvePackagePublicationPolicy(
    repository: string,
    packagePath: string,
  ): ResolvedPackagePublicationPolicy;
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
  const packageRules = pack.company.globalPackageRules.map((input) =>
    GlobalPackageRuleSchema.parse(input),
  );

  const resolveProjectWorkflowProfile = (repository: string): ProjectWorkflowProfile =>
    profiles.get(repository) ??
    ProjectWorkflowProfileSchema.parse({
      repository,
      repositoryKind: 'generic',
      source: 'default',
      translations: { kind: 'none' },
    });

  const resolvePackagePublicationPolicy = (
    repository: string,
    packagePath: string,
  ): ResolvedPackagePublicationPolicy => {
    const project = resolveProjectWorkflowProfile(repository);
    const match = packageRules.find(
      (rule) =>
        rule.repositoryKind === project.repositoryKind && packagePath.startsWith(rule.pathPrefix),
    );

    return match === undefined
      ? ResolvedPackagePublicationPolicySchema.parse({ kind: 'none', source: 'default' })
      : ResolvedPackagePublicationPolicySchema.parse({
          kind: match.publication.kind,
          source: 'global',
          policyId: match.id,
          pathPrefix: match.pathPrefix,
          developmentPublishCommand: match.publication.developmentPublishCommand,
        });
  };

  return Object.freeze({ resolvePackagePublicationPolicy, resolveProjectWorkflowProfile });
};

const defaultResolver = createProjectPolicyResolver(getHarnessPack());

export const resolveProjectWorkflowProfile = (repository: string): ProjectWorkflowProfile =>
  defaultResolver.resolveProjectWorkflowProfile(repository);

export const resolvePackagePublicationPolicy = (
  repository: string,
  packagePath: string,
): ResolvedPackagePublicationPolicy =>
  defaultResolver.resolvePackagePublicationPolicy(repository, packagePath);
