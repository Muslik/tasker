import { z } from 'zod';

import { JsonValueSchema, NodeIdSchema, type WorkflowNodeSource } from '../workflow/schema.js';
import { EvidenceBundleSchema } from './evidence-bundle.js';
import { WorkflowAnalyzerOutputSchema } from './workflow-proposal-contracts.js';
import { PlanningTaskSnapshotSchema } from './task-snapshot.js';
import { BlockDefinitionSchema } from '../blocks/contracts.js';
import { TaskExecutionStrategySchema } from '../harness/execution-profile-contracts.js';

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

const AcceptanceVerificationWorkflowStepsSchema = z.array(NodeIdSchema).min(1).max(10);

export const AcceptanceVerificationSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('automated_test'),
      source: z.enum(['existing', 'new']),
      level: z.enum(['unit', 'integration', 'e2e', 'visual']),
      scenario: z.string().min(1).max(2_000),
      workflowStepIds: AcceptanceVerificationWorkflowStepsSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('process'),
      profile: z.string().min(1).max(160),
      scenario: z.string().min(1).max(2_000),
      workflowStepIds: AcceptanceVerificationWorkflowStepsSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('runtime_evidence'),
      scenario: z.string().min(1).max(2_000),
      evidence: z
        .array(z.enum(['video', 'image', 'log', 'structured_output']))
        .min(1)
        .max(4),
      workflowStepIds: AcceptanceVerificationWorkflowStepsSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('inspection'),
      target: z.string().min(1).max(1_000),
      expectation: z.string().min(1).max(2_000),
      workflowStepIds: AcceptanceVerificationWorkflowStepsSchema,
    })
    .strict(),
]);

export const AcceptanceCriterionSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]*$/u),
    expected: z.string().min(1).max(1_000),
    verification: z.array(AcceptanceVerificationSchema).min(1).max(10),
  })
  .strict();

export const ImplementationPlanSchema = z
  .object({
    schemaVersion: z.literal(2),
    title: z.string().min(1).max(200),
    summary: z.string().min(1).max(4_000),
    steps: z.array(ImplementationPlanStepSchema).min(1).max(30),
    assumptions: z.array(z.string().min(1).max(1_000)).max(20),
    risks: z.array(ImplementationPlanRiskSchema).max(20),
    acceptanceCriteria: z.array(AcceptanceCriterionSchema).min(1).max(30),
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

export const ImplementationPlanFollowUpSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]*$/u),
    title: z.string().min(1).max(200),
    reason: z.string().min(1).max(2_000),
  })
  .strict();

export const PrePlanInvestigationStepSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]*$/u),
    uses: z.string().regex(/^[a-z][a-z0-9_.-]*@[1-9]\d*$/u),
    with: JsonValueSchema,
  })
  .strict();

export const PrePlanInvestigationRequestSchema = z
  .object({
    reason: z.string().min(1).max(4_000),
    steps: z.array(PrePlanInvestigationStepSchema).min(1).max(5),
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

const workflowStepIds = (root: WorkflowNodeSource): ReadonlySet<string> => {
  const ids = new Set<string>();
  const visit = (node: WorkflowNodeSource): void => {
    switch (node.kind) {
      case 'step':
        ids.add(node.id);
        return;
      case 'sequence':
        node.children.forEach(visit);
        return;
      case 'branch':
        visit(node.then);
        visit(node.otherwise);
        return;
      case 'bounded_loop':
        visit(node.body);
        return;
      case 'wait':
      case 'gate':
      case 'finalize':
        return;
    }
  };
  visit(root);
  return ids;
};

export const ReadyImplementationPlanningDecisionSchema = z
  .object({
    status: z.literal('ready'),
    executionStrategy: TaskExecutionStrategySchema,
    plan: ImplementationPlanSchema,
    followUps: z.array(ImplementationPlanFollowUpSchema).max(20),
    workflow: WorkflowAnalyzerOutputSchema,
  })
  .strict();

export const validateAcceptanceVerificationLinks = (
  decision: z.infer<typeof ReadyImplementationPlanningDecisionSchema>,
): readonly string[] => {
  const criterionIds = new Set<string>();
  const stepIds = workflowStepIds(decision.workflow.source.root);
  const issues: string[] = [];
  decision.plan.acceptanceCriteria.forEach((criterion) => {
    if (criterionIds.has(criterion.id)) {
      issues.push(`Duplicate acceptance criterion id ${criterion.id}.`);
    }
    criterionIds.add(criterion.id);
    criterion.verification.forEach((verification) => {
      verification.workflowStepIds.forEach((stepId) => {
        if (!stepIds.has(stepId)) {
          issues.push(
            `Acceptance criterion ${criterion.id} references missing workflow step ${stepId}.`,
          );
        }
      });
    });
  });
  return issues;
};

export const ImplementationPlanningDecisionSchema = z.discriminatedUnion('status', [
  ReadyImplementationPlanningDecisionSchema,
  z
    .object({
      status: z.literal('needs_clarification'),
      questions: z.array(PlanningQuestionSchema).min(1).max(10),
    })
    .strict(),
  z
    .object({
      status: z.literal('investigation_required'),
      request: PrePlanInvestigationRequestSchema,
    })
    .strict(),
]);

export const ImplementationPlannerContextSchema = z
  .object({
    task: PlanningTaskSnapshotSchema,
    taskSnapshot: JsonValueSchema,
    blocks: z.array(BlockDefinitionSchema).min(1),
    evidenceBundle: EvidenceBundleSchema,
    repositoryReference: z.string().min(1),
    operatorGuidance: z.string().min(1).max(10_000).nullable(),
    validationFeedback: z.array(z.string().min(1).max(2_000)).max(50),
    previousDecision: ReadyImplementationPlanningDecisionSchema.nullable(),
  })
  .strict();

export type PlanningStrategyRequest = z.infer<typeof PlanningStrategyRequestSchema>;
export type PlanningStrategy = z.infer<typeof PlanningStrategySchema>;
export type ImplementationPlanLink = z.infer<typeof ImplementationPlanLinkSchema>;
export type ImplementationPlan = z.infer<typeof ImplementationPlanSchema>;
export type AcceptanceCriterion = z.infer<typeof AcceptanceCriterionSchema>;
export type AcceptanceVerification = z.infer<typeof AcceptanceVerificationSchema>;
export type PlanningQuestionAnswer = z.infer<typeof PlanningQuestionAnswerSchema>;
export type PlanningClarificationAnswerCommand = z.infer<
  typeof PlanningClarificationAnswerCommandSchema
>;
export type WorkflowChangeRequest = z.infer<typeof WorkflowChangeRequestSchema>;
export type PrePlanInvestigationRequest = z.infer<typeof PrePlanInvestigationRequestSchema>;
export type ReadyImplementationPlanningDecision = z.infer<
  typeof ReadyImplementationPlanningDecisionSchema
>;
export type ImplementationPlanningDecision = z.infer<typeof ImplementationPlanningDecisionSchema>;
export type ImplementationPlannerContext = z.infer<typeof ImplementationPlannerContextSchema>;
