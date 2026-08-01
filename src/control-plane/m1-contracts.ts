import { z } from 'zod';

import { JsonValueSchema } from '../workflow/schema.js';

export const M1_VIEW_SCHEMA_VERSION = 1;

export const FixtureFamilySchema = z.enum([
  'short_bugfix',
  'feature_with_review',
  'translation_cross_repo',
  'invalid_workflow',
]);

export const FixtureSummarySchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    family: FixtureFamilySchema,
    purpose: z.string().min(1),
  })
  .strict();

export const WorkflowValidationIssueViewSchema = z
  .object({
    code: z.string().min(1),
    message: z.string().min(1),
    path: z.array(z.union([z.string(), z.number()])),
    details: JsonValueSchema.optional(),
  })
  .strict();

export const GraphDiffEntrySchema = z
  .object({
    kind: z.enum(['added', 'changed', 'removed']),
    path: z.string().min(1),
    before: JsonValueSchema.optional(),
    after: JsonValueSchema.optional(),
  })
  .strict();

export const WorkflowTreeNodeSchema: z.ZodType<{
  readonly id: string;
  readonly kind: string;
  readonly label: string;
  readonly status: 'planned';
  readonly retryBudget: number | null;
  readonly waitKind?: string | undefined;
  readonly slotPolicy?: 'release' | 'retain' | undefined;
  readonly children: readonly z.infer<typeof WorkflowTreeNodeSchema>[];
}> = z.lazy(() =>
  z
    .object({
      id: z.string().min(1),
      kind: z.string().min(1),
      label: z.string().min(1),
      status: z.literal('planned'),
      retryBudget: z.number().int().nonnegative().nullable(),
      waitKind: z.string().min(1).optional(),
      slotPolicy: z.enum(['release', 'retain']).optional(),
      children: z.array(WorkflowTreeNodeSchema),
    })
    .strict(),
);

export const WorkflowViewSchema = z
  .object({
    schemaVersion: z.literal(M1_VIEW_SCHEMA_VERSION),
    fixture: FixtureSummarySchema,
    intake: z
      .object({
        id: z.string().min(1),
        status: z.enum(['accepted', 'rejected']),
        eligibility: z
          .object({
            eligible: z.boolean(),
            reason: z.string().min(1),
          })
          .strict(),
      })
      .strict(),
    task: z
      .object({
        id: z.string().min(1),
        status: z.enum(['planned', 'workflow_rejected']),
      })
      .strict(),
    workflow: z
      .object({
        proposalId: z.string().min(1),
        templateId: z.string().min(1),
        status: z.enum(['valid', 'rejected']),
        graphHash: z.string().min(1).nullable(),
        graph: JsonValueSchema.nullable(),
        tree: WorkflowTreeNodeSchema.nullable(),
        validatorReport: z
          .object({
            workflowId: z.string().min(1).optional(),
            issues: z.array(WorkflowValidationIssueViewSchema),
          })
          .strict(),
        diff: z.array(GraphDiffEntrySchema),
        capabilities: z
          .object({
            available: z.array(z.string().min(1)),
            required: z.array(z.string().min(1)),
          })
          .strict(),
        retryBudgets: z.record(z.string(), z.number().int().nonnegative()),
        waits: z.array(
          z
            .object({
              nodeId: z.string().min(1),
              waitKind: z.string().min(1),
              slotPolicy: z.enum(['release', 'retain']),
            })
            .strict(),
        ),
        expectedArtifacts: z.array(z.string().min(1)),
        verificationPlan: z
          .object({
            profile: z.enum(['build_only', 'targeted_tests', 'full_suite', 'visual_compare']),
            rationale: z.string().min(1),
          })
          .strict(),
        executable: z.literal(false),
      })
      .strict(),
    persistedAt: z.iso.datetime(),
  })
  .strict();

export const FixtureListResponseSchema = z
  .object({
    fixtures: z.array(FixtureSummarySchema),
  })
  .strict();

export const WorkflowResponseSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ready'), view: WorkflowViewSchema }).strict(),
  z.object({ status: z.literal('rejected'), view: WorkflowViewSchema }).strict(),
]);

export const ApiErrorResponseSchema = z
  .object({
    error: z.string().min(1),
    message: z.string().min(1),
  })
  .strict();

export type FixtureFamily = z.infer<typeof FixtureFamilySchema>;
export type FixtureSummary = z.infer<typeof FixtureSummarySchema>;
export type WorkflowTreeNode = z.infer<typeof WorkflowTreeNodeSchema>;
export type WorkflowView = z.infer<typeof WorkflowViewSchema>;
export type WorkflowResponse = z.infer<typeof WorkflowResponseSchema>;
