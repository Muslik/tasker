import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  buildM1Api,
  createM1WorkflowService,
  FixtureListResponseSchema,
  WorkflowResponseSchema,
} from '../../src/control-plane/index.js';
import { openSqliteLedger, type SqliteLedger } from '../../src/ledger/index.js';
import { makeAdjustableClock } from '../../src/shared/clock.js';

const resources: { readonly directory: string; readonly ledger: SqliteLedger }[] = [];

const setup = () => {
  const directory = mkdtempSync(join(tmpdir(), 'tasker-m1-api-'));
  const clock = makeAdjustableClock('2026-08-01T12:00:00.000Z');
  const ledger = openSqliteLedger({ filename: join(directory, 'ledger.sqlite'), clock });
  resources.push({ directory, ledger });
  const service = createM1WorkflowService(ledger.repository, clock);
  return { api: buildM1Api({ service }), ledger };
};

afterEach(() => {
  for (const resource of resources.splice(0)) {
    resource.ledger.close();
    rmSync(resource.directory, { recursive: true, force: true });
  }
});

describe('M1 HTTP API', () => {
  it('lists fixtures, generates a workflow, reads it, and downloads the exact graph', async () => {
    const { api, ledger } = setup();

    const fixturesResponse = await api.inject({ method: 'GET', url: '/api/fixtures' });
    const fixtures = FixtureListResponseSchema.parse(fixturesResponse.json());
    const generateResponse = await api.inject({
      method: 'POST',
      url: '/api/workflows/avia-13236-short-bug/generate',
    });
    const generated = WorkflowResponseSchema.parse(generateResponse.json());
    const readResponse = await api.inject({
      method: 'GET',
      url: '/api/workflows/avia-13236-short-bug',
    });
    const restored = WorkflowResponseSchema.parse(readResponse.json());
    const downloadResponse = await api.inject({
      method: 'GET',
      url: '/api/workflows/avia-13236-short-bug/graph.json',
    });
    const intakeResponse = await api.inject({
      method: 'GET',
      url: '/api/intakes/intake%3Aavia-13236-short-bug',
    });
    const taskResponse = await api.inject({
      method: 'GET',
      url: '/api/tasks/AVIA-13236',
    });
    const graphProjectionResponse = await api.inject({
      method: 'GET',
      url: '/api/graphs/avia-13236-short-bug',
    });
    const runResponse = await api.inject({ method: 'GET', url: '/api/runs/not-created-in-m1' });

    expect(fixtures.fixtures).toHaveLength(8);
    expect(generateResponse.statusCode).toBe(200);
    expect(generated.status).toBe('ready');
    expect(restored).toEqual(generated);
    expect(downloadResponse.statusCode).toBe(200);
    expect(downloadResponse.headers['content-disposition']).toContain(
      'avia-13236-short-bug-graph.json',
    );
    expect(downloadResponse.json()).toEqual(generated.view.workflow.graph);
    expect(intakeResponse.json()).toMatchObject({ intake: { status: 'accepted' } });
    expect(taskResponse.json()).toMatchObject({ task: { status: 'planned' } });
    expect(graphProjectionResponse.json()).toEqual(generated.view.workflow);
    expect(runResponse.statusCode).toBe(404);
    expect(ledger.repository.listOutbox()).toEqual([]);

    await api.close();
  });

  it('returns a structured rejected workflow and refuses graph download', async () => {
    const { api } = setup();

    const generateResponse = await api.inject({
      method: 'POST',
      url: '/api/workflows/invalid-unmet-capability/generate',
    });
    const generated = WorkflowResponseSchema.parse(generateResponse.json());
    const downloadResponse = await api.inject({
      method: 'GET',
      url: '/api/workflows/invalid-unmet-capability/graph.json',
    });

    expect(generated.status).toBe('rejected');
    expect(generated.view.workflow.validatorReport.issues[0]?.message).toContain('repository.read');
    expect(downloadResponse.statusCode).toBe(409);
    expect(downloadResponse.json()).toMatchObject({ error: 'workflow_rejected' });

    await api.close();
  });

  it('keeps missing fixtures and non-generated workflows distinct', async () => {
    const { api } = setup();

    const missingWorkflow = await api.inject({
      method: 'GET',
      url: '/api/workflows/avia-12536-feature-review',
    });
    const unknownFixture = await api.inject({
      method: 'POST',
      url: '/api/workflows/not-in-catalog/generate',
    });

    expect(missingWorkflow.statusCode).toBe(404);
    expect(missingWorkflow.json()).toMatchObject({ error: 'workflow_not_found' });
    expect(unknownFixture.statusCode).toBe(404);
    expect(unknownFixture.json()).toMatchObject({ error: 'fixture_not_found' });

    await api.close();
  });
});
