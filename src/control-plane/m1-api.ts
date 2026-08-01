import { readFile } from 'node:fs/promises';
import { extname, join, relative, resolve } from 'node:path';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import { z } from 'zod';

import { ApiErrorResponseSchema } from './m1-contracts.js';
import type { M1ServiceError, M1WorkflowService } from './m1-service.js';

const FixtureParamsSchema = z.object({ fixtureId: z.string().min(1) }).strict();
const ProjectionParamsSchema = z.object({ projectionId: z.string().min(1) }).strict();
const AssetParamsSchema = z.object({ '*': z.string().min(1) }).strict();

export interface BuildM1ApiOptions {
  readonly service: M1WorkflowService;
  readonly cockpitDirectory?: string | undefined;
  readonly logger?: boolean | undefined;
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

    const result = options.service.generate(params.data.fixtureId);
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
