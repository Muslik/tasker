import { z } from 'zod';

import type { BlockDefinition, CompletionEvaluator } from '../blocks/index.js';
import type { HarnessStepManifest, HarnessStepSource } from './contracts.js';
import type { StepTypeContract } from '../workflow/index.js';

export const taskInputSchema = z
  .object({
    objective: z.string().min(1),
    repository: z.string().min(1),
    taskId: z.string().min(1),
  })
  .strict();

export const reproductionInputSchema = taskInputSchema.extend({
  phase: z.literal('after'),
});

export const investigationInputSchema = taskInputSchema;

export const verificationInputSchema = z
  .object({
    profile: z.string().min(1),
    taskId: z.string().min(1),
  })
  .strict();

export const processInputSchema = z
  .object({
    repository: z.string().min(1),
    taskId: z.string().min(1),
  })
  .strict();

export const WorkspaceRelativePathSchema = z
  .string()
  .min(1)
  .refine((value) => !value.startsWith('/') && !value.split('/').includes('..'), {
    message: 'Expected a path relative to the managed worktree',
  });

export const pullRequestInputSchema = taskInputSchema.extend({
  draftPath: WorkspaceRelativePathSchema,
});

export const agentOutputSchema = z
  .object({
    summary: z.string().min(1),
    artifacts: z.array(z.string().min(1)).default([]),
  })
  .strict();

const ReproductionEvidenceSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('video'),
      path: WorkspaceRelativePathSchema,
      mimeType: z.string().regex(/^video\/[a-z0-9][a-z0-9.+-]*$/u),
    })
    .strict(),
  z
    .object({
      kind: z.literal('image'),
      path: WorkspaceRelativePathSchema,
      mimeType: z.string().regex(/^image\/[a-z0-9][a-z0-9.+-]*$/u),
    })
    .strict(),
  z
    .object({
      kind: z.literal('log'),
      path: WorkspaceRelativePathSchema,
      mimeType: z.string().regex(/^(?:text|application)\/[a-z0-9][a-z0-9.+-]*$/u),
    })
    .strict(),
]);

export const reproductionOutputSchema = z
  .object({
    summary: z.string().min(1),
    phase: z.literal('after'),
    outcome: z.literal('verified_fixed'),
    evidence: z.array(ReproductionEvidenceSchema).min(1),
  })
  .strict();

export const investigationOutputSchema = z
  .object({
    summary: z.string().min(1),
    outcome: z.enum(['reproduced', 'not_reproduced', 'inconclusive']),
    observations: z.array(z.string().min(1)).min(1).max(50),
    evidence: z.array(ReproductionEvidenceSchema).max(30),
  })
  .strict();

export const processOutputSchema = z
  .object({
    exitCode: z.number().int(),
    receiptId: z.string().min(1),
  })
  .strict();

export const integrationOutputSchema = z
  .object({
    externalId: z.string().min(1),
    status: z.string().min(1),
  })
  .strict();

export const pullRequestOutputSchema = z
  .object({
    externalId: z.string().min(1),
    status: z.literal('open'),
    provider: z.string().min(1),
    repository: z.string().min(1),
    sourceBranch: z.string().min(1),
    targetBranch: z.string().min(1),
    url: z.url().nullable(),
  })
  .strict();

export const ciObservationOutputSchema = z
  .object({
    externalId: z.string().min(1),
    status: z.enum([
      'passed',
      'likely_caused_by_change',
      'likely_flaky',
      'infrastructure',
      'unknown',
    ]),
    provider: z.string().min(1),
    build: z
      .object({
        number: z.number().int().nonnegative(),
        url: z.httpUrl(),
        revision: z.string().min(1),
        result: z.string().min(1),
        durationMs: z.number().int().nonnegative(),
      })
      .strict(),
    stages: z.array(
      z
        .object({
          name: z.string().min(1),
          status: z.string().min(1),
        })
        .strict(),
    ),
    failures: z.array(
      z
        .object({
          uid: z.string().min(1),
          name: z.string().min(1),
          status: z.string().min(1),
          message: z.string().nullable(),
          flaky: z.boolean(),
          attachments: z.array(
            z
              .object({
                name: z.string().min(1),
                type: z.string().min(1),
                source: z.string().min(1),
              })
              .strict(),
          ),
        })
        .strict(),
    ),
  })
  .strict();

const contractSchemas = {
  agent_output: agentOutputSchema,
  ci_observation_output: ciObservationOutputSchema,
  integration_output: integrationOutputSchema,
  investigation_input: investigationInputSchema,
  investigation_output: investigationOutputSchema,
  process_input: processInputSchema,
  process_output: processOutputSchema,
  pull_request_input: pullRequestInputSchema,
  pull_request_output: pullRequestOutputSchema,
  reproduction_input: reproductionInputSchema,
  reproduction_output: reproductionOutputSchema,
  task_input: taskInputSchema,
  verification_input: verificationInputSchema,
} as const satisfies Readonly<Record<HarnessStepManifest['inputContract'], z.ZodType>>;

const versionedIdentity = (
  reference: string,
): { readonly id: string; readonly version: string } => {
  const separator = reference.lastIndexOf('@');
  if (separator < 1 || separator === reference.length - 1) {
    throw new Error(`Invalid harness step reference ${reference}`);
  }
  return { id: reference.slice(0, separator), version: reference.slice(separator + 1) };
};

export const stepDefinitionFromManifest = (manifest: HarnessStepManifest): HarnessStepSource => {
  const identity = versionedIdentity(manifest.reference);
  return {
    reference: manifest.reference,
    ...(manifest.policy === undefined ? {} : { policy: manifest.policy }),
    description: manifest.description,
    stage: manifest.stage,
    availableDuring: manifest.availableDuring,
    inputContract: manifest.inputContract,
    outputContract: manifest.outputContract,
    executor: manifest.executor,
    outcomes: manifest.outcomes,
    completion: manifest.completion,
    contract: {
      ...identity,
      inputSchema: contractSchemas[manifest.inputContract],
      outputSchema: contractSchemas[manifest.outputContract],
      activityDelivery: { kind: manifest.activityDelivery },
      allowedEffects: manifest.allowedEffects,
      requiredCapabilities: manifest.requiredCapabilities,
      resumeBoundary: manifest.resumeBoundary,
      idempotency: manifest.idempotency,
      waitKinds: manifest.waitKinds,
      artifactContracts: manifest.artifactContracts,
      requiredArtifactContracts: manifest.requiredArtifactContracts,
      workflowChanges: manifest.workflowChanges,
      ...(manifest.reconciliation === undefined ? {} : { reconciliation: manifest.reconciliation }),
    },
  };
};

const contract = (
  id: string,
  options: Omit<StepTypeContract, 'id' | 'version'>,
): StepTypeContract => ({
  id,
  version: '1',
  activityDelivery: options.activityDelivery,
  inputSchema: options.inputSchema,
  outputSchema: options.outputSchema,
  allowedEffects: options.allowedEffects,
  requiredCapabilities: options.requiredCapabilities,
  resumeBoundary: options.resumeBoundary,
  idempotency: options.idempotency,
  waitKinds: options.waitKinds,
  artifactContracts: options.artifactContracts,
  requiredArtifactContracts: options.requiredArtifactContracts,
  workflowChanges: options.workflowChanges,
  ...(options.reconciliation === undefined ? {} : { reconciliation: options.reconciliation }),
});

const agentStep = (
  id: string,
  options: {
    readonly description: string;
    readonly stage: { readonly id: string; readonly label: string };
    readonly availableDuring?: BlockDefinition['availableDuring'];
    readonly profile: string;
    readonly completion: CompletionEvaluator;
    readonly inputSchema?: z.ZodType;
    readonly outputSchema?: z.ZodType;
    readonly inputContract?: HarnessStepManifest['inputContract'];
    readonly outputContract?: HarnessStepManifest['outputContract'];
    readonly prompt: string;
    readonly skills: readonly string[];
    readonly artifactContracts: readonly string[];
    readonly requiredArtifactContracts?: readonly string[];
    readonly allowedEffects?: readonly string[];
    readonly requiredCapabilities?: readonly string[];
    readonly workflowChanges?: StepTypeContract['workflowChanges'];
  },
): HarnessStepSource => ({
  reference: `${id}@1`,
  description: options.description,
  stage: options.stage,
  availableDuring: options.availableDuring ?? ['execution'],
  inputContract: options.inputContract ?? 'task_input',
  outputContract: options.outputContract ?? 'agent_output',
  executor: {
    kind: 'agent',
    profile: options.profile,
    prompt: options.prompt,
    skills: options.skills,
  },
  outcomes: ['completed', 'needs_input', 'continuation_required', 'blocked', 'failed'],
  completion: options.completion,
  contract: contract(id, {
    inputSchema: options.inputSchema ?? taskInputSchema,
    outputSchema: options.outputSchema ?? agentOutputSchema,
    allowedEffects: [...(options.allowedEffects ?? [])],
    requiredCapabilities: [...(options.requiredCapabilities ?? ['repository.read'])],
    resumeBoundary: options.allowedEffects?.length ? 'step' : 'attempt',
    idempotency: options.allowedEffects?.length ? 'key' : 'none',
    waitKinds: [],
    artifactContracts: [...options.artifactContracts],
    requiredArtifactContracts: [...(options.requiredArtifactContracts ?? [])],
    workflowChanges: [...(options.workflowChanges ?? [])],
    activityDelivery: { kind: 'workspace_reconciled' },
    ...(options.allowedEffects?.length ? { reconciliation: { strategy: 'receipt' as const } } : {}),
  }),
});

const processStep = (
  id: string,
  options: {
    readonly description: string;
    readonly stage: { readonly id: string; readonly label: string };
    readonly executor: string;
    readonly allowedEffects: readonly string[];
    readonly requiredCapabilities: readonly string[];
    readonly waitKinds?: readonly string[];
    readonly artifactContracts: readonly string[];
    readonly requiredArtifactContracts?: readonly string[];
    readonly workflowChanges?: StepTypeContract['workflowChanges'];
  },
): HarnessStepSource => ({
  reference: `${id}@1`,
  description: options.description,
  stage: options.stage,
  availableDuring: ['execution'],
  inputContract: 'process_input',
  outputContract: 'process_output',
  executor: { kind: 'process', executor: options.executor },
  outcomes: ['completed', 'needs_input', 'blocked', 'failed'],
  completion: { kind: 'process_receipt', expectedExitCode: 0 },
  contract: contract(id, {
    inputSchema: processInputSchema,
    outputSchema: processOutputSchema,
    allowedEffects: [...options.allowedEffects],
    requiredCapabilities: [...options.requiredCapabilities],
    resumeBoundary: 'step',
    idempotency: 'probe',
    waitKinds: [...(options.waitKinds ?? [])],
    artifactContracts: [...options.artifactContracts],
    requiredArtifactContracts: [...(options.requiredArtifactContracts ?? [])],
    workflowChanges: [...(options.workflowChanges ?? [])],
    activityDelivery: { kind: 'single_attempt' },
    reconciliation: { strategy: 'probe' },
  }),
});

const integrationStep = (
  id: string,
  options: {
    readonly adapter: string;
    readonly description: string;
    readonly stage: { readonly id: string; readonly label: string };
    readonly allowedEffects: readonly string[];
    readonly requiredCapabilities: readonly string[];
    readonly waitKinds?: readonly string[];
    readonly artifactContracts: readonly string[];
    readonly requiredArtifactContracts?: readonly string[];
    readonly activityDelivery?: StepTypeContract['activityDelivery'];
    readonly inputSchema?: z.ZodType;
    readonly outputSchema?: z.ZodType;
    readonly inputContract?: HarnessStepManifest['inputContract'];
    readonly outputContract?: HarnessStepManifest['outputContract'];
  },
): HarnessStepSource => ({
  reference: `${id}@1`,
  description: options.description,
  stage: options.stage,
  availableDuring: ['execution'],
  inputContract: options.inputContract ?? 'task_input',
  outputContract: options.outputContract ?? 'integration_output',
  executor: { kind: 'integration', adapter: options.adapter },
  outcomes: ['completed', 'needs_input', 'blocked', 'failed'],
  completion: { kind: 'reconciled_effect' },
  contract: contract(id, {
    inputSchema: options.inputSchema ?? taskInputSchema,
    outputSchema: options.outputSchema ?? integrationOutputSchema,
    allowedEffects: [...options.allowedEffects],
    requiredCapabilities: [...options.requiredCapabilities],
    resumeBoundary: 'step',
    idempotency: 'probe',
    waitKinds: [...(options.waitKinds ?? [])],
    artifactContracts: [...options.artifactContracts],
    requiredArtifactContracts: [...(options.requiredArtifactContracts ?? [])],
    workflowChanges: [],
    activityDelivery: options.activityDelivery ?? { kind: 'single_attempt' },
    reconciliation: { strategy: 'probe' },
  }),
});

const stages = {
  investigation: { id: 'investigation', label: 'Investigate' },
  implementation: { id: 'implementation', label: 'Implement' },
  verification: { id: 'verification', label: 'Verify' },
  delivery: { id: 'delivery', label: 'Deliver' },
} as const;

export const TWIKET_HARNESS_STEPS = [
  agentStep('bug.investigate', {
    description:
      'Ground the reported bug before planning and preserve observed behavior as planning evidence.',
    stage: stages.investigation,
    availableDuring: ['bootstrap_investigation'],
    profile: 'investigation',
    completion: {
      kind: 'structured_evidence',
      source: 'task_output',
      requiredArtifactKinds: ['investigation-result'],
    },
    inputSchema: investigationInputSchema,
    outputSchema: investigationOutputSchema,
    inputContract: 'investigation_input',
    outputContract: 'investigation_output',
    prompt: 'prompts/steps/bug-investigate.md',
    skills: ['playwright-demo', 'jenkins'],
    artifactContracts: ['investigation-result'],
    allowedEffects: ['command.run'],
    requiredCapabilities: ['command.run', 'repository.read'],
    workflowChanges: [
      'cross_repository_dependency',
      'task_scope_changed',
      'verification_scope_changed',
    ],
  }),
  agentStep('bug.reproduce', {
    description: 'Repeat the investigated scenario after implementation and preserve fix evidence.',
    stage: stages.investigation,
    profile: 'investigation',
    completion: {
      kind: 'structured_evidence',
      source: 'workspace_files',
      requiredArtifactKinds: ['reproduction-media'],
    },
    inputSchema: reproductionInputSchema,
    outputSchema: reproductionOutputSchema,
    inputContract: 'reproduction_input',
    outputContract: 'reproduction_output',
    prompt: 'prompts/steps/bug-reproduce.md',
    skills: ['playwright-demo', 'jenkins'],
    artifactContracts: ['reproduction-report', 'reproduction-media'],
    allowedEffects: ['command.run'],
    requiredCapabilities: ['command.run', 'repository.read'],
    workflowChanges: [
      'cross_repository_dependency',
      'task_scope_changed',
      'verification_scope_changed',
    ],
  }),
  agentStep('code.implement', {
    description: 'Implement a bounded change in a managed worktree.',
    stage: stages.implementation,
    profile: 'implementation',
    completion: { kind: 'workspace_mutation' },
    prompt: 'prompts/steps/code-implement.md',
    skills: ['typescript-design', 'test-design'],
    artifactContracts: ['source-diff'],
    allowedEffects: ['workspace.write'],
    requiredCapabilities: ['repository.read', 'workspace.write'],
    workflowChanges: [
      'cross_repository_dependency',
      'external_process_required',
      'task_scope_changed',
      'verification_scope_changed',
    ],
  }),
  ...(['targeted', 'full', 'visual'] as const).map((profile) =>
    agentStep(`verify.${profile}`, {
      description: `Run ${profile} verification selected for this task.`,
      stage: stages.verification,
      profile: 'verification',
      completion: {
        kind: 'structured_evidence',
        source: 'workspace_files',
        requiredArtifactKinds: [`verification-${profile}`],
      },
      inputSchema: verificationInputSchema,
      inputContract: 'verification_input',
      prompt: 'prompts/steps/verify.md',
      skills:
        profile === 'visual'
          ? ['playwright-demo', 'jenkins', 'test-design']
          : ['jenkins', 'test-design'],
      artifactContracts: [`verification-${profile}`],
      allowedEffects: ['command.run'],
      requiredCapabilities: ['command.run'],
      workflowChanges: ['verification_scope_changed'],
    }),
  ),
  agentStep('fill-test-ops-plan', {
    description: 'Prepare a test-operations plan when company policy requires one.',
    stage: stages.verification,
    profile: 'verification',
    completion: {
      kind: 'structured_evidence',
      source: 'task_output',
      requiredArtifactKinds: ['test-operations-plan'],
    },
    prompt: 'prompts/steps/fill-test-ops-plan.md',
    skills: ['test-ops-planning'],
    artifactContracts: ['test-operations-plan'],
  }),
  processStep('translations.extract', {
    description: 'Extract translation keys with the project-defined command.',
    stage: stages.implementation,
    executor: 'translations.extract@1',
    allowedEffects: ['command.run'],
    requiredCapabilities: ['command.run'],
    waitKinds: ['translation_complete@1'],
    artifactContracts: ['translation-keys'],
    workflowChanges: ['external_process_required'],
  }),
  processStep('translations.pull', {
    description: 'Pull completed translations with the project-defined command.',
    stage: stages.implementation,
    executor: 'translations.pull@1',
    allowedEffects: ['command.run'],
    requiredCapabilities: ['command.run'],
    artifactContracts: ['translated-resources'],
  }),
  processStep('component.dev_publish', {
    description: 'Publish a development build of a shared component.',
    stage: stages.delivery,
    executor: 'component.dev-publish@1',
    allowedEffects: ['package.publish'],
    requiredCapabilities: ['command.run', 'package.publish'],
    waitKinds: ['final_publish@1'],
    artifactContracts: ['development-package'],
    workflowChanges: ['external_process_required'],
  }),
  agentStep('component.consume_published', {
    description: 'Consume an exact published component version in the target repository.',
    stage: stages.implementation,
    profile: 'implementation',
    completion: { kind: 'workspace_mutation' },
    prompt: 'prompts/steps/component-consume.md',
    skills: ['typescript-design'],
    artifactContracts: ['consumer-version-diff'],
    allowedEffects: ['workspace.write'],
    requiredCapabilities: ['repository.read', 'workspace.write'],
    workflowChanges: ['cross_repository_dependency', 'verification_scope_changed'],
  }),
  integrationStep('pr.prepare', {
    adapter: 'bitbucket.pull-request@1',
    description: 'Prepare and reconcile a Bitbucket pull request.',
    stage: stages.delivery,
    allowedEffects: ['git.write'],
    requiredCapabilities: ['git.write'],
    waitKinds: ['code_review@1'],
    artifactContracts: ['pull-request'],
    requiredArtifactContracts: ['pull-request-draft'],
    inputSchema: pullRequestInputSchema,
    outputSchema: pullRequestOutputSchema,
    inputContract: 'pull_request_input',
    outputContract: 'pull_request_output',
    activityDelivery: { kind: 'remote_reconciled' },
  }),
  {
    reference: 'unsafe.effect@1',
    description: 'Invalid fixture used to prove effect validation.',
    stage: stages.delivery,
    availableDuring: ['execution'],
    inputContract: 'task_input',
    outputContract: 'integration_output',
    executor: { kind: 'integration', adapter: 'invalid.remote-write@1' },
    outcomes: ['completed', 'blocked', 'failed'],
    completion: { kind: 'reconciled_effect' },
    contract: contract('unsafe.effect', {
      inputSchema: taskInputSchema,
      outputSchema: integrationOutputSchema,
      allowedEffects: ['remote.write'],
      requiredCapabilities: ['remote.write'],
      resumeBoundary: 'none',
      idempotency: 'none',
      waitKinds: [],
      artifactContracts: [],
      requiredArtifactContracts: [],
      workflowChanges: [],
      activityDelivery: { kind: 'single_attempt' },
    }),
  },
] satisfies readonly HarnessStepSource[];
