import { z } from 'zod';

import {
  BlockDefinitionSchema,
  BlockStageSchema,
  CompletionEvaluatorSchema,
  type BlockDefinition,
  type CompletionEvaluator,
} from '../blocks/contracts.js';
import type { StepTypeContract } from '../workflow/contracts.js';
import { WorkflowChangeKindSchema } from '../workflow/execution-result.js';
import {
  JsonValueSchema,
  OutputPredicateMappingSchema,
  type JsonValue,
} from '../workflow/schema.js';
import {
  ApiPricingTableSchema,
  ExecutionProfileNameSchema,
  ExecutionProfileRoutingSchema,
  ExecutionProfileSchema,
  ProjectExecutionProfileOverridesSchema,
} from './execution-profile-contracts.js';

const VersionedReferenceSchema = z.string().regex(/^[a-z][a-z0-9_.-]*@[1-9]\d*$/u);
const PolicyIdSchema = z.string().regex(/^[a-z][a-z0-9-]*$/u);
const RelativePathSchema = z
  .string()
  .min(1)
  .refine((value) => !value.startsWith('/') && !value.split('/').includes('..'), {
    message: 'Expected a path relative to the harness pack',
  });
export const ProcessInvocationSchema = z
  .object({
    command: z
      .string()
      .trim()
      .regex(/^[^\s]+$/u),
    args: z.array(z.string()).default([]),
  })
  .strict();

export const ProcessExecutionPlanSchema = z
  .object({
    commands: z.array(ProcessInvocationSchema).min(1).max(12),
    timeoutMs: z
      .number()
      .int()
      .min(1_000)
      .max(60 * 60_000)
      .default(35 * 60_000),
  })
  .strict();

const ProcessCommandsSchema = z.record(VersionedReferenceSchema, ProcessExecutionPlanSchema);

export const HarnessContractNameSchema = z.enum([
  'agent_output',
  'agent_review_output',
  'ci_observation_output',
  'integration_output',
  'investigation_input',
  'investigation_output',
  'process_input',
  'process_output',
  'pull_request_input',
  'pull_request_output',
  'reproduction_input',
  'reproduction_output',
  'verification_targeted_input',
  'verification_full_input',
  'verification_build_input',
  'verification_visual_input',
  'task_input',
]);

const HarnessBlockExecutorManifestSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('agent'),
      profile: z.string().min(1),
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
    schemaVersion: z.literal(2),
    reference: VersionedReferenceSchema,
    policy: PolicyIdSchema.optional(),
    description: z.string().min(1),
    stage: BlockStageSchema,
    availableDuring: z.array(z.enum(['bootstrap_investigation', 'execution'])).min(1),
    inputContract: HarnessContractNameSchema,
    outputContract: HarnessContractNameSchema,
    outputPredicates: OutputPredicateMappingSchema.optional(),
    executor: HarnessBlockExecutorManifestSchema,
    outcomes: z
      .array(z.enum(['completed', 'needs_input', 'continuation_required', 'blocked', 'failed']))
      .min(1),
    completion: CompletionEvaluatorSchema,
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
      with: z.record(z.string(), JsonValueSchema).optional(),
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
  z
    .object({
      kind: z.literal('effect'),
      reference: z.string().min(1),
    })
    .strict(),
]);

const HarnessPathSequenceObligationSchema = z
  .object({
    id: PolicyIdSchema,
    kind: z.literal('path_sequence'),
    direction: z.enum(['before', 'after']).default('before'),
    trigger: HarnessPolicyMarkerSchema,
    ordered: z.array(HarnessPolicyMarkerSchema).min(1),
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
    appliesTo: z
      .object({
        taskOrigins: z.array(z.string().min(1)).min(1),
      })
      .strict()
      .optional(),
    configuration: JsonValueSchema,
    obligations: z.array(HarnessPathSequenceObligationSchema).default([]),
    agentSkills: z
      .array(
        z
          .object({
            skill: z.string().min(1),
            steps: z.array(VersionedReferenceSchema).min(1),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();

export type HarnessBlockExecutorSource =
  | {
      readonly kind: 'agent';
      readonly profile: string;
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

export interface HarnessStepSource {
  readonly reference: string;
  readonly policy?: string;
  readonly description: string;
  readonly stage: z.infer<typeof BlockStageSchema>;
  readonly availableDuring: BlockDefinition['availableDuring'];
  readonly inputContract: z.infer<typeof HarnessContractNameSchema>;
  readonly outputContract: z.infer<typeof HarnessContractNameSchema>;
  readonly contract: StepTypeContract;
  readonly executor: HarnessBlockExecutorSource;
  readonly outcomes: BlockDefinition['outcomes'];
  readonly completion: CompletionEvaluator;
}

const TranslationPolicySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }).strict(),
  z.object({ kind: z.literal('human_handoff') }).strict(),
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

const GitBranchPolicySchema = z
  .object({
    kind: z.literal('task_key_slug'),
    maxLength: z.number().int().min(32).max(160).default(96),
  })
  .strict();

const GitCommitPolicySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('task_key_subject') }).strict(),
  z
    .object({
      kind: z.literal('conventional_task_key'),
      allowedTypes: z.array(z.string().regex(/^[a-z][a-z0-9-]*$/u)).min(1),
      requireScope: z.boolean().default(false),
    })
    .strict(),
]);

export const HarnessGitPolicySchema = z
  .object({
    baseBranch: z.string().regex(/^[A-Za-z0-9._/-]+$/u),
    branch: GitBranchPolicySchema,
    commit: GitCommitPolicySchema,
  })
  .strict();

const WorkspaceRuntimeImageSchema = z
  .object({
    kind: z.literal('prebuilt'),
    reference: z.string().trim().min(1),
  })
  .strict();

const WorkspaceRuntimeCacheVolumeSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]*$/u),
    mountPath: z.string().trim().min(1),
  })
  .strict();

const WorkspaceRuntimeServiceSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]*$/u),
    command: z.string().trim().min(1),
    aliases: z.array(z.string().trim().min(1)).default([]),
    readyCheck: z.string().trim().min(1).optional(),
    environment: z.record(z.string(), z.string()).default({}),
  })
  .strict();

export const WorkspaceRuntimeSchema = z
  .object({
    engine: z.literal('docker'),
    image: WorkspaceRuntimeImageSchema,
    workspaceMountPath: z.string().trim().min(1).default('/workspace'),
    environment: z.record(z.string(), z.string()).default({}),
    bootstrap: z.array(z.string().trim().min(1)).default([]),
    cacheVolumes: z.array(WorkspaceRuntimeCacheVolumeSchema).default([]),
    services: z.array(WorkspaceRuntimeServiceSchema).default([]),
  })
  .strict();

export const HarnessProjectManifestSchema = z
  .object({
    schemaVersion: z.literal(2),
    version: z.string().min(1),
    repository: z.string().min(1),
    repositoryKind: z.enum(['frontend', 'generic']),
    translations: TranslationPolicySchema,
    ci: CiPolicySchema.default({ kind: 'none' }),
    git: HarnessGitPolicySchema,
    processCommands: ProcessCommandsSchema,
    workspaceRuntime: WorkspaceRuntimeSchema.partial().optional(),
    executionProfileOverrides: ProjectExecutionProfileOverridesSchema.optional(),
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
    schemaVersion: z.literal(2),
    id: z.string().min(1),
    version: z.string().min(1),
    availableCapabilities: z.array(z.string().min(1)).min(1),
    processCommands: ProcessCommandsSchema,
    workspaceRuntime: WorkspaceRuntimeSchema,
    systemPrompts: z
      .object({
        implementationPlanner: RelativePathSchema,
        implementationPlannerSkills: z.array(z.string().min(1)),
        workflowAnalyzer: RelativePathSchema,
      })
      .strict(),
    globalPackageRules: z.array(GlobalPackageRuleManifestSchema),
    apiPricing: ApiPricingTableSchema,
    executionProfiles: z
      .record(ExecutionProfileNameSchema, ExecutionProfileSchema)
      .refine((profiles) => Object.keys(profiles).length > 0, {
        message: 'At least one execution profile is required',
      }),
    executionProfileRouting: ExecutionProfileRoutingSchema,
  })
  .strict();

export type HarnessProjectManifest = z.infer<typeof HarnessProjectManifestSchema>;
export type HarnessGitPolicy = z.infer<typeof HarnessGitPolicySchema>;
export type HarnessCompanyManifest = z.infer<typeof HarnessCompanyManifestSchema>;
export type HarnessStepManifest = z.infer<typeof HarnessStepManifestSchema>;
export type WorkspaceRuntime = z.infer<typeof WorkspaceRuntimeSchema>;
export type ProcessExecutionPlan = z.infer<typeof ProcessExecutionPlanSchema>;
export type HarnessPolicyManifest = z.infer<typeof HarnessPolicyManifestSchema>;
export type HarnessPolicyMarker = z.infer<typeof HarnessPolicyMarkerSchema>;

export const harnessPolicyAppliesToTask = (
  policy: HarnessPolicyManifest,
  task: { readonly origin: string },
): boolean => policy.appliesTo === undefined || policy.appliesTo.taskOrigins.includes(task.origin);

const matchesJson = (actual: JsonValue | undefined, expected: JsonValue): boolean => {
  if (expected === null || typeof expected !== 'object') return actual === expected;
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((value, index) => matchesJson(actual[index], value))
    );
  }
  if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) return false;
  return Object.entries(expected).every(([key, value]) => matchesJson(actual[key], value));
};

export const harnessPolicyStepMarkerMatches = (
  marker: Extract<HarnessPolicyMarker, { readonly kind: 'step' }>,
  reference: string,
  input: JsonValue | undefined,
): boolean =>
  marker.reference === reference && (marker.with === undefined || matchesJson(input, marker.with));

export interface LoadedPrompt {
  readonly content: string;
  readonly contentSha256: string;
  readonly relativePath: string;
}

export interface LoadedHarnessStep {
  readonly reference: string;
  readonly policy?: string;
  readonly contract: StepTypeContract;
  readonly block: BlockDefinition;
  readonly prompt: LoadedPrompt | null;
}

export type LoadedHarnessProject = HarnessProjectManifest;

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

export const applyHarnessPolicySkills = (
  block: BlockDefinition,
  reference: string,
  policies: readonly HarnessPolicyManifest[],
): BlockDefinition => {
  if (block.executor.kind !== 'agent') return block;
  const skills = policies.flatMap((policy) =>
    policy.agentSkills
      .filter((binding) => binding.steps.includes(reference))
      .map((binding) => binding.skill),
  );
  if (skills.length === 0) return block;
  return BlockDefinitionSchema.parse({
    ...block,
    executor: {
      ...block.executor,
      skills: [...new Set([...block.executor.skills, ...skills])],
    },
  });
};

export const parseVersionedReference = (reference: string): string =>
  VersionedReferenceSchema.parse(reference);
