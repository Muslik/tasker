import { readFile } from 'node:fs/promises';
import { extname, join, relative, resolve } from 'node:path';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import { z } from 'zod';

import type { JiraIssueService, JiraIssueServiceError } from '../integrations/index.js';
import { ApiErrorResponseSchema } from './m1-contracts.js';
import type { M1ServiceError, M1WorkflowService } from './m1-service.js';
import { providerFailureSummary, type WorkflowGenerator } from './workflow-generator.js';

const FixtureParamsSchema = z.object({ fixtureId: z.string().min(1) }).strict();
const JiraIssueParamsSchema = z.object({ issueKey: z.string().min(1) }).strict();
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
}

const apiError = (error: string, message: string) =>
  ApiErrorResponseSchema.parse({ error, message });

const sendServiceError = (reply: FastifyReply, error: M1ServiceError): FastifyReply => {
  switch (error.kind) {
    case 'fixture_not_found':
      return reply
        .code(404)
        .send(apiError('fixture_not_found', `Fixture ${error.fixtureId} does not exist`));
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

  api.get('/api/operator/tasks', (_request, reply) => {
    const result = options.service.listOperatorTasks();
    if (!result.ok) return sendServiceError(reply, result.error);
    if (options.jiraIssueService === undefined) return reply.send(result.value);
    const jiraTasks = options.jiraIssueService.listOperatorTasks();
    if (!jiraTasks.ok) return sendJiraServiceError(reply, jiraTasks.error);
    return reply.send({
      tasks: [...jiraTasks.value, ...result.value.tasks],
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
      return jiraResult.ok
        ? reply.send(jiraResult.value)
        : sendJiraServiceError(reply, jiraResult.error);
    }

    const result = options.service.readActivity(params.data.fixtureId);
    return result.ok ? reply.send(result.value) : sendServiceError(reply, result.error);
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
    const result = await options.jiraIssueService.sync(params.data.issueKey);
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
      for (const event of options.service.listStreamEventsAfter(cursor)) {
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

    return reply.send(result.value);
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

    return reply.send(result.value);
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
