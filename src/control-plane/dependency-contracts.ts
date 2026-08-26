import { z } from 'zod';

const PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;

export const DependencyPackageNameSchema = z
  .string()
  .trim()
  .min(1)
  .regex(PACKAGE_NAME_PATTERN, 'Expected a valid npm package name');

export const DependencyDeclarationModeSchema = z.enum(['final_only', 'validate_dev_then_final']);

export const DependencyDeclarationSourceSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('jira_link'),
      linkId: z.string().min(1),
      linkTypeId: z.string().min(1),
      direction: z.enum(['inward', 'outward']),
    })
    .strict()
    .readonly(),
  z
    .object({
      kind: z.literal('runtime_discovery'),
      workflowRunId: z.string().min(1),
      requestArtifactId: z.string().min(1),
    })
    .strict()
    .readonly(),
]);

const DependencyPackagesSchema = z
  .array(DependencyPackageNameSchema)
  .min(1)
  .superRefine((packages, context) => {
    const seen = new Set<string>();
    for (const [index, packageName] of packages.entries()) {
      if (seen.has(packageName)) {
        context.addIssue({
          code: 'custom',
          message: `Duplicate package name "${packageName}"`,
          path: [index],
        });
      }
      seen.add(packageName);
    }
  });

export const RecordDependencyDeclarationInputSchema = z
  .object({
    consumerTaskReference: z.string().min(1),
    producerTaskReference: z.string().min(1),
    producerRepository: z.string().min(1),
    packages: DependencyPackagesSchema,
    mode: DependencyDeclarationModeSchema,
    source: DependencyDeclarationSourceSchema,
  })
  .strict()
  .readonly();

export const DependencyDeclarationSchema = z
  .object({
    consumerTaskReference: z.string().min(1),
    producerTaskReference: z.string().min(1),
    producerRepository: z.string().min(1),
    packages: DependencyPackagesSchema,
    mode: DependencyDeclarationModeSchema,
    source: DependencyDeclarationSourceSchema,
    schemaVersion: z.literal(1),
    declarationId: z.string().min(1),
    revision: z.number().int().positive(),
    hash: z.string().regex(/^[a-f0-9]{64}$/u),
    createdAt: z.iso.datetime(),
  })
  .strict()
  .readonly();

export type DependencyDeclarationSource = z.infer<typeof DependencyDeclarationSourceSchema>;
export type RecordDependencyDeclarationInput = z.infer<
  typeof RecordDependencyDeclarationInputSchema
>;
export type DependencyDeclaration = z.infer<typeof DependencyDeclarationSchema>;
