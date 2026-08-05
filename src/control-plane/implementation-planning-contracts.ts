import { z } from 'zod';

import {
  ImplementationPlanningDecisionSchema,
  PlanningStrategyRequestSchema,
  PlanningStrategySchema,
} from '../planning/implementation-plan.js';
import { PlanningSnapshotReferenceSchema } from '../planning/run-planning-snapshot.js';
import { ImplementationPlannerReceiptSchema } from '../providers/contracts.js';

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
  attempt: z.number().int().positive(),
  requestedStrategy: PlanningStrategyRequestSchema,
  selectedStrategy: PlanningStrategySchema,
  selectionReason: z.string().min(1),
  startedAt: z.iso.datetime(),
  operatorGuidance: z.string().min(1).max(10_000).nullable(),
});

export const ImplementationPlanningRecordSchema = z.discriminatedUnion('status', [
  PlanningRecordBaseSchema.extend({ status: z.literal('planning') }).strict(),
  PlanningRecordBaseSchema.extend({
    status: z.literal('ready'),
    completedAt: z.iso.datetime(),
    artifactId: z.string().min(1),
    decision: ImplementationPlanningDecisionSchema.and(z.object({ status: z.literal('ready') })),
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
    status: z.literal('workflow_change_required'),
    completedAt: z.iso.datetime(),
    artifactId: z.string().min(1),
    decision: ImplementationPlanningDecisionSchema.and(
      z.object({ status: z.literal('workflow_change_required') }),
    ),
    receipt: ImplementationPlannerReceiptSchema,
  }).strict(),
  PlanningRecordBaseSchema.extend({
    status: z.literal('failed'),
    completedAt: z.iso.datetime(),
    failure: PlanningFailureViewSchema,
  }).strict(),
]);

export type ImplementationPlanningRecord = z.infer<typeof ImplementationPlanningRecordSchema>;
export type ReadyImplementationPlanningRecord = Extract<
  ImplementationPlanningRecord,
  { readonly status: 'ready' }
>;
