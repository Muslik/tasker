import { z } from 'zod';

import { getHarnessPack, harnessWaitContracts, type LoadedHarnessStep } from '../harness/index.js';
import {
  createPredicateRegistry,
  createStepTypeRegistry,
  createWaitRegistry,
  toContractReference,
  type WorkflowCompilerContracts,
} from '../graph/index.js';

const parseReference = (reference: string) => {
  const separator = reference.lastIndexOf('@');
  if (separator <= 0 || separator === reference.length - 1) {
    throw new Error(`Invalid versioned contract reference ${reference}`);
  }
  return {
    id: reference.slice(0, separator),
    version: reference.slice(separator + 1),
    inputSchema: z.object({}).strict(),
  };
};

export const createHarnessWorkflowContracts = (
  definitions: readonly Pick<LoadedHarnessStep, 'reference' | 'contract'>[],
): WorkflowCompilerContracts => {
  for (const definition of definitions) {
    if (definition.reference !== toContractReference(definition.contract)) {
      throw new Error(
        `Harness step reference ${definition.reference} does not match its contract ${toContractReference(definition.contract)}`,
      );
    }
  }

  const predicateReferences = new Set<string>();
  for (const definition of definitions) {
    const mappings = definition.contract.outputPredicates;
    if (mappings === undefined) continue;
    for (const reference of [
      ...Object.values(mappings.cases).flatMap((facts) => Object.keys(facts)),
      ...Object.keys(mappings.defaultFacts ?? {}),
    ]) {
      predicateReferences.add(reference);
    }
  }
  for (const wait of harnessWaitContracts) {
    if (wait.resolutionMapping === undefined) continue;
    for (const facts of Object.values(wait.resolutionMapping.cases)) {
      for (const reference of Object.keys(facts)) predicateReferences.add(reference);
    }
  }

  return Object.freeze({
    predicates: createPredicateRegistry([...predicateReferences].sort().map(parseReference)),
    stepTypes: createStepTypeRegistry(definitions.map(({ contract }) => contract)),
    waits: createWaitRegistry(harnessWaitContracts),
  });
};

const defaultPack = getHarnessPack();

export const HARNESS_WORKFLOW_CONTRACTS = createHarnessWorkflowContracts(defaultPack.steps);

const stepSources = new Map(
  defaultPack.steps.map((definition) => [definition.reference, definition]),
);

export const getHarnessStepDefinition = (reference: string): LoadedHarnessStep | undefined =>
  stepSources.get(reference);
