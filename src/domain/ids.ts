import { z } from 'zod';

import { idFromTrustedString } from '../shared/ids.js';

const createIdSchema = <Kind extends string>() =>
  z
    .string()
    .min(1)
    .transform(idFromTrustedString<Kind>);

export const eventIdSchema = createIdSchema<'event'>();
export type EventId = z.infer<typeof eventIdSchema>;

export const commandIdSchema = createIdSchema<'command'>();
export type CommandId = z.infer<typeof commandIdSchema>;

export const artifactIdSchema = createIdSchema<'artifact'>();
export type ArtifactId = z.infer<typeof artifactIdSchema>;

export const correlationIdSchema = createIdSchema<'correlation'>();
export type CorrelationId = z.infer<typeof correlationIdSchema>;

export const causationIdSchema = createIdSchema<'causation'>();
export type CausationId = z.infer<typeof causationIdSchema>;

export const intakeRequestIdSchema = createIdSchema<'intake_request'>();
export type IntakeRequestId = z.infer<typeof intakeRequestIdSchema>;

export const taskIdSchema = createIdSchema<'task'>();
export type TaskId = z.infer<typeof taskIdSchema>;

export const runIdSchema = createIdSchema<'run'>();
export type RunId = z.infer<typeof runIdSchema>;

export const stepIdSchema = createIdSchema<'step'>();
export type StepId = z.infer<typeof stepIdSchema>;

export const attemptIdSchema = createIdSchema<'attempt'>();
export type AttemptId = z.infer<typeof attemptIdSchema>;

export const waitIdSchema = createIdSchema<'wait'>();
export type WaitId = z.infer<typeof waitIdSchema>;

export const interventionEventIdSchema = createIdSchema<'intervention_event'>();
export type InterventionEventId = z.infer<typeof interventionEventIdSchema>;

export const manualTakeoverIdSchema = createIdSchema<'manual_takeover'>();
export type ManualTakeoverId = z.infer<typeof manualTakeoverIdSchema>;

export const reviewCycleIdSchema = createIdSchema<'review_cycle'>();
export type ReviewCycleId = z.infer<typeof reviewCycleIdSchema>;

export const providerAttemptIdSchema = createIdSchema<'provider_attempt'>();
export type ProviderAttemptId = z.infer<typeof providerAttemptIdSchema>;

export const mutationReceiptIdSchema = createIdSchema<'mutation_receipt'>();
export type MutationReceiptId = z.infer<typeof mutationReceiptIdSchema>;
