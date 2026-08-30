import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import type {
  OperatorRunLogResponse,
  OperatorTaskInvocationListRow,
} from '../../server/operator-contracts.js';
import {
  AttemptsList,
  attemptSelectionFor,
  groupAttemptsByStep,
  resolveAttemptInvocation,
  triggerAttemptPromptOpen,
  triggerAttemptSelection,
} from './AttemptsList.js';

const runLog: OperatorRunLogResponse = {
  schemaVersion: 1,
  taskReference: 'TASK-1',
  bootstrapRunId: 'bootstrap-1',
  executionRunId: 'execution-1',
  entries: [
    {
      id: 'bootstrap:1',
      runtime: 'bootstrap',
      nodeId: 'planning',
      reference: 'implementation.plan',
      blockRun: 1,
      status: 'completed',
      startedAt: '2026-08-30T10:00:00.000Z',
      completedAt: '2026-08-30T10:01:30.000Z',
      rawLog: 'planner log',
      truncated: false,
      runner: 'planner',
      resultSummary: null,
      usage: null,
      evidence: [],
      workspaceChanges: null,
    },
    {
      id: 'execution:1',
      runtime: 'execution',
      nodeId: 'deliver-pr',
      reference: 'deliver.pull-request@1',
      blockRun: 1,
      status: 'blocked',
      startedAt: '2026-08-30T10:03:00.000Z',
      completedAt: '2026-08-30T10:05:30.000Z',
      rawLog: 'waiting for CI',
      truncated: false,
      runner: 'agent',
      resultSummary: 'Waiting on CI',
      usage: null,
      evidence: [],
      workspaceChanges: null,
    },
    {
      id: 'execution:2',
      runtime: 'execution',
      nodeId: 'deliver-pr',
      reference: 'deliver.pull-request@1',
      blockRun: 2,
      status: 'completed',
      startedAt: '2026-08-30T10:10:00.000Z',
      completedAt: '2026-08-30T10:12:00.000Z',
      rawLog: 'merged',
      truncated: false,
      runner: 'agent',
      resultSummary: 'Pull request delivered',
      usage: null,
      evidence: [],
      workspaceChanges: null,
    },
  ],
};

const invocations: readonly OperatorTaskInvocationListRow[] = [
  {
    invocationId: 'invocation-deliver-1-new',
    taskReference: 'TASK-1',
    scope: 'execution',
    nodeId: 'deliver-pr',
    planningEpisodeId: null,
    blockRun: 1,
    provider: 'codex',
    profile: 'default',
    model: 'gpt-5.4',
    effort: 'high',
    serviceTier: 'fast',
    promptBytes: 220,
    durationMs: 7_000,
    status: 'waiting',
    startedAt: '2026-08-30T10:04:00.000Z',
    finishedAt: '2026-08-30T10:04:07.000Z',
    usage: {
      inputTokens: 11,
      cachedInputTokens: 1,
      outputTokens: 3,
      reasoningOutputTokens: 2,
    },
    cost: { source: 'provider_reported', amountUsd: 0.18 },
  },
  {
    invocationId: 'invocation-deliver-1-old',
    taskReference: 'TASK-1',
    scope: 'execution',
    nodeId: 'deliver-pr',
    planningEpisodeId: null,
    blockRun: 1,
    provider: 'codex',
    profile: 'default',
    model: 'gpt-5.4',
    effort: 'high',
    serviceTier: 'fast',
    promptBytes: 180,
    durationMs: 4_000,
    status: 'failed',
    startedAt: '2026-08-30T10:03:00.000Z',
    finishedAt: '2026-08-30T10:03:04.000Z',
    usage: {
      inputTokens: 10,
      cachedInputTokens: 1,
      outputTokens: 2,
      reasoningOutputTokens: 1,
    },
    cost: { source: 'unrated' },
  },
  {
    invocationId: 'invocation-deliver-2',
    taskReference: 'TASK-1',
    scope: 'execution',
    nodeId: 'deliver-pr',
    planningEpisodeId: null,
    blockRun: 2,
    provider: 'codex',
    profile: 'default',
    model: 'gpt-5.4',
    effort: 'high',
    serviceTier: 'fast',
    promptBytes: 256,
    durationMs: 5_000,
    status: 'completed',
    startedAt: '2026-08-30T10:10:00.000Z',
    finishedAt: '2026-08-30T10:10:05.000Z',
    usage: {
      inputTokens: 12,
      cachedInputTokens: 2,
      outputTokens: 4,
      reasoningOutputTokens: 2,
    },
    cost: { source: 'price_table', amountUsd: 0.24, pricingVersion: '2026-08-30' },
  },
];

describe('AttemptsList', () => {
  it('renders grouped attempts for SSR', () => {
    const html = renderToStaticMarkup(
      createElement(AttemptsList, {
        runLog,
        invocations,
        selectedAttempt: {
          nodeId: 'deliver-pr',
          blockRun: 2,
          invocationId: 'invocation-deliver-2',
        },
      }),
    );

    expect(html).toContain('Attempts');
    expect(html).toContain('Planning');
    expect(html).toContain('deliver.pull-request@1');
    expect(html).toContain('Planning only');
    expect(html).toContain('Prompt');
    expect(html).toContain('1m');
    expect(html).toContain('2m');
    expect(html).toContain('aria-pressed="true"');
  });

  it('builds selection payloads and triggers selection callbacks', () => {
    const groups = groupAttemptsByStep(runLog, invocations);
    const onSelectAttempt = vi.fn();
    const selectedEntry = runLog.entries[2];
    const blockedEntry = runLog.entries[1];
    const planningEntry = runLog.entries[0];
    if (selectedEntry === undefined || blockedEntry === undefined || planningEntry === undefined) {
      throw new Error('Test fixture is incomplete');
    }

    expect(groups).toHaveLength(2);
    expect(groups[1]?.attempts.map(({ selection }) => selection)).toEqual([
      {
        nodeId: 'deliver-pr',
        blockRun: 1,
        invocationId: 'invocation-deliver-1-new',
      },
      {
        nodeId: 'deliver-pr',
        blockRun: 2,
        invocationId: 'invocation-deliver-2',
      },
    ]);
    expect(resolveAttemptInvocation(blockedEntry, invocations)?.invocationId).toBe(
      'invocation-deliver-1-new',
    );
    expect(attemptSelectionFor(selectedEntry, invocations)).toEqual({
      nodeId: 'deliver-pr',
      blockRun: 2,
      invocationId: 'invocation-deliver-2',
    });
    expect(attemptSelectionFor(planningEntry, invocations)).toEqual({
      nodeId: 'planning',
      blockRun: 1,
      invocationId: null,
    });
    expect(triggerAttemptSelection(blockedEntry, invocations, onSelectAttempt)).toEqual({
      nodeId: 'deliver-pr',
      blockRun: 1,
      invocationId: 'invocation-deliver-1-new',
    });
    expect(onSelectAttempt).toHaveBeenCalledWith({
      nodeId: 'deliver-pr',
      blockRun: 1,
      invocationId: 'invocation-deliver-1-new',
    });
  });

  it('opens the resolved prompt invocation', () => {
    const onOpenInvocation = vi.fn();
    const blockedEntry = runLog.entries[1];
    if (blockedEntry === undefined) throw new Error('Test fixture is incomplete');

    expect(triggerAttemptPromptOpen(blockedEntry, invocations, onOpenInvocation)).toEqual({
      nodeId: 'deliver-pr',
      blockRun: 1,
      invocationId: 'invocation-deliver-1-new',
    });
    expect(onOpenInvocation).toHaveBeenCalledWith({
      nodeId: 'deliver-pr',
      blockRun: 1,
      invocationId: 'invocation-deliver-1-new',
    });
  });
});
