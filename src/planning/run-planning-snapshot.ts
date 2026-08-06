import { z } from 'zod';

import {
  HarnessCompanyManifestSchema,
  HarnessPolicyManifestSchema,
  HarnessProjectManifestSchema,
  WorkspaceRuntimeSchema,
} from '../harness/contracts.js';
import { TaskFixtureSchema } from './fixtures.js';
import type { Outcome } from '../shared/outcome.js';
import { JsonValueSchema } from '../workflow/schema.js';
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

const SnapshottedExecutionSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('agent'),
      skills: z.array(z.string().min(1)),
      prompt: SnapshottedPromptSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('process'),
      executor: z.string().min(1),
      command: z.string().min(1),
    })
    .strict(),
  z.object({ kind: z.literal('integration'), adapter: z.string().min(1) }).strict(),
]);

const SnapshottedStepSchema = z
  .object({
    reference: z.string().min(1),
    execution: SnapshottedExecutionSchema,
  })
  .strict();

const HistoricalHarnessCompanyManifestSchema = HarnessCompanyManifestSchema.extend({
  workspaceRuntime: WorkspaceRuntimeSchema.optional(),
});

const snapshottedHarnessSchema = (
  company: typeof HarnessCompanyManifestSchema | typeof HistoricalHarnessCompanyManifestSchema,
) =>
  z
    .object({
      company,
      project: z
        .object({
          manifest: HarnessProjectManifestSchema,
          guidance: SnapshottedPromptSchema.nullable(),
        })
        .strict()
        .nullable(),
      implementationPlanner: z
        .object({
          prompt: SnapshottedPromptSchema,
          skills: z.array(z.string().min(1)),
        })
        .strict(),
      policies: z.array(HarnessPolicyManifestSchema),
      steps: z.array(SnapshottedStepSchema),
    })
    .strict();

const runPlanningSnapshotSchema = <Version extends 4 | 5>(
  schemaVersion: Version,
  company: typeof HarnessCompanyManifestSchema | typeof HistoricalHarnessCompanyManifestSchema,
) =>
  z
    .object({
      schemaVersion: z.literal(schemaVersion),
      taskReference: z.string().min(1),
      workflowHash: ContentHashSchema,
      task: TaskFixtureSchema,
      taskSnapshot: JsonValueSchema,
      workflow: JsonValueSchema,
      evidenceBundle: EvidenceBundleReferenceSchema,
      repository: z
        .object({
          workspaceId: z.string().regex(/^[a-f0-9]{24}$/u),
          reference: z.string().min(1),
          path: z.string().min(1),
        })
        .strict(),
      harness: snapshottedHarnessSchema(company),
      createdAt: z.iso.datetime(),
    })
    .strict();

const RunPlanningSnapshotV4Schema = runPlanningSnapshotSchema(
  4,
  HistoricalHarnessCompanyManifestSchema,
);
const RunPlanningSnapshotV5Schema = runPlanningSnapshotSchema(5, HarnessCompanyManifestSchema);

export const RunPlanningSnapshotSchema = z
  .discriminatedUnion('schemaVersion', [RunPlanningSnapshotV4Schema, RunPlanningSnapshotV5Schema])
  .readonly();

export type PlanningSnapshotReference = z.infer<typeof PlanningSnapshotReferenceSchema>;
export type RunPlanningSnapshot = z.infer<typeof RunPlanningSnapshotSchema>;

export interface PlanningSnapshotWorkspace {
  readonly workspaceId: string;
  readonly reference: string;
  readonly path: string;
}

export interface PlanningSnapshotSource {
  createRunSnapshot(
    taskReference: string,
    workflowHash: string,
    workspace: PlanningSnapshotWorkspace,
  ): Outcome<PlanningSnapshotReference, { readonly kind: string }>;
}
