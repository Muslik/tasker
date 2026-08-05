import { z } from 'zod';

import { JsonValueSchema } from '../workflow/schema.js';

export const PlanningEvidenceRequestSchema = z
  .object({
    requestId: z.string().regex(/^[a-z][a-z0-9-]*$/u),
    skill: z.string().regex(/^[a-z0-9][a-z0-9-]*$/u),
    locator: z.string().trim().min(1).max(2_000),
    purpose: z.string().trim().min(1).max(2_000),
  })
  .strict()
  .readonly();

export const PlanningEvidenceObservationSchema = z
  .object({
    skill: z.string().regex(/^[a-z0-9][a-z0-9-]*$/u),
    locator: z.string().min(1).max(2_000),
    title: z.string().min(1).max(300),
    observedVersion: z.string().min(1).max(500),
    mediaType: z.string().min(1).max(200),
    content: JsonValueSchema,
  })
  .strict()
  .readonly();

export const PlanningEvidenceCaptureSchema = z
  .object({
    request: PlanningEvidenceRequestSchema,
    observation: PlanningEvidenceObservationSchema,
  })
  .strict()
  .readonly();

export type PlanningEvidenceRequest = z.infer<typeof PlanningEvidenceRequestSchema>;
export type PlanningEvidenceObservation = z.infer<typeof PlanningEvidenceObservationSchema>;
export type PlanningEvidenceCapture = z.infer<typeof PlanningEvidenceCaptureSchema>;
