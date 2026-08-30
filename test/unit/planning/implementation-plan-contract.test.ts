import { describe, expect, it } from 'vitest';

import {
  ReadyImplementationPlanningDecisionSchema,
  validateAcceptanceVerificationLinks,
} from '../../../src/planning/index.js';
import { SemanticWorkflowSourceSchema } from '../../../src/workflow/index.js';

const workflowSource = SemanticWorkflowSourceSchema.parse({
  schemaVersion: 1,
  id: 'payment-spacing-repair',
  version: 1,
  root: {
    kind: 'sequence',
    id: 'delivery',
    children: [
      {
        kind: 'step',
        id: 'verify-change',
        uses: 'verify.acceptance@1',
        with: {
          objective: 'Verify the repair',
          repository: 'onetwotrip/front-avia',
          taskId: 'AVIA-12045',
        },
      },
    ],
  },
});

const decision = {
  status: 'ready',
  executionStrategy: 'simple',
  plan: {
    schemaVersion: 2,
    title: 'Repair payment spacing',
    summary: 'Preserve the expected payment layout.',
    steps: [
      {
        id: 'repair-spacing',
        title: 'Repair spacing',
        objective: 'Restore the intended spacing above the payment button.',
        repository: 'onetwotrip/front-avia',
        files: ['src/pages/FlightsPay'],
        verification: ['Run the targeted payment-page check.'],
      },
    ],
    assumptions: [],
    risks: [],
    acceptanceCriteria: [
      {
        id: 'payment-spacing-restored',
        expected: 'The payment button has the intended vertical separation.',
        verification: [
          {
            kind: 'runtime_evidence',
            scenario: 'Repeat the investigated payment-page scenario after the repair.',
            evidence: ['video'],
            workflowStepIds: ['verify-change'],
          },
        ],
      },
    ],
  },
  archetype: 'deliver-pr',
  segments: [],
  verification: {
    checks: ['Repeat the investigated scenario.'],
    profile: 'targeted',
    rationale: 'The change is bounded to the payment page.',
  },
  rationale: 'deliver-pr is sufficient because no dependency or translation segment is required.',
} as const;

describe('implementation plan acceptance contract', () => {
  it('accepts a criterion whose verification is performed by a workflow step', () => {
    const parsed = ReadyImplementationPlanningDecisionSchema.parse(decision);

    expect(parsed.plan.acceptanceCriteria[0]?.verification[0]).toMatchObject({
      kind: 'runtime_evidence',
      workflowStepIds: ['verify-change'],
    });
  });

  it('rejects a criterion whose declared verification is absent from the workflow', () => {
    const candidate = ReadyImplementationPlanningDecisionSchema.parse({
      ...decision,
      plan: {
        ...decision.plan,
        acceptanceCriteria: [
          {
            ...decision.plan.acceptanceCriteria[0],
            verification: [
              {
                ...decision.plan.acceptanceCriteria[0].verification[0],
                workflowStepIds: ['missing-validation-step'],
              },
            ],
          },
        ],
      },
    });

    expect(validateAcceptanceVerificationLinks(candidate, workflowSource)).toEqual([
      'Acceptance criterion payment-spacing-restored references missing workflow step missing-validation-step.',
    ]);
  });

  it('rejects duplicate acceptance criterion ids while using the explicit workflow source', () => {
    const candidate = ReadyImplementationPlanningDecisionSchema.parse({
      ...decision,
      plan: {
        ...decision.plan,
        acceptanceCriteria: [
          ...decision.plan.acceptanceCriteria,
          {
            ...decision.plan.acceptanceCriteria[0],
            expected: 'The same criterion id appears twice.',
          },
        ],
      },
    });

    expect(validateAcceptanceVerificationLinks(candidate, workflowSource)).toEqual([
      'Duplicate acceptance criterion id payment-spacing-restored.',
    ]);
  });

  it('rejects the obsolete string-criterion plan instead of upcasting it', () => {
    const result = ReadyImplementationPlanningDecisionSchema.safeParse({
      ...decision,
      plan: {
        ...decision.plan,
        schemaVersion: 1,
        acceptanceCriteria: ['The payment spacing is restored.'],
      },
    });

    expect(result.success).toBe(false);
  });

  it('rejects duplicate segment selections instead of deduplicating them', () => {
    const result = ReadyImplementationPlanningDecisionSchema.safeParse({
      ...decision,
      segments: ['translations', 'translations'],
    });

    expect(result.success).toBe(false);
  });
});
