import { z } from 'zod';

import {
  createPredicateRegistry,
  createStepTypeRegistry,
  createWaitRegistry,
  type PredicateContract,
  type StepTypeContract,
  type WorkflowCompilerContracts,
  type WaitContract,
} from '../workflow/index.js';

const taskInputSchema = z
  .object({
    objective: z.string().min(1),
    repository: z.string().min(1),
    taskId: z.string().min(1),
  })
  .strict();

const verificationInputSchema = z
  .object({
    profile: z.string().min(1),
    taskId: z.string().min(1),
  })
  .strict();

const commandInputSchema = z
  .object({
    command: z.string().min(1),
    repository: z.string().min(1),
    taskId: z.string().min(1),
  })
  .strict();

const defineReadOnlyStep = (
  id: string,
  artifactContracts: readonly string[],
  retryBudget: number,
): M1StepDefinition => ({
  contract: {
    id,
    version: '1',
    inputSchema: taskInputSchema,
    outputSchema: z.looseObject({}),
    allowedEffects: [],
    requiredCapabilities: ['repository.read'],
    resumeBoundary: 'attempt',
    idempotency: 'none',
    retryPolicy: `bounded:${String(retryBudget)}`,
    waitKinds: [],
    artifactContracts: [...artifactContracts],
  },
  retryBudget,
});

interface M1StepDefinition {
  readonly contract: StepTypeContract;
  readonly retryBudget: number;
}

const stepDefinitions: readonly M1StepDefinition[] = [
  defineReadOnlyStep('task.analyze', ['analysis-report'], 1),
  {
    contract: {
      id: 'bug.reproduce',
      version: '1',
      inputSchema: taskInputSchema,
      outputSchema: z.looseObject({}),
      allowedEffects: ['command.run'],
      requiredCapabilities: ['command.run', 'repository.read'],
      resumeBoundary: 'step',
      idempotency: 'probe',
      retryPolicy: 'bounded:2',
      waitKinds: [],
      artifactContracts: ['reproduction-report'],
      reconciliation: { strategy: 'probe' },
    },
    retryBudget: 2,
  },
  {
    contract: {
      id: 'code.implement',
      version: '1',
      inputSchema: taskInputSchema,
      outputSchema: z.looseObject({}),
      allowedEffects: ['workspace.write'],
      requiredCapabilities: ['repository.read', 'workspace.write'],
      resumeBoundary: 'step',
      idempotency: 'key',
      retryPolicy: 'bounded:3',
      waitKinds: [],
      artifactContracts: ['source-diff'],
      reconciliation: { strategy: 'receipt' },
    },
    retryBudget: 3,
  },
  ...(['targeted', 'full', 'visual'] as const).map((profile): M1StepDefinition => ({
    contract: {
      id: `verify.${profile}`,
      version: '1',
      inputSchema: verificationInputSchema,
      outputSchema: z.looseObject({}),
      allowedEffects: ['command.run'],
      requiredCapabilities: ['command.run'],
      resumeBoundary: 'step',
      idempotency: 'probe',
      retryPolicy: 'bounded:2',
      waitKinds: [],
      artifactContracts: [`verification-${profile}`],
      reconciliation: { strategy: 'probe' },
    },
    retryBudget: 2,
  })),
  {
    contract: {
      id: 'pr.prepare',
      version: '1',
      inputSchema: taskInputSchema,
      outputSchema: z.looseObject({}),
      allowedEffects: ['git.write'],
      requiredCapabilities: ['git.write'],
      resumeBoundary: 'step',
      idempotency: 'probe',
      retryPolicy: 'bounded:2',
      waitKinds: ['code_review@1'],
      artifactContracts: ['pull-request-draft'],
      reconciliation: { strategy: 'probe' },
    },
    retryBudget: 2,
  },
  ...(['extract', 'pull'] as const).map((action): M1StepDefinition => ({
    contract: {
      id: `translations.${action}`,
      version: '1',
      inputSchema: commandInputSchema,
      outputSchema: z.looseObject({}),
      allowedEffects: ['command.run'],
      requiredCapabilities: ['command.run'],
      resumeBoundary: 'step',
      idempotency: 'probe',
      retryPolicy: 'bounded:2',
      waitKinds: action === 'extract' ? ['translation_complete@1'] : [],
      artifactContracts: [action === 'extract' ? 'translation-keys' : 'translated-resources'],
      reconciliation: { strategy: 'probe' },
    },
    retryBudget: 2,
  })),
  {
    contract: {
      id: 'component.dev_publish',
      version: '1',
      inputSchema: commandInputSchema,
      outputSchema: z.looseObject({}),
      allowedEffects: ['package.publish'],
      requiredCapabilities: ['command.run', 'package.publish'],
      resumeBoundary: 'step',
      idempotency: 'probe',
      retryPolicy: 'bounded:2',
      waitKinds: ['final_publish@1'],
      artifactContracts: ['development-package'],
      reconciliation: { strategy: 'probe' },
    },
    retryBudget: 2,
  },
  {
    contract: {
      id: 'unsafe.effect',
      version: '1',
      inputSchema: taskInputSchema,
      outputSchema: z.looseObject({}),
      allowedEffects: ['remote.write'],
      requiredCapabilities: ['remote.write'],
      resumeBoundary: 'none',
      idempotency: 'none',
      retryPolicy: 'bounded:0',
      waitKinds: [],
      artifactContracts: [],
    },
    retryBudget: 0,
  },
];

const predicateContracts = [
  {
    id: 'attempt.succeeded',
    version: '1',
    inputSchema: z.object({}).strict(),
    description: 'The most recent implementation and verification attempt succeeded.',
  },
  {
    id: 'plan.approved',
    version: '1',
    inputSchema: z.object({ taskId: z.string().min(1) }).strict(),
    description: 'The optional human plan-review gate is resolved.',
  },
] satisfies readonly PredicateContract[];

const waitContracts = [
  {
    id: 'code_review',
    version: '1',
    resolutionSchema: z
      .object({
        decision: z.enum(['approved', 'changes_requested']),
        reviewId: z.string().min(1),
      })
      .strict(),
    slotPolicy: 'release',
    description: 'Wait for a human review decision or actionable PR comments.',
  },
  {
    id: 'translation_complete',
    version: '1',
    resolutionSchema: z.object({ translationRevision: z.string().min(1) }).strict(),
    slotPolicy: 'release',
    description: 'Wait for the translator to finish external work.',
  },
  {
    id: 'final_publish',
    version: '1',
    resolutionSchema: z.object({ version: z.string().min(1) }).strict(),
    slotPolicy: 'release',
    description: 'Wait for a human-owned final package publication.',
  },
] satisfies readonly WaitContract[];

export const M1_WORKFLOW_CONTRACTS: WorkflowCompilerContracts = Object.freeze({
  predicates: createPredicateRegistry(predicateContracts),
  stepTypes: createStepTypeRegistry(stepDefinitions.map(({ contract }) => contract)),
  waits: createWaitRegistry(waitContracts),
});

const retryBudgets = new Map(
  stepDefinitions.map(({ contract, retryBudget }) => [
    `${contract.id}@${contract.version}`,
    retryBudget,
  ]),
);

export const getStepRetryBudget = (reference: string): number | undefined =>
  retryBudgets.get(reference);
