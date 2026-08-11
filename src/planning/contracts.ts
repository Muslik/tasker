import { z } from 'zod';

import { getHarnessPack, type LoadedHarnessStep } from '../harness/index.js';
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
    id: 'validation.passed',
    version: '1',
    inputSchema: z.object({}).strict(),
    description: 'The latest declared project validation command exited successfully.',
  },
  {
    id: 'validation.failed',
    version: '1',
    inputSchema: z.object({}).strict(),
    description:
      'The latest declared project validation command produced actionable failure evidence.',
  },
  {
    id: 'agent_review.accepted',
    version: '1',
    inputSchema: z.object({}).strict(),
    description: 'The latest independent local agent review accepted the change and evidence.',
  },
  {
    id: 'agent_review.changes_requested',
    version: '1',
    inputSchema: z.object({}).strict(),
    description: 'The latest independent local agent review produced actionable findings.',
  },
  {
    id: 'ci.passed',
    version: '1',
    inputSchema: z.object({}).strict(),
    description: 'The latest exact-revision CI observation passed.',
  },
  {
    id: 'ci.change_failure',
    version: '1',
    inputSchema: z.object({}).strict(),
    description: 'The latest exact-revision CI observation is attributable to the task change.',
  },
  {
    id: 'ci.flaky',
    version: '1',
    inputSchema: z.object({}).strict(),
    description: 'The latest exact-revision CI observation is likely flaky.',
  },
  {
    id: 'ci.infrastructure',
    version: '1',
    inputSchema: z.object({}).strict(),
    description: 'The latest exact-revision CI observation failed in infrastructure.',
  },
  {
    id: 'ci.unknown',
    version: '1',
    inputSchema: z.object({}).strict(),
    description: 'The latest exact-revision CI observation cannot be classified safely.',
  },
  {
    id: 'review.approved',
    version: '1',
    inputSchema: z.object({}).strict(),
    description: 'The latest imported or operator-provided code-review decision is approval.',
  },
  {
    id: 'review.changes_requested',
    version: '1',
    inputSchema: z.object({}).strict(),
    description: 'The latest imported code-review decision contains actionable changes.',
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
    stage: { id: 'review', label: 'Review' },
    resolutionSchema: z
      .object({
        decision: z.enum(['approved', 'changes_requested']),
        reviewId: z.string().min(1),
      })
      .strict(),
    resolutionMapping: {
      discriminator: 'decision',
      cases: {
        approved: {
          'review.approved@1': true,
          'review.changes_requested@1': false,
        },
        changes_requested: {
          'review.approved@1': false,
          'review.changes_requested@1': true,
        },
      },
    },
    artifactContracts: ['pull-request-review'],
    description: 'Wait for a human review decision or actionable PR comments.',
  },
  {
    id: 'operator_guidance',
    version: '1',
    stage: { id: 'attention', label: 'Needs attention' },
    resolutionSchema: z
      .object({
        decision: z.literal('resume'),
        guidance: z.string().trim().min(1),
      })
      .strict(),
    description: 'Pause an exhausted bounded loop for explicit operator correction.',
  },
  {
    id: 'ci_retry',
    version: '1',
    stage: { id: 'delivery', label: 'Deliver' },
    resolutionSchema: z
      .object({
        decision: z.literal('resume'),
        guidance: z.string().trim().min(1).optional(),
      })
      .strict(),
    description: 'Wait until a likely-flaky exact-revision CI build has been retried.',
  },
  {
    id: 'ci_infrastructure',
    version: '1',
    stage: { id: 'delivery', label: 'Deliver' },
    resolutionSchema: z
      .object({
        decision: z.literal('resume'),
        guidance: z.string().trim().min(1).optional(),
      })
      .strict(),
    description: 'Wait until the reported CI infrastructure problem has been corrected.',
  },
  {
    id: 'ci_unknown',
    version: '1',
    stage: { id: 'attention', label: 'Needs attention' },
    resolutionSchema: z
      .object({
        decision: z.literal('resume'),
        guidance: z.string().trim().min(1).optional(),
      })
      .strict(),
    description: 'Pause an unclassified CI failure for an operator decision.',
  },
  {
    id: 'translation_complete',
    version: '1',
    stage: { id: 'implementation', label: 'Implement' },
    resolutionSchema: z.object({ translationRevision: z.string().min(1) }).strict(),
    description: 'Wait for the translator to finish external work.',
  },
  {
    id: 'final_publish',
    version: '1',
    stage: { id: 'delivery', label: 'Deliver' },
    resolutionSchema: z.object({ version: z.string().min(1) }).strict(),
    description: 'Wait for a human-owned final package publication.',
  },
] satisfies readonly WaitContract[];

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

  const predicates = createPredicateRegistry(predicateContracts);
  for (const definition of definitions) {
    const mappings = definition.contract.outputPredicates;
    if (mappings === undefined) continue;
    for (const reference of [
      ...Object.values(mappings.cases).flatMap((facts) => Object.keys(facts)),
      ...Object.keys(mappings.defaultFacts ?? {}),
    ]) {
      if (!predicates.has(reference)) {
        throw new Error(
          `Harness step ${definition.reference} maps output to unknown predicate ${reference}`,
        );
      }
    }
  }

  return Object.freeze({
    predicates,
    stepTypes: createStepTypeRegistry(definitions.map(({ contract }) => contract)),
    waits: createWaitRegistry(waitContracts),
  });
};

const defaultPack = getHarnessPack();

export const M1_WORKFLOW_CONTRACTS = createHarnessWorkflowContracts(defaultPack.steps);

const stepSources = new Map(
  defaultPack.steps.map((definition) => [definition.reference, definition]),
);

export const getHarnessStepDefinition = (reference: string): LoadedHarnessStep | undefined =>
  stepSources.get(reference);
