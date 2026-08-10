import { describe, expect, it } from 'vitest';

import {
  ReadyImplementationPlanningDecisionSchema,
  validateAcceptanceVerificationLinks,
} from '../../../src/planning/index.js';

const decision = {
  status: 'ready',
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
            workflowStepIds: ['validate-fixed-spacing'],
          },
        ],
      },
    ],
  },
  followUps: [],
  workflow: {
    assemblyDecisions: [
      {
        id: 'verify-spacing',
        title: 'Verify repaired spacing',
        source: 'bug investigation',
        reason: 'The reported behavior was reproduced.',
        effect: 'Repeat the same scenario after implementation.',
      },
    ],
    source: {
      id: 'payment-spacing-repair',
      version: 1,
      root: {
        kind: 'sequence',
        id: 'delivery',
        children: [
          {
            kind: 'step',
            id: 'validate-fixed-spacing',
            uses: 'bug.validate_fix@1',
            with: {
              objective: 'Verify the repair',
              repository: 'onetwotrip/front-avia',
              taskId: 'AVIA-12045',
              phase: 'after',
            },
          },
          { kind: 'finalize', id: 'finished', outcome: 'accepted' },
        ],
      },
    },
    verificationPlan: {
      checks: ['Repeat the investigated scenario.'],
      profile: 'targeted',
      rationale: 'The change is bounded to the payment page.',
    },
  },
} as const;

describe('implementation plan acceptance contract', () => {
  it('accepts a criterion whose verification is performed by a workflow step', () => {
    const parsed = ReadyImplementationPlanningDecisionSchema.parse(decision);

    expect(parsed.plan.acceptanceCriteria[0]?.verification[0]).toMatchObject({
      kind: 'runtime_evidence',
      workflowStepIds: ['validate-fixed-spacing'],
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

    expect(validateAcceptanceVerificationLinks(candidate)).toEqual([
      'Acceptance criterion payment-spacing-restored references missing workflow step missing-validation-step.',
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
});
