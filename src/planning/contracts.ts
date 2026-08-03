import { z } from 'zod';

import {
  getHarnessPack,
  type HarnessStepDefinition,
  type LoadedHarnessStep,
} from '../harness/index.js';
import {
  createPredicateRegistry,
  createStepTypeRegistry,
  createWaitRegistry,
  toContractReference,
  type PredicateContract,
  type WorkflowCompilerContracts,
  type WaitContract,
} from '../workflow/index.js';

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
      'The mandatory plan boundary resolved automatically or by the operator according to immutable run settings.',
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
  definitions: readonly HarnessStepDefinition[],
): WorkflowCompilerContracts => {
  for (const definition of definitions) {
    if (definition.reference !== toContractReference(definition.contract)) {
      throw new Error(
        `Harness step reference ${definition.reference} does not match its contract ${toContractReference(definition.contract)}`,
      );
    }
  }

  return Object.freeze({
    predicates: createPredicateRegistry(predicateContracts),
    stepTypes: createStepTypeRegistry(definitions.map(({ contract }) => contract)),
    waits: createWaitRegistry(waitContracts),
  });
};

const defaultPack = getHarnessPack();

export const M1_WORKFLOW_CONTRACTS = createHarnessWorkflowContracts(defaultPack.steps);

const retryBudgets = new Map(
  defaultPack.steps.map((definition) => [definition.reference, definition.retryBudget]),
);

export const getStepRetryBudget = (reference: string): number | undefined =>
  retryBudgets.get(reference);

const stepSources = new Map(
  defaultPack.steps.map((definition) => [definition.reference, definition]),
);

export const getHarnessStepDefinition = (reference: string): LoadedHarnessStep | undefined =>
  stepSources.get(reference);
