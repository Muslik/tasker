import { z } from 'zod';

import { AgentClaimCategorySchema, CompletionEvidenceSchema } from '../blocks/contracts.js';
import { JiraIssueKeySchema } from '../integrations/jira/contracts.js';
import { AgentApiCostSchema, AgentInvocationUsageSchema } from '../observability/agent-usage.js';
import {
  AgentInvocationExitStatusSchema,
  AgentInvocationReferencesSchema,
  AgentInvocationTokenUsageSchema,
} from '../observability/agent-invocation.js';
import { WorkflowAnalyzerReceiptSchema } from '../providers/contracts.js';
import { JiraRepositoryBindingSchema } from '../repositories/contracts.js';
import { TaskRunPublicStateSchema } from '../temporal/public-state.js';
import { TaskRunSettingsSchema } from '../temporal/bootstrap-kernel/contracts.js';
import { TaskStepOutputArtifactSchema } from '../temporal/task-step-output.js';
import { TaskStepEvidenceArtifactSchema } from '../temporal/task-step-evidence-contracts.js';
import { PlanningClarificationAnswerCommandSchema } from '../planning/implementation-plan.js';
import { JsonValueSchema } from '../workflow/schema.js';
import {
  DependencyDeclarationModeSchema,
  DependencyPackageNameSchema,
} from './dependency-contracts.js';
import { PlanningTranscriptViewSchema } from './planning-transcript.js';

export const OPERATOR_VIEW_SCHEMA_VERSION = 7;
export const OPERATOR_WORKFLOW_PROJECTION_SCHEMA_VERSION = 9;

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
    verdict: z.enum(['accepted', 'rejected', 'waiting']),
    summary: z.string().min(1),
    category: AgentClaimCategorySchema.optional(),
    retryable: z.boolean().optional(),
    evidence: z.array(CompletionEvidenceSchema),
    transcriptReference: z.string().min(1).nullable(),
    usageReference: z.string().min(1).nullable(),
    usage: AgentInvocationUsageSchema.nullable(),
    completedAt: z.iso.datetime(),
  })
  .strict()
  .readonly();

export const OperatorEvidenceArtifactSchema = TaskStepEvidenceArtifactSchema.extend({
  artifactId: z.string().min(1),
}).strict();

const OperatorWorkspaceChangesSchema = z
  .object({
    changed: z.boolean(),
    fingerprint: z.string().min(1),
    trackedDiffSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .nullable(),
    paths: z.array(z.object({ status: z.string().length(2), path: z.string().min(1) }).strict()),
    truncated: z.boolean(),
  })
  .strict();

export const OperatorExecutionAttemptSchema = z
  .object({
    schemaVersion: z.literal(1),
    taskReference: z.string().min(1),
    workflowId: z.string().min(1),
    workflowRunId: z.string().min(1),
    nodeId: z.string().min(1),
    blockRun: z.number().int().positive(),
    transcript: PlanningTranscriptViewSchema.nullable(),
    output: TaskStepOutputArtifactSchema.nullable(),
    evidence: z.array(OperatorEvidenceArtifactSchema),
    workspaceChanges: OperatorWorkspaceChangesSchema.nullable(),
  })
  .strict()
  .readonly();

export const OperatorRunLogEntrySchema = z
  .object({
    id: z.string().min(1),
    runtime: z.enum(['bootstrap', 'execution']),
    nodeId: z.string().min(1),
    reference: z.string().min(1),
    blockRun: z.number().int().positive(),
    status: z.enum(['running', 'completed', 'blocked', 'workflow_change_required']),
    startedAt: z.iso.datetime().nullable(),
    completedAt: z.iso.datetime().nullable(),
    rawLog: z.string(),
    truncated: z.boolean(),
    runner: z.string().min(1).nullable(),
    resultSummary: z.string().min(1).nullable(),
    usage: AgentInvocationUsageSchema.nullable(),
    evidence: z.array(OperatorEvidenceArtifactSchema),
    workspaceChanges: OperatorWorkspaceChangesSchema.nullable(),
  })
  .strict()
  .readonly();

export const OperatorRunLogResponseSchema = z
  .object({
    schemaVersion: z.literal(1),
    taskReference: z.string().min(1),
    bootstrapRunId: z.string().min(1),
    executionRunId: z.string().min(1).nullable(),
    entries: z.array(OperatorRunLogEntrySchema),
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

const OperatorWorkflowContinuationBaseSchema = z
  .object({
    continuationId: z.string().min(1),
    attempt: z.number().int().positive(),
    parentNodeId: z.string().min(1),
    reason: z.string().min(1),
    transcriptOperationId: z.string().min(1),
  })
  .strict();

export const OperatorWorkflowContinuationSchema = z.union([
  OperatorWorkflowContinuationBaseSchema.extend({
    status: z.enum(['planning', 'needs_input']),
  }).strict(),
  OperatorWorkflowContinuationBaseSchema.extend({
    usage: AgentInvocationUsageSchema,
    semanticHash: z.string().regex(/^[a-f0-9]{64}$/u),
    workflowHash: z.string().regex(/^[a-f0-9]{64}$/u),
    status: z.enum(['awaiting_review', 'rejected', 'running', 'completed']),
  }).strict(),
]);

export const OperatorInterventionActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('operator_guidance') }).strict(),
  z.object({ kind: z.literal('external_prerequisite') }).strict(),
  z.object({ kind: z.literal('retry_step') }).strict(),
  z
    .object({
      kind: z.literal('typed_resolution'),
      waitKind: z.string().min(1),
      details: z
        .union([
          z
            .object({
              kind: z.literal('dependency_available'),
              declarationId: z.string().min(1),
              declarationRevision: z.number().int().positive(),
              channel: z.enum(['dev', 'final']),
              packages: z.array(DependencyPackageNameSchema).min(1),
              observation: z.discriminatedUnion('status', [
                z
                  .object({
                    status: z.literal('missing'),
                    observationId: z.null(),
                    observedAt: z.null(),
                    provenance: z.null(),
                    packages: z.array(z.never()).length(0),
                  })
                  .strict(),
                z
                  .object({
                    status: z.literal('recorded'),
                    observationId: z.string().min(1),
                    observedAt: z.iso.datetime(),
                    provenance: z
                      .object({
                        kind: z.literal('loop'),
                        postId: z.string().min(1),
                        url: z.url().optional(),
                      })
                      .strict()
                      .nullable(),
                    packages: z.array(
                      z
                        .object({
                          name: DependencyPackageNameSchema,
                          version: z.string().min(1),
                          registry: z.url(),
                          tarballUrl: z.url(),
                          integrity: z.string().min(1),
                        })
                        .strict(),
                    ),
                  })
                  .strict(),
              ]),
            })
            .strict(),
          z
            .object({
              kind: z.literal('dependency_discovery'),
              requestArtifactId: z.string().min(1),
              requestedRepository: z.string().min(1),
              requestedOutcome: z.string().min(1),
              componentPath: z.string().min(1).nullable(),
              expectedPackage: DependencyPackageNameSchema.nullable(),
              declaration: z.discriminatedUnion('status', [
                z
                  .object({
                    status: z.literal('missing'),
                    declarationId: z.null(),
                    declarationRevision: z.null(),
                    producerTaskReference: z.null(),
                    producerRepository: z.null(),
                    packages: z.array(z.never()).length(0),
                    mode: z.null(),
                  })
                  .strict(),
                z
                  .object({
                    status: z.literal('recorded'),
                    declarationId: z.string().min(1),
                    declarationRevision: z.number().int().positive(),
                    producerTaskReference: z.string().min(1),
                    producerRepository: z.string().min(1),
                    packages: z.array(DependencyPackageNameSchema).min(1),
                    mode: DependencyDeclarationModeSchema,
                  })
                  .strict(),
              ]),
            })
            .strict(),
        ])
        .nullable(),
    })
    .strict(),
]);

const OperatorWorkflowCurrentBaseSchema = {
  runtime: z.enum(['bootstrap', 'execution']),
  nodeId: z.string().min(1),
  reference: z.string().min(1).nullable(),
  blockRun: z.number().int().positive().nullable(),
  transcript: PlanningTranscriptViewSchema.nullable(),
};

export const OperatorWorkflowCurrentAttemptSchema = z
  .object({
    latestInvocationId: z.string().min(1),
    nodeId: z.string().min(1),
    blockRun: z.number().int().positive(),
    startedAt: z.iso.datetime(),
    waitingSince: z.iso.datetime().nullable(),
  })
  .strict()
  .readonly();

export const OperatorWorkflowProjectionSchema = z
  .object({
    schemaVersion: z.literal(OPERATOR_WORKFLOW_PROJECTION_SCHEMA_VERSION),
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
    currentAttempt: OperatorWorkflowCurrentAttemptSchema.nullable(),
    dependencies: z.array(
      z
        .object({
          declarationId: z.string().min(1),
          revision: z.number().int().positive(),
          producerTaskReference: z.string().min(1),
          producerRepository: z.string().min(1),
          packages: z.array(DependencyPackageNameSchema).min(1),
          mode: DependencyDeclarationModeSchema,
          source: z.discriminatedUnion('kind', [
            z
              .object({
                kind: z.literal('jira_link'),
                linkId: z.string().min(1),
                linkTypeId: z.string().min(1),
                direction: z.enum(['inward', 'outward']),
              })
              .strict(),
            z
              .object({
                kind: z.literal('runtime_discovery'),
                workflowRunId: z.string().min(1),
                requestArtifactId: z.string().min(1),
              })
              .strict(),
          ]),
          createdAt: z.iso.datetime(),
        })
        .strict(),
    ),
    stages: z.array(OperatorWorkflowStageSchema),
    continuations: z.array(OperatorWorkflowContinuationSchema),
  })
  .strict()
  .readonly();

export const OperatorTaskInvocationListRowSchema = z
  .object({
    invocationId: z.string().min(1),
    taskReference: z.string().min(1),
    scope: z.enum(['execution', 'planning']),
    nodeId: z.string().min(1).nullable(),
    planningEpisodeId: z.string().min(1).nullable(),
    blockRun: z.number().int().positive().nullable(),
    provider: z.enum(['codex', 'claude']),
    profile: z.string().min(1),
    model: z.string().min(1),
    effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']),
    serviceTier: z.enum(['fast', 'flex']).nullable(),
    promptBytes: z.number().int().nonnegative(),
    durationMs: z.number().nonnegative(),
    status: z.enum(['completed', 'waiting', 'failed']),
    startedAt: z.iso.datetime(),
    finishedAt: z.iso.datetime(),
    usage: AgentInvocationTokenUsageSchema,
    cost: AgentApiCostSchema,
  })
  .strict()
  .readonly();

export const OperatorTaskInvocationTotalsSchema = z
  .object({
    invocationCount: z.number().int().nonnegative(),
    inputTokens: z.number().int().nonnegative(),
    cachedInputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    reasoningOutputTokens: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
    costUsd: z.number().nonnegative(),
    unratedCount: z.number().int().nonnegative(),
  })
  .strict()
  .readonly();

export const OperatorTaskInvocationListResponseSchema = z
  .object({
    schemaVersion: z.literal(1),
    taskReference: z.string().min(1),
    invocations: z.array(OperatorTaskInvocationListRowSchema),
    totals: OperatorTaskInvocationTotalsSchema,
  })
  .strict()
  .readonly();

export const OperatorTaskInvocationDetailSchema = z
  .object({
    schemaVersion: z.literal(1),
    invocationId: z.string().min(1),
    taskReference: z.string().min(1),
    prompt: z.string(),
    promptBytes: z.number().int().nonnegative(),
    provider: z.enum(['codex', 'claude']),
    profile: z.string().min(1),
    profileSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    model: z.string().min(1),
    effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']),
    serviceTier: z.enum(['fast', 'flex']).nullable(),
    argv: z.array(z.string()).min(1),
    skills: z.array(z.string().min(1)),
    inputEvidenceArtifactIds: z.array(z.string().min(1)),
    startedAt: z.iso.datetime(),
    finishedAt: z.iso.datetime(),
    durationMs: z.number().nonnegative(),
    status: z.enum(['completed', 'waiting', 'failed']),
    exitStatus: AgentInvocationExitStatusSchema,
    usage: AgentInvocationTokenUsageSchema,
    cost: AgentApiCostSchema,
    references: AgentInvocationReferencesSchema,
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
        semanticHash: z
          .string()
          .regex(/^[a-f0-9]{64}$/u)
          .nullable(),
        semanticSource: JsonValueSchema.nullable(),
        compilerVersion: z.string().min(1).nullable(),
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
    settings: TaskRunSettingsSchema,
  })
  .strict();

export const DEFAULT_RUN_START_COMMAND = {
  settings: {
    planReview: 'required',
    planningStrategy: 'auto',
    trackerStatusUpdates: 'enabled',
  },
} as const satisfies z.input<typeof RunStartCommandSchema>;

export const ResumeRunCommandSchema = z
  .object({
    expectedRunId: z.string().min(1),
    guidance: z.string().trim().min(1).max(10_000).optional(),
    dismissWorkflowChange: z.literal(true).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.dismissWorkflowChange === true && value.guidance === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['guidance'],
        message: 'Dismissing a workflow change requires a reason',
      });
    }
  });

export const ConfigureTaskDependencyCommandSchema = z
  .object({
    consumerTaskReference: z.string().min(1),
    producerTaskReference: z.string().min(1),
    producerRepository: z.string().min(1),
    packages: z
      .array(DependencyPackageNameSchema)
      .min(1)
      .superRefine((packages, context) => {
        const seen = new Set<string>();
        for (const [index, packageName] of packages.entries()) {
          if (seen.has(packageName)) {
            context.addIssue({
              code: 'custom',
              message: `Duplicate package name "${packageName}"`,
              path: [index],
            });
          }
          seen.add(packageName);
        }
      }),
    mode: DependencyDeclarationModeSchema,
    source: z
      .object({
        kind: z.literal('jira_link'),
        linkId: z.string().min(1),
        linkTypeId: z.string().min(1),
        direction: z.enum(['inward', 'outward']),
      })
      .strict(),
  })
  .strict();

export const DependencyAvailableCommandSchema = z
  .object({
    expectedRunId: z.string().min(1),
    nodeId: z.string().min(1),
    waitKind: z.literal('dependency.available@1'),
    declarationId: z.string().min(1),
    declarationRevision: z.number().int().positive(),
    channel: z.enum(['dev', 'final']),
    packages: z
      .array(
        z
          .object({
            name: DependencyPackageNameSchema,
            version: z.string().trim().min(1),
          })
          .strict(),
      )
      .min(1)
      .superRefine((packages, context) => {
        const seen = new Set<string>();
        for (const [index, item] of packages.entries()) {
          if (seen.has(item.name)) {
            context.addIssue({
              code: 'custom',
              message: `Duplicate package name "${item.name}"`,
              path: [index, 'name'],
            });
          }
          seen.add(item.name);
        }
      }),
    provenance: z
      .object({
        kind: z.literal('loop'),
        postId: z.string().min(1),
        url: z.url().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const DependencyDiscoveryCommandSchema = z
  .object({
    expectedRunId: z.string().min(1),
    nodeId: z.string().min(1),
    waitKind: z.literal('dependency.discovery@1'),
    requestArtifactId: z.string().min(1),
    producerTaskReference: z.string().min(1),
    producerRepository: z.string().min(1),
    packages: z
      .array(DependencyPackageNameSchema)
      .min(1)
      .superRefine((packages, context) => {
        const seen = new Set<string>();
        for (const [index, packageName] of packages.entries()) {
          if (seen.has(packageName)) {
            context.addIssue({
              code: 'custom',
              message: `Duplicate package name "${packageName}"`,
              path: [index],
            });
          }
          seen.add(packageName);
        }
      }),
    mode: DependencyDeclarationModeSchema,
  })
  .strict();

export const WorkflowChangeReviewCommandSchema = z.discriminatedUnion('decision', [
  z
    .object({
      expectedRunId: z.string().min(1),
      continuationId: z.string().min(1),
      decision: z.literal('accept'),
    })
    .strict(),
  z
    .object({
      expectedRunId: z.string().min(1),
      continuationId: z.string().min(1),
      decision: z.literal('reject'),
      guidance: z.string().trim().min(1).max(10_000),
    })
    .strict(),
]);

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
export type OperatorExecutionAttempt = z.infer<typeof OperatorExecutionAttemptSchema>;
export type OperatorRunLogEntry = z.infer<typeof OperatorRunLogEntrySchema>;
export type OperatorRunLogResponse = z.infer<typeof OperatorRunLogResponseSchema>;
export type BlockReceiptSummary = z.infer<typeof BlockReceiptSummarySchema>;
export type OperatorWorkflowStep = z.infer<typeof OperatorWorkflowStepSchema>;
export type OperatorWorkflowStage = z.infer<typeof OperatorWorkflowStageSchema>;
export type OperatorWorkflowContinuation = z.infer<typeof OperatorWorkflowContinuationSchema>;
export type OperatorInterventionAction = z.infer<typeof OperatorInterventionActionSchema>;
export type OperatorWorkflowProjection = z.infer<typeof OperatorWorkflowProjectionSchema>;
export type OperatorWorkflowCurrentAttempt = z.infer<typeof OperatorWorkflowCurrentAttemptSchema>;
export type WorkflowView = z.infer<typeof WorkflowViewSchema>;
export type WorkflowResponse = z.infer<typeof WorkflowResponseSchema>;
export type ExecutionRunView = z.infer<typeof ExecutionRunViewSchema>;
export type RunStartCommand = z.infer<typeof RunStartCommandSchema>;
export type ResumeRunCommand = z.infer<typeof ResumeRunCommandSchema>;
export type ConfigureTaskDependencyCommand = z.infer<typeof ConfigureTaskDependencyCommandSchema>;
export type DependencyAvailableCommand = z.infer<typeof DependencyAvailableCommandSchema>;
export type DependencyDiscoveryCommand = z.infer<typeof DependencyDiscoveryCommandSchema>;
export type WorkflowChangeReviewCommand = z.infer<typeof WorkflowChangeReviewCommandSchema>;
export type RestartRunCommand = z.infer<typeof RestartRunCommandSchema>;
export type ExpectedRunCommand = z.infer<typeof ExpectedRunCommandSchema>;
export type PlanningClarificationSubmission = z.infer<typeof PlanningClarificationSubmissionSchema>;
export type CodeReviewSyncResponse = z.infer<typeof CodeReviewSyncResponseSchema>;
export type OperatorTaskSummary = z.infer<typeof OperatorTaskSummarySchema>;
export type OperatorTaskListResponse = z.infer<typeof OperatorTaskListResponseSchema>;
export type OperatorActivityResponse = z.infer<typeof OperatorActivityResponseSchema>;
export type OperatorStreamEvent = z.infer<typeof OperatorStreamEventSchema>;
export type OperatorTaskInvocationListRow = z.infer<typeof OperatorTaskInvocationListRowSchema>;
export type OperatorTaskInvocationTotals = z.infer<typeof OperatorTaskInvocationTotalsSchema>;
export type OperatorTaskInvocationListResponse = z.infer<
  typeof OperatorTaskInvocationListResponseSchema
>;
export type OperatorTaskInvocationDetail = z.infer<typeof OperatorTaskInvocationDetailSchema>;
