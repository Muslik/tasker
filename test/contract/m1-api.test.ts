import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildM1Api,
  createM1WorkflowService,
  FixtureListResponseSchema,
  OperatorTaskListResponseSchema,
  WorkflowResponseSchema,
} from '../../src/control-plane/index.js';
import { openSqliteLedger, type SqliteLedger } from '../../src/ledger/index.js';
import { makeAdjustableClock } from '../../src/shared/clock.js';

const resources: { readonly directory: string; readonly ledger: SqliteLedger }[] = [];

const setup = (useWorkflowGenerator = false) => {
  const directory = mkdtempSync(join(tmpdir(), 'tasker-m1-api-'));
  const clock = makeAdjustableClock('2026-08-01T12:00:00.000Z');
  const ledger = openSqliteLedger({ filename: join(directory, 'ledger.sqlite'), clock });
  resources.push({ directory, ledger });
  const service = createM1WorkflowService(ledger.repository, clock);
  const generate = vi.fn((fixtureId: string) => Promise.resolve(service.generate(fixtureId)));
  return {
    api: buildM1Api({
      service,
      ...(useWorkflowGenerator ? { workflowGenerator: { generate } } : {}),
    }),
    generate,
    ledger,
    service,
  };
};

afterEach(() => {
  for (const resource of resources.splice(0)) {
    resource.ledger.close();
    rmSync(resource.directory, { recursive: true, force: true });
  }
});

describe('M1 HTTP API', () => {
  it('routes operator generation through the configured real-provider boundary', async () => {
    const { api, generate } = setup(true);

    const response = await api.inject({
      method: 'POST',
      url: '/api/workflows/avia-13236-short-bug/generate',
    });

    expect(response.statusCode).toBe(200);
    expect(generate).toHaveBeenCalledExactlyOnceWith('avia-13236-short-bug');

    await api.close();
  });

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

    expect(fixtures.fixtures).toHaveLength(9);
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

  it('renders persisted workflow state as an operator task queue', async () => {
    const { api, service } = setup();
    service.generate('avia-13236-short-bug');
    service.generate('invalid-unknown-step');

    const response = await api.inject({ method: 'GET', url: '/api/operator/tasks' });
    const taskList = OperatorTaskListResponseSchema.parse(response.json());
    const { tasks } = taskList;

    expect(response.statusCode).toBe(200);
    expect(taskList.streamCursor).toBe(6);
    expect(tasks.find((task) => task.taskId === 'AVIA-13236')).toMatchObject({
      status: 'planned',
      attention: 'none',
    });
    expect(tasks.find((task) => task.taskId === 'AVIA-15001')).toMatchObject({
      status: 'workflow_rejected',
      attention: 'operator',
    });
    expect(tasks.find((task) => task.taskId === 'AVIA-12536')).toMatchObject({
      status: 'backlog',
    });

    await api.close();
  });

  it('exposes the selected task persisted activity without inventing agent output', async () => {
    const { api, service } = setup();
    service.generate('avia-13236-short-bug');

    const response = await api.inject({
      method: 'GET',
      url: '/api/operator/tasks/avia-13236-short-bug/activity',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      providerSession: { status: 'not_started', reason: 'm1_planning_only' },
      entries: [
        { source: 'kernel', title: 'Intake accepted' },
        { source: 'kernel', title: 'Task created' },
        { source: 'planner', title: 'Workflow compiled and persisted' },
      ],
    });

    await api.close();
  });

  it('replays persisted stream events after the supplied ledger cursor', () => {
    const { service } = setup();
    service.generate('avia-13236-short-bug');

    const events = service.listStreamEventsAfter(2);

    expect(events).toEqual([
      {
        sequence: 3,
        fixtureId: 'avia-13236-short-bug',
        eventType: 'WorkflowPlanned',
      },
    ]);
  });
});
