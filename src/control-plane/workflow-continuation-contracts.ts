import { z } from 'zod';

import { WorkflowChangeRequestSchema } from '../planning/implementation-plan.js';

export const WorkflowContinuationIssueSchema = z
  .object({
    code: z.enum([
      'multiple_repositories_unsupported',
      'repository_catalog_unavailable',
      'repository_not_found',
      'repository_ambiguous',
      'repository_unavailable',
      'candidate_rejected',
      'candidate_matches_parent',
      'repository_not_represented',
      'capability_not_represented',
      'generation_failed',
    ]),
    message: z.string().min(1),
    retryable: z.boolean(),
  })
  .strict();

const WorkflowContinuationSourceSchema = z
  .object({
    kind: z.literal('implementation_planning'),
    attempt: z.number().int().positive(),
    artifactId: z.string().min(1),
    request: WorkflowChangeRequestSchema,
  })
  .strict();

const WorkflowContinuationParentSchema = z
  .object({
    taskReference: z.string().min(1),
    runId: z.string().min(1),
    workflowId: z.string().min(1),
    graphHash: z.string().min(1),
  })
  .strict();

const WorkflowContinuationCandidateSchema = z
  .object({
    taskReference: z.string().min(1),
    repositoryReference: z.string().min(1),
    workflowId: z.string().min(1),
    graphHash: z.string().min(1),
  })
  .strict();

const WorkflowContinuationChildSchema = z
  .object({
    taskReference: z.string().min(1),
    runId: z.string().min(1),
  })
  .strict();

const WorkflowContinuationRecordBaseSchema = z.object({
  schemaVersion: z.literal(1),
  continuationId: z.string().min(1),
  attempt: z.number().int().positive(),
  parent: WorkflowContinuationParentSchema,
  source: WorkflowContinuationSourceSchema,
  reviewPolicy: z.literal('review_all'),
  createdAt: z.iso.datetime(),
});

export const WorkflowContinuationRecordSchema = z.discriminatedUnion('status', [
  WorkflowContinuationRecordBaseSchema.extend({
    status: z.literal('awaiting_review'),
    candidate: WorkflowContinuationCandidateSchema,
  }).strict(),
  WorkflowContinuationRecordBaseSchema.extend({
    status: z.literal('accepted'),
    candidate: WorkflowContinuationCandidateSchema,
    reviewedAt: z.iso.datetime(),
  }).strict(),
  WorkflowContinuationRecordBaseSchema.extend({
    status: z.literal('linked'),
    candidate: WorkflowContinuationCandidateSchema,
    reviewedAt: z.iso.datetime(),
    linkedAt: z.iso.datetime(),
    child: WorkflowContinuationChildSchema,
  }).strict(),
  WorkflowContinuationRecordBaseSchema.extend({
    status: z.literal('rejected_by_operator'),
    candidate: WorkflowContinuationCandidateSchema,
    reviewedAt: z.iso.datetime(),
    guidance: z.string().min(1).max(10_000),
  }).strict(),
  WorkflowContinuationRecordBaseSchema.extend({
    status: z.literal('superseded_by_plan'),
    candidate: WorkflowContinuationCandidateSchema,
    reviewedAt: z.iso.datetime(),
    guidance: z.string().min(1).max(10_000),
    resolvedAt: z.iso.datetime(),
    implementationPlanArtifactId: z.string().min(1),
  }).strict(),
  WorkflowContinuationRecordBaseSchema.extend({
    status: z.literal('invalid'),
    candidateTaskReference: z.string().min(1).nullable(),
    issues: z.array(WorkflowContinuationIssueSchema).min(1),
  }).strict(),
  WorkflowContinuationRecordBaseSchema.extend({
    status: z.literal('blocked'),
    repositoryReference: z.string().min(1),
    issues: z.array(WorkflowContinuationIssueSchema).min(1),
  }).strict(),
  WorkflowContinuationRecordBaseSchema.extend({
    status: z.literal('failed'),
    issues: z.array(WorkflowContinuationIssueSchema).min(1),
  }).strict(),
]);

export const WorkflowContinuationReviewCommandSchema = z.discriminatedUnion('decision', [
  z.object({ decision: z.literal('accept'), continuationId: z.string().min(1) }).strict(),
  z
    .object({
      decision: z.literal('reject'),
      continuationId: z.string().min(1),
      guidance: z.string().trim().min(1).max(10_000),
    })
    .strict(),
]);

export type WorkflowContinuationIssue = z.infer<typeof WorkflowContinuationIssueSchema>;
export type WorkflowContinuationRecord = z.infer<typeof WorkflowContinuationRecordSchema>;
export type WorkflowContinuationReviewCommand = z.infer<
  typeof WorkflowContinuationReviewCommandSchema
>;
