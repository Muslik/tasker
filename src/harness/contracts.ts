import { z } from 'zod';

import type { StepTypeContract } from '../workflow/contracts.js';
import { WorkflowChangeKindSchema } from '../workflow/execution-result.js';
import { JsonValueSchema } from '../workflow/schema.js';

const VersionedReferenceSchema = z.string().regex(/^[a-z][a-z0-9_.-]*@[1-9]\d*$/u);
const PolicyIdSchema = z.string().regex(/^[a-z][a-z0-9-]*$/u);
const RelativePathSchema = z
  .string()
  .min(1)
  .refine((value) => !value.startsWith('/') && !value.split('/').includes('..'), {
    message: 'Expected a path relative to the harness pack',
  });
const ProcessCommandsSchema = z.record(VersionedReferenceSchema, z.string().trim().min(1));

export const HarnessContractNameSchema = z.enum([
  'agent_output',
  'ci_observation_output',
  'integration_output',
  'process_input',
  'process_output',
  'pull_request_input',
  'pull_request_output',
  'reproduction_input',
  'task_input',
  'verification_input',
]);

const HarnessStepExecutionManifestSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('agent'),
      prompt: RelativePathSchema,
      skills: z.array(z.string().min(1)),
    })
    .strict(),
  z
    .object({
      kind: z.literal('process'),
      executor: VersionedReferenceSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('integration'),
      adapter: VersionedReferenceSchema,
    })
    .strict(),
]);

export const HarnessStepManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    reference: VersionedReferenceSchema,
    policy: PolicyIdSchema.optional(),
    description: z.string().min(1),
    retryBudget: z.number().int().nonnegative(),
    inputContract: HarnessContractNameSchema,
    outputContract: HarnessContractNameSchema,
    execution: HarnessStepExecutionManifestSchema,
    activityDelivery: z.enum([
      'single_attempt',
      'read_only',
      'workspace_reconciled',
      'remote_reconciled',
    ]),
    allowedEffects: z.array(z.string().min(1)),
    requiredCapabilities: z.array(z.string().min(1)),
    resumeBoundary: z.enum(['none', 'attempt', 'step']),
    idempotency: z.enum(['none', 'key', 'probe']),
    waitKinds: z.array(VersionedReferenceSchema),
    artifactContracts: z.array(z.string().min(1)),
    requiredArtifactContracts: z.array(z.string().min(1)).default([]),
    workflowChanges: z.array(WorkflowChangeKindSchema),
    reconciliation: z
      .object({ strategy: z.enum(['probe', 'receipt']) })
      .strict()
      .optional(),
  })
  .strict();

const HarnessPolicyMarkerSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('step'),
      reference: VersionedReferenceSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('gate'),
      reference: VersionedReferenceSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('wait'),
      reference: VersionedReferenceSchema,
    })
    .strict(),
]);

const HarnessPathSequenceObligationSchema = z
  .object({
    id: PolicyIdSchema,
    kind: z.literal('path_sequence'),
    direction: z.enum(['before', 'after']).default('before'),
    trigger: HarnessPolicyMarkerSchema,
    ordered: z.array(HarnessPolicyMarkerSchema).min(2),
    reason: z.string().min(1),
  })
  .strict();

export const HarnessPolicyManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().regex(/^[a-z][a-z0-9-]*$/u),
    version: z.string().min(1),
    enabled: z.boolean(),
    description: z.string().min(1),
    configuration: JsonValueSchema,
    obligations: z.array(HarnessPathSequenceObligationSchema).min(1),
  })
  .strict();

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
  readonly policy?: string;
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

const CiPolicySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }).strict(),
  z
    .object({
      kind: z.literal('jenkins'),
      job: z.string().trim().min(1),
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
    ci: CiPolicySchema.default({ kind: 'none' }),
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
export type HarnessStepManifest = z.infer<typeof HarnessStepManifestSchema>;
export type HarnessPolicyManifest = z.infer<typeof HarnessPolicyManifestSchema>;
export type HarnessPolicyMarker = z.infer<typeof HarnessPolicyMarkerSchema>;

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
  readonly policies: readonly HarnessPolicyManifest[];
  readonly projects: readonly LoadedHarnessProject[];
  readonly prompts: {
    readonly implementationPlanner: LoadedPrompt;
    readonly workflowAnalyzer: LoadedPrompt;
  };
}

export const parseVersionedReference = (reference: string): string =>
  VersionedReferenceSchema.parse(reference);
