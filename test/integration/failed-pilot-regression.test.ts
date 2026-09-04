import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

const PilotRegressionFixtureSchema = z
  .object({
    schemaVersion: z.literal(1),
    caseId: z.literal('simple-bug-expanded-recovery'),
    taskClass: z.literal('simple_frontend_bug'),
    observed: z
      .object({
        semanticIntent: z.array(z.string().min(1)),
        compiledGraph: z
          .object({
            nodes: z.number().int().positive(),
            steps: z.number().int().positive(),
            loops: z.number().int().positive(),
            waits: z.number().int().positive(),
            branches: z.number().int().positive(),
          })
          .strict(),
        validation: z
          .object({
            transportStatus: z.literal('succeeded'),
            domainPassed: z.literal(false),
            domainFailed: z.literal(true),
            projectedStageStatus: z.literal('succeeded'),
            nextMaterializedWork: z.literal('validation_repair'),
          })
          .strict(),
        qualityOrder: z.array(z.string().min(1)),
        usage: z
          .object({
            initialPlanningTokens: z.number().int().nonnegative(),
            investigationTokens: z.number().int().nonnegative(),
            finalPlanningTokens: z.number().int().nonnegative(),
            implementationTokens: z.number().int().nonnegative(),
            validationRepairTokens: z.number().int().nonnegative(),
            agentReviewTokens: z.number().int().nonnegative(),
            totalTokens: z.number().int().positive(),
          })
          .strict(),
      })
      .strict(),
    requiredCutover: z
      .object({
        maximumSimpleSemanticNodes: z.number().int().positive(),
        maximumInitialDevelopmentLoops: z.number().int().positive(),
        validationDomainStatus: z.literal('failed'),
        causalNextWork: z.literal('development_loop_attempt'),
        completedAttemptTranscriptAddressable: z.literal(true),
        agentAuthoredEvidencePaths: z.literal(false),
        readOnlyInvestigationWorkspace: z.literal(true),
      })
      .strict(),
  })
  .strict();

const fixturePath = fileURLToPath(
  new URL('../fixtures/simple-bug-expanded-recovery.json', import.meta.url),
);

describe('failed pilot regression evidence', () => {
  it('preserves the structural failure without company task content', () => {
    const source = readFileSync(fixturePath, 'utf8');
    const fixture = PilotRegressionFixtureSchema.parse(JSON.parse(source) as unknown);

    expect(source).not.toMatch(/AVIA-|jira\.twiket|\/Users\//u);
    expect(fixture.observed.compiledGraph).toEqual({
      nodes: 114,
      steps: 62,
      loops: 15,
      waits: 8,
      branches: 6,
    });
    expect(fixture.observed.validation).toMatchObject({
      transportStatus: 'succeeded',
      domainPassed: false,
      projectedStageStatus: 'succeeded',
      nextMaterializedWork: 'validation_repair',
    });
    expect(fixture.observed.qualityOrder).toEqual([
      'implement',
      'project_validation',
      'agent_review',
      'post_fix_evidence',
    ]);
  });

  it('keeps the measured token total internally consistent', () => {
    const fixture = PilotRegressionFixtureSchema.parse(
      JSON.parse(readFileSync(fixturePath, 'utf8')) as unknown,
    );
    const usage = fixture.observed.usage;

    expect(
      usage.initialPlanningTokens +
        usage.investigationTokens +
        usage.finalPlanningTokens +
        usage.implementationTokens +
        usage.validationRepairTokens +
        usage.agentReviewTokens,
    ).toBe(usage.totalTokens);
  });
});
