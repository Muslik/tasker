import { z } from 'zod';

import {
  ImplementationPlanningDecisionSchema,
  ReadyImplementationPlanningDecisionSchema,
  PlanningStrategyRequestSchema,
  PlanningStrategySchema,
} from '../planning/implementation-plan.js';
import { PlanningSnapshotReferenceSchema } from '../planning/run-planning-snapshot.js';
import { EvidenceBundleReferenceSchema } from '../planning/evidence-bundle.js';
import { ImplementationPlannerReceiptSchema } from '../providers/contracts.js';
import { PlanningEvidenceRequestSchema } from '../planning/planning-evidence.js';

const PlanningEvidencePendingObjectSchema = z
  .object({
    round: z.number().int().positive().max(3),
    operationId: z.string().min(1),
    requests: z.array(PlanningEvidenceRequestSchema).min(1).max(10),
    receipt: ImplementationPlannerReceiptSchema,
    requestedAt: z.iso.datetime(),
  })
  .strict();

export const PlanningEvidencePendingSchema = PlanningEvidencePendingObjectSchema.readonly();

export const PlanningEvidenceRoundSchema = PlanningEvidencePendingObjectSchema.extend({
  evidenceBundle: EvidenceBundleReferenceSchema,
  completedAt: z.iso.datetime(),
})
  .strict()
  .readonly();

export const PlanningFailureViewSchema = z
  .object({
    kind: z.enum([
      'invalid_skill_selection',
      'invalid_skill_package',
      'skill_unavailable',
      'skill_materialization_failed',
      'provider_unavailable',
      'provider_timed_out',
      'provider_failed',
      'invalid_event_stream',
      'invalid_planner_output',
    ]),
    message: z.string().min(1),
    retryable: z.boolean(),
  })
  .strict();

const PlanningRecordBaseSchema = z.object({
  schemaVersion: z.literal(1),
  taskReference: z.string().min(1),
  commandId: z.string().min(1).nullable(),
  transcriptId: z.string().min(1).nullable(),
  planningSnapshot: PlanningSnapshotReferenceSchema.nullable(),
  evidenceBundle: EvidenceBundleReferenceSchema,
  evidenceRounds: z.array(PlanningEvidenceRoundSchema).max(3),
  attempt: z.number().int().positive(),
  requestedStrategy: PlanningStrategyRequestSchema,
  selectedStrategy: PlanningStrategySchema,
  selectionReason: z.string().min(1),
  startedAt: z.iso.datetime(),
  operatorGuidance: z.string().min(1).max(10_000).nullable(),
  validationFeedback: z.array(z.string().min(1).max(2_000)).max(50),
  validationRevision: z.number().int().nonnegative().max(3),
  previousDecision: ReadyImplementationPlanningDecisionSchema.nullable(),
});

export const ImplementationPlanningRecordSchema = z.discriminatedUnion('status', [
  PlanningRecordBaseSchema.extend({
    status: z.literal('planning'),
    pendingEvidence: PlanningEvidencePendingSchema.nullable(),
  }).strict(),
  PlanningRecordBaseSchema.extend({
    status: z.literal('ready'),
    completedAt: z.iso.datetime(),
    artifactId: z.string().min(1),
    decision: ImplementationPlanningDecisionSchema.and(z.object({ status: z.literal('ready') })),
    workflowHash: z.string().regex(/^[a-f0-9]{64}$/u),
    executionSnapshot: PlanningSnapshotReferenceSchema,
    receipt: ImplementationPlannerReceiptSchema,
  }).strict(),
  PlanningRecordBaseSchema.extend({
    status: z.literal('needs_clarification'),
    completedAt: z.iso.datetime(),
    artifactId: z.string().min(1),
    decision: ImplementationPlanningDecisionSchema.and(
      z.object({ status: z.literal('needs_clarification') }),
    ),
    receipt: ImplementationPlannerReceiptSchema,
  }).strict(),
  PlanningRecordBaseSchema.extend({
    status: z.literal('investigation_required'),
    completedAt: z.iso.datetime(),
    artifactId: z.string().min(1),
    decision: ImplementationPlanningDecisionSchema.and(
      z.object({ status: z.literal('investigation_required') }),
    ),
    receipt: ImplementationPlannerReceiptSchema,
  }).strict(),
  PlanningRecordBaseSchema.extend({
    status: z.literal('failed'),
    completedAt: z.iso.datetime(),
    failure: PlanningFailureViewSchema,
    receipt: ImplementationPlannerReceiptSchema.nullable(),
  }).strict(),
]);

export type ImplementationPlanningRecord = z.infer<typeof ImplementationPlanningRecordSchema>;
export type PlanningEvidencePending = z.infer<typeof PlanningEvidencePendingSchema>;
export type PlanningEvidenceRound = z.infer<typeof PlanningEvidenceRoundSchema>;
export type ReadyImplementationPlanningRecord = Extract<
  ImplementationPlanningRecord,
  { readonly status: 'ready' }
>;
