import { readFile } from 'node:fs/promises';
import { extname, join, relative, resolve } from 'node:path';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import { z } from 'zod';

import {
  ImplementationPlanningRecordSchema,
  type ImplementationPlanningCoordinator,
  type ImplementationPlanningRecord,
} from './implementation-planning.js';
import { PlanningTranscriptViewSchema } from './planning-transcript.js';
import {
  WorkflowContinuationRecordSchema,
  WorkflowContinuationReviewCommandSchema,
  type WorkflowContinuationCoordinator,
  type WorkflowContinuationError,
  type WorkflowContinuationRecord,
} from './workflow-continuation.js';
import type { JiraIssueService, JiraIssueServiceError } from '../integrations/index.js';
import {
  RepositoryCatalogResponseSchema,
  RepositoryReferenceSchema,
} from '../repositories/contracts.js';
import { PlanningClarificationAnswerCommandSchema } from '../planning/implementation-plan.js';
import {
  ApiErrorResponseSchema,
  ExecutionRunViewSchema,
  OperatorActivityResponseSchema,
  OperatorTaskSummarySchema,
  WorkflowResponseSchema,
  type OperatorTaskSummary,
  type WorkflowResponse,
  type WorkflowTreeNode,
} from './m1-contracts.js';
import {
  DEFAULT_RUN_START_COMMAND,
  type DurableStubScheduler,
  PlanReviewCommandSchema,
  RunProjectionSchema,
  RunStartCommandSchema,
  type DeterministicStubRunService,
  type RunProjection,
  type StubRunError,
} from '../runner/index.js';
import type { M1ServiceError, M1WorkflowService } from './m1-service.js';
import { providerFailureSummary, type WorkflowGenerator } from './workflow-generator.js';
import {
  type TaskTemporalRunService,
  type TaskWorkflowPublicState,
  type TemporalRunError,
} from '../temporal/index.js';
import { CompiledWorkflowSchema } from '../workflow/index.js';

const FixtureParamsSchema = z.object({ fixtureId: z.string().min(1) }).strict();
const JiraIssueParamsSchema = z.object({ issueKey: z.string().min(1) }).strict();
const JiraSyncBodySchema = z.object({ repository: RepositoryReferenceSchema.optional() }).strict();
const JiraAttachmentParamsSchema = z
  .object({ issueKey: z.string().min(1), attachmentId: z.string().min(1) })
  .strict();
const ProjectionParamsSchema = z.object({ projectionId: z.string().min(1) }).strict();
const AssetParamsSchema = z.object({ '*': z.string().min(1) }).strict();
const StreamQuerySchema = z
  .object({ after: z.coerce.number().int().nonnegative().optional() })
  .strict();

interface BuildM1ApiCommonOptions {
  readonly service: M1WorkflowService;
  readonly cockpitDirectory?: string | undefined;
  readonly logger?: boolean | undefined;
  readonly workflowGenerator?: WorkflowGenerator | undefined;
  readonly jiraIssueService?: JiraIssueService | undefined;
  readonly implementationPlanning?: ImplementationPlanningCoordinator | undefined;
  readonly workflowContinuation?: WorkflowContinuationCoordinator | undefined;
}

type ExecutionRuntimeOptions =
  | {
      readonly runService?: undefined;
      readonly scheduler?: undefined;
      readonly temporalRunService?: undefined;
    }
  | {
      readonly runService: DeterministicStubRunService;
      readonly scheduler?: DurableStubScheduler | undefined;
      readonly temporalRunService?: undefined;
    }
  | {
      readonly runService?: undefined;
      readonly scheduler?: undefined;
      readonly temporalRunService: TaskTemporalRunService;
    };

export type BuildM1ApiOptions = BuildM1ApiCommonOptions & ExecutionRuntimeOptions;

const apiError = (error: string, message: string) =>
  ApiErrorResponseSchema.parse({ error, message });

const sendServiceError = (reply: FastifyReply, error: M1ServiceError): FastifyReply => {
  switch (error.kind) {
    case 'fixture_not_found':
      return reply
        .code(404)
        .send(apiError('fixture_not_found', `Fixture ${error.fixtureId} does not exist`));
    case 'task_not_found':
      return reply
        .code(404)
        .send(apiError('task_not_found', `Task ${error.taskReference} does not exist`));
    case 'generation_blocked':
      return reply.code(409).send(apiError('generation_blocked', error.reason));
    case 'planner_contract_failure':
      return reply
        .code(500)
        .send(apiError('planner_contract_failure', `Planner stopped at ${error.stage}`));
    case 'non_json_artifact':
      return reply
        .code(500)
        .send(apiError('non_json_artifact', `Planner produced non-JSON ${error.artifact}`));
    case 'store_failure':
      return reply
        .code(500)
        .send(
          apiError('store_failure', `Ledger could not serve the workflow: ${error.error.kind}`),
        );
    case 'provider_failure':
      return reply
        .code(502)
        .send(apiError('provider_failure', providerFailureSummary(error.failure)));
  }
};

const sendJiraServiceError = (reply: FastifyReply, error: JiraIssueServiceError): FastifyReply => {
  switch (error.kind) {
    case 'invalid_issue_key':
      return reply
        .code(400)
        .send(apiError('invalid_issue_key', 'Use a Jira key such as AVIA-13235'));
    case 'issue_not_imported':
      return reply
        .code(404)
        .send(apiError('jira_issue_not_imported', 'Import the Jira issue first'));
    case 'attachment_not_found':
      return reply.code(404).send(apiError('jira_attachment_not_found', 'Attachment not found'));
    case 'attachment_unavailable':
      return reply
        .code(error.retryable ? 503 : 422)
        .send(apiError('jira_attachment_unavailable', error.message));
    case 'store_failure':
      return reply.code(500).send(apiError('jira_store_failure', error.error.kind));
  }
};

const sendRunError = (reply: FastifyReply, error: StubRunError): FastifyReply => {
  switch (error.kind) {
    case 'workflow_not_found':
      return reply.code(404).send(apiError(error.kind, 'Generate this workflow first'));
    case 'workflow_not_executable':
      return reply.code(409).send(apiError(error.kind, 'Only a valid compiled workflow can start'));
    case 'run_not_found':
      return reply.code(404).send(apiError(error.kind, 'This workflow has not started'));
    case 'run_not_waiting':
      return reply.code(409).send(apiError(error.kind, 'The run is not waiting for a signal'));
    case 'run_settings_conflict':
      return reply
        .code(409)
        .send(apiError(error.kind, 'This run already exists with different immutable settings'));
    case 'run_not_at_plan_review':
      return reply.code(409).send(apiError(error.kind, 'The run is not waiting for plan review'));
    case 'run_not_at_planning_clarification':
      return reply
        .code(409)
        .send(apiError(error.kind, 'The run is not waiting for planning clarification'));
    case 'run_not_at_workflow_continuation':
      return reply
        .code(409)
        .send(apiError(error.kind, 'The run is not waiting for workflow continuation review'));
    case 'linked_run_conflict':
      return reply
        .code(409)
        .send(apiError(error.kind, 'The continuation task is already linked to another run'));
    case 'plan_revision_target_not_found':
      return reply
        .code(409)
        .send(apiError(error.kind, 'The workflow has no revisable planning step'));
    case 'projection_corrupt':
      return reply.code(500).send(apiError(error.kind, 'The persisted run projection is invalid'));
    case 'ledger_conflict':
      return reply.code(409).send(apiError(error.kind, 'The run changed concurrently; reload it'));
  }
};

const sendTemporalRunError = (reply: FastifyReply, error: TemporalRunError): FastifyReply => {
  switch (error.kind) {
    case 'run_not_found':
      return reply.code(404).send(apiError(error.kind, 'This workflow has not started'));
    case 'run_settings_conflict':
      return reply
        .code(409)
        .send(apiError(error.kind, 'This run already exists with different immutable settings'));
    case 'planning_snapshot_unavailable':
      return reply.code(503).send(apiError(error.kind, error.message));
    case 'runtime_unavailable':
      return reply.code(503).send(apiError(error.kind, error.message));
  }
};

const sendContinuationError = (
  reply: FastifyReply,
  error: WorkflowContinuationError,
): FastifyReply => {
  switch (error.kind) {
    case 'parent_workflow_not_ready':
      return reply
        .code(409)
        .send(apiError(error.kind, 'The parent workflow is not ready for continuation'));
    case 'subject':
      return reply
        .code(503)
        .send(apiError('workflow_continuation_subject_failed', error.error.kind));
    case 'store':
      return reply
        .code(
          error.error.kind === 'continuation_not_reviewable' ||
            error.error.kind === 'continuation_not_linkable' ||
            error.error.kind === 'continuation_not_resolvable' ||
            error.error.kind === 'continuation_not_retryable'
            ? 409
            : 500,
        )
        .send(apiError('workflow_continuation_store_failed', error.error.kind));
  }
};

const applyRunToTask = (
  task: OperatorTaskSummary,
  run: RunProjection | null,
): OperatorTaskSummary => {
  if (run === null) return task;
  if (run.status === 'queued') {
    return OperatorTaskSummarySchema.parse({
      ...task,
      status: 'queued',
      attention: 'none',
      currentStage: 'Queued for stub capacity',
      updatedAt: run.updatedAt,
    });
  }
  if (run.status === 'executing') {
    return OperatorTaskSummarySchema.parse({
      ...task,
      status: 'running',
      attention: 'none',
      currentStage: 'Executing deterministic stub workflow',
      updatedAt: run.updatedAt,
    });
  }
  if (run.status === 'waiting') {
    const codeReview = run.wait.waitKind === 'code_review@1';
    const planReview = run.wait.waitKind === 'plan.approved@1';
    return OperatorTaskSummarySchema.parse({
      ...task,
      status: codeReview ? 'code_review' : planReview ? 'plan_review' : 'waiting',
      attention: 'operator',
      currentStage: codeReview
        ? 'Waiting for code review'
        : planReview
          ? 'Plan review required'
          : `Waiting for ${run.wait.waitKind.replace('@1', '').replaceAll('_', ' ')}`,
      updatedAt: run.updatedAt,
    });
  }
  return OperatorTaskSummarySchema.parse({
    ...task,
    status: 'done',
    attention: 'none',
    currentStage: 'Workflow completed',
    updatedAt: run.updatedAt,
  });
};

const applyTemporalRunToTask = (
  task: OperatorTaskSummary,
  run: TaskWorkflowPublicState | null,
): OperatorTaskSummary => {
  if (run === null) return task;

  switch (run.status) {
    case 'running':
      return OperatorTaskSummarySchema.parse({
        ...task,
        status: 'running',
        attention: 'none',
        currentStage:
          run.currentNodeId === null ? 'Temporal workflow running' : `Running ${run.currentNodeId}`,
      });
    case 'waiting': {
      const codeReview = run.wait.waitKind === 'code_review@1';
      const planReview = run.wait.waitKind === 'plan.approved@1';
      return OperatorTaskSummarySchema.parse({
        ...task,
        status: codeReview ? 'code_review' : planReview ? 'plan_review' : 'waiting',
        attention: 'operator',
        currentStage: codeReview
          ? 'Waiting for code review'
          : planReview
            ? 'Plan review required'
            : `Waiting for ${run.wait.waitKind.replace('@1', '').replaceAll('_', ' ')}`,
      });
    }
    case 'completed':
      return OperatorTaskSummarySchema.parse({
        ...task,
        status: 'done',
        attention: 'none',
        currentStage: `Workflow completed · ${run.outcome}`,
      });
    case 'unavailable':
      return OperatorTaskSummarySchema.parse({
        ...task,
        status: 'needs_attention',
        attention: 'operator',
        currentStage: 'Temporal runtime unavailable',
      });
  }
};

const decorateTreeWithTemporalState = (
  node: WorkflowTreeNode,
  run: TaskWorkflowPublicState,
): WorkflowTreeNode => ({
  ...node,
  status: run.nodeStates[node.id] ?? node.status,
  children: node.children.map((child) => decorateTreeWithTemporalState(child, run)),
});

const decorateWorkflowWithTemporalState = (
  workflow: WorkflowResponse,
  run: TaskWorkflowPublicState | null,
): WorkflowResponse => {
  if (run === null || workflow.view.workflow.tree === null) return workflow;

  return WorkflowResponseSchema.parse({
    ...workflow,
    view: {
      ...workflow.view,
      workflow: {
        ...workflow.view.workflow,
        tree: decorateTreeWithTemporalState(workflow.view.workflow.tree, run),
      },
    },
  });
};

const contentType = (filename: string): string => {
  switch (extname(filename)) {
    case '.css':
      return 'text/css; charset=utf-8';
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
      return 'text/javascript; charset=utf-8';
    case '.svg':
      return 'image/svg+xml';
    default:
      return 'application/octet-stream';
  }
};

const resolveCockpitAsset = (directory: string, asset: string): string | null => {
  const root = resolve(directory);
  const filename = resolve(join(root, 'assets', asset));
  const pathFromRoot = relative(root, filename);

  return pathFromRoot.startsWith('..') || pathFromRoot.length === 0 ? null : filename;
};

export const buildM1Api = (options: BuildM1ApiOptions): FastifyInstance => {
  const api = Fastify({ logger: options.logger ?? false });
  const executionRuntime =
    options.temporalRunService !== undefined
      ? 'temporal'
      : options.runService !== undefined
        ? 'legacy_stub'
        : 'disabled';

  const readContinuation = (taskReference: string): WorkflowContinuationRecord | null => {
    const result = options.workflowContinuation?.read(taskReference);
    return result?.ok === true ? result.value : null;
  };

  const linkedRunActivity = (taskReference: string) => {
    const continuation = readContinuation(taskReference);
    return continuation?.status === 'linked'
      ? (options.runService?.readActivity(continuation.child.taskReference) ?? [])
      : [];
  };

  const openWorkflowContinuation = async (
    taskReference: string,
    settings: RunProjection['settings'],
    planning: Extract<
      ImplementationPlanningRecord,
      { readonly status: 'workflow_change_required' }
    >,
    reply: FastifyReply,
  ): Promise<FastifyReply> => {
    if (options.runService === undefined || options.workflowContinuation === undefined) {
      return reply
        .code(409)
        .send(apiError('workflow_change_required', planning.decision.request.reason));
    }
    const waiting = options.runService.openWorkflowContinuation(taskReference, settings, {
      attempt: planning.attempt,
      artifactId: planning.artifactId,
    });
    if (!waiting.ok) return sendRunError(reply, waiting.error);
    const proposed = await options.workflowContinuation.proposeFromPlanning(
      taskReference,
      waiting.value.runId,
      planning,
    );
    return proposed.ok
      ? reply.send(RunProjectionSchema.parse(waiting.value))
      : sendContinuationError(reply, proposed.error);
  };

  const reviseWorkflowContinuation = async (
    taskReference: string,
    rejected: Extract<WorkflowContinuationRecord, { readonly status: 'rejected_by_operator' }>,
    reply: FastifyReply,
  ): Promise<FastifyReply> => {
    if (
      options.runService === undefined ||
      options.implementationPlanning === undefined ||
      options.workflowContinuation === undefined
    ) {
      return reply
        .code(503)
        .send(apiError('implementation_planning_not_configured', 'Planning is disabled'));
    }
    const currentRun = options.runService.read(taskReference);
    if (!currentRun.ok) return sendRunError(reply, currentRun.error);
    if (
      currentRun.value === null ||
      currentRun.value.status !== 'waiting' ||
      currentRun.value.wait.waitKind !== 'workflow_continuation_review'
    ) {
      return sendRunError(reply, {
        kind: 'run_not_at_workflow_continuation',
        taskReference,
      });
    }

    const planned = await options.implementationPlanning.prepare(
      taskReference,
      currentRun.value.settings.planningStrategy,
      rejected.guidance,
    );
    if (!planned.ok) {
      return reply
        .code(503)
        .send(
          apiError('implementation_planning_failed', `Planning stopped: ${planned.error.kind}`),
        );
    }
    if (planned.value.status === 'planning') {
      return reply
        .code(409)
        .send(apiError('implementation_planning_in_progress', 'Planning is still running'));
    }
    if (planned.value.status === 'failed') {
      // The failed planning attempt is already durable. Returning the rejected record keeps
      // this operator command retryable instead of disguising a domain wait as a transport loss.
      return reply.send(WorkflowContinuationRecordSchema.parse(rejected));
    }
    if (planned.value.status === 'needs_clarification') {
      const waiting = options.runService.openPlanningClarification(
        taskReference,
        currentRun.value.settings,
        { attempt: planned.value.attempt, artifactId: planned.value.artifactId },
      );
      return waiting.ok
        ? reply.send(WorkflowContinuationRecordSchema.parse(rejected))
        : sendRunError(reply, waiting.error);
    }
    if (planned.value.status === 'workflow_change_required') {
      const waiting = options.runService.openWorkflowContinuation(
        taskReference,
        currentRun.value.settings,
        { attempt: planned.value.attempt, artifactId: planned.value.artifactId },
      );
      if (!waiting.ok) return sendRunError(reply, waiting.error);
      const proposed = await options.workflowContinuation.proposeFromPlanning(
        taskReference,
        waiting.value.runId,
        planned.value,
      );
      return proposed.ok
        ? reply.send(WorkflowContinuationRecordSchema.parse(proposed.value))
        : sendContinuationError(reply, proposed.error);
    }

    const implementationPlan = options.implementationPlanning.link(planned.value);
    const queued = options.runService.resolveWorkflowContinuationRevision(
      taskReference,
      implementationPlan,
    );
    if (!queued.ok) return sendRunError(reply, queued.error);
    const superseded = options.workflowContinuation.supersedeWithPlan(
      taskReference,
      implementationPlan.artifactId,
    );
    if (!superseded.ok) return sendContinuationError(reply, superseded.error);
    if (options.scheduler === undefined) {
      const continued = options.runService.claim(taskReference, 'direct-stub-runner');
      if (!continued.ok) return sendRunError(reply, continued.error);
    }
    return reply.send(WorkflowContinuationRecordSchema.parse(superseded.value));
  };

  api.get('/api/health', () => ({ status: 'ok', milestone: 'm1', executionRuntime }));

  api.get('/api/fixtures', () => options.service.listFixtures());

  api.get('/api/repositories', (_request, reply) => {
    if (options.jiraIssueService === undefined) {
      return reply.code(503).send(apiError('jira_not_configured', 'Jira integration is disabled'));
    }
    return reply.send(
      RepositoryCatalogResponseSchema.parse({
        repositories: options.jiraIssueService.listRepositories(),
      }),
    );
  });

  api.get('/api/operator/tasks', async (_request, reply) => {
    const result = options.service.listOperatorTasks();
    if (!result.ok) return sendServiceError(reply, result.error);
    const withRunState = async (task: OperatorTaskSummary): Promise<OperatorTaskSummary> => {
      const withPlanning = options.implementationPlanning?.decorateTask(task) ?? task;
      if (options.temporalRunService !== undefined) {
        const run = await options.temporalRunService.read(task.id);
        if (!run.ok) {
          return OperatorTaskSummarySchema.parse({
            ...withPlanning,
            status: 'needs_attention',
            attention: 'operator',
            currentStage: 'Temporal runtime unavailable',
          });
        }
        return applyTemporalRunToTask(withPlanning, run.value);
      }
      if (options.runService === undefined) {
        return options.workflowContinuation?.decorateTask(withPlanning) ?? withPlanning;
      }
      const continuation = readContinuation(task.id);
      if (continuation?.status === 'linked') {
        const child = options.runService.read(continuation.child.taskReference);
        if (child.ok && child.value !== null) return applyRunToTask(withPlanning, child.value);
      }
      const run = options.runService.read(task.id);
      const withRun = run.ok ? applyRunToTask(withPlanning, run.value) : withPlanning;
      const continuationOwnsStage =
        !run.ok ||
        run.value === null ||
        (run.value.status === 'waiting' &&
          (run.value.wait.waitKind === 'workflow_continuation_review' ||
            run.value.wait.waitKind === 'linked_continuation_ready' ||
            run.value.wait.waitKind === 'linked_continuation_running'));
      return continuationOwnsStage
        ? (options.workflowContinuation?.decorateTask(withRun) ?? withRun)
        : withRun;
    };
    if (options.jiraIssueService === undefined) {
      return reply.send({
        ...result.value,
        tasks: await Promise.all(result.value.tasks.map(withRunState)),
      });
    }
    const jiraTasks = options.jiraIssueService.listOperatorTasks();
    if (!jiraTasks.ok) return sendJiraServiceError(reply, jiraTasks.error);
    const hydratedJiraTasks = [];
    for (const task of jiraTasks.value) {
      const workflow = options.service.read(task.id);
      if (!workflow.ok) return sendServiceError(reply, workflow.error);
      hydratedJiraTasks.push(
        await withRunState(
          workflow.value === null
            ? task
            : OperatorTaskSummarySchema.parse({
                ...task,
                status: workflow.value.status === 'ready' ? 'planned' : 'workflow_rejected',
                attention: workflow.value.status === 'ready' ? 'none' : 'operator',
                currentStage:
                  workflow.value.status === 'ready'
                    ? 'Workflow ready · ready to test on stubs'
                    : 'Workflow validation failed',
                updatedAt: workflow.value.view.persistedAt,
              }),
        ),
      );
    }
    return reply.send({
      tasks: [...hydratedJiraTasks, ...(await Promise.all(result.value.tasks.map(withRunState)))],
      streamCursor: result.value.streamCursor,
    });
  });

  api.get('/api/operator/tasks/:fixtureId/activity', (request, reply) => {
    const params = FixtureParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(apiError('invalid_request', 'fixtureId is required'));
    }

    if (params.data.fixtureId.startsWith('jira:') && options.jiraIssueService !== undefined) {
      const jiraResult = options.jiraIssueService.readActivity(params.data.fixtureId);
      if (!jiraResult.ok) return sendJiraServiceError(reply, jiraResult.error);
      const workflowResult = options.service.readActivity(params.data.fixtureId);
      if (!workflowResult.ok) return sendServiceError(reply, workflowResult.error);
      return reply.send(
        OperatorActivityResponseSchema.parse({
          fixtureId: params.data.fixtureId,
          providerSession:
            workflowResult.value.providerSession.status === 'completed'
              ? workflowResult.value.providerSession
              : jiraResult.value.providerSession,
          entries: [
            ...jiraResult.value.entries,
            ...workflowResult.value.entries,
            ...(options.implementationPlanning?.readActivity(params.data.fixtureId) ?? []),
            ...(options.workflowContinuation?.readActivity(params.data.fixtureId) ?? []),
            ...(options.runService?.readActivity(params.data.fixtureId) ?? []),
            ...linkedRunActivity(params.data.fixtureId),
          ].sort((left, right) => left.sequence - right.sequence),
        }),
      );
    }

    const result = options.service.readActivity(params.data.fixtureId);
    return result.ok
      ? reply.send(
          OperatorActivityResponseSchema.parse({
            ...result.value,
            entries: [
              ...result.value.entries,
              ...(options.implementationPlanning?.readActivity(params.data.fixtureId) ?? []),
              ...(options.workflowContinuation?.readActivity(params.data.fixtureId) ?? []),
              ...(options.runService?.readActivity(params.data.fixtureId) ?? []),
              ...linkedRunActivity(params.data.fixtureId),
            ].sort((left, right) => left.sequence - right.sequence),
          }),
        )
      : sendServiceError(reply, result.error);
  });

  api.get('/api/jira/issues/:issueKey', (request, reply) => {
    if (options.jiraIssueService === undefined) {
      return reply.code(503).send(apiError('jira_not_configured', 'Jira integration is disabled'));
    }
    const params = JiraIssueParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(apiError('invalid_request', 'issueKey is required'));
    }
    const result = options.jiraIssueService.read(params.data.issueKey);
    if (!result.ok) return sendJiraServiceError(reply, result.error);
    return result.value === null
      ? reply.code(404).send(apiError('jira_issue_not_imported', 'Import the Jira issue first'))
      : reply.send(result.value);
  });

  api.post('/api/jira/issues/:issueKey/sync', async (request, reply) => {
    if (options.jiraIssueService === undefined) {
      return reply.code(503).send(apiError('jira_not_configured', 'Jira integration is disabled'));
    }
    const params = JiraIssueParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(apiError('invalid_request', 'issueKey is required'));
    }
    const body = JiraSyncBodySchema.safeParse(request.body ?? {});
    if (!body.success) {
      return reply
        .code(400)
        .send(
          apiError('invalid_repository', 'Repository must be a catalog name such as front-avia'),
        );
    }
    const result = await options.jiraIssueService.sync(params.data.issueKey, body.data.repository);
    return result.ok ? reply.send(result.value) : sendJiraServiceError(reply, result.error);
  });

  api.get('/api/jira/issues/:issueKey/attachments/:attachmentId', async (request, reply) => {
    if (options.jiraIssueService === undefined) {
      return reply.code(503).send(apiError('jira_not_configured', 'Jira integration is disabled'));
    }
    const params = JiraAttachmentParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(apiError('invalid_request', 'Attachment identity is required'));
    }
    const result = await options.jiraIssueService.readAttachment(
      params.data.issueKey,
      params.data.attachmentId,
    );
    return result.ok
      ? reply.type(result.value.contentType).send(Buffer.from(result.value.bytes))
      : sendJiraServiceError(reply, result.error);
  });

  api.get('/api/events', (request, reply) => {
    const query = StreamQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply
        .code(400)
        .send(apiError('invalid_request', 'after must be a non-negative cursor'));
    }

    const header = request.headers['last-event-id'];
    const headerValue = Array.isArray(header) ? header[0] : header;
    const headerCursor = headerValue === undefined ? 0 : Number(headerValue);
    let cursor = Math.max(
      query.data.after ?? 0,
      Number.isSafeInteger(headerCursor) ? headerCursor : 0,
    );

    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });

    const flush = (): void => {
      const events = [
        ...options.service.listStreamEventsAfter(cursor),
        ...(options.implementationPlanning?.listStreamEventsAfter(cursor) ?? []),
        ...(options.workflowContinuation?.listStreamEventsAfter(cursor) ?? []),
        ...(options.runService?.listStreamEventsAfter(cursor) ?? []),
      ].sort((left, right) => left.sequence - right.sequence);
      for (const event of events) {
        reply.raw.write(
          `id: ${String(event.sequence)}\nevent: ledger\ndata: ${JSON.stringify(event)}\n\n`,
        );
        cursor = event.sequence;
      }
    };

    flush();
    const poll = setInterval(flush, 500);
    const keepAlive = setInterval(() => reply.raw.write(': keep-alive\n\n'), 15_000);
    reply.raw.once('close', () => {
      clearInterval(poll);
      clearInterval(keepAlive);
    });

    return reply;
  });

  const registerProjectionRoute = (
    route: '/api/intakes/:projectionId' | '/api/runs/:projectionId' | '/api/tasks/:projectionId',
    projectionType: 'm1_intake' | 'm1_run' | 'm1_task',
  ): void => {
    api.get(route, (request, reply) => {
      const params = ProjectionParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send(apiError('invalid_request', 'projectionId is required'));
      }

      const projection = options.service.readProjection(projectionType, params.data.projectionId);
      return projection === null
        ? reply.code(404).send(apiError('projection_not_found', 'Projection does not exist'))
        : reply.send(projection);
    });
  };

  registerProjectionRoute('/api/intakes/:projectionId', 'm1_intake');
  registerProjectionRoute('/api/tasks/:projectionId', 'm1_task');
  registerProjectionRoute('/api/runs/:projectionId', 'm1_run');

  api.get('/api/workflows/:fixtureId', async (request, reply) => {
    const params = FixtureParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(apiError('invalid_request', 'fixtureId is required'));
    }

    const result = options.service.read(params.data.fixtureId);
    if (!result.ok) return sendServiceError(reply, result.error);
    if (result.value === null) {
      return reply.code(404).send(apiError('workflow_not_found', 'Generate this workflow first'));
    }

    if (options.temporalRunService !== undefined) {
      const run = await options.temporalRunService.read(params.data.fixtureId);
      return reply.send(
        WorkflowResponseSchema.parse(
          run.ok ? decorateWorkflowWithTemporalState(result.value, run.value) : result.value,
        ),
      );
    }

    return reply.send(
      WorkflowResponseSchema.parse(
        options.runService?.decorateWorkflow(result.value) ?? result.value,
      ),
    );
  });

  api.get('/api/workflows/:fixtureId/run', async (request, reply) => {
    if (options.runService === undefined && options.temporalRunService === undefined) {
      return reply.code(503).send(apiError('runner_not_configured', 'M2 runner is disabled'));
    }
    const params = FixtureParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(apiError('invalid_request', 'fixtureId is required'));
    }
    if (options.temporalRunService !== undefined) {
      const result = await options.temporalRunService.read(params.data.fixtureId);
      if (!result.ok) return sendTemporalRunError(reply, result.error);
      return result.value === null
        ? reply.code(404).send(apiError('run_not_found', 'This workflow has not started'))
        : reply.send(ExecutionRunViewSchema.parse(result.value));
    }

    const result = options.runService.read(params.data.fixtureId);
    if (!result.ok) return sendRunError(reply, result.error);
    return result.value === null
      ? reply.code(404).send(apiError('run_not_found', 'This workflow has not started'))
      : reply.send(RunProjectionSchema.parse(result.value));
  });

  api.get('/api/workflows/:fixtureId/implementation-plan', (request, reply) => {
    if (options.implementationPlanning === undefined) {
      return reply
        .code(404)
        .send(apiError('implementation_plan_not_found', 'No implementation plan exists'));
    }
    const params = FixtureParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(apiError('invalid_request', 'fixtureId is required'));
    }
    const result = options.implementationPlanning.read(params.data.fixtureId);
    if (!result.ok) {
      return reply
        .code(500)
        .send(apiError('implementation_plan_store_failure', 'The plan projection is invalid'));
    }
    return result.value === null
      ? reply
          .code(404)
          .send(apiError('implementation_plan_not_found', 'No implementation plan exists'))
      : reply.send(ImplementationPlanningRecordSchema.parse(result.value));
  });

  api.get('/api/workflows/:fixtureId/planning-transcript', (request, reply) => {
    if (options.implementationPlanning === undefined) {
      return reply
        .code(404)
        .send(apiError('planning_transcript_not_found', 'No planning transcript exists'));
    }
    const params = FixtureParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(apiError('invalid_request', 'fixtureId is required'));
    }
    const result = options.implementationPlanning.readTranscript(params.data.fixtureId);
    if (!result.ok) {
      return reply
        .code(500)
        .send(apiError('planning_transcript_store_failure', 'The transcript is invalid'));
    }
    return result.value === null
      ? reply
          .code(404)
          .send(apiError('planning_transcript_not_found', 'No planning transcript exists'))
      : reply.send(PlanningTranscriptViewSchema.parse(result.value));
  });

  api.get('/api/workflows/:fixtureId/continuation', (request, reply) => {
    if (options.workflowContinuation === undefined) {
      return reply
        .code(404)
        .send(apiError('workflow_continuation_not_found', 'No continuation exists'));
    }
    const params = FixtureParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(apiError('invalid_request', 'fixtureId is required'));
    }
    const result = options.workflowContinuation.read(params.data.fixtureId);
    if (!result.ok) return sendContinuationError(reply, result.error);
    return result.value === null
      ? reply.code(404).send(apiError('workflow_continuation_not_found', 'No continuation exists'))
      : reply.send(WorkflowContinuationRecordSchema.parse(result.value));
  });

  api.post('/api/workflows/:fixtureId/continuation/review', async (request, reply) => {
    if (options.workflowContinuation === undefined) {
      return reply
        .code(503)
        .send(apiError('workflow_continuation_not_configured', 'Continuation is disabled'));
    }
    const params = FixtureParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(apiError('invalid_request', 'fixtureId is required'));
    }
    const command = WorkflowContinuationReviewCommandSchema.safeParse(request.body);
    if (!command.success) {
      return reply
        .code(400)
        .send(apiError('invalid_continuation_review', 'Accept or reject with non-empty guidance'));
    }
    const reviewed = options.workflowContinuation.review(params.data.fixtureId, command.data);
    if (!reviewed.ok) return sendContinuationError(reply, reviewed.error);
    let response = reviewed.value;
    if (
      command.data.decision === 'accept' &&
      (reviewed.value.status === 'accepted' || reviewed.value.status === 'linked')
    ) {
      if (options.runService === undefined) {
        return reply.code(503).send(apiError('runner_not_configured', 'M2 runner is disabled'));
      }
      const accepted = options.runService.acceptWorkflowContinuation(
        params.data.fixtureId,
        reviewed.value.continuationId,
      );
      if (!accepted.ok) return sendRunError(reply, accepted.error);
      const child = options.runService.enqueueWorkflowContinuation(
        params.data.fixtureId,
        reviewed.value.continuationId,
        reviewed.value.candidate.taskReference,
      );
      if (!child.ok) return sendRunError(reply, child.error);
      if (options.scheduler === undefined) {
        const started = options.runService.claim(child.value.taskReference, 'direct-stub-runner');
        if (!started.ok) return sendRunError(reply, started.error);
      }
      const linked = options.workflowContinuation.linkExecution(params.data.fixtureId, {
        taskReference: child.value.taskReference,
        runId: child.value.runId,
      });
      if (!linked.ok) return sendContinuationError(reply, linked.error);
      response = linked.value;
      if (options.scheduler === undefined) {
        const reconciled = options.runService.reconcileLinkedContinuations();
        if (!reconciled.ok) return sendRunError(reply, reconciled.error);
      }
    }
    if (reviewed.value.status === 'rejected_by_operator') {
      return reviseWorkflowContinuation(params.data.fixtureId, reviewed.value, reply);
    }
    return reply.send(WorkflowContinuationRecordSchema.parse(response));
  });

  api.post('/api/workflows/:fixtureId/continuation/retry', async (request, reply) => {
    if (options.workflowContinuation === undefined) {
      return reply
        .code(503)
        .send(apiError('workflow_continuation_not_configured', 'Continuation is disabled'));
    }
    const params = FixtureParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(apiError('invalid_request', 'fixtureId is required'));
    }
    const retried = await options.workflowContinuation.retry(params.data.fixtureId);
    return retried.ok
      ? reply.send(WorkflowContinuationRecordSchema.parse(retried.value))
      : sendContinuationError(reply, retried.error);
  });

  api.post('/api/workflows/:fixtureId/start', async (request, reply) => {
    if (options.runService === undefined && options.temporalRunService === undefined) {
      return reply.code(503).send(apiError('runner_not_configured', 'M2 runner is disabled'));
    }
    const params = FixtureParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(apiError('invalid_request', 'fixtureId is required'));
    }
    const command = RunStartCommandSchema.safeParse(
      request.body === undefined || request.body === null
        ? DEFAULT_RUN_START_COMMAND
        : request.body,
    );
    if (!command.success) {
      return reply.code(400).send(apiError('invalid_run_settings', 'Run settings are invalid'));
    }

    if (options.temporalRunService !== undefined) {
      const workflow = options.service.read(params.data.fixtureId);
      if (!workflow.ok) return sendServiceError(reply, workflow.error);
      if (workflow.value === null) {
        return reply.code(404).send(apiError('workflow_not_found', 'Generate this workflow first'));
      }
      if (workflow.value.status !== 'ready') {
        return reply
          .code(409)
          .send(apiError('workflow_not_executable', 'Only a valid compiled workflow can start'));
      }
      const graph = CompiledWorkflowSchema.safeParse(workflow.value.view.workflow.graph);
      const workflowHash = workflow.value.view.workflow.graphHash;
      if (!graph.success || workflowHash === null) {
        return reply
          .code(500)
          .send(apiError('workflow_projection_corrupt', 'Compiled workflow graph is invalid'));
      }
      const started = await options.temporalRunService.start({
        taskReference: params.data.fixtureId,
        workflowHash,
        graph: graph.data,
        settings: command.data.settings,
      });
      return started.ok
        ? reply.send(ExecutionRunViewSchema.parse(started.value))
        : sendTemporalRunError(reply, started.error);
    }

    const existingRun = options.runService.read(params.data.fixtureId);
    if (!existingRun.ok) return sendRunError(reply, existingRun.error);
    let implementationPlan = existingRun.value?.implementationPlan ?? null;
    if (existingRun.value === null && options.implementationPlanning !== undefined) {
      const planned = await options.implementationPlanning.prepare(
        params.data.fixtureId,
        command.data.settings.planningStrategy,
      );
      if (!planned.ok) {
        return reply
          .code(503)
          .send(
            apiError('implementation_planning_failed', `Planning stopped: ${planned.error.kind}`),
          );
      }
      if (planned.value.status === 'planning') {
        return reply
          .code(409)
          .send(apiError('implementation_planning_in_progress', 'Planning is still running'));
      }
      if (planned.value.status === 'failed') {
        return reply
          .code(503)
          .send(apiError('implementation_planning_failed', planned.value.failure.message));
      }
      if (planned.value.status === 'needs_clarification') {
        const waiting = options.runService.openPlanningClarification(
          params.data.fixtureId,
          command.data.settings,
          { attempt: planned.value.attempt, artifactId: planned.value.artifactId },
        );
        return waiting.ok
          ? reply.send(RunProjectionSchema.parse(waiting.value))
          : sendRunError(reply, waiting.error);
      }
      if (planned.value.status === 'workflow_change_required') {
        return openWorkflowContinuation(
          params.data.fixtureId,
          command.data.settings,
          planned.value,
          reply,
        );
      }
      implementationPlan = options.implementationPlanning.link(planned.value);
    }
    if (options.scheduler !== undefined) {
      const queued = options.scheduler.enqueue(
        params.data.fixtureId,
        command.data.settings,
        implementationPlan,
      );
      return queued.ok
        ? reply.send(RunProjectionSchema.parse(queued.value))
        : sendRunError(reply, queued.error.error);
    }
    const started = options.runService.start(
      params.data.fixtureId,
      command.data.settings,
      {},
      implementationPlan,
    );
    return started.ok
      ? reply.send(RunProjectionSchema.parse(started.value))
      : sendRunError(reply, started.error);
  });

  api.post('/api/workflows/:fixtureId/resume', async (request, reply) => {
    if (options.runService === undefined && options.temporalRunService === undefined) {
      return reply.code(503).send(apiError('runner_not_configured', 'M2 runner is disabled'));
    }
    const params = FixtureParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(apiError('invalid_request', 'fixtureId is required'));
    }
    if (options.temporalRunService !== undefined) {
      const current = await options.temporalRunService.read(params.data.fixtureId);
      if (!current.ok) return sendTemporalRunError(reply, current.error);
      if (current.value === null) {
        return sendTemporalRunError(reply, {
          kind: 'run_not_found',
          taskReference: params.data.fixtureId,
        });
      }
      if (current.value.status !== 'waiting') {
        return reply
          .code(409)
          .send(apiError('run_not_waiting', 'The run is not waiting for an operator command'));
      }
      if (
        current.value.wait.waitKind === 'human_clarification' ||
        current.value.wait.waitKind === 'plan.approved@1' ||
        current.value.wait.waitKind === 'workflow_change.review@1'
      ) {
        return reply
          .code(409)
          .send(
            apiError(
              'typed_resolution_required',
              'Use the dedicated planning or workflow-review command for this wait',
            ),
          );
      }
      const resumed = await options.temporalRunService.resolveWait(params.data.fixtureId, {
        nodeId: current.value.wait.nodeId,
        waitKind: current.value.wait.waitKind,
        resolution: { decision: 'resume' },
      });
      return resumed.ok
        ? reply.send(ExecutionRunViewSchema.parse(resumed.value))
        : sendTemporalRunError(reply, resumed.error);
    }
    const continuation = readContinuation(params.data.fixtureId);
    const runTaskReference =
      continuation?.status === 'linked' ? continuation.child.taskReference : params.data.fixtureId;
    const result =
      options.scheduler === undefined
        ? options.runService.resume(runTaskReference)
        : options.runService.resolveWait(runTaskReference);
    if (result.ok) {
      const reconciled = options.runService.reconcileLinkedContinuations();
      if (!reconciled.ok) return sendRunError(reply, reconciled.error);
    }
    return result.ok
      ? reply.send(RunProjectionSchema.parse(result.value))
      : sendRunError(reply, result.error);
  });

  api.post('/api/workflows/:fixtureId/plan-review', async (request, reply) => {
    if (options.runService === undefined && options.temporalRunService === undefined) {
      return reply.code(503).send(apiError('runner_not_configured', 'M2 runner is disabled'));
    }
    const params = FixtureParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(apiError('invalid_request', 'fixtureId is required'));
    }
    const command = PlanReviewCommandSchema.safeParse(request.body);
    if (!command.success) {
      return reply
        .code(400)
        .send(apiError('invalid_plan_review', 'Approve or provide non-empty plan guidance'));
    }

    if (options.temporalRunService !== undefined) {
      const current = await options.temporalRunService.read(params.data.fixtureId);
      if (!current.ok) return sendTemporalRunError(reply, current.error);
      if (
        current.value === null ||
        current.value.status !== 'waiting' ||
        current.value.wait.waitKind !== 'plan.approved@1'
      ) {
        return reply
          .code(409)
          .send(apiError('run_not_at_plan_review', 'The run is not waiting for plan review'));
      }
      const reviewed = await options.temporalRunService.resolveWait(params.data.fixtureId, {
        nodeId: current.value.wait.nodeId,
        waitKind: current.value.wait.waitKind,
        resolution: command.data,
      });
      return reviewed.ok
        ? reply.send(ExecutionRunViewSchema.parse(reviewed.value))
        : sendTemporalRunError(reply, reviewed.error);
    }

    if (
      command.data.decision === 'request_changes' &&
      options.implementationPlanning !== undefined
    ) {
      const recorded = options.runService.recordPlanChanges(
        params.data.fixtureId,
        command.data.guidance,
      );
      if (!recorded.ok) return sendRunError(reply, recorded.error);
      const planned = await options.implementationPlanning.prepare(
        params.data.fixtureId,
        recorded.value.settings.planningStrategy,
        command.data.guidance,
      );
      if (!planned.ok) {
        return reply
          .code(503)
          .send(
            apiError('implementation_planning_failed', `Planning stopped: ${planned.error.kind}`),
          );
      }
      if (planned.value.status === 'failed') {
        return reply
          .code(503)
          .send(apiError('implementation_planning_failed', planned.value.failure.message));
      }
      if (planned.value.status === 'planning') {
        return reply
          .code(409)
          .send(apiError('implementation_planning_in_progress', 'Planning is still running'));
      }
      if (planned.value.status === 'needs_clarification') {
        const waiting = options.runService.openPlanningClarification(
          params.data.fixtureId,
          recorded.value.settings,
          { attempt: planned.value.attempt, artifactId: planned.value.artifactId },
        );
        return waiting.ok
          ? reply.send(RunProjectionSchema.parse(waiting.value))
          : sendRunError(reply, waiting.error);
      }
      if (planned.value.status === 'workflow_change_required') {
        return openWorkflowContinuation(
          params.data.fixtureId,
          recorded.value.settings,
          planned.value,
          reply,
        );
      }
      const revised = options.runService.applyPlanRevision(
        params.data.fixtureId,
        options.implementationPlanning.link(planned.value),
      );
      if (!revised.ok) return sendRunError(reply, revised.error);
      if (options.scheduler !== undefined) {
        return reply.send(RunProjectionSchema.parse(revised.value));
      }
      const continued = options.runService.claim(params.data.fixtureId, 'direct-stub-runner');
      return continued.ok
        ? reply.send(RunProjectionSchema.parse(continued.value))
        : sendRunError(reply, continued.error);
    }

    const reviewed = options.runService.reviewPlan(params.data.fixtureId, command.data);
    if (!reviewed.ok) return sendRunError(reply, reviewed.error);
    if (options.scheduler !== undefined) {
      return reply.send(RunProjectionSchema.parse(reviewed.value));
    }
    const continued = options.runService.claim(params.data.fixtureId, 'direct-stub-runner');
    return continued.ok
      ? reply.send(RunProjectionSchema.parse(continued.value))
      : sendRunError(reply, continued.error);
  });

  api.post('/api/workflows/:fixtureId/planning-clarification', async (request, reply) => {
    if (
      options.temporalRunService === undefined &&
      (options.runService === undefined || options.implementationPlanning === undefined)
    ) {
      return reply
        .code(503)
        .send(apiError('implementation_planning_not_configured', 'Planning is disabled'));
    }
    const params = FixtureParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(apiError('invalid_request', 'fixtureId is required'));
    }
    const command = PlanningClarificationAnswerCommandSchema.safeParse(request.body);
    if (!command.success) {
      return reply
        .code(400)
        .send(apiError('invalid_clarification_answers', 'Provide a non-empty answer per question'));
    }
    if (options.temporalRunService !== undefined) {
      const current = await options.temporalRunService.read(params.data.fixtureId);
      if (!current.ok) return sendTemporalRunError(reply, current.error);
      if (
        current.value === null ||
        current.value.status !== 'waiting' ||
        current.value.wait.waitKind !== 'human_clarification' ||
        current.value.planning?.status !== 'needs_clarification'
      ) {
        return reply
          .code(409)
          .send(
            apiError(
              'run_not_at_planning_clarification',
              'The run is not waiting for planning clarification',
            ),
          );
      }
      const expected = new Set(current.value.planning.questions.map((question) => question.id));
      const received = new Set(command.data.answers.map((answer) => answer.questionId));
      if (
        received.size !== command.data.answers.length ||
        received.size !== expected.size ||
        [...received].some((questionId) => !expected.has(questionId))
      ) {
        return reply
          .code(400)
          .send(
            apiError(
              'invalid_clarification_answers',
              'Provide exactly one answer for every active planning question',
            ),
          );
      }
      const answered = await options.temporalRunService.resolveWait(params.data.fixtureId, {
        nodeId: current.value.wait.nodeId,
        waitKind: current.value.wait.waitKind,
        resolution: command.data,
      });
      return answered.ok
        ? reply.send(ExecutionRunViewSchema.parse(answered.value))
        : sendTemporalRunError(reply, answered.error);
    }
    if (options.implementationPlanning === undefined) {
      return reply
        .code(503)
        .send(apiError('implementation_planning_not_configured', 'Planning is disabled'));
    }
    const currentRun = options.runService.read(params.data.fixtureId);
    if (!currentRun.ok) return sendRunError(reply, currentRun.error);
    if (currentRun.value === null) {
      return sendRunError(reply, {
        kind: 'run_not_found',
        taskReference: params.data.fixtureId,
      });
    }
    if (
      currentRun.value.status !== 'waiting' ||
      currentRun.value.wait.waitKind !== 'human_clarification'
    ) {
      return sendRunError(reply, {
        kind: 'run_not_at_planning_clarification',
        taskReference: params.data.fixtureId,
      });
    }
    const continuationBeforeAnswer = options.workflowContinuation?.read(params.data.fixtureId);
    if (continuationBeforeAnswer !== undefined && !continuationBeforeAnswer.ok) {
      return sendContinuationError(reply, continuationBeforeAnswer.error);
    }

    const planned = await options.implementationPlanning.answer(
      params.data.fixtureId,
      command.data.answers,
    );
    if (!planned.ok) {
      return planned.error.kind === 'invalid_clarification_answers'
        ? reply
            .code(400)
            .send(apiError('invalid_clarification_answers', planned.error.issues.join(' ')))
        : reply
            .code(503)
            .send(
              apiError('implementation_planning_failed', `Planning stopped: ${planned.error.kind}`),
            );
    }
    if (planned.value.status === 'planning') {
      return reply
        .code(409)
        .send(apiError('implementation_planning_in_progress', 'Planning is still running'));
    }
    if (planned.value.status === 'failed') {
      return reply
        .code(503)
        .send(apiError('implementation_planning_failed', planned.value.failure.message));
    }
    if (planned.value.status === 'workflow_change_required') {
      return openWorkflowContinuation(
        params.data.fixtureId,
        currentRun.value.settings,
        planned.value,
        reply,
      );
    }
    if (planned.value.status === 'needs_clarification') {
      const waiting = options.runService.openPlanningClarification(
        params.data.fixtureId,
        currentRun.value.settings,
        { attempt: planned.value.attempt, artifactId: planned.value.artifactId },
      );
      return waiting.ok
        ? reply.send(RunProjectionSchema.parse(waiting.value))
        : sendRunError(reply, waiting.error);
    }

    const queued = options.runService.resolvePlanningClarification(
      params.data.fixtureId,
      options.implementationPlanning.link(planned.value),
    );
    if (!queued.ok) return sendRunError(reply, queued.error);
    if (continuationBeforeAnswer?.value?.status === 'rejected_by_operator') {
      if (options.workflowContinuation === undefined) {
        return reply
          .code(503)
          .send(apiError('workflow_continuation_not_configured', 'Continuation is disabled'));
      }
      const superseded = options.workflowContinuation.supersedeWithPlan(
        params.data.fixtureId,
        planned.value.artifactId,
      );
      if (!superseded.ok) return sendContinuationError(reply, superseded.error);
    }
    if (options.scheduler !== undefined) {
      return reply.send(RunProjectionSchema.parse(queued.value));
    }
    const continued = options.runService.claim(params.data.fixtureId, 'direct-stub-runner');
    return continued.ok
      ? reply.send(RunProjectionSchema.parse(continued.value))
      : sendRunError(reply, continued.error);
  });

  api.post('/api/workflows/:fixtureId/generate', async (request, reply) => {
    const params = FixtureParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(apiError('invalid_request', 'fixtureId is required'));
    }

    const result =
      options.workflowGenerator === undefined
        ? options.service.generate(params.data.fixtureId)
        : await options.workflowGenerator.generate(params.data.fixtureId);
    if (!result.ok) return sendServiceError(reply, result.error);

    return reply.send(
      WorkflowResponseSchema.parse(
        options.runService?.decorateWorkflow(result.value) ?? result.value,
      ),
    );
  });

  api.get('/api/workflows/:fixtureId/graph.json', async (request, reply) => {
    const params = FixtureParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(apiError('invalid_request', 'fixtureId is required'));
    }

    const result = options.service.read(params.data.fixtureId);
    if (!result.ok) return sendServiceError(reply, result.error);
    if (result.value === null) {
      return reply.code(404).send(apiError('workflow_not_found', 'Generate this workflow first'));
    }
    if (result.value.status === 'rejected') {
      return reply
        .code(409)
        .send(apiError('workflow_rejected', 'Rejected graphs cannot be downloaded'));
    }

    return reply
      .header('content-disposition', `attachment; filename="${params.data.fixtureId}-graph.json"`)
      .type('application/json; charset=utf-8')
      .send(result.value.view.workflow.graph);
  });

  api.get('/api/graphs/:fixtureId', async (request, reply) => {
    const params = FixtureParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(apiError('invalid_request', 'fixtureId is required'));
    }

    const result = options.service.read(params.data.fixtureId);
    if (!result.ok) return sendServiceError(reply, result.error);
    if (result.value === null) {
      return reply.code(404).send(apiError('workflow_not_found', 'Generate this workflow first'));
    }

    return reply.send(
      (options.runService?.decorateWorkflow(result.value) ?? result.value).view.workflow,
    );
  });

  if (options.cockpitDirectory !== undefined) {
    api.get('/', async (_request, reply) => {
      const body = await readFile(join(options.cockpitDirectory as string, 'index.html'));
      return reply.type('text/html; charset=utf-8').send(body);
    });

    api.get('/assets/*', async (request, reply) => {
      const params = AssetParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(404).send();
      }

      const filename = resolveCockpitAsset(options.cockpitDirectory as string, params.data['*']);
      if (filename === null) {
        return reply.code(404).send();
      }

      let body: Buffer;
      try {
        body = await readFile(filename);
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
          return reply.code(404).send();
        }
        throw error;
      }

      return reply.type(contentType(filename)).send(body);
    });
  }

  return api;
};
