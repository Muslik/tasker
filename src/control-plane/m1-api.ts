import { readFile } from 'node:fs/promises';
import { extname, join, relative, resolve } from 'node:path';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import { z } from 'zod';

import {
  ImplementationPlanningRecordSchema,
  type ImplementationPlanningCoordinator,
} from './implementation-planning.js';
import type { JiraIssueService, JiraIssueServiceError } from '../integrations/index.js';
import {
  RepositoryCatalogResponseSchema,
  RepositoryReferenceSchema,
} from '../repositories/contracts.js';
import {
  ApiErrorResponseSchema,
  OperatorActivityResponseSchema,
  OperatorTaskSummarySchema,
  WorkflowResponseSchema,
  type OperatorTaskSummary,
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
  readonly runService?: DeterministicStubRunService | undefined;
  readonly scheduler?: DurableStubScheduler | undefined;
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

  api.get('/api/health', () => ({ status: 'ok', milestone: 'm1' }));

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

  api.get('/api/operator/tasks', (_request, reply) => {
    const result = options.service.listOperatorTasks();
    if (!result.ok) return sendServiceError(reply, result.error);
    const withRunState = (task: OperatorTaskSummary): OperatorTaskSummary => {
      const withPlanning = options.implementationPlanning?.decorateTask(task) ?? task;
      if (options.runService === undefined) return withPlanning;
      const run = options.runService.read(task.id);
      return run.ok ? applyRunToTask(withPlanning, run.value) : withPlanning;
    };
    if (options.jiraIssueService === undefined) {
      return reply.send({
        ...result.value,
        tasks: result.value.tasks.map(withRunState),
      });
    }
    const jiraTasks = options.jiraIssueService.listOperatorTasks();
    if (!jiraTasks.ok) return sendJiraServiceError(reply, jiraTasks.error);
    const hydratedJiraTasks = [];
    for (const task of jiraTasks.value) {
      const workflow = options.service.read(task.id);
      if (!workflow.ok) return sendServiceError(reply, workflow.error);
      hydratedJiraTasks.push(
        withRunState(
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
      tasks: [...hydratedJiraTasks, ...result.value.tasks.map(withRunState)],
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
            ...(options.runService?.readActivity(params.data.fixtureId) ?? []),
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
              ...(options.runService?.readActivity(params.data.fixtureId) ?? []),
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

    return reply.send(
      WorkflowResponseSchema.parse(
        options.runService?.decorateWorkflow(result.value) ?? result.value,
      ),
    );
  });

  api.get('/api/workflows/:fixtureId/run', (request, reply) => {
    if (options.runService === undefined) {
      return reply.code(503).send(apiError('runner_not_configured', 'M2 runner is disabled'));
    }
    const params = FixtureParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(apiError('invalid_request', 'fixtureId is required'));
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

  api.post('/api/workflows/:fixtureId/start', async (request, reply) => {
    if (options.runService === undefined) {
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
        return reply
          .code(409)
          .send(apiError('planning_clarification_required', 'Answer the planning questions'));
      }
      if (planned.value.status === 'workflow_change_required') {
        return reply
          .code(409)
          .send(apiError('workflow_change_required', planned.value.decision.request.reason));
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

  api.post('/api/workflows/:fixtureId/resume', (request, reply) => {
    if (options.runService === undefined) {
      return reply.code(503).send(apiError('runner_not_configured', 'M2 runner is disabled'));
    }
    const params = FixtureParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(apiError('invalid_request', 'fixtureId is required'));
    }
    const result =
      options.scheduler === undefined
        ? options.runService.resume(params.data.fixtureId)
        : options.runService.resolveWait(params.data.fixtureId);
    return result.ok
      ? reply.send(RunProjectionSchema.parse(result.value))
      : sendRunError(reply, result.error);
  });

  api.post('/api/workflows/:fixtureId/plan-review', async (request, reply) => {
    if (options.runService === undefined) {
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
        return reply
          .code(409)
          .send(apiError('planning_clarification_required', 'Answer the planning questions'));
      }
      if (planned.value.status === 'workflow_change_required') {
        return reply
          .code(409)
          .send(apiError('workflow_change_required', planned.value.decision.request.reason));
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
