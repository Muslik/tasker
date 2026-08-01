import { z } from 'zod';

const TranslationPolicySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('inline_json') }).strict(),
  z
    .object({
      kind: z.literal('external'),
      extractCommand: z.string().min(1),
      pullCommand: z.string().min(1),
    })
    .strict(),
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

const configuredProfiles = [
  {
    repository: 'twiket/ui-kit',
    repositoryKind: 'frontend',
    source: 'configured',
    translations: {
      kind: 'external',
      extractCommand: 'pnpm translations:extract',
      pullCommand: 'pnpm translations:pull',
    },
  },
  {
    repository: 'twiket/avia-web',
    repositoryKind: 'frontend',
    source: 'configured',
    translations: { kind: 'inline_json' },
  },
] satisfies readonly z.input<typeof ProjectWorkflowProfileSchema>[];

const globalPackageRules = [
  {
    id: 'frontend-ott-package',
    repositoryKind: 'frontend',
    pathPrefix: 'packages/@ott/',
    publication: {
      kind: 'human_final',
      developmentPublishCommand: 'pnpm component:publish-dev',
    },
  },
] satisfies readonly z.input<typeof GlobalPackageRuleSchema>[];

const profiles = new Map(
  configuredProfiles.map((input) => {
    const profile = ProjectWorkflowProfileSchema.parse(input);
    return [profile.repository, profile] as const;
  }),
);

const packageRules = globalPackageRules.map((input) => GlobalPackageRuleSchema.parse(input));

export const resolveProjectWorkflowProfile = (repository: string): ProjectWorkflowProfile =>
  profiles.get(repository) ??
  ProjectWorkflowProfileSchema.parse({
    repository,
    repositoryKind: 'generic',
    source: 'default',
    translations: { kind: 'inline_json' },
  });

export const resolvePackagePublicationPolicy = (
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
