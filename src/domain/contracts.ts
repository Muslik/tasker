import { z } from 'zod';

import {
  artifactIdSchema,
  attemptIdSchema,
  causationIdSchema,
  commandIdSchema,
  correlationIdSchema,
  eventIdSchema,
  intakeRequestIdSchema,
  interventionEventIdSchema,
  manualTakeoverIdSchema,
  mutationReceiptIdSchema,
  providerAttemptIdSchema,
  reviewCycleIdSchema,
  runIdSchema,
  stepIdSchema,
  taskIdSchema,
  waitIdSchema,
} from './ids.js';

const nonEmptyStringSchema = z.string().min(1);
const timestampSchema = z.iso.datetime({ offset: true });
const nonNegativeIntSchema = z.number().int().min(0);
const positiveIntSchema = z.number().int().positive();
const strictObject = <Shape extends z.ZodRawShape>(shape: Shape) => z.object(shape).strict();
const versionedReferenceSchema = z.string().regex(/^[a-z][a-z0-9_]*(?:[._-][a-z0-9_]+)*@[1-9]\d*$/);

export const supportedEventSchemaVersion = 1 as const;
export const eventSchemaVersionSchema = z.literal(supportedEventSchemaVersion);
export type EventSchemaVersion = z.infer<typeof eventSchemaVersionSchema>;

export const redactionStatusSchema = z.enum(['clean', 'redacted', 'blocked']);
export type RedactionStatus = z.infer<typeof redactionStatusSchema>;

export const redactionMetadataSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('clean'),
    policyRef: versionedReferenceSchema,
  }),
  z.object({
    status: z.literal('redacted'),
    policyRef: versionedReferenceSchema,
    redactedFieldPaths: z.array(nonEmptyStringSchema).min(1),
    diagnosticArtifactId: artifactIdSchema.optional(),
  }),
  z.object({
    status: z.literal('blocked'),
    policyRef: versionedReferenceSchema,
    blockedReason: nonEmptyStringSchema,
  }),
]);
export type RedactionMetadata = z.infer<typeof redactionMetadataSchema>;

export const artifactReferenceSchema = z.object({
  artifactId: artifactIdSchema,
  role: nonEmptyStringSchema,
  mediaType: nonEmptyStringSchema.optional(),
  redaction: redactionMetadataSchema,
});
export type ArtifactReference = z.infer<typeof artifactReferenceSchema>;

export const aggregateKindSchema = z.enum([
  'IntakeRequest',
  'Task',
  'Run',
  'Step',
  'Attempt',
  'Wait',
  'InterventionEvent',
  'ManualTakeover',
  'ReviewCycle',
  'ProviderAttempt',
  'MutationReceipt',
]);
export type AggregateKind = z.infer<typeof aggregateKindSchema>;

export const aggregateReferenceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('IntakeRequest'), id: intakeRequestIdSchema }),
  z.object({ kind: z.literal('Task'), id: taskIdSchema }),
  z.object({ kind: z.literal('Run'), id: runIdSchema }),
  z.object({ kind: z.literal('Step'), id: stepIdSchema }),
  z.object({ kind: z.literal('Attempt'), id: attemptIdSchema }),
  z.object({ kind: z.literal('Wait'), id: waitIdSchema }),
  z.object({ kind: z.literal('InterventionEvent'), id: interventionEventIdSchema }),
  z.object({ kind: z.literal('ManualTakeover'), id: manualTakeoverIdSchema }),
  z.object({ kind: z.literal('ReviewCycle'), id: reviewCycleIdSchema }),
  z.object({ kind: z.literal('ProviderAttempt'), id: providerAttemptIdSchema }),
  z.object({ kind: z.literal('MutationReceipt'), id: mutationReceiptIdSchema }),
]);
export type AggregateReference = z.infer<typeof aggregateReferenceSchema>;

export const actorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('system'), id: nonEmptyStringSchema }),
  z.object({ kind: z.literal('runner'), id: nonEmptyStringSchema }),
  z.object({ kind: z.literal('operator'), id: nonEmptyStringSchema }),
  z.object({ kind: z.literal('integration'), id: nonEmptyStringSchema }),
]);
export type Actor = z.infer<typeof actorSchema>;

export const eventVersionMetadataSchema = z.object({
  schema: eventSchemaVersionSchema,
  aggregateVersion: nonNegativeIntSchema,
  expectedAggregateVersion: nonNegativeIntSchema.optional(),
});
export type EventVersionMetadata = z.infer<typeof eventVersionMetadataSchema>;

export const eventEnvelopeMetadataSchema = strictObject({
  eventId: eventIdSchema,
  eventType: versionedReferenceSchema,
  aggregate: aggregateReferenceSchema,
  version: eventVersionMetadataSchema,
  correlationId: correlationIdSchema,
  causationId: causationIdSchema.optional(),
  actor: actorSchema,
  occurredAt: timestampSchema,
  redaction: redactionMetadataSchema,
  artifactReferences: z.array(artifactReferenceSchema),
});
export type EventEnvelopeMetadata = z.infer<typeof eventEnvelopeMetadataSchema>;

export const makeEventEnvelopeSchema = <PayloadSchema extends z.ZodType>(
  payloadSchema: PayloadSchema,
) =>
  strictObject({
    ...eventEnvelopeMetadataSchema.shape,
    payload: payloadSchema,
  });

export const eventEnvelopeSchema = makeEventEnvelopeSchema(z.unknown());
export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;

export const supportedCommandSchemaVersion = 1 as const;
export const commandSchemaVersionSchema = z.literal(supportedCommandSchemaVersion);
export type CommandSchemaVersion = z.infer<typeof commandSchemaVersionSchema>;

export const commandEnvelopeMetadataSchema = strictObject({
  commandId: commandIdSchema,
  commandType: versionedReferenceSchema,
  target: aggregateReferenceSchema,
  schemaVersion: commandSchemaVersionSchema,
  expectedAggregateVersion: nonNegativeIntSchema,
  correlationId: correlationIdSchema,
  causationId: causationIdSchema.optional(),
  actor: actorSchema,
  issuedAt: timestampSchema,
});
export type CommandEnvelopeMetadata = z.infer<typeof commandEnvelopeMetadataSchema>;

export const makeCommandEnvelopeSchema = <PayloadSchema extends z.ZodType>(
  payloadSchema: PayloadSchema,
) =>
  strictObject({
    ...commandEnvelopeMetadataSchema.shape,
    payload: payloadSchema,
  });

export const commandEnvelopeSchema = makeCommandEnvelopeSchema(z.unknown());
export type CommandEnvelope = z.infer<typeof commandEnvelopeSchema>;

const retryEvidenceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }),
  z.object({
    kind: z.literal('server_hint'),
    retryAt: timestampSchema.optional(),
    retryAfterSeconds: positiveIntSchema.optional(),
  }),
  z.object({
    kind: z.literal('transport_observation'),
    detail: nonEmptyStringSchema,
  }),
  z.object({
    kind: z.literal('operator_confirmation'),
    detail: nonEmptyStringSchema,
  }),
  z.object({
    kind: z.literal('probe_required'),
    detail: nonEmptyStringSchema,
  }),
]);
export type RetryEvidence = z.infer<typeof retryEvidenceSchema>;

export const operationalFailureSourceSchema = z.enum([
  'provider',
  'integration',
  'environment',
  'ci',
  'operator',
  'system',
  'infrastructure',
]);
export type OperationalFailureSource = z.infer<typeof operationalFailureSourceSchema>;

export const reconciliationProbeSchema = z.object({
  probe: versionedReferenceSchema,
  correlationId: correlationIdSchema,
  target: nonEmptyStringSchema,
});
export type ReconciliationProbe = z.infer<typeof reconciliationProbeSchema>;

const operationalFailureBaseShape = {
  code: nonEmptyStringSchema,
  safeMessage: nonEmptyStringSchema,
  source: operationalFailureSourceSchema,
  occurredAt: timestampSchema,
  retryEvidence: retryEvidenceSchema,
  correlationId: correlationIdSchema,
  redactedDiagnosticArtifactId: artifactIdSchema.optional(),
};

export const operationalFailureSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('invalid_input'),
    ...operationalFailureBaseShape,
    repairAction: nonEmptyStringSchema,
  }),
  z.object({
    kind: z.literal('not_eligible'),
    ...operationalFailureBaseShape,
    reasons: z.array(nonEmptyStringSchema).min(1),
  }),
  z.object({
    kind: z.literal('access_denied'),
    ...operationalFailureBaseShape,
    operatorAction: nonEmptyStringSchema,
    failedPreflight: nonEmptyStringSchema.optional(),
  }),
  z.object({
    kind: z.literal('authentication'),
    ...operationalFailureBaseShape,
    credentialRef: nonEmptyStringSchema,
  }),
  z.object({
    kind: z.literal('quota_exhausted'),
    ...operationalFailureBaseShape,
    resetAt: timestampSchema,
  }),
  z.object({
    kind: z.literal('rate_limited'),
    ...operationalFailureBaseShape,
    retryAfterSeconds: positiveIntSchema,
  }),
  z.object({
    kind: z.literal('transient_transport'),
    ...operationalFailureBaseShape,
    operation: nonEmptyStringSchema,
  }),
  z.object({
    kind: z.literal('remote_rejected'),
    ...operationalFailureBaseShape,
    resolution: nonEmptyStringSchema,
    remoteStatus: positiveIntSchema.optional(),
  }),
  z.object({
    kind: z.literal('contract_violation'),
    ...operationalFailureBaseShape,
    contract: nonEmptyStringSchema,
  }),
  z.object({
    kind: z.literal('infrastructure'),
    ...operationalFailureBaseShape,
    component: nonEmptyStringSchema,
  }),
  z.object({
    kind: z.literal('cancelled'),
    ...operationalFailureBaseShape,
    cancelledBy: z.enum(['operator', 'system']),
  }),
  z.object({
    kind: z.literal('unknown_outcome'),
    ...operationalFailureBaseShape,
    probe: reconciliationProbeSchema,
  }),
]);
export type OperationalFailure = z.infer<typeof operationalFailureSchema>;

export const waitKindSchema = z.enum([
  'quota_reset',
  'human_clarification',
  'ci_build',
  'review_event',
  'translation_ready',
  'external_artifact',
  'retry_backoff',
  'provider_resume_ready',
]);
export type WaitKind = z.infer<typeof waitKindSchema>;

export const waitStatusSchema = z.enum(['open', 'resolved', 'cancelled']);
export type WaitStatus = z.infer<typeof waitStatusSchema>;

export const waitSlotPolicySchema = z.enum(['retain', 'release']);
export type WaitSlotPolicy = z.infer<typeof waitSlotPolicySchema>;

const waitBaseShape = {
  id: waitIdSchema,
  runId: runIdSchema,
  scope: nonEmptyStringSchema,
  kind: waitKindSchema,
  resumeCursor: nonEmptyStringSchema,
  resolutionSchema: versionedReferenceSchema,
  slotPolicy: waitSlotPolicySchema,
  openedByEventId: eventIdSchema,
  correlationId: correlationIdSchema,
  deadlineAt: timestampSchema.optional(),
};

export const waitSchema = z.discriminatedUnion('status', [
  strictObject({
    ...waitBaseShape,
    status: z.literal('open'),
  }),
  strictObject({
    ...waitBaseShape,
    status: z.literal('resolved'),
    resolvedByEventId: eventIdSchema,
  }),
  strictObject({
    ...waitBaseShape,
    status: z.literal('cancelled'),
    cancelledByEventId: eventIdSchema,
  }),
]);
export type Wait = z.infer<typeof waitSchema>;

export const recoveryActionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('retry'),
    attemptId: attemptIdSchema,
    cursor: nonEmptyStringSchema,
    remainingAttempts: nonNegativeIntSchema,
  }),
  z.object({
    kind: z.literal('wait'),
    wait: waitSchema,
  }),
  z.object({
    kind: z.literal('reconcile'),
    effectIntent: versionedReferenceSchema,
    probe: reconciliationProbeSchema,
  }),
  z.object({
    kind: z.literal('gate'),
    action: nonEmptyStringSchema,
    resumeWhen: nonEmptyStringSchema,
  }),
  z.object({
    kind: z.literal('fail'),
    outcome: nonEmptyStringSchema,
  }),
  z.object({
    kind: z.literal('quarantine'),
    reason: nonEmptyStringSchema,
    debugBundleRequired: z.literal(true),
  }),
]);
export type RecoveryAction = z.infer<typeof recoveryActionSchema>;

export const taskStatusSchema = z.enum([
  'backlog',
  'queued',
  'running',
  'plan_review',
  'waiting_for_review',
  'revise',
  'blocked',
  'handed_to_human',
  'cancelled',
  'done',
]);
export type TaskStatus = z.infer<typeof taskStatusSchema>;

export const runStatusSchema = z.enum([
  'created',
  'leased',
  'executing',
  'waiting',
  'blocked_recoverable',
  'completed',
  'handed_off',
  'quarantined',
  'cancelled',
]);
export type RunStatus = z.infer<typeof runStatusSchema>;

export const stepStatusSchema = z.enum([
  'pending',
  'ready',
  'in_progress',
  'waiting',
  'retry_ready',
  'succeeded',
  'blocked',
  'skipped',
  'cancelled',
]);
export type StepStatus = z.infer<typeof stepStatusSchema>;

export const attemptOutcomeSchema = z.enum([
  'succeeded',
  'retryable',
  'needs_human',
  'wait_requested',
  'not_applied',
  'unknown_outcome',
  'fatal',
]);
export type AttemptOutcome = z.infer<typeof attemptOutcomeSchema>;

export const intakeRequestStateSchema = z.discriminatedUnion('status', [
  strictObject({ status: z.literal('received') }),
  strictObject({
    status: z.literal('fetching_context'),
    fetchAttempts: nonNegativeIntSchema,
  }),
  strictObject({
    status: z.literal('ready_for_task_creation'),
    normalizedInput: z.record(z.string(), z.unknown()),
  }),
  strictObject({
    status: z.literal('waiting_for_intake_repair'),
    failure: operationalFailureSchema,
    repairAction: nonEmptyStringSchema,
  }),
  strictObject({
    status: z.literal('not_eligible'),
    reasons: z.array(nonEmptyStringSchema).min(1),
  }),
  strictObject({
    status: z.literal('failed_terminal'),
    failure: operationalFailureSchema,
  }),
]);
export type IntakeRequestState = z.infer<typeof intakeRequestStateSchema>;

export const intakeRequestSchema = strictObject({
  id: intakeRequestIdSchema,
  source: nonEmptyStringSchema,
  externalRef: nonEmptyStringSchema,
  createdAt: timestampSchema,
  state: intakeRequestStateSchema,
});
export type IntakeRequest = z.infer<typeof intakeRequestSchema>;

export const taskSchema = strictObject({
  id: taskIdSchema,
  intakeRequestId: intakeRequestIdSchema,
  title: nonEmptyStringSchema,
  createdAt: timestampSchema,
  status: taskStatusSchema,
  currentRunId: runIdSchema.optional(),
});
export type Task = z.infer<typeof taskSchema>;

const runBaseShape = {
  id: runIdSchema,
  taskId: taskIdSchema,
  createdAt: timestampSchema,
  fenceToken: nonNegativeIntSchema,
  predecessorRunId: runIdSchema.optional(),
};

export const runSchema = z.discriminatedUnion('status', [
  strictObject({
    ...runBaseShape,
    status: z.literal('created'),
  }),
  strictObject({
    ...runBaseShape,
    status: z.literal('leased'),
  }),
  strictObject({
    ...runBaseShape,
    status: z.literal('executing'),
  }),
  strictObject({
    ...runBaseShape,
    status: z.literal('waiting'),
    waitId: waitIdSchema,
  }),
  strictObject({
    ...runBaseShape,
    status: z.literal('blocked_recoverable'),
    recovery: recoveryActionSchema,
  }),
  strictObject({
    ...runBaseShape,
    status: z.literal('completed'),
    completedAt: timestampSchema,
  }),
  strictObject({
    ...runBaseShape,
    status: z.literal('handed_off'),
    manualTakeoverId: manualTakeoverIdSchema,
  }),
  strictObject({
    ...runBaseShape,
    status: z.literal('quarantined'),
    quarantineReason: nonEmptyStringSchema,
  }),
  strictObject({
    ...runBaseShape,
    status: z.literal('cancelled'),
    cancelledAt: timestampSchema,
  }),
]);
export type Run = z.infer<typeof runSchema>;

const stepBaseShape = {
  id: stepIdSchema,
  runId: runIdSchema,
  key: nonEmptyStringSchema,
  stepRef: versionedReferenceSchema,
};

export const stepSchema = z.discriminatedUnion('status', [
  strictObject({
    ...stepBaseShape,
    status: z.literal('pending'),
  }),
  strictObject({
    ...stepBaseShape,
    status: z.literal('ready'),
  }),
  strictObject({
    ...stepBaseShape,
    status: z.literal('in_progress'),
  }),
  strictObject({
    ...stepBaseShape,
    status: z.literal('waiting'),
    waitId: waitIdSchema,
  }),
  strictObject({
    ...stepBaseShape,
    status: z.literal('retry_ready'),
    recovery: recoveryActionSchema,
  }),
  strictObject({
    ...stepBaseShape,
    status: z.literal('succeeded'),
  }),
  strictObject({
    ...stepBaseShape,
    status: z.literal('blocked'),
    recovery: recoveryActionSchema,
  }),
  strictObject({
    ...stepBaseShape,
    status: z.literal('skipped'),
    reason: nonEmptyStringSchema,
  }),
  strictObject({
    ...stepBaseShape,
    status: z.literal('cancelled'),
    cancelledAt: timestampSchema,
  }),
]);
export type Step = z.infer<typeof stepSchema>;

export const mutationReceiptSchema = strictObject({
  id: mutationReceiptIdSchema,
  providerAttemptId: providerAttemptIdSchema,
  externalReference: nonEmptyStringSchema,
  target: nonEmptyStringSchema,
  observedAt: timestampSchema,
  correlationId: correlationIdSchema,
  evidenceArtifactId: artifactIdSchema.optional(),
});
export type MutationReceipt = z.infer<typeof mutationReceiptSchema>;

export const makeEffectOutcomeSchema = <
  ReceiptSchema extends z.ZodType,
  FailureSchema extends z.ZodType,
  ProbeSchema extends z.ZodType,
>(
  receiptSchema: ReceiptSchema,
  failureSchema: FailureSchema,
  probeSchema: ProbeSchema,
) =>
  z.discriminatedUnion('status', [
    strictObject({
      status: z.literal('applied'),
      receipt: receiptSchema,
    }),
    strictObject({
      status: z.literal('not_applied'),
      failure: failureSchema,
    }),
    strictObject({
      status: z.literal('unknown_outcome'),
      failure: failureSchema,
      probe: probeSchema,
    }),
  ]);

export const mutationEffectOutcomeSchema = makeEffectOutcomeSchema(
  mutationReceiptSchema,
  operationalFailureSchema,
  reconciliationProbeSchema,
);
export type MutationEffectOutcome = z.infer<typeof mutationEffectOutcomeSchema>;

export const attemptSchema = z.discriminatedUnion('phase', [
  strictObject({
    id: attemptIdSchema,
    stepId: stepIdSchema,
    number: positiveIntSchema,
    startedAt: timestampSchema,
    phase: z.literal('in_progress'),
  }),
  strictObject({
    id: attemptIdSchema,
    stepId: stepIdSchema,
    number: positiveIntSchema,
    startedAt: timestampSchema,
    phase: z.literal('settled'),
    finishedAt: timestampSchema,
    outcome: attemptOutcomeSchema,
    effect: mutationEffectOutcomeSchema.optional(),
    recovery: recoveryActionSchema.optional(),
  }),
]);
export type Attempt = z.infer<typeof attemptSchema>;

export const interventionEventSchema = strictObject({
  id: interventionEventIdSchema,
  runId: runIdSchema,
  stepId: stepIdSchema,
  priorAttemptId: attemptIdSchema,
  kind: nonEmptyStringSchema,
  guidanceArtifactId: artifactIdSchema,
  author: actorSchema,
  createdAt: timestampSchema,
});
export type InterventionEvent = z.infer<typeof interventionEventSchema>;

const manualTakeoverBaseShape = {
  id: manualTakeoverIdSchema,
  runId: runIdSchema,
  requestedBy: actorSchema,
  requestedAt: timestampSchema,
  cursor: nonEmptyStringSchema,
};

export const manualTakeoverSchema = z.discriminatedUnion('status', [
  strictObject({
    ...manualTakeoverBaseShape,
    status: z.literal('requested'),
  }),
  strictObject({
    ...manualTakeoverBaseShape,
    status: z.literal('reconciled'),
    reconciledAt: timestampSchema,
    reconciledBy: actorSchema,
  }),
  strictObject({
    ...manualTakeoverBaseShape,
    status: z.literal('released'),
    reconciledAt: timestampSchema,
    reconciledBy: actorSchema,
    releasedAt: timestampSchema,
    releasedFenceToken: nonNegativeIntSchema,
  }),
]);
export type ManualTakeover = z.infer<typeof manualTakeoverSchema>;

const reviewCycleBaseShape = {
  id: reviewCycleIdSchema,
  taskId: taskIdSchema,
  runId: runIdSchema,
  openedAt: timestampSchema,
};

export const reviewCycleSchema = z.discriminatedUnion('status', [
  strictObject({
    ...reviewCycleBaseShape,
    status: z.literal('open'),
  }),
  strictObject({
    ...reviewCycleBaseShape,
    status: z.literal('approved'),
    closedAt: timestampSchema,
  }),
  strictObject({
    ...reviewCycleBaseShape,
    status: z.literal('changes_requested'),
    closedAt: timestampSchema,
  }),
  strictObject({
    ...reviewCycleBaseShape,
    status: z.literal('dismissed'),
    closedAt: timestampSchema,
  }),
]);
export type ReviewCycle = z.infer<typeof reviewCycleSchema>;

const providerAttemptBaseShape = {
  id: providerAttemptIdSchema,
  attemptId: attemptIdSchema,
  provider: nonEmptyStringSchema,
  startedAt: timestampSchema,
  providerSessionId: nonEmptyStringSchema.optional(),
};

export const providerAttemptSchema = z.discriminatedUnion('status', [
  strictObject({
    ...providerAttemptBaseShape,
    status: z.literal('started'),
  }),
  strictObject({
    ...providerAttemptBaseShape,
    status: z.literal('completed'),
    finishedAt: timestampSchema,
  }),
  strictObject({
    ...providerAttemptBaseShape,
    status: z.literal('failed'),
    finishedAt: timestampSchema,
    failure: operationalFailureSchema,
  }),
]);
export type ProviderAttempt = z.infer<typeof providerAttemptSchema>;
