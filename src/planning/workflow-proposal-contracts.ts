import { z } from 'zod';

import { ValidationProfileSchema } from '../workflow/archetypes/index.js';
import { SemanticWorkflowSourceSchema } from '../workflow/semantic-schema.js';

export const VerificationProfileSchema = z.enum([
  'full',
  'full_with_visual',
  'targeted',
  'translation_and_targeted',
]);

export const VerificationPlanSchema = z
  .object({
    checks: z.array(z.string().min(1)).min(1),
    profile: VerificationProfileSchema,
    validationProfile: ValidationProfileSchema.default('targeted'),
    rationale: z.string().min(1),
  })
  .strict();

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
