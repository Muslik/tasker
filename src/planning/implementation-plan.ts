import { z } from 'zod';

import { JsonValueSchema } from '../workflow/schema.js';
import { EvidenceBundleSchema } from './evidence-bundle.js';

export const PlanningStrategyRequestSchema = z.enum(['auto', 'fast', 'ralplan']);
export const PlanningStrategySchema = z.enum(['fast', 'ralplan']);

export const ImplementationPlanLinkSchema = z
  .object({
    artifactId: z.string().min(1),
    attempt: z.number().int().positive(),
    requestedStrategy: PlanningStrategyRequestSchema,
    selectedStrategy: PlanningStrategySchema,
  })
  .strict();

export const ImplementationPlanStepSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]*$/u),
    title: z.string().min(1).max(160),
    objective: z.string().min(1).max(2_000),
    repository: z.string().min(1),
    files: z.array(z.string().min(1)).max(30),
    verification: z.array(z.string().min(1)).min(1).max(20),
  })
  .strict();

export const ImplementationPlanRiskSchema = z
  .object({
    risk: z.string().min(1).max(1_000),
    mitigation: z.string().min(1).max(1_000),
  })
  .strict();

export const ImplementationPlanSchema = z
  .object({
    schemaVersion: z.literal(1),
    title: z.string().min(1).max(200),
    summary: z.string().min(1).max(4_000),
    steps: z.array(ImplementationPlanStepSchema).min(1).max(30),
    assumptions: z.array(z.string().min(1).max(1_000)).max(20),
    risks: z.array(ImplementationPlanRiskSchema).max(20),
    acceptanceCriteria: z.array(z.string().min(1).max(1_000)).min(1).max(30),
  })
  .strict();

export const PlanningQuestionSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]*$/u),
    question: z.string().min(1).max(2_000),
    reason: z.string().min(1).max(2_000),
  })
  .strict();

export const PlanningQuestionAnswerSchema = z
  .object({
    questionId: z.string().regex(/^[a-z][a-z0-9-]*$/u),
    answer: z.string().trim().min(1).max(10_000),
  })
  .strict();

export const PlanningClarificationAnswerCommandSchema = z
  .object({
    answers: z.array(PlanningQuestionAnswerSchema).min(1).max(10),
  })
  .strict();

export const WorkflowChangeRequestSchema = z
  .object({
    reason: z.string().min(1).max(4_000),
    discoveredRepositories: z.array(z.string().min(1)).max(20),
    requiredCapabilities: z.array(z.string().min(1)).max(20),
    evidence: z.array(z.string().min(1).max(2_000)).min(1).max(30),
  })
  .strict();

export const ImplementationPlanningDecisionSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('ready'),
      plan: ImplementationPlanSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal('needs_clarification'),
      questions: z.array(PlanningQuestionSchema).min(1).max(10),
    })
    .strict(),
  z
    .object({
      status: z.literal('workflow_change_required'),
      request: WorkflowChangeRequestSchema,
    })
    .strict(),
]);

export const ImplementationPlannerContextSchema = z
  .object({
    taskSnapshot: JsonValueSchema,
    workflow: JsonValueSchema,
    evidenceBundle: EvidenceBundleSchema,
    repositoryReference: z.string().min(1),
    operatorGuidance: z.string().min(1).max(10_000).nullable(),
  })
  .strict();

export type PlanningStrategyRequest = z.infer<typeof PlanningStrategyRequestSchema>;
export type PlanningStrategy = z.infer<typeof PlanningStrategySchema>;
export type ImplementationPlanLink = z.infer<typeof ImplementationPlanLinkSchema>;
export type ImplementationPlan = z.infer<typeof ImplementationPlanSchema>;
export type PlanningQuestionAnswer = z.infer<typeof PlanningQuestionAnswerSchema>;
export type PlanningClarificationAnswerCommand = z.infer<
  typeof PlanningClarificationAnswerCommandSchema
>;
export type WorkflowChangeRequest = z.infer<typeof WorkflowChangeRequestSchema>;
export type ImplementationPlanningDecision = z.infer<typeof ImplementationPlanningDecisionSchema>;
export type ImplementationPlannerContext = z.infer<typeof ImplementationPlannerContextSchema>;
