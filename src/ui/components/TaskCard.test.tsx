import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import type {
  OperatorTaskInvocationListResponse,
  OperatorTaskSummary,
  OperatorWorkflowProjection,
} from '../../server/operator-contracts.js';
import { operatorQueryKeys } from '../api/index.js';
import {
  SELECTED_TASK_POLL_INTERVAL_MS,
  TaskCard,
  shouldPollSelectedTask,
  triggerTaskInvocationOpen,
} from './TaskCard.js';

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
  schemaVersion: 9,
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
  currentAttempt: {
    latestInvocationId: 'invocation-42',
    nodeId: 'verify-runtime',
    blockRun: 3,
    startedAt: '2026-08-30T09:40:00.000Z',
    waitingSince: '2026-08-30T09:45:00.000Z',
  },
  dependencies: [],
  stages: [],
  continuations: [],
};

const invocations: OperatorTaskInvocationListResponse = {
  schemaVersion: 1,
  taskReference: task.id,
  totals: {
    invocationCount: 1,
    inputTokens: 800,
    cachedInputTokens: 200,
    outputTokens: 500,
    reasoningOutputTokens: 100,
    totalTokens: 1_300,
    costUsd: 0.125,
    unratedCount: 0,
  },
  invocations: [
    {
      invocationId: 'invocation-42',
      taskReference: task.id,
      scope: 'execution',
      nodeId: 'verify-runtime',
      planningEpisodeId: null,
      blockRun: 3,
      provider: 'codex',
      profile: 'default',
      model: 'gpt-5.4',
      effort: 'high',
      serviceTier: 'fast',
      promptBytes: 3_072,
      durationMs: 300_000,
      status: 'waiting',
      startedAt: '2026-08-30T09:40:00.000Z',
      finishedAt: '2026-08-30T09:45:00.000Z',
      usage: {
        inputTokens: 800,
        cachedInputTokens: 200,
        outputTokens: 500,
        reasoningOutputTokens: 100,
      },
      cost: { source: 'provider_reported', amountUsd: 0.125 },
    },
  ],
};

describe('TaskCard', () => {
  it('polls only while the selected task is running', () => {
    expect(SELECTED_TASK_POLL_INTERVAL_MS).toBe(8_000);
    expect(shouldPollSelectedTask('running')).toBe(true);
    expect(shouldPollSelectedTask('waiting')).toBe(false);
    expect(shouldPollSelectedTask('done')).toBe(false);
  });

  it('answers what is happening and preserves the full wait reason', () => {
    const client = new QueryClient({
      defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY } },
    });
    client.setQueryData(operatorQueryKeys.projection(task.id), projection);
    client.setQueryData(operatorQueryKeys.runLog(task.id), null);
    client.setQueryData(operatorQueryKeys.currentRun(task.id), null);
    client.setQueryData(operatorQueryKeys.invocations(task.id), invocations);

    const html = renderToStaticMarkup(
      createElement(QueryClientProvider, { client }, createElement(TaskCard, { task })),
    );

    expect(html).toContain('Stabilize checkout recovery');
    expect(html).toContain('verify-runtime');
    expect(html).toContain('Block run');
    expect(html).toContain(
      'waiting for external.result@1 / The canary must remain healthy for the full observation window.',
    );
    expect(html).toContain('Open invocation');
    expect(html).toContain('Tokens');
    expect(html).toContain('1,300');
  });

  it('opens an exact invocation on the prompt tab', () => {
    const selectAttempt = vi.fn();
    const selectTab = vi.fn();
    const selection = {
      nodeId: 'verify-runtime',
      blockRun: 3,
      invocationId: 'invocation-42',
    };

    expect(triggerTaskInvocationOpen(selection, selectAttempt, selectTab)).toEqual(selection);
    expect(selectAttempt).toHaveBeenCalledWith(selection);
    expect(selectTab).toHaveBeenCalledWith('prompt');
  });
});
