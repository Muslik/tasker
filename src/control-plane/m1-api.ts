import { readFile } from 'node:fs/promises';
import { extname, join, relative, resolve } from 'node:path';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import { z } from 'zod';

import { type ImplementationPlanningCoordinator } from './implementation-planning.js';
import { ImplementationPlanningRecordSchema } from './implementation-planning-contracts.js';
import { PlanningTranscriptViewSchema } from './planning-transcript.js';
import {
  WorkflowContinuationRecordSchema,
  WorkflowContinuationReviewCommandSchema,
  type WorkflowContinuationCoordinator,
  type WorkflowContinuationError,
} from './workflow-continuation.js';
import type {
  BitbucketReviewCoordinator,
  BitbucketReviewSyncError,
  JiraIssueService,
  JiraIssueServiceError,
} from '../integrations/index.js';
import {
  RepositoryCatalogResponseSchema,
  RepositoryReferenceSchema,
} from '../repositories/contracts.js';
import { PlanningClarificationAnswerCommandSchema } from '../planning/implementation-plan.js';
import {
  ApiErrorResponseSchema,
  CodeReviewSyncResponseSchema,
  DEFAULT_RUN_START_COMMAND,
  ExecutionRunViewSchema,
  OperatorActivityResponseSchema,
  OperatorTaskSummarySchema,
  PlanReviewCommandSchema,
  ResumeRunCommandSchema,
  RunStartCommandSchema,
  WorkflowResponseSchema,
  type OperatorTaskSummary,
  type WorkflowResponse,
  type WorkflowTreeNode,
} from './m1-contracts.js';
import type { M1ServiceError, M1WorkflowService } from './m1-service.js';
import type { ExecutionActivityReader } from './execution-activity.js';
import { providerFailureSummary, type WorkflowGenerator } from './workflow-generator.js';
import {
  WorkflowContinuationAcceptanceSchema,
  type TaskTemporalRunService,
  type TaskWorkflowPublicState,
  type TemporalRunError,
} from '../temporal/index.js';
import { CompiledWorkflowSchema, JsonValueSchema } from '../workflow/index.js';

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

export interface BuildM1ApiOptions {
  readonly service: M1WorkflowService;
  readonly cockpitDirectory?: string | undefined;
  readonly logger?: boolean | undefined;
  readonly workflowGenerator?: WorkflowGenerator | undefined;
  readonly jiraIssueService?: JiraIssueService | undefined;
  readonly implementationPlanning?: ImplementationPlanningCoordinator | undefined;
  readonly workflowContinuation?: WorkflowContinuationCoordinator | undefined;
  readonly executionActivity?: ExecutionActivityReader | undefined;
  readonly bitbucketReview?: Pick<BitbucketReviewCoordinator, 'sync'> | undefined;
  readonly temporalRunService: TaskTemporalRunService;
}

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

const sendTemporalRunError = (reply: FastifyReply, error: TemporalRunError): FastifyReply => {
  switch (error.kind) {
    case 'run_not_found':
      return reply.code(404).send(apiError(error.kind, 'This workflow has not started'));
    case 'run_settings_conflict':
      return reply
        .code(409)
        .send(apiError(error.kind, 'This run already exists with different immutable settings'));
    case 'runtime_unavailable':
      return reply.code(503).send(apiError(error.kind, error.message));
  }
};

const sendBitbucketReviewError = (
  reply: FastifyReply,
  error: BitbucketReviewSyncError,
): FastifyReply => {
  switch (error.kind) {
    case 'pull_request_evidence_missing':
    case 'invalid_pull_request_evidence':
      return reply.code(409).send(apiError(error.kind, 'Pull request evidence is unavailable'));
    case 'review_failed':
      return reply
        .code(error.problem.retryable ? 503 : 422)
        .send(apiError(error.problem.kind, error.problem.message));
    case 'store_failed':
      return reply.code(500).send(apiError('review_store_failed', error.error.kind));
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
  const temporalRunService = options.temporalRunService;

  const ensureWorkflowContinuation = async (
    taskReference: string,
    run: TaskWorkflowPublicState,
  ) => {
    if (
      options.workflowContinuation === undefined ||
      run.status !== 'waiting' ||
      run.wait.waitKind !== 'workflow_change.review@1' ||
      run.workflowChange === null
    ) {
      return null;
    }
    const request =
      'changes' in run.workflowChange.request
        ? {
            reason: run.workflowChange.request.summary,
            discoveredRepositories: run.workflowChange.request.changes.flatMap((change) =>
              change.kind === 'cross_repository_dependency' ? [change.repository] : [],
            ),
            requiredCapabilities: [
              ...new Set(
                run.workflowChange.request.changes.flatMap((change) => {
                  switch (change.kind) {
                    case 'cross_repository_dependency':
                      return ['repository.read', 'workspace.write'];
                    case 'external_process_required':
                    case 'verification_scope_changed':
                      return ['command.run'];
                    case 'task_scope_changed':
                      return [];
                  }
                }),
              ),
            ],
            evidence: run.workflowChange.request.evidenceArtifactIds,
          }
        : run.workflowChange.request;
    return options.workflowContinuation.proposeFromPlanning(taskReference, run.runId, {
      attempt: run.workflowChange.attempt,
      artifactId: run.workflowChange.artifactId,
      decision: {
        status: 'workflow_change_required',
        request,
      },
    });
  };

  const sendTemporalState = async (
    reply: FastifyReply,
    taskReference: string,
    run: TaskWorkflowPublicState,
  ): Promise<FastifyReply> => {
    const continuation = await ensureWorkflowContinuation(taskReference, run);
    return continuation !== null && !continuation.ok
      ? sendContinuationError(reply, continuation.error)
      : reply.send(ExecutionRunViewSchema.parse(run));
  };

  api.get('/api/health', () => ({
    status: 'ok',
    milestone: 'm1',
    executionRuntime: 'temporal',
  }));

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
      const run = await temporalRunService.read(task.id);
      if (!run.ok) {
        return OperatorTaskSummarySchema.parse({
          ...withPlanning,
          status: 'needs_attention',
          attention: 'operator',
          currentStage: 'Temporal runtime unavailable',
        });
      }
      const withExecution = applyTemporalRunToTask(withPlanning, run.value);
      return options.workflowContinuation?.decorateTask(withExecution) ?? withExecution;
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
                    ? 'Workflow ready · ready for Temporal execution'
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
            ...(options.executionActivity?.readActivity(params.data.fixtureId) ?? []),
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
              ...(options.executionActivity?.readActivity(params.data.fixtureId) ?? []),
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
    reply.raw.write(': connected\n\n');

    const flush = (): void => {
      const events = [
        ...options.service.listStreamEventsAfter(cursor),
        ...(options.implementationPlanning?.listStreamEventsAfter(cursor) ?? []),
        ...(options.workflowContinuation?.listStreamEventsAfter(cursor) ?? []),
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
    route: '/api/intakes/:projectionId' | '/api/tasks/:projectionId',
    projectionType: 'm1_intake' | 'm1_task',
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

    const run = await temporalRunService.read(params.data.fixtureId);
    return reply.send(
      WorkflowResponseSchema.parse(
        run.ok ? decorateWorkflowWithTemporalState(result.value, run.value) : result.value,
      ),
    );
  });

  api.get('/api/workflows/:fixtureId/run', async (request, reply) => {
    const params = FixtureParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(apiError('invalid_request', 'fixtureId is required'));
    }
    const result = await temporalRunService.read(params.data.fixtureId);
    if (!result.ok) return sendTemporalRunError(reply, result.error);
    return result.value === null
      ? reply.code(404).send(apiError('run_not_found', 'This workflow has not started'))
      : reply.send(ExecutionRunViewSchema.parse(result.value));
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

  api.get('/api/workflows/:fixtureId/continuation', async (request, reply) => {
    if (options.workflowContinuation === undefined) {
      return reply
        .code(404)
        .send(apiError('workflow_continuation_not_found', 'No continuation exists'));
    }
    const params = FixtureParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(apiError('invalid_request', 'fixtureId is required'));
    }
    const run = await temporalRunService.read(params.data.fixtureId);
    if (!run.ok) return sendTemporalRunError(reply, run.error);
    if (run.value !== null) {
      const proposed = await ensureWorkflowContinuation(params.data.fixtureId, run.value);
      if (proposed !== null && !proposed.ok) return sendContinuationError(reply, proposed.error);
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
    const current = await temporalRunService.read(params.data.fixtureId);
    if (!current.ok) return sendTemporalRunError(reply, current.error);
    if (
      current.value === null ||
      current.value.status !== 'waiting' ||
      current.value.wait.waitKind !== 'workflow_change.review@1'
    ) {
      return reply
        .code(409)
        .send(apiError('run_not_at_workflow_continuation', 'The run is not waiting for review'));
    }
    if (reviewed.value.status === 'rejected_by_operator') {
      const resumed = await temporalRunService.resolveWait(params.data.fixtureId, {
        nodeId: current.value.wait.nodeId,
        waitKind: current.value.wait.waitKind,
        resolution: { decision: 'request_changes', guidance: reviewed.value.guidance },
      });
      if (!resumed.ok) return sendTemporalRunError(reply, resumed.error);
      const proposed = await ensureWorkflowContinuation(params.data.fixtureId, resumed.value);
      if (proposed !== null && !proposed.ok) return sendContinuationError(reply, proposed.error);
      const latest = options.workflowContinuation.read(params.data.fixtureId);
      return latest.ok && latest.value !== null
        ? reply.send(WorkflowContinuationRecordSchema.parse(latest.value))
        : latest.ok
          ? reply
              .code(404)
              .send(apiError('workflow_continuation_not_found', 'No continuation exists'))
          : sendContinuationError(reply, latest.error);
    }
    if (reviewed.value.status !== 'accepted' && reviewed.value.status !== 'linked') {
      return reply.send(WorkflowContinuationRecordSchema.parse(reviewed.value));
    }
    if (reviewed.value.status === 'accepted') {
      const candidate = options.service.read(reviewed.value.candidate.taskReference);
      if (!candidate.ok) return sendServiceError(reply, candidate.error);
      if (candidate.value?.status !== 'ready') {
        return reply
          .code(409)
          .send(apiError('workflow_continuation_not_ready', 'The accepted graph is unavailable'));
      }
      const graph = CompiledWorkflowSchema.safeParse(candidate.value.view.workflow.graph);
      const workflowHash = candidate.value.view.workflow.graphHash;
      if (!graph.success || workflowHash === null) {
        return reply
          .code(500)
          .send(apiError('workflow_projection_corrupt', 'Continuation graph is invalid'));
      }
      const resumed = await temporalRunService.resolveWait(params.data.fixtureId, {
        nodeId: current.value.wait.nodeId,
        waitKind: current.value.wait.waitKind,
        resolution: JsonValueSchema.parse(
          WorkflowContinuationAcceptanceSchema.parse({
            decision: 'accept',
            continuationId: reviewed.value.continuationId,
            taskReference: reviewed.value.candidate.taskReference,
            workflowHash,
            graph: graph.data,
            settings: current.value.settings,
          }),
        ),
      });
      if (!resumed.ok) return sendTemporalRunError(reply, resumed.error);
    }
    const latest = options.workflowContinuation.read(params.data.fixtureId);
    return latest.ok && latest.value !== null
      ? reply.send(WorkflowContinuationRecordSchema.parse(latest.value))
      : latest.ok
        ? reply
            .code(404)
            .send(apiError('workflow_continuation_not_found', 'No continuation exists'))
        : sendContinuationError(reply, latest.error);
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
    const started = await temporalRunService.start({
      taskReference: params.data.fixtureId,
      workflowHash,
      graph: graph.data,
      settings: command.data.settings,
    });
    return started.ok
      ? sendTemporalState(reply, params.data.fixtureId, started.value)
      : sendTemporalRunError(reply, started.error);
  });

  api.post('/api/workflows/:fixtureId/code-review/sync', async (request, reply) => {
    if (options.bitbucketReview === undefined) {
      return reply
        .code(503)
        .send(apiError('bitbucket_review_not_configured', 'Bitbucket review intake is disabled'));
    }
    const params = FixtureParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(apiError('invalid_request', 'fixtureId is required'));
    }
    const current = await temporalRunService.read(params.data.fixtureId);
    if (!current.ok) return sendTemporalRunError(reply, current.error);
    if (
      current.value === null ||
      current.value.status !== 'waiting' ||
      current.value.wait.waitKind !== 'code_review@1'
    ) {
      return reply
        .code(409)
        .send(apiError('run_not_at_code_review', 'The run is not waiting for code review'));
    }
    const synced = await options.bitbucketReview.sync({
      taskReference: params.data.fixtureId,
      workflowId: current.value.workflowId,
      workflowRunId: current.value.runId,
    });
    if (!synced.ok) return sendBitbucketReviewError(reply, synced.error);
    if (synced.value.status === 'pending') {
      return reply.send(
        CodeReviewSyncResponseSchema.parse({
          status: 'pending',
          reviewId: null,
          pullRequestUrl: synced.value.pullRequestUrl,
          run: current.value,
        }),
      );
    }
    const resumed = await temporalRunService.resolveWait(params.data.fixtureId, {
      nodeId: current.value.wait.nodeId,
      waitKind: current.value.wait.waitKind,
      resolution: {
        decision: synced.value.status,
        reviewId: synced.value.reviewId,
      },
    });
    if (!resumed.ok) return sendTemporalRunError(reply, resumed.error);
    return reply.send(
      CodeReviewSyncResponseSchema.parse({
        status: synced.value.status,
        reviewId: synced.value.reviewId,
        pullRequestUrl: synced.value.evidence.snapshot.pullRequestUrl,
        run: resumed.value,
      }),
    );
  });

  api.post('/api/workflows/:fixtureId/code-review/complete', async (request, reply) => {
    const params = FixtureParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(apiError('invalid_request', 'fixtureId is required'));
    }
    const current = await temporalRunService.read(params.data.fixtureId);
    if (!current.ok) return sendTemporalRunError(reply, current.error);
    if (
      current.value === null ||
      current.value.status !== 'waiting' ||
      current.value.wait.waitKind !== 'code_review@1'
    ) {
      return reply
        .code(409)
        .send(apiError('run_not_at_code_review', 'The run is not waiting for code review'));
    }
    const reviewId = `operator:${current.value.runId}:${current.value.wait.nodeId}`;
    const completed = await temporalRunService.resolveWait(params.data.fixtureId, {
      nodeId: current.value.wait.nodeId,
      waitKind: current.value.wait.waitKind,
      resolution: { decision: 'approved', reviewId },
    });
    if (!completed.ok) return sendTemporalRunError(reply, completed.error);
    return reply.send(
      CodeReviewSyncResponseSchema.parse({
        status: 'approved',
        reviewId,
        pullRequestUrl: null,
        run: completed.value,
      }),
    );
  });

  api.post('/api/workflows/:fixtureId/resume', async (request, reply) => {
    const params = FixtureParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(apiError('invalid_request', 'fixtureId is required'));
    }
    const command = ResumeRunCommandSchema.safeParse(request.body ?? {});
    if (!command.success) {
      return reply
        .code(400)
        .send(apiError('invalid_resume_guidance', 'Guidance must be non-empty when provided'));
    }
    const current = await temporalRunService.read(params.data.fixtureId);
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
      current.value.wait.waitKind === 'workflow_change.review@1' ||
      current.value.wait.waitKind === 'code_review@1'
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
    const resumed = await temporalRunService.resolveWait(params.data.fixtureId, {
      nodeId: current.value.wait.nodeId,
      waitKind: current.value.wait.waitKind,
      resolution: {
        decision: 'resume',
        ...(command.data.guidance === undefined ? {} : { guidance: command.data.guidance }),
      },
    });
    return resumed.ok
      ? sendTemporalState(reply, params.data.fixtureId, resumed.value)
      : sendTemporalRunError(reply, resumed.error);
  });

  api.post('/api/workflows/:fixtureId/plan-review', async (request, reply) => {
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
    const current = await temporalRunService.read(params.data.fixtureId);
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
    const reviewed = await temporalRunService.resolveWait(params.data.fixtureId, {
      nodeId: current.value.wait.nodeId,
      waitKind: current.value.wait.waitKind,
      resolution: command.data,
    });
    return reviewed.ok
      ? sendTemporalState(reply, params.data.fixtureId, reviewed.value)
      : sendTemporalRunError(reply, reviewed.error);
  });

  api.post('/api/workflows/:fixtureId/planning-clarification', async (request, reply) => {
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
    const current = await temporalRunService.read(params.data.fixtureId);
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
    const answered = await temporalRunService.resolveWait(params.data.fixtureId, {
      nodeId: current.value.wait.nodeId,
      waitKind: current.value.wait.waitKind,
      resolution: command.data,
    });
    return answered.ok
      ? sendTemporalState(reply, params.data.fixtureId, answered.value)
      : sendTemporalRunError(reply, answered.error);
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

    return reply.send(WorkflowResponseSchema.parse(result.value));
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

    return reply.send(result.value.view.workflow);
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
