import { z } from 'zod';

import type { StepTypeContract } from '../workflow/index.js';

const VersionedReferenceSchema = z.string().regex(/^[a-z][a-z0-9_.-]*@[1-9]\d*$/u);
const RelativePathSchema = z
  .string()
  .min(1)
  .refine((value) => !value.startsWith('/') && !value.split('/').includes('..'), {
    message: 'Expected a path relative to the harness pack',
  });
const ProcessCommandsSchema = z.record(VersionedReferenceSchema, z.string().trim().min(1));

export type HarnessExecutionBinding =
  | {
      readonly kind: 'agent';
      readonly prompt: string;
      readonly skills: readonly string[];
    }
  | {
      readonly kind: 'process';
      readonly executor: string;
    }
  | {
      readonly kind: 'integration';
      readonly adapter: string;
    };

export interface HarnessStepDefinition {
  readonly reference: string;
  readonly description: string;
  readonly retryBudget: number;
  readonly contract: StepTypeContract;
  readonly execution: HarnessExecutionBinding;
}

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
    processCommands: ProcessCommandsSchema,
    workflowGuidance: RelativePathSchema.optional(),
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
    processCommands: ProcessCommandsSchema,
    systemPrompts: z
      .object({
        implementationPlanner: RelativePathSchema,
        workflowAnalyzer: RelativePathSchema,
      })
      .strict(),
    globalPackageRules: z.array(GlobalPackageRuleManifestSchema),
  })
  .strict();

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
  readonly prompts: {
    readonly implementationPlanner: LoadedPrompt;
    readonly workflowAnalyzer: LoadedPrompt;
  };
}

export const parseVersionedReference = (reference: string): string =>
  VersionedReferenceSchema.parse(reference);
