import { z } from 'zod';

import {
  getHarnessPack,
  type HarnessStepDefinition,
  type LoadedHarnessPack,
  type LoadedHarnessStep,
  type StepInputKindSchema,
} from '../harness/index.js';
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

type StepInputKind = z.infer<typeof StepInputKindSchema>;

const inputSchemas = {
  command: commandInputSchema,
  json: z.looseObject({}),
  task: taskInputSchema,
  verification: verificationInputSchema,
} satisfies Readonly<Record<StepInputKind, z.ZodType>>;

interface M1StepDefinition {
  readonly contract: StepTypeContract;
  readonly source: LoadedHarnessStep;
}

const splitReference = (reference: string): { readonly id: string; readonly version: string } => {
  const separator = reference.lastIndexOf('@');
  if (separator < 1) throw new Error(`Invalid versioned step reference: ${reference}`);
  return { id: reference.slice(0, separator), version: reference.slice(separator + 1) };
};

const toRuntimeContract = (source: HarnessStepDefinition): StepTypeContract => {
  const { id, version } = splitReference(source.reference);
  return {
    id,
    version,
    inputSchema: inputSchemas[source.inputKind],
    outputSchema: z.looseObject({}),
    allowedEffects: [...source.allowedEffects],
    requiredCapabilities: [...source.requiredCapabilities],
    resumeBoundary: source.resumeBoundary,
    idempotency: source.idempotency,
    retryPolicy: `bounded:${String(source.retryBudget)}`,
    waitKinds: [...source.waitKinds],
    artifactContracts: [...source.artifactContracts],
    workflowChanges: [...source.workflowChanges],
    ...(source.reconciliation === undefined
      ? {}
      : { reconciliation: { ...source.reconciliation } }),
  };
};

const createStepDefinitions = (pack: LoadedHarnessPack): readonly M1StepDefinition[] =>
  pack.steps.map((source) => ({ contract: toRuntimeContract(source), source }));

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
    description:
      'The universal planning boundary was resolved automatically or by the operator according to immutable run settings.',
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

export const createHarnessWorkflowContracts = (
  pack: LoadedHarnessPack,
): WorkflowCompilerContracts => {
  const definitions = createStepDefinitions(pack);
  return Object.freeze({
    predicates: createPredicateRegistry(predicateContracts),
    stepTypes: createStepTypeRegistry(definitions.map(({ contract }) => contract)),
    waits: createWaitRegistry(waitContracts),
  });
};

const defaultPack = getHarnessPack();
const stepDefinitions = createStepDefinitions(defaultPack);

export const M1_WORKFLOW_CONTRACTS = createHarnessWorkflowContracts(defaultPack);

const retryBudgets = new Map(
  stepDefinitions.map(({ source }) => [source.reference, source.retryBudget]),
);

export const getStepRetryBudget = (reference: string): number | undefined =>
  retryBudgets.get(reference);

const stepSources = new Map(stepDefinitions.map(({ source }) => [source.reference, source]));

export const getHarnessStepDefinition = (reference: string): LoadedHarnessStep | undefined =>
  stepSources.get(reference);
