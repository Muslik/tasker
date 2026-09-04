import { describe, expect, it, vi, afterEach } from 'vitest';

import type {
  OperatorTaskInvocationDetail,
  OperatorTaskInvocationListResponse,
} from '../../server/operator-contracts.js';
import {
  fetchTaskInvocation,
  fetchTaskInvocations,
  taskInvocationQueryOptions,
  taskInvocationsQueryOptions,
} from './invocations.js';
import { operatorQueryKeys } from './query.js';

const invocationListFixture = (): OperatorTaskInvocationListResponse => ({
  schemaVersion: 1,
  taskReference: 'jira:AVIA-1',
  invocations: [
    {
      invocationId: 'invocation-1',
      taskReference: 'jira:AVIA-1',
      scope: 'execution',
      nodeId: 'build',
      planningEpisodeId: null,
      blockRun: 2,
      provider: 'codex',
      profile: 'default',
      model: 'gpt-5.4',
      effort: 'high',
      serviceTier: 'fast',
      promptBytes: 128,
      durationMs: 4200,
      status: 'completed',
      startedAt: '2026-08-30T00:00:00.000Z',
      finishedAt: '2026-08-30T00:00:04.200Z',
      usage: {
        inputTokens: 10,
        cachedInputTokens: 1,
        outputTokens: 4,
        reasoningOutputTokens: 2,
      },
      cost: {
        source: 'price_table',
        amountUsd: 0.12,
        pricingVersion: '2026-08-30',
      },
    },
  ],
  totals: {
    invocationCount: 1,
    inputTokens: 10,
    cachedInputTokens: 1,
    outputTokens: 4,
    reasoningOutputTokens: 2,
    totalTokens: 14,
    costUsd: 0.12,
    unratedCount: 0,
  },
});

const invocationDetailFixture = (): OperatorTaskInvocationDetail => ({
  schemaVersion: 1,
  invocationId: 'invocation/1',
  taskReference: 'jira:AVIA-1/subtask',
  prompt: 'Run the task.',
  promptBytes: 256,
  provider: 'codex',
  profile: 'default',
  profileSha256: 'a'.repeat(64),
  model: 'gpt-5.4',
  effort: 'high',
  serviceTier: 'fast',
  argv: ['codex', 'exec'],
  skills: ['typescript-design'],
  inputEvidenceArtifactIds: ['artifact-1'],
  startedAt: '2026-08-30T00:00:00.000Z',
  finishedAt: '2026-08-30T00:00:05.000Z',
  durationMs: 5000,
  status: 'completed',
  exitStatus: {
    kind: 'exited',
    exitCode: 0,
  },
  usage: {
    inputTokens: 11,
    cachedInputTokens: 2,
    outputTokens: 5,
    reasoningOutputTokens: 3,
  },
  cost: {
    source: 'provider_reported',
    amountUsd: 0.34,
  },
  references: {
    kind: 'execution',
    workflowId: 'wf-1',
    runId: 'run-1',
    nodeId: 'deliver',
    blockRun: 3,
    providerAttempt: 1,
    transcriptId: 'transcript-1',
    outputArtifactIds: ['artifact-2'],
    receiptArtifactId: null,
  },
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('task invocation API', () => {
  it('fetches and parses invocation list responses with the canonical query key', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(invocationListFixture()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchTaskInvocations('jira:AVIA-1')).resolves.toEqual(invocationListFixture());
    expect(taskInvocationsQueryOptions('jira:AVIA-1').queryKey).toEqual(
      operatorQueryKeys.invocations('jira:AVIA-1'),
    );
    const request = fetchMock.mock.calls[0];
    expect(request?.[0]).toBe('/api/operator/tasks/jira%3AAVIA-1/invocations');
    expect(request?.[1]?.headers).toBeInstanceOf(Headers);
  });

  it('fetches invocation detail with encoded task and invocation identities', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(invocationDetailFixture()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchTaskInvocation('jira:AVIA-1/subtask', 'invocation/1')).resolves.toEqual(
      invocationDetailFixture(),
    );
    expect(taskInvocationQueryOptions('jira:AVIA-1/subtask', 'invocation/1').queryKey).toEqual(
      operatorQueryKeys.invocation('jira:AVIA-1/subtask', 'invocation/1'),
    );
    const request = fetchMock.mock.calls[0];
    expect(request?.[0]).toBe(
      '/api/operator/tasks/jira%3AAVIA-1%2Fsubtask/invocations/invocation%2F1',
    );
    expect(request?.[1]?.headers).toBeInstanceOf(Headers);
  });
});
