import { z } from 'zod';

import { WorkflowChangeKindSchema, WorkflowSourceSchema } from '../workflow/index.js';

const VersionedReferenceSchema = z.string().regex(/^[a-z][a-z0-9_.-]*@[1-9]\d*$/u);
const RelativePathSchema = z
  .string()
  .min(1)
  .refine((value) => !value.startsWith('/') && !value.split('/').includes('..'), {
    message: 'Expected a path relative to the harness pack',
  });

export const StepInputKindSchema = z.enum(['command', 'json', 'task', 'verification']);

export const StepExecutionBindingSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('agent'),
      prompt: RelativePathSchema,
      skills: z.array(VersionedReferenceSchema),
    })
    .strict(),
  z
    .object({
      kind: z.literal('system'),
      executor: VersionedReferenceSchema,
    })
    .strict(),
]);

export const HarnessStepDefinitionSchema = z
  .object({
    reference: VersionedReferenceSchema,
    description: z.string().min(1),
    inputKind: StepInputKindSchema,
    allowedEffects: z.array(z.string().min(1)),
    requiredCapabilities: z.array(z.string().min(1)),
    resumeBoundary: z.enum(['none', 'attempt', 'step']),
    idempotency: z.enum(['none', 'key', 'probe']),
    retryBudget: z.number().int().nonnegative(),
    waitKinds: z.array(VersionedReferenceSchema),
    artifactContracts: z.array(z.string().min(1)),
    workflowChanges: z.array(WorkflowChangeKindSchema),
    reconciliation: z
      .object({
        strategy: z.enum(['probe', 'receipt']),
        description: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    execution: StepExecutionBindingSchema,
  })
  .strict();

export const HarnessStepsManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    steps: z.array(HarnessStepDefinitionSchema).min(1),
  })
  .strict();

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

export const HarnessProjectManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    version: z.string().min(1),
    repository: z.string().min(1),
    repositoryKind: z.enum(['frontend', 'generic']),
    translations: TranslationPolicySchema,
    workflowGuidance: RelativePathSchema.optional(),
    workOverlay: RelativePathSchema.optional(),
  })
  .strict();

export const GlobalPackageRuleManifestSchema = z
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

export const HarnessCompanyManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().min(1),
    version: z.string().min(1),
    availableCapabilities: z.array(z.string().min(1)).min(1),
    systemPrompts: z
      .object({
        implementationPlanner: RelativePathSchema,
        workflowAnalyzer: RelativePathSchema,
      })
      .strict(),
    workflowTemplates: z.record(z.string().min(1), RelativePathSchema),
    globalPackageRules: z.array(GlobalPackageRuleManifestSchema),
    workOverlay: RelativePathSchema.optional(),
  })
  .strict();

export const HarnessWorkflowTemplateSchema = WorkflowSourceSchema;

export type HarnessStepDefinition = z.infer<typeof HarnessStepDefinitionSchema>;
export type HarnessProjectManifest = z.infer<typeof HarnessProjectManifestSchema>;
export type HarnessCompanyManifest = z.infer<typeof HarnessCompanyManifestSchema>;

export interface LoadedPrompt {
  readonly content: string;
  readonly contentSha256: string;
  readonly relativePath: string;
}

export interface LoadedHarnessStep extends HarnessStepDefinition {
  readonly prompt: LoadedPrompt | null;
}

export interface LoadedHarnessProject extends HarnessProjectManifest {
  readonly guidance: LoadedPrompt | null;
}

export interface LoadedHarnessPack {
  readonly rootPath: string;
  readonly company: HarnessCompanyManifest;
  readonly steps: readonly LoadedHarnessStep[];
  readonly projects: readonly LoadedHarnessProject[];
  readonly workflowTemplates: ReadonlyMap<string, z.infer<typeof WorkflowSourceSchema>>;
  readonly prompts: {
    readonly implementationPlanner: LoadedPrompt;
    readonly workflowAnalyzer: LoadedPrompt;
  };
}
