import { z } from 'zod';

import type { HarnessStepDefinition, HarnessStepManifest } from './contracts.js';
import type { StepTypeContract } from '../workflow/index.js';

export const taskInputSchema = z
  .object({
    objective: z.string().min(1),
    repository: z.string().min(1),
    taskId: z.string().min(1),
  })
  .strict();

export const reproductionInputSchema = taskInputSchema.extend({
  phase: z.enum(['before', 'after']),
});

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

const WorkspaceRelativePathSchema = z
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

const contractSchemas = {
  agent_output: agentOutputSchema,
  integration_output: integrationOutputSchema,
  process_input: processInputSchema,
  process_output: processOutputSchema,
  pull_request_input: pullRequestInputSchema,
  reproduction_input: reproductionInputSchema,
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

export const stepDefinitionFromManifest = (
  manifest: HarnessStepManifest,
): HarnessStepDefinition => {
  const identity = versionedIdentity(manifest.reference);
  return {
    reference: manifest.reference,
    ...(manifest.policy === undefined ? {} : { policy: manifest.policy }),
    description: manifest.description,
    retryBudget: manifest.retryBudget,
    execution: manifest.execution,
    contract: {
      ...identity,
      retryPolicy: `bounded:${String(manifest.retryBudget)}`,
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
  options: Omit<StepTypeContract, 'id' | 'version' | 'retryPolicy'> & {
    readonly retryBudget: number;
  },
): StepTypeContract => ({
  id,
  version: '1',
  retryPolicy: `bounded:${String(options.retryBudget)}`,
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
    readonly inputSchema?: z.ZodType;
    readonly prompt: string;
    readonly skills: readonly string[];
    readonly retryBudget: number;
    readonly artifactContracts: readonly string[];
    readonly requiredArtifactContracts?: readonly string[];
    readonly allowedEffects?: readonly string[];
    readonly requiredCapabilities?: readonly string[];
    readonly workflowChanges?: StepTypeContract['workflowChanges'];
  },
): HarnessStepDefinition => ({
  reference: `${id}@1`,
  description: options.description,
  retryBudget: options.retryBudget,
  execution: { kind: 'agent', prompt: options.prompt, skills: options.skills },
  contract: contract(id, {
    retryBudget: options.retryBudget,
    inputSchema: options.inputSchema ?? taskInputSchema,
    outputSchema: agentOutputSchema,
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
    readonly executor: string;
    readonly retryBudget: number;
    readonly allowedEffects: readonly string[];
    readonly requiredCapabilities: readonly string[];
    readonly waitKinds?: readonly string[];
    readonly artifactContracts: readonly string[];
    readonly requiredArtifactContracts?: readonly string[];
    readonly workflowChanges?: StepTypeContract['workflowChanges'];
  },
): HarnessStepDefinition => ({
  reference: `${id}@1`,
  description: options.description,
  retryBudget: options.retryBudget,
  execution: { kind: 'process', executor: options.executor },
  contract: contract(id, {
    retryBudget: options.retryBudget,
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
    readonly retryBudget: number;
    readonly allowedEffects: readonly string[];
    readonly requiredCapabilities: readonly string[];
    readonly waitKinds?: readonly string[];
    readonly artifactContracts: readonly string[];
    readonly requiredArtifactContracts?: readonly string[];
    readonly activityDelivery?: StepTypeContract['activityDelivery'];
    readonly inputSchema?: z.ZodType;
  },
): HarnessStepDefinition => ({
  reference: `${id}@1`,
  description: options.description,
  retryBudget: options.retryBudget,
  execution: { kind: 'integration', adapter: options.adapter },
  contract: contract(id, {
    retryBudget: options.retryBudget,
    inputSchema: options.inputSchema ?? taskInputSchema,
    outputSchema: integrationOutputSchema,
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

export const TWIKET_HARNESS_STEPS = [
  agentStep('task.analyze', {
    description: 'Analyze task and repository evidence before execution.',
    prompt: 'prompts/steps/task-analyze.md',
    skills: ['jira', 'confluence', 'loop'],
    retryBudget: 1,
    artifactContracts: ['analysis-report'],
    workflowChanges: [
      'cross_repository_dependency',
      'external_process_required',
      'task_scope_changed',
      'verification_scope_changed',
    ],
  }),
  agentStep('bug.reproduce', {
    description: 'Reproduce a bug before or after implementation and preserve evidence.',
    inputSchema: reproductionInputSchema,
    prompt: 'prompts/steps/bug-reproduce.md',
    skills: ['playwright-demo', 'jenkins'],
    retryBudget: 2,
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
    prompt: 'prompts/steps/code-implement.md',
    skills: ['typescript-design', 'test-design'],
    retryBudget: 3,
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
      inputSchema: verificationInputSchema,
      prompt: 'prompts/steps/verify.md',
      skills:
        profile === 'visual'
          ? ['playwright-demo', 'jenkins', 'test-design']
          : ['jenkins', 'test-design'],
      retryBudget: 2,
      artifactContracts: [`verification-${profile}`],
      allowedEffects: ['command.run'],
      requiredCapabilities: ['command.run'],
      workflowChanges: ['verification_scope_changed'],
    }),
  ),
  agentStep('fill-test-ops-plan', {
    description: 'Prepare a test-operations plan when company policy requires one.',
    prompt: 'prompts/steps/fill-test-ops-plan.md',
    skills: ['test-ops-planning'],
    retryBudget: 1,
    artifactContracts: ['test-operations-plan'],
  }),
  processStep('translations.extract', {
    description: 'Extract translation keys with the project-defined command.',
    executor: 'translations.extract@1',
    retryBudget: 2,
    allowedEffects: ['command.run'],
    requiredCapabilities: ['command.run'],
    waitKinds: ['translation_complete@1'],
    artifactContracts: ['translation-keys'],
    workflowChanges: ['external_process_required'],
  }),
  processStep('translations.pull', {
    description: 'Pull completed translations with the project-defined command.',
    executor: 'translations.pull@1',
    retryBudget: 2,
    allowedEffects: ['command.run'],
    requiredCapabilities: ['command.run'],
    artifactContracts: ['translated-resources'],
  }),
  processStep('component.dev_publish', {
    description: 'Publish a development build of a shared component.',
    executor: 'component.dev-publish@1',
    retryBudget: 2,
    allowedEffects: ['package.publish'],
    requiredCapabilities: ['command.run', 'package.publish'],
    waitKinds: ['final_publish@1'],
    artifactContracts: ['development-package'],
    workflowChanges: ['external_process_required'],
  }),
  agentStep('component.consume_published', {
    description: 'Consume an exact published component version in the target repository.',
    prompt: 'prompts/steps/component-consume.md',
    skills: ['typescript-design'],
    retryBudget: 2,
    artifactContracts: ['consumer-version-diff'],
    allowedEffects: ['workspace.write'],
    requiredCapabilities: ['repository.read', 'workspace.write'],
    workflowChanges: ['cross_repository_dependency', 'verification_scope_changed'],
  }),
  integrationStep('pr.prepare', {
    adapter: 'bitbucket.pull-request@1',
    description: 'Prepare and reconcile a Bitbucket pull request.',
    retryBudget: 2,
    allowedEffects: ['git.write'],
    requiredCapabilities: ['git.write'],
    waitKinds: ['code_review@1'],
    artifactContracts: ['pull-request'],
    requiredArtifactContracts: ['pull-request-draft'],
    inputSchema: pullRequestInputSchema,
    activityDelivery: { kind: 'remote_reconciled' },
  }),
  integrationStep('ci.observe', {
    adapter: 'jenkins.build@1',
    description: 'Observe Jenkins and classify product, infrastructure, and flaky failures.',
    retryBudget: 3,
    allowedEffects: [],
    requiredCapabilities: ['ci.read'],
    artifactContracts: ['ci-verdict'],
  }),
  {
    reference: 'unsafe.effect@1',
    description: 'Invalid fixture used to prove effect validation.',
    retryBudget: 0,
    execution: { kind: 'integration', adapter: 'invalid.remote-write@1' },
    contract: contract('unsafe.effect', {
      retryBudget: 0,
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
] satisfies readonly HarnessStepDefinition[];
