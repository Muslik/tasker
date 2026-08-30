import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import type { OperatorRunLogResponse } from '../../control-plane/operator-contracts.js';
import {
  AttemptsList,
  attemptSelectionFor,
  groupAttemptsByStep,
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

describe('AttemptsList', () => {
  it('renders grouped attempts for SSR', () => {
    const html = renderToStaticMarkup(
      createElement(AttemptsList, {
        runLog,
        selectedAttempt: { nodeId: 'deliver-pr', blockRun: 2 },
      }),
    );

    expect(html).toContain('Attempts');
    expect(html).toContain('Planning');
    expect(html).toContain('deliver.pull-request@1');
    expect(html).toContain('1m');
    expect(html).toContain('2m');
    expect(html).toContain('aria-pressed="true"');
  });

  it('builds selection payloads and triggers selection callbacks', () => {
    const groups = groupAttemptsByStep(runLog);
    const onSelectAttempt = vi.fn();
    const selectedEntry = runLog.entries[2];
    const blockedEntry = runLog.entries[1];
    if (selectedEntry === undefined || blockedEntry === undefined) {
      throw new Error('Test fixture is incomplete');
    }

    expect(groups).toHaveLength(2);
    expect(groups[1]?.attempts.map(({ selection }) => selection)).toEqual([
      { nodeId: 'deliver-pr', blockRun: 1 },
      { nodeId: 'deliver-pr', blockRun: 2 },
    ]);
    expect(attemptSelectionFor(selectedEntry)).toEqual({
      nodeId: 'deliver-pr',
      blockRun: 2,
    });
    expect(triggerAttemptSelection(blockedEntry, onSelectAttempt)).toEqual({
      nodeId: 'deliver-pr',
      blockRun: 1,
    });
    expect(onSelectAttempt).toHaveBeenCalledWith({ nodeId: 'deliver-pr', blockRun: 1 });
  });
});
