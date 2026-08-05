import { z } from 'zod';

import { PlanningSnapshotReferenceSchema } from '../planning/run-planning-snapshot.js';
import { EvidenceBundleReferenceSchema } from '../planning/evidence-bundle.js';

export const WorkflowFreezeApprovalSchema = z.discriminatedUnion('kind', [
  z
    .object({ kind: z.literal('automatic') })
    .strict()
    .readonly(),
  z
    .object({ kind: z.literal('operator_approved') })
    .strict()
    .readonly(),
]);

const FreezeTaskWorkflowInputObjectSchema = z
  .object({
    taskReference: z.string().min(1),
    workflowId: z.string().min(1),
    workflowRunId: z.string().min(1),
    workflowHash: z.string().regex(/^[a-f0-9]{64}$/u),
    planningAttempt: z.number().int().positive(),
    planningArtifactId: z.string().min(1),
    planningSnapshot: PlanningSnapshotReferenceSchema,
    evidenceBundle: EvidenceBundleReferenceSchema,
    approval: WorkflowFreezeApprovalSchema,
  })
  .strict();

export const FreezeTaskWorkflowInputSchema = FreezeTaskWorkflowInputObjectSchema.readonly();

export const WorkflowFreezeReceiptSchema = FreezeTaskWorkflowInputObjectSchema.extend({
  schemaVersion: z.literal(1),
  receiptId: z.string().min(1),
  frozenAt: z.iso.datetime(),
})
  .strict()
  .readonly();

export type FreezeTaskWorkflowInput = z.infer<typeof FreezeTaskWorkflowInputSchema>;
export type WorkflowFreezeApproval = z.infer<typeof WorkflowFreezeApprovalSchema>;
export type WorkflowFreezeReceipt = z.infer<typeof WorkflowFreezeReceiptSchema>;
