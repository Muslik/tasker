import { z } from 'zod';

import { ValidationProfileSchema } from '../graph/archetypes/index.js';
import { SemanticWorkflowSourceSchema } from '../graph/semantic-schema.js';

const DeliverPrVerificationProfileSchema = z.enum([
  'full',
  'full_with_visual',
  'targeted',
  'translation_and_targeted',
]);

export const VerificationProfileSchema = z.enum([
  ...DeliverPrVerificationProfileSchema.options,
  'research',
]);

export const DeliverPrVerificationPlanSchema = z
  .object({
    checks: z.array(z.string().min(1)).min(1),
    profile: DeliverPrVerificationProfileSchema,
    validationProfile: ValidationProfileSchema.default('targeted'),
    rationale: z.string().min(1),
  })
  .strict();

export const ResearchVerificationPlanSchema = z
  .object({
    checks: z.array(z.string().min(1)).min(1),
    profile: z.literal('research'),
    rationale: z.string().min(1),
  })
  .strict();

export const VerificationPlanSchema = z.union([
  DeliverPrVerificationPlanSchema,
  ResearchVerificationPlanSchema,
]);

export const WorkflowAssemblyDecisionSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    source: z.string().min(1),
    reason: z.string().min(1),
    effect: z.string().min(1),
  })
  .strict();

export const WorkflowAnalyzerOutputSchema = z
  .object({
    assemblyDecisions: z.array(WorkflowAssemblyDecisionSchema).min(1),
    source: SemanticWorkflowSourceSchema,
    verificationPlan: VerificationPlanSchema,
  })
  .strict();

export type WorkflowAnalyzerOutput = z.infer<typeof WorkflowAnalyzerOutputSchema>;
export type WorkflowAssemblyDecision = z.infer<typeof WorkflowAssemblyDecisionSchema>;
export type DeliverPrVerificationPlan = z.infer<typeof DeliverPrVerificationPlanSchema>;
export type ResearchVerificationPlan = z.infer<typeof ResearchVerificationPlanSchema>;
export type VerificationPlan = z.infer<typeof VerificationPlanSchema>;
