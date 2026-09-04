import { z } from 'zod';

import {
  HarnessProductManifestSchema,
  type HarnessStepManifest,
  type HarnessStepSource,
} from './contracts.js';
import { ValidationProfileSchema } from '../graph/archetypes/index.js';
import { ResearchDocumentReviewOutputSchema } from '../shared/research-document-review.js';
import { RetrospectiveAnalyzerOutputSchema } from '../shared/retrospective.js';

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

const RuntimeObservationEvidenceKindSchema = z.enum(['image', 'video', 'log', 'structured_output']);

export const runtimeObservationInputSchema = taskInputSchema
  .extend({
    claim: z.string().min(1),
    scenario: z.string().min(1),
    requestedEvidence: z.array(RuntimeObservationEvidenceKindSchema).min(1).max(4),
  })
  .superRefine((value, context) => {
    if (new Set(value.requestedEvidence).size !== value.requestedEvidence.length) {
      context.addIssue({ code: 'custom', message: 'Requested evidence kinds must be unique' });
    }
  });

export const validationInputSchema = z.object({ profile: ValidationProfileSchema }).strict();

export const processInputSchema = z
  .object({
    repository: z.string().min(1),
    taskId: z.string().min(1),
  })
  .strict();

const DependencyChannelSchema = z.enum(['dev', 'final']);
const ResearchOpenQuestionSchema = z
  .object({
    addressee: z.string().min(1),
    question: z.string().min(1),
  })
  .strict();
const ResearchLocalIdSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u, 'Expected a kebab-case localId');
const JiraIssueKeySchema = z.string().regex(/^[A-Z][A-Z0-9_]*-\d+$/u);
const ResearchTaskReferenceSchema = z.union([ResearchLocalIdSchema, JiraIssueKeySchema]);
const ResearchProposedTaskSchema = z
  .object({
    localId: ResearchLocalIdSchema,
    title: z.string().min(1),
    description: z.string().min(1),
    team: z.enum(['FE', 'BE', 'product']),
    issueType: z.enum(['task', 'bug', 'subtask']).default('task'),
    parent: ResearchTaskReferenceSchema.optional(),
    links: z
      .array(
        z
          .object({
            type: z.enum(['blocks', 'relates']),
            target: ResearchTaskReferenceSchema,
          })
          .strict(),
      )
      .optional(),
  })
  .strict();
const ResearchReviewEditSchema = z
  .object({
    section: z.string().min(1),
    change: z.string().min(1),
  })
  .strict();

export const researchInputSchema = taskInputSchema
  .extend({
    questions: z.array(z.string().min(1)).min(1).max(10),
    product: HarnessProductManifestSchema,
    repositoryReference: z.string().min(1).optional(),
    operatorBrief: z.string().max(10_000).nullable().default(null),
  })
  .strict();

const DependencyPackageNameSchema = z
  .string()
  .trim()
  .min(1)
  .regex(/^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/u);

const uniquePackageNames = (packages: readonly string[], context: z.RefinementCtx): void => {
  if (new Set(packages).size !== packages.length) {
    context.addIssue({ code: 'custom', message: 'Dependency package names must be unique' });
  }
};

export const dependencyWaitInputSchema = taskInputSchema
  .extend({
    declarationId: z.string().min(1),
    declarationRevision: z.number().int().positive(),
    channel: DependencyChannelSchema,
    packages: z.array(DependencyPackageNameSchema).min(1),
    afterObservationId: z.string().min(1).optional(),
  })
  .superRefine((value, context) => {
    uniquePackageNames(value.packages, context);
  });

export const dependencyConsumeInputSchema = taskInputSchema.extend({
  declarationId: z.string().min(1),
  declarationRevision: z.number().int().positive(),
  channel: DependencyChannelSchema,
});

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

const RuntimeObservationEvidenceSchema = z.discriminatedUnion('kind', [
  ...ReproductionEvidenceSchema.options,
  z
    .object({
      kind: z.literal('structured_output'),
      path: ArtifactRelativePathSchema,
      mimeType: z.literal('application/json'),
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

export const researchInvestigationOutputSchema = z
  .object({
    findings: z
      .array(
        z
          .object({
            statement: z.string().min(1),
            sources: z.array(z.string().min(1)).min(1),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

export const researchDraftOutputSchema = z
  .object({
    documentStorageHtml: z.string().min(1),
    proposedTasks: z
      .array(ResearchProposedTaskSchema)
      .min(1)
      .superRefine((tasks, context) => {
        if (new Set(tasks.map(({ title }) => title)).size !== tasks.length) {
          context.addIssue({ code: 'custom', message: 'Proposed task titles must be unique' });
        }
        const localIds = tasks.map(({ localId }) => localId);
        if (new Set(localIds).size !== localIds.length) {
          context.addIssue({ code: 'custom', message: 'Proposed task localIds must be unique' });
        }
        const localIdSet = new Set(localIds);
        const jiraKeyPattern = /^[A-Z][A-Z0-9_]*-\d+$/u;
        for (const [index, task] of tasks.entries()) {
          if (task.issueType === 'subtask' && !task.parent) {
            context.addIssue({
              code: 'custom',
              path: [index, 'parent'],
              message: 'Subtasks must specify a parent',
            });
          }
          if (task.issueType !== 'subtask' && task.parent) {
            context.addIssue({
              code: 'custom',
              path: [index, 'parent'],
              message: 'Only subtasks may specify a parent',
            });
          }
          if (task.parent && !localIdSet.has(task.parent) && !jiraKeyPattern.test(task.parent)) {
            context.addIssue({
              code: 'custom',
              path: [index, 'parent'],
              message: 'Parent must reference a proposed localId or Jira issue key',
            });
          }
          for (const [linkIndex, link] of (task.links ?? []).entries()) {
            if (!localIdSet.has(link.target) && !jiraKeyPattern.test(link.target)) {
              context.addIssue({
                code: 'custom',
                path: [index, 'links', linkIndex, 'target'],
                message: 'Link target must reference a proposed localId or Jira issue key',
              });
            }
          }
        }
      }),
    openQuestions: z.array(ResearchOpenQuestionSchema),
  })
  .strict();

export const researchReviewOutputSchema = z.discriminatedUnion('decision', [
  z
    .object({
      decision: z.literal('accepted'),
      concreteEdits: z.array(z.never()).length(0),
    })
    .strict(),
  z
    .object({
      decision: z.literal('changes_requested'),
      concreteEdits: z.array(ResearchReviewEditSchema).min(1),
    })
    .strict(),
]);

export const researchDocumentReviewOutputSchema = ResearchDocumentReviewOutputSchema;

export const researchPublicationOutputSchema = z
  .object({
    pageId: z.string().min(1),
    pageUrl: z.url(),
  })
  .strict();

export const researchTaskFilingOutputSchema = z
  .object({
    issueKeys: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*-\d+$/u)).min(1),
    pageVersion: z.number().int().positive(),
  })
  .strict();

const RuntimeObservationOutputBaseSchema = z
  .object({
    summary: z.string().min(1),
    claim: z.string().min(1),
    scenario: z.string().min(1),
    observations: z.array(z.string().min(1)).min(1).max(50),
    evidence: z.array(RuntimeObservationEvidenceSchema).max(30),
  })
  .strict();

export const runtimeObservationOutputSchema = z.discriminatedUnion('outcome', [
  RuntimeObservationOutputBaseSchema.extend({
    outcome: z.literal('observed'),
    evidence: z.array(RuntimeObservationEvidenceSchema).min(1).max(30),
  }).strict(),
  RuntimeObservationOutputBaseSchema.extend({
    outcome: z.literal('not_observed'),
    evidence: z.array(RuntimeObservationEvidenceSchema).min(1).max(30),
  }).strict(),
  RuntimeObservationOutputBaseSchema.extend({
    outcome: z.literal('inconclusive'),
  }).strict(),
]);

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

export const dependencyPublicationOutputSchema = z
  .object({
    outcome: z.literal('verified'),
    observationId: z.string().min(1),
    declarationId: z.string().min(1),
    declarationRevision: z.number().int().positive(),
    channel: DependencyChannelSchema,
    packages: z
      .array(
        z
          .object({
            name: DependencyPackageNameSchema,
            version: z.string().min(1),
            registry: z.url(),
            tarballUrl: z.url(),
            integrity: z.string().min(1),
          })
          .strict(),
      )
      .min(1),
  })
  .strict()
  .superRefine((value, context) => {
    uniquePackageNames(
      value.packages.map(({ name }) => name),
      context,
    );
  });

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

export const deliveryOutputSchema = pullRequestOutputSchema
  .extend({
    outcome: z.enum(['accepted', 'repair_required']),
    ci: ciObservationOutputSchema,
    repair: z
      .discriminatedUnion('kind', [
        z
          .object({
            kind: z.literal('ci'),
            summary: z.string().min(1),
          })
          .strict(),
        z
          .object({
            kind: z.literal('human_review'),
            reviewId: z.string().min(1),
            summary: z.string().min(1),
          })
          .strict(),
      ])
      .nullable(),
  })
  .superRefine((value, context) => {
    if (value.outcome === 'accepted' && value.repair !== null) {
      context.addIssue({
        code: 'custom',
        path: ['repair'],
        message: 'Accepted delivery has no repair',
      });
    }
    if (value.outcome === 'repair_required' && value.repair === null) {
      context.addIssue({
        code: 'custom',
        path: ['repair'],
        message: 'Repair-required delivery must describe the repair input',
      });
    }
  });

const contractSchemas = {
  agent_output: agentOutputSchema,
  agent_review_output: agentReviewOutputSchema,
  ci_observation_output: ciObservationOutputSchema,
  delivery_output: deliveryOutputSchema,
  dependency_consume_input: dependencyConsumeInputSchema,
  dependency_publication_output: dependencyPublicationOutputSchema,
  dependency_wait_input: dependencyWaitInputSchema,
  integration_output: integrationOutputSchema,
  runtime_observation_input: runtimeObservationInputSchema,
  runtime_observation_output: runtimeObservationOutputSchema,
  validation_input: validationInputSchema,
  process_input: processInputSchema,
  process_output: processOutputSchema,
  pull_request_input: pullRequestInputSchema,
  pull_request_output: pullRequestOutputSchema,
  research_draft_output: researchDraftOutputSchema,
  research_document_review_output: researchDocumentReviewOutputSchema,
  research_input: researchInputSchema,
  research_investigation_output: researchInvestigationOutputSchema,
  research_publication_output: researchPublicationOutputSchema,
  research_review_output: researchReviewOutputSchema,
  research_task_filing_output: researchTaskFilingOutputSchema,
  reproduction_input: reproductionInputSchema,
  reproduction_output: reproductionOutputSchema,
  task_input: taskInputSchema,
  retrospective_analyze_output: RetrospectiveAnalyzerOutputSchema,
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
