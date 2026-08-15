import { z } from 'zod';

import { BlockDefinitionSchema } from '../blocks/contracts.js';
import {
  HarnessCompanyManifestSchema,
  HarnessPolicyManifestSchema,
  HarnessProjectManifestSchema,
  ProcessExecutionPlanSchema,
} from '../harness/contracts.js';
import { ResolvedExecutionProfileSchema } from '../harness/execution-profile-contracts.js';
import { PlanningTaskSnapshotSchema } from './task-snapshot.js';
import type { Outcome } from '../shared/outcome.js';
import { JsonValueSchema, StepActivityDeliverySchema } from '../workflow/schema.js';
import { EvidenceBundleReferenceSchema } from './evidence-bundle.js';

const ContentHashSchema = z.string().regex(/^[a-f0-9]{64}$/u);

export const PlanningSnapshotReferenceSchema = z
  .object({
    artifactId: z.string().min(1),
    checksum: ContentHashSchema,
  })
  .strict()
  .readonly();

const SnapshottedPromptSchema = z
  .object({
    relativePath: z.string().min(1),
    content: z.string().min(1),
    contentSha256: ContentHashSchema,
  })
  .strict();

const SnapshottedStepSchema = z
  .object({
    reference: z.string().min(1),
    block: BlockDefinitionSchema,
    activityDelivery: StepActivityDeliverySchema,
    resolvedProcess: ProcessExecutionPlanSchema.nullable(),
    executionProfile: ResolvedExecutionProfileSchema.nullable(),
  })
  .strict();

const SnapshottedHarnessSchema = z
  .object({
    company: HarnessCompanyManifestSchema,
    project: HarnessProjectManifestSchema.nullable(),
    implementationPlanner: z
      .object({
        prompt: SnapshottedPromptSchema,
        skills: z.array(z.string().min(1)),
        profiles: z
          .object({
            fast: ResolvedExecutionProfileSchema,
            ralplan: ResolvedExecutionProfileSchema,
          })
          .strict(),
      })
      .strict(),
    policies: z.array(HarnessPolicyManifestSchema),
    steps: z.array(SnapshottedStepSchema),
  })
  .strict();

const RunSnapshotBaseSchema = z.object({
  schemaVersion: z.literal(9),
  taskReference: z.string().min(1),
  workflowRunId: z.string().min(1),
  task: PlanningTaskSnapshotSchema,
  taskSnapshot: JsonValueSchema,
  repository: z
    .object({
      workspaceId: z.string().regex(/^[a-f0-9]{24}$/u),
      reference: z.string().min(1),
      path: z.string().min(1),
    })
    .strict(),
  harness: SnapshottedHarnessSchema,
  createdAt: z.iso.datetime(),
});

export const PlanningContextSnapshotSchema = RunSnapshotBaseSchema.extend({
  kind: z.literal('planning_context'),
  contextHash: ContentHashSchema,
})
  .strict()
  .readonly();

export const ExecutionRunSnapshotSchema = RunSnapshotBaseSchema.extend({
  kind: z.literal('execution'),
  workflowHash: ContentHashSchema,
  workflow: JsonValueSchema,
  acceptedPlan: JsonValueSchema,
  evidenceBundle: EvidenceBundleReferenceSchema,
})
  .strict()
  .readonly();

export const RunPlanningSnapshotSchema = z.discriminatedUnion('kind', [
  PlanningContextSnapshotSchema,
  ExecutionRunSnapshotSchema,
]);

export type PlanningSnapshotReference = z.infer<typeof PlanningSnapshotReferenceSchema>;
export type PlanningContextSnapshot = z.infer<typeof PlanningContextSnapshotSchema>;
export type ExecutionRunSnapshot = z.infer<typeof ExecutionRunSnapshotSchema>;
export type RunPlanningSnapshot = z.infer<typeof RunPlanningSnapshotSchema>;

export interface PlanningSnapshotWorkspace {
  readonly workspaceId: string;
  readonly reference: string;
  readonly path: string;
}

export interface PlanningSnapshotSource {
  createPlanningContextSnapshot(
    taskReference: string,
    workflowRunId: string,
    workspace: PlanningSnapshotWorkspace,
  ): Outcome<
    { readonly reference: PlanningSnapshotReference; readonly contextHash: string },
    { readonly kind: string }
  >;
}
