import { z } from 'zod';

import { CompletionEvidenceSchema } from '../blocks/contracts.js';
import { JiraIssueKeySchema } from '../integrations/jira/contracts.js';
import { AgentInvocationUsageSchema } from '../providers/agent-usage.js';
import { WorkflowAnalyzerReceiptSchema } from '../providers/contracts.js';
import { JiraRepositoryBindingSchema } from '../repositories/contracts.js';
import { TaskRunPublicStateSchema } from '../temporal/public-state.js';
import {
  PlanningClarificationAnswerCommandSchema,
  PlanningStrategyRequestSchema,
} from '../planning/implementation-plan.js';
import { JsonValueSchema } from '../workflow/schema.js';
import { PlanningTranscriptViewSchema } from './planning-transcript.js';

export const OPERATOR_VIEW_SCHEMA_VERSION = 6;

export const PlanningTaskSummarySchema = z
  .object({
    reference: z.string().min(1),
    title: z.string().min(1),
    kind: z.enum(['bug', 'feature', 'task', 'other']),
  })
  .strict();

export const WorkflowValidationIssueViewSchema = z
  .object({
    code: z.string().min(1),
    message: z.string().min(1),
    path: z.array(z.union([z.string(), z.number()])),
    details: JsonValueSchema.optional(),
  })
  .strict();

export const WorkflowAssemblyDecisionViewSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    source: z.string().min(1),
    reason: z.string().min(1),
    effect: z.string().min(1),
  })
  .strict();

export const WorkflowNodeStatusSchema = z.enum([
  'planned',
  'running',
  'waiting',
  'succeeded',
  'skipped',
  'failed',
]);

export const BlockReceiptSummarySchema = z
  .object({
    receiptId: z.string().min(1),
    blockRun: z.number().int().positive(),
    claimStatus: z.enum([
      'candidate_complete',
      'needs_input',
      'continuation_required',
      'blocked',
      'failed',
    ]),
    verdict: z.enum(['accepted', 'rejected']),
    summary: z.string().min(1),
    evidence: z.array(CompletionEvidenceSchema),
    transcriptReference: z.string().min(1).nullable(),
    usageReference: z.string().min(1).nullable(),
    usage: AgentInvocationUsageSchema.nullable(),
    completedAt: z.iso.datetime(),
  })
  .strict()
  .readonly();

const OperatorWorkflowStepBaseSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  status: WorkflowNodeStatusSchema,
});

export const OperatorWorkflowStepSchema = z.discriminatedUnion('kind', [
  OperatorWorkflowStepBaseSchema.extend({
    kind: z.literal('agent'),
    reference: z.string().min(1),
    profile: z.string().min(1),
    skills: z.array(z.string().min(1)),
    attempts: z.number().int().nonnegative(),
    receipts: z.array(BlockReceiptSummarySchema),
  }).strict(),
  OperatorWorkflowStepBaseSchema.extend({
    kind: z.literal('process'),
    reference: z.string().min(1),
    executor: z.string().min(1),
    attempts: z.number().int().nonnegative(),
    receipts: z.array(BlockReceiptSummarySchema),
  }).strict(),
  z
    .object({
      kind: z.literal('wait'),
      id: z.string().min(1),
      label: z.string().min(1),
      status: WorkflowNodeStatusSchema,
      reference: z.string().min(1),
    })
    .strict(),
]);

export const OperatorWorkflowStageSchema = z
  .object({
    key: z.string().min(1),
    id: z.string().min(1),
    label: z.string().min(1),
    status: WorkflowNodeStatusSchema,
    steps: z.array(OperatorWorkflowStepSchema),
  })
  .strict();

export const OperatorInterventionActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('operator_guidance') }).strict(),
  z.object({ kind: z.literal('external_prerequisite') }).strict(),
  z.object({ kind: z.literal('typed_resolution') }).strict(),
]);

const OperatorWorkflowCurrentBaseSchema = {
  runtime: z.enum(['bootstrap', 'execution']),
  nodeId: z.string().min(1),
  reference: z.string().min(1).nullable(),
  blockRun: z.number().int().positive().nullable(),
  transcript: PlanningTranscriptViewSchema.nullable(),
};

export const OperatorWorkflowProjectionSchema = z
  .object({
    schemaVersion: z.literal(6),
    taskReference: z.string().min(1),
    status: z.enum(['not_started', 'running', 'waiting', 'completed']),
    activeRuntime: z.enum(['bootstrap', 'execution']).nullable(),
    activeRunId: z.string().min(1).nullable(),
    graphHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .nullable(),
    current: z
      .discriminatedUnion('status', [
        z
          .object({
            ...OperatorWorkflowCurrentBaseSchema,
            status: z.literal('running'),
            waitKind: z.null(),
            reason: z.null(),
            intervention: z.null(),
          })
          .strict(),
        z
          .object({
            ...OperatorWorkflowCurrentBaseSchema,
            status: z.literal('waiting'),
            waitKind: z.string().min(1),
            reason: z.string().min(1).nullable(),
            intervention: OperatorInterventionActionSchema,
          })
          .strict(),
      ])
      .nullable(),
    stages: z.array(OperatorWorkflowStageSchema),
  })
  .strict()
  .readonly();

export const WorkflowViewSchema = z
  .object({
    schemaVersion: z.literal(OPERATOR_VIEW_SCHEMA_VERSION),
    taskSummary: PlanningTaskSummarySchema,
    intake: z
      .object({
        id: z.string().min(1),
        status: z.enum(['accepted', 'rejected']),
        eligibility: z
          .object({
            eligible: z.boolean(),
            reason: z.string().min(1),
          })
          .strict(),
      })
      .strict(),
    task: z
      .object({
        id: z.string().min(1),
        status: z.enum(['planned', 'workflow_rejected']),
      })
      .strict(),
    workflow: z
      .object({
        proposalId: z.string().min(1),
        assemblyDecisions: z.array(WorkflowAssemblyDecisionViewSchema).min(1),
        status: z.enum(['valid', 'rejected']),
        graphHash: z.string().min(1).nullable(),
        graph: JsonValueSchema.nullable(),
        validatorReport: z
          .object({
            workflowId: z.string().min(1).optional(),
            issues: z.array(WorkflowValidationIssueViewSchema),
          })
          .strict(),
        capabilities: z
          .object({
            available: z.array(z.string().min(1)),
            required: z.array(z.string().min(1)),
          })
          .strict(),
        waits: z.array(
          z
            .object({
              nodeId: z.string().min(1),
              waitKind: z.string().min(1),
            })
            .strict(),
        ),
        expectedArtifacts: z.array(z.string().min(1)),
        verificationPlan: z
          .object({
            profile: z.enum(['build_only', 'targeted_tests', 'full_suite', 'visual_compare']),
            rationale: z.string().min(1),
          })
          .strict(),
        executable: z.boolean(),
      })
      .strict(),
    persistedAt: z.iso.datetime(),
  })
  .strict();

export const WorkflowResponseSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ready'), view: WorkflowViewSchema }).strict(),
  z.object({ status: z.literal('rejected'), view: WorkflowViewSchema }).strict(),
]);

export const ApiErrorResponseSchema = z
  .object({
    error: z.string().min(1),
    message: z.string().min(1),
  })
  .strict();

export const ExecutionRunViewSchema = TaskRunPublicStateSchema;

export const RunStartCommandSchema = z
  .object({
    settings: z
      .object({
        planReview: z.enum(['required', 'automatic']),
        planningStrategy: PlanningStrategyRequestSchema,
      })
      .strict(),
  })
  .strict();

export const DEFAULT_RUN_START_COMMAND = {
  settings: {
    planReview: 'required',
    planningStrategy: 'auto',
  },
} as const satisfies z.input<typeof RunStartCommandSchema>;

export const ResumeRunCommandSchema = z
  .object({
    expectedRunId: z.string().min(1),
    guidance: z.string().trim().min(1).max(10_000).optional(),
  })
  .strict();

export const RestartRunCommandSchema = z
  .object({
    expectedRunId: z.string().min(1),
    confirmation: z.literal('restart_from_scratch'),
  })
  .strict();

export const ExpectedRunCommandSchema = z
  .object({
    expectedRunId: z.string().min(1),
  })
  .strict();

export const PlanningClarificationSubmissionSchema =
  PlanningClarificationAnswerCommandSchema.extend({
    expectedRunId: z.string().min(1),
  }).strict();

export const CodeReviewSyncResponseSchema = z
  .object({
    status: z.enum(['pending', 'approved', 'changes_requested']),
    reviewId: z.string().min(1).nullable(),
    pullRequestUrl: z.url().nullable(),
    run: TaskRunPublicStateSchema,
  })
  .strict();

export const OperatorTaskStatusSchema = z.enum([
  'backlog',
  'planned',
  'workflow_rejected',
  'queued',
  'running',
  'plan_review',
  'waiting',
  'needs_attention',
  'code_review',
  'done',
  'failed',
]);

export const OperatorTaskOriginSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('jira'),
      issueKey: JiraIssueKeySchema,
      issueType: z.string().min(1).nullable(),
      browseUrl: z.url().nullable(),
      syncStatus: z.enum(['current', 'stale', 'unavailable']),
      repositoryBinding: JiraRepositoryBindingSchema,
    })
    .strict(),
]);

export const OperatorTaskPlanningSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('available') }).strict(),
  z
    .object({
      status: z.literal('blocked'),
      reason: z.string().min(1),
    })
    .strict(),
]);

export const OperatorTaskSummarySchema = z
  .object({
    id: z.string().min(1),
    taskId: z.string().min(1),
    title: z.string().min(1),
    origin: OperatorTaskOriginSchema,
    planning: OperatorTaskPlanningSchema,
    status: OperatorTaskStatusSchema,
    attention: z.enum(['none', 'operator']),
    currentStage: z.string().min(1),
    updatedAt: z.iso.datetime().nullable(),
  })
  .strict();

export const OperatorTaskListResponseSchema = z
  .object({
    tasks: z.array(OperatorTaskSummarySchema),
    streamCursor: z.number().int().nonnegative(),
  })
  .strict();

export const OperatorActivityEntrySchema = z
  .object({
    sequence: z.number().int().positive(),
    occurredAt: z.iso.datetime(),
    source: z.enum(['kernel', 'planner', 'agent', 'tool', 'operator']),
    level: z.enum(['info', 'warning', 'error']),
    title: z.string().min(1),
    detail: z.string().min(1),
    externalUrl: z.httpUrl().optional(),
  })
  .strict();

export const OperatorActivityResponseSchema = z
  .object({
    taskReference: z.string().min(1),
    providerSession: z.union([
      z
        .object({
          status: z.literal('not_started'),
          reason: z.literal('planning_only'),
        })
        .strict(),
      WorkflowAnalyzerReceiptSchema,
    ]),
    entries: z.array(OperatorActivityEntrySchema),
  })
  .strict();

export const OperatorStreamEventSchema = z
  .object({
    sequence: z.number().int().positive(),
    taskReference: z.string().min(1),
    eventType: z.string().min(1),
  })
  .strict();

export type PlanningTaskSummary = z.infer<typeof PlanningTaskSummarySchema>;
export type WorkflowNodeStatus = z.infer<typeof WorkflowNodeStatusSchema>;
export type BlockReceiptSummary = z.infer<typeof BlockReceiptSummarySchema>;
export type OperatorWorkflowStep = z.infer<typeof OperatorWorkflowStepSchema>;
export type OperatorWorkflowStage = z.infer<typeof OperatorWorkflowStageSchema>;
export type OperatorInterventionAction = z.infer<typeof OperatorInterventionActionSchema>;
export type OperatorWorkflowProjection = z.infer<typeof OperatorWorkflowProjectionSchema>;
export type WorkflowView = z.infer<typeof WorkflowViewSchema>;
export type WorkflowResponse = z.infer<typeof WorkflowResponseSchema>;
export type ExecutionRunView = z.infer<typeof ExecutionRunViewSchema>;
export type RunStartCommand = z.infer<typeof RunStartCommandSchema>;
export type ResumeRunCommand = z.infer<typeof ResumeRunCommandSchema>;
export type RestartRunCommand = z.infer<typeof RestartRunCommandSchema>;
export type ExpectedRunCommand = z.infer<typeof ExpectedRunCommandSchema>;
export type PlanningClarificationSubmission = z.infer<typeof PlanningClarificationSubmissionSchema>;
export type CodeReviewSyncResponse = z.infer<typeof CodeReviewSyncResponseSchema>;
export type OperatorTaskSummary = z.infer<typeof OperatorTaskSummarySchema>;
export type OperatorTaskListResponse = z.infer<typeof OperatorTaskListResponseSchema>;
export type OperatorActivityResponse = z.infer<typeof OperatorActivityResponseSchema>;
export type OperatorStreamEvent = z.infer<typeof OperatorStreamEventSchema>;
