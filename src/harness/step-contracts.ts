import { z } from 'zod';

import type { HarnessStepManifest, HarnessStepSource } from './contracts.js';

export const taskInputSchema = z
  .object({
    objective: z.string().min(1),
    repository: z.string().min(1),
    taskId: z.string().min(1),
  })
  .strict();

export const reproductionInputSchema = taskInputSchema.extend({
  phase: z.literal('after'),
});

export const investigationInputSchema = taskInputSchema;

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

export const WorkspaceRelativePathSchema = z
  .string()
  .min(1)
  .refine((value) => !value.startsWith('/') && !value.split('/').includes('..'), {
    message: 'Expected a path relative to the managed worktree',
  });

export const ArtifactRelativePathSchema = z
  .string()
  .min(1)
  .refine((value) => !value.startsWith('/') && !value.split('/').includes('..'), {
    message: 'Expected a path relative to the Tasker artifact root',
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

export const agentReviewOutputSchema = z.discriminatedUnion('decision', [
  z
    .object({
      decision: z.literal('accepted'),
      summary: z.string().min(1),
      findings: z.array(z.never()).length(0),
    })
    .strict(),
  z
    .object({
      decision: z.literal('changes_requested'),
      summary: z.string().min(1),
      findings: z
        .array(
          z
            .object({
              title: z.string().min(1),
              description: z.string().min(1),
              severity: z.enum(['blocking', 'important']),
              files: z.array(WorkspaceRelativePathSchema).min(1),
            })
            .strict(),
        )
        .min(1),
    })
    .strict(),
]);

const ReproductionEvidenceSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('video'),
      path: ArtifactRelativePathSchema,
      mimeType: z.string().regex(/^video\/[a-z0-9][a-z0-9.+-]*$/u),
    })
    .strict(),
  z
    .object({
      kind: z.literal('image'),
      path: ArtifactRelativePathSchema,
      mimeType: z.string().regex(/^image\/[a-z0-9][a-z0-9.+-]*$/u),
    })
    .strict(),
  z
    .object({
      kind: z.literal('log'),
      path: ArtifactRelativePathSchema,
      mimeType: z.string().regex(/^(?:text|application)\/[a-z0-9][a-z0-9.+-]*$/u),
    })
    .strict(),
]);

export const reproductionOutputSchema = z
  .object({
    summary: z.string().min(1),
    phase: z.literal('after'),
    outcome: z.literal('verified_fixed'),
    evidence: z.array(ReproductionEvidenceSchema).min(1),
  })
  .strict();

export const investigationOutputSchema = z
  .object({
    summary: z.string().min(1),
    outcome: z.enum(['reproduced', 'not_reproduced', 'inconclusive']),
    observations: z.array(z.string().min(1)).min(1).max(50),
    evidence: z.array(ReproductionEvidenceSchema).max(30),
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

export const pullRequestOutputSchema = z
  .object({
    externalId: z.string().min(1),
    status: z.literal('open'),
    provider: z.string().min(1),
    repository: z.string().min(1),
    sourceBranch: z.string().min(1),
    targetBranch: z.string().min(1),
    url: z.url().nullable(),
  })
  .strict();

export const ciObservationOutputSchema = z
  .object({
    externalId: z.string().min(1),
    status: z.enum([
      'passed',
      'likely_caused_by_change',
      'likely_flaky',
      'infrastructure',
      'unknown',
    ]),
    provider: z.string().min(1),
    build: z
      .object({
        number: z.number().int().nonnegative(),
        url: z.httpUrl(),
        revision: z.string().min(1),
        result: z.string().min(1),
        durationMs: z.number().int().nonnegative(),
      })
      .strict(),
    stages: z.array(
      z
        .object({
          name: z.string().min(1),
          status: z.string().min(1),
        })
        .strict(),
    ),
    failures: z.array(
      z
        .object({
          uid: z.string().min(1),
          name: z.string().min(1),
          status: z.string().min(1),
          message: z.string().nullable(),
          flaky: z.boolean(),
          attachments: z.array(
            z
              .object({
                name: z.string().min(1),
                type: z.string().min(1),
                source: z.string().min(1),
              })
              .strict(),
          ),
        })
        .strict(),
    ),
  })
  .strict();

const contractSchemas = {
  agent_output: agentOutputSchema,
  agent_review_output: agentReviewOutputSchema,
  ci_observation_output: ciObservationOutputSchema,
  integration_output: integrationOutputSchema,
  investigation_input: investigationInputSchema,
  investigation_output: investigationOutputSchema,
  process_input: processInputSchema,
  process_output: processOutputSchema,
  pull_request_input: pullRequestInputSchema,
  pull_request_output: pullRequestOutputSchema,
  reproduction_input: reproductionInputSchema,
  reproduction_output: reproductionOutputSchema,
  task_input: taskInputSchema,
  verification_targeted_input: verificationInputSchema.extend({ profile: z.literal('targeted') }),
  verification_full_input: verificationInputSchema.extend({ profile: z.literal('full') }),
  verification_build_input: verificationInputSchema.extend({ profile: z.literal('build') }),
  verification_visual_input: verificationInputSchema.extend({ profile: z.literal('visual') }),
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

export const stepDefinitionFromManifest = (manifest: HarnessStepManifest): HarnessStepSource => {
  const identity = versionedIdentity(manifest.reference);
  return {
    reference: manifest.reference,
    ...(manifest.policy === undefined ? {} : { policy: manifest.policy }),
    description: manifest.description,
    stage: manifest.stage,
    availableDuring: manifest.availableDuring,
    inputContract: manifest.inputContract,
    outputContract: manifest.outputContract,
    executor: manifest.executor,
    outcomes: manifest.outcomes,
    completion: manifest.completion,
    contract: {
      ...identity,
      inputSchema: contractSchemas[manifest.inputContract],
      outputSchema: contractSchemas[manifest.outputContract],
      ...(manifest.outputPredicates === undefined
        ? {}
        : { outputPredicates: manifest.outputPredicates }),
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
