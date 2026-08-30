import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import type { OperatorTaskInvocationListResponse } from '../../server/operator-contracts.js';
import {
  buildInvocationTokensRows,
  invocationSelectionFor,
  InvocationTokens,
  triggerInvocationSelection,
} from './InvocationTokens.js';

const invocations: OperatorTaskInvocationListResponse = {
  schemaVersion: 1,
  taskReference: 'jira:AVIA-42',
  totals: {
    invocationCount: 3,
    inputTokens: 1_500,
    cachedInputTokens: 220,
    outputTokens: 640,
    reasoningOutputTokens: 80,
    totalTokens: 2_140,
    costUsd: 0.3142,
    unratedCount: 1,
  },
  invocations: [
    {
      invocationId: 'invocation-2',
      taskReference: 'jira:AVIA-42',
      scope: 'execution',
      nodeId: 'deliver-pr',
      planningEpisodeId: null,
      blockRun: 2,
      provider: 'codex',
      profile: 'default',
      model: 'gpt-5.4',
      effort: 'high',
      serviceTier: 'fast',
      promptBytes: 2_600,
      durationMs: 120_000,
      status: 'waiting',
      startedAt: '2026-08-30T10:00:00.000Z',
      finishedAt: '2026-08-30T10:02:00.000Z',
      usage: {
        inputTokens: 800,
        cachedInputTokens: 100,
        outputTokens: 340,
        reasoningOutputTokens: 40,
      },
      cost: { source: 'price_table', amountUsd: 0.2118, pricingVersion: '2026-08-01' },
    },
    {
      invocationId: 'invocation-1',
      taskReference: 'jira:AVIA-42',
      scope: 'execution',
      nodeId: 'deliver-pr',
      planningEpisodeId: null,
      blockRun: 1,
      provider: 'codex',
      profile: 'default',
      model: 'gpt-5.4',
      effort: 'high',
      serviceTier: 'fast',
      promptBytes: 1_024,
      durationMs: 90_000,
      status: 'completed',
      startedAt: '2026-08-30T09:00:00.000Z',
      finishedAt: '2026-08-30T09:01:30.000Z',
      usage: {
        inputTokens: 700,
        cachedInputTokens: 120,
        outputTokens: 300,
        reasoningOutputTokens: 40,
      },
      cost: { source: 'provider_reported', amountUsd: 0.1024 },
    },
    {
      invocationId: 'invocation-3',
      taskReference: 'jira:AVIA-42',
      scope: 'planning',
      nodeId: null,
      planningEpisodeId: 'planning-1',
      blockRun: null,
      provider: 'claude',
      profile: 'planner',
      model: 'claude-opus',
      effort: 'medium',
      serviceTier: null,
      promptBytes: 700,
      durationMs: 30_000,
      status: 'failed',
      startedAt: '2026-08-30T08:30:00.000Z',
      finishedAt: '2026-08-30T08:30:30.000Z',
      usage: {
        inputTokens: null,
        cachedInputTokens: null,
        outputTokens: null,
        reasoningOutputTokens: null,
      },
      cost: { source: 'unrated' },
    },
  ],
};

describe('InvocationTokens', () => {
  it('renders totals and newest-first invocation rows in SSR', () => {
    const rows = buildInvocationTokensRows(invocations);
    const html = renderToStaticMarkup(
      createElement(InvocationTokens, {
        invocations,
      }),
    );

    expect(html).toContain('Total tokens');
    expect(html).toContain('2,140');
    expect(html).toContain('deliver-pr');
    expect(html).toContain('2.5');
    expect(html).toContain('$0.3142');
    expect(html).toContain('Planning');
    expect(rows.map((row) => row.invocationId)).toEqual([
      'invocation-2',
      'invocation-1',
      'invocation-3',
    ]);
  });

  it('flags prompt spikes and emits invocation selections for execution rows', () => {
    const onOpenInvocation = vi.fn();
    const rows = buildInvocationTokensRows(invocations);
    const firstRow = invocations.invocations[0];
    const planningRow = invocations.invocations[2];
    if (firstRow === undefined || planningRow === undefined) {
      throw new Error('Test fixture is incomplete');
    }

    expect(rows[0]?.invocationId).toBe('invocation-2');
    expect(rows[0]?.promptSpike).toBe(true);
    expect(invocationSelectionFor(firstRow)).toEqual({
      nodeId: 'deliver-pr',
      blockRun: 2,
      invocationId: 'invocation-2',
    });
    expect(triggerInvocationSelection(firstRow, onOpenInvocation)).toEqual({
      nodeId: 'deliver-pr',
      blockRun: 2,
      invocationId: 'invocation-2',
    });
    expect(triggerInvocationSelection(planningRow, onOpenInvocation)).toBeNull();
    expect(onOpenInvocation).toHaveBeenCalledWith({
      nodeId: 'deliver-pr',
      blockRun: 2,
      invocationId: 'invocation-2',
    });
  });
});
