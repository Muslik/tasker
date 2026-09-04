import { describe, expect, it } from 'vitest';

import {
  ReadyDeliverPrImplementationPlanningDecisionSchema,
  ReadyResearchImplementationPlanningDecisionSchema,
  ReadyImplementationPlanningDecisionSchema,
  validateAcceptanceVerificationLinks,
} from './index.js';
import { SemanticWorkflowSourceSchema } from '../graph/index.js';

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
        id: 'run-validation',
        uses: 'validation.run@1',
        with: { profile: 'targeted' },
      },
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

const researchWorkflowSource = SemanticWorkflowSourceSchema.parse({
  schemaVersion: 1,
  id: 'research-package',
  version: 1,
  root: {
    kind: 'sequence',
    id: 'task-work',
    children: [
      {
        kind: 'step',
        id: 'investigate-research',
        uses: 'research.investigate@1',
        with: {},
      },
      {
        kind: 'bounded_loop',
        id: 'review-feedback',
        maxAttempts: 3,
        until: 'research.document_approved@1',
        body: {
          kind: 'sequence',
          id: 'review-attempt',
          children: [
            {
              kind: 'step',
              id: 'draft-research',
              uses: 'research.draft@1',
              with: {},
            },
            {
              kind: 'step',
              id: 'review-research',
              uses: 'research.review@1',
              with: {},
            },
            {
              kind: 'step',
              id: 'document-review-research',
              uses: 'research.document-review@1',
              with: {},
            },
          ],
        },
      },
      {
        kind: 'step',
        id: 'publish-research',
        uses: 'research.publish@1',
        with: {},
      },
      {
        kind: 'step',
        id: 'file-research-tasks',
        uses: 'research.file-tasks@1',
        with: {},
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
    validationProfile: 'targeted',
    rationale: 'The change is bounded to the payment page.',
  },
  rationale: 'deliver-pr is sufficient because no dependency or translation segment is required.',
} as const;

describe('implementation plan acceptance contract', () => {
  it('accepts a criterion whose verification is performed by a workflow step', () => {
    const parsed = ReadyDeliverPrImplementationPlanningDecisionSchema.parse(decision);

    expect(parsed.plan.acceptanceCriteria[0]?.verification[0]).toMatchObject({
      kind: 'runtime_evidence',
      workflowStepIds: ['verify-change'],
    });
  });

  it('rejects a criterion whose declared verification is absent from the workflow', () => {
    const candidate = ReadyDeliverPrImplementationPlanningDecisionSchema.parse({
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
    const candidate = ReadyDeliverPrImplementationPlanningDecisionSchema.parse({
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

  it('defaults an omitted validation profile to targeted', () => {
    const parsed = ReadyDeliverPrImplementationPlanningDecisionSchema.parse({
      ...decision,
      verification: {
        checks: ['Repeat the investigated scenario.'],
        profile: 'targeted',
        rationale: 'The change is bounded to the payment page.',
      },
    });

    expect(parsed.verification.validationProfile).toBe('targeted');
  });

  it('accepts each explicit validation profile', () => {
    expect(
      ['targeted', 'full', 'build'].map(
        (validationProfile) =>
          ReadyDeliverPrImplementationPlanningDecisionSchema.parse({
            ...decision,
            verification: {
              ...decision.verification,
              validationProfile,
            },
          }).verification.validationProfile,
      ),
    ).toEqual(['targeted', 'full', 'build']);
  });

  it('rejects an unknown validation profile', () => {
    const result = ReadyImplementationPlanningDecisionSchema.safeParse({
      ...decision,
      verification: {
        ...decision.verification,
        validationProfile: 'smoke',
      },
    });

    expect(result.success).toBe(false);
  });

  it('rejects process verification owned by the acceptance judge', () => {
    const candidate = ReadyDeliverPrImplementationPlanningDecisionSchema.parse({
      ...decision,
      plan: {
        ...decision.plan,
        acceptanceCriteria: [
          {
            id: 'validation-passes',
            expected: 'The project validation profile passes.',
            verification: [
              {
                kind: 'process',
                profile: 'targeted',
                scenario: 'Run deterministic project validation.',
                workflowStepIds: ['verify-change'],
              },
            ],
          },
        ],
      },
    });

    expect(validateAcceptanceVerificationLinks(candidate, workflowSource)).toContain(
      'Acceptance criterion validation-passes process verification must reference only run-validation.',
    );
  });

  it('rejects a process profile that differs from the verification slot', () => {
    const candidate = ReadyDeliverPrImplementationPlanningDecisionSchema.parse({
      ...decision,
      plan: {
        ...decision.plan,
        acceptanceCriteria: [
          {
            id: 'validation-passes',
            expected: 'The project validation profile passes.',
            verification: [
              {
                kind: 'process',
                profile: 'full',
                scenario: 'Run deterministic project validation.',
                workflowStepIds: ['run-validation'],
              },
            ],
          },
        ],
      },
    });

    expect(validateAcceptanceVerificationLinks(candidate, workflowSource)).toContain(
      'Acceptance criterion validation-passes process profile full does not match validation profile targeted.',
    );
  });

  it('accepts a research decision without a validation profile', () => {
    const parsed = ReadyResearchImplementationPlanningDecisionSchema.parse({
      status: 'ready',
      executionStrategy: 'simple',
      plan: {
        schemaVersion: 2,
        title: 'Prepare research',
        summary: 'Investigate, draft, review, publish, and file follow-up tasks.',
        steps: [
          {
            id: 'prepare-research',
            title: 'Prepare research',
            objective: 'Ground the package in current evidence.',
            repository: 'onetwotrip/front-avia',
            files: ['src', 'docs'],
            verification: ['Publish the approved package and proposed tasks.'],
          },
        ],
        assumptions: [],
        risks: [],
        acceptanceCriteria: [
          {
            id: 'research-published',
            expected: 'The approved research package is published.',
            verification: [
              {
                kind: 'inspection',
                target: 'published package',
                expectation: 'The published page and proposed tasks are present.',
                workflowStepIds: ['publish-research', 'file-research-tasks'],
              },
            ],
          },
        ],
      },
      archetype: 'research',
      segments: [],
      verification: {
        checks: ['Review accepts the draft and the publication package is complete.'],
        profile: 'research',
        rationale: 'Research uses review and publication instead of project validation commands.',
      },
      questions: [
        'Which current constraints and open decisions must the research package resolve?',
      ],
      rationale: 'research matches the document-first workflow.',
    });

    expect(parsed.verification).not.toHaveProperty('validationProfile');
    expect(validateAcceptanceVerificationLinks(parsed, researchWorkflowSource)).toEqual([]);
  });

  it('rejects missing research workflow steps through the shared link validator', () => {
    const candidate = ReadyResearchImplementationPlanningDecisionSchema.parse({
      status: 'ready',
      executionStrategy: 'simple',
      plan: {
        schemaVersion: 2,
        title: 'Prepare research',
        summary: 'Investigate, draft, review, publish, and file follow-up tasks.',
        steps: [
          {
            id: 'prepare-research',
            title: 'Prepare research',
            objective: 'Ground the package in current evidence.',
            repository: 'onetwotrip/front-avia',
            files: ['src', 'docs'],
            verification: ['Publish the approved package and proposed tasks.'],
          },
        ],
        assumptions: [],
        risks: [],
        acceptanceCriteria: [
          {
            id: 'research-published',
            expected: 'The approved research package is published.',
            verification: [
              {
                kind: 'inspection',
                target: 'published package',
                expectation: 'The published page and proposed tasks are present.',
                workflowStepIds: ['missing-research-step'],
              },
            ],
          },
        ],
      },
      archetype: 'research',
      segments: [],
      verification: {
        checks: ['Review accepts the draft and the publication package is complete.'],
        profile: 'research',
        rationale: 'Research uses review and publication instead of project validation commands.',
      },
      questions: [
        'Which current constraints and open decisions must the research package resolve?',
      ],
      rationale: 'research matches the document-first workflow.',
    });

    expect(validateAcceptanceVerificationLinks(candidate, researchWorkflowSource)).toEqual([
      'Acceptance criterion research-published references missing workflow step missing-research-step.',
    ]);
  });
});
