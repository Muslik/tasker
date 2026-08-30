import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type {
  OperatorActivityResponse,
  OperatorTaskSummary,
  OperatorWorkflowProjection,
} from '../../control-plane/operator-contracts.js';
import { operatorQueryKeys } from '../api/index.js';
import { TaskCard, buildTaskHeaderView } from './TaskCard.js';

const task: OperatorTaskSummary = {
  id: 'jira:AVIA-42',
  taskId: 'AVIA-42',
  title: 'Stabilize checkout recovery',
  origin: {
    kind: 'jira',
    issueKey: 'AVIA-42',
    issueType: 'Bug',
    browseUrl: null,
    syncStatus: 'current',
    repositoryBinding: {
      status: 'missing',
      issueKey: 'AVIA-42',
      recordedAt: '2026-08-30T09:00:00.000Z',
    },
  },
  planning: { status: 'available' },
  status: 'waiting',
  attention: 'operator',
  currentStage: 'Waiting for operator decision',
  updatedAt: '2026-08-30T09:00:00.000Z',
};

const projection: OperatorWorkflowProjection = {
  schemaVersion: 8,
  taskReference: task.id,
  status: 'waiting',
  activeRuntime: 'execution',
  activeRunId: 'run-42',
  graphHash: null,
  current: {
    runtime: 'execution',
    nodeId: 'verify-runtime',
    reference: 'runtime.verify@1',
    blockRun: 3,
    transcript: null,
    status: 'waiting',
    waitKind: 'external.result@1',
    reason: 'The canary must remain healthy for the full observation window.',
    intervention: { kind: 'external_prerequisite' },
  },
  dependencies: [],
  stages: [],
  continuations: [],
};

const activity: OperatorActivityResponse = {
  taskReference: task.id,
  providerSession: { status: 'not_started', reason: 'planning_only' },
  entries: [
    {
      sequence: 1,
      occurredAt: '2026-08-30T09:45:00.000Z',
      source: 'kernel',
      level: 'info',
      title: 'Waiting',
      detail: 'Observation window opened',
    },
  ],
};

describe('TaskCard', () => {
  it('answers what is happening and preserves the full wait reason', () => {
    const client = new QueryClient({
      defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY } },
    });
    client.setQueryData(operatorQueryKeys.projection(task.id), projection);
    client.setQueryData(operatorQueryKeys.activity(task.id), activity);
    client.setQueryData(operatorQueryKeys.runLog(task.id), null);
    client.setQueryData(operatorQueryKeys.currentRun(task.id), null);

    const html = renderToStaticMarkup(
      createElement(QueryClientProvider, { client }, createElement(TaskCard, { task })),
    );

    expect(html).toContain('Stabilize checkout recovery');
    expect(html).toContain('verify-runtime');
    expect(html).toContain('Attempt</dt><dd class="mt-1 font-medium text-foreground">3');
    expect(html).toContain('The canary must remain healthy for the full observation window.');
    expect(html).toContain('Tokens');
  });

  it('derives time in state from the latest activity transition', () => {
    const header = buildTaskHeaderView(
      projection,
      activity,
      task.updatedAt,
      Date.parse('2026-08-30T10:00:00.000Z'),
    );

    expect(header.timeInState).toBe('15m');
    expect(header.attempt).toBe('3');
  });
});
