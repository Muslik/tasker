import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import type {
  OperatorExecutionAttempt,
  OperatorRunLogEntry,
} from '../../control-plane/operator-contracts.js';
import {
  AttemptDetails,
  availableAttemptDetailsTabs,
  resolveAttemptDetailsTab,
  triggerAttemptTabChange,
} from './AttemptDetails.js';

const entry: OperatorRunLogEntry = {
  id: 'execution:deliver-pr:1',
  runtime: 'execution',
  nodeId: 'deliver-pr',
  reference: 'deliver.pull-request@1',
  blockRun: 1,
  status: 'completed',
  startedAt: '2026-08-30T10:03:00.000Z',
  completedAt: '2026-08-30T10:05:30.000Z',
  rawLog: 'raw execution log',
  truncated: false,
  runner: 'agent',
  resultSummary: 'Pull request delivered',
  usage: null,
  evidence: [],
  workspaceChanges: null,
};

const attempt: OperatorExecutionAttempt = {
  schemaVersion: 1,
  taskReference: 'TASK-1',
  workflowId: 'workflow-1',
  workflowRunId: 'run-1',
  nodeId: 'deliver-pr',
  blockRun: 1,
  transcript: {
    transcriptId: 'task-step-transcript:1',
    operationId: 'op-1',
    totalBytes: 32,
    truncated: false,
    chunks: [
      {
        schemaVersion: 1,
        transcriptId: 'task-step-transcript:1',
        operationId: 'op-1',
        sequence: 1,
        providerAttempt: 1,
        stream: 'stdout',
        content: 'hello\n',
        byteLength: 6,
        recordedAt: '2026-08-30T10:03:10.000Z',
      },
      {
        schemaVersion: 1,
        transcriptId: 'task-step-transcript:1',
        operationId: 'op-1',
        sequence: 2,
        providerAttempt: 1,
        stream: 'stderr',
        content: 'warning\n',
        byteLength: 8,
        recordedAt: '2026-08-30T10:03:12.000Z',
      },
    ],
  },
  output: {
    schemaVersion: 3,
    operationId: 'op-1',
    workflowId: 'workflow-1',
    workflowRunId: 'run-1',
    nodeId: 'deliver-pr',
    stepReference: 'deliver.pull-request@1',
    stepAttempt: 1,
    runner: 'agent',
    command: 'pnpm test',
    args: ['test'],
    cwd: '/workspace',
    exitCode: 0,
    status: 'completed',
    stdout: 'tests passed',
    stderr: '',
    details: { summary: 'done' },
    usage: null,
    result: null,
    recordedAt: '2026-08-30T10:05:30.000Z',
  },
  evidence: [],
  workspaceChanges: null,
};

describe('AttemptDetails', () => {
  it('renders transcript, output, and prompt placeholders in SSR', () => {
    const html = renderToStaticMarkup(
      createElement(AttemptDetails, {
        entry,
        attempt,
        selectedTab: 'output',
      }),
    );

    expect(html).toContain('Attempt #1');
    expect(html).toContain('pnpm test');
    expect(html).toContain('tests passed');
    expect(html).toContain('Prompt');
    expect(html).toContain('role="tablist"');
  });

  it('resolves available tabs and triggers tab callbacks', () => {
    const onTabChange = vi.fn();

    expect(availableAttemptDetailsTabs(entry, null)).toEqual(['log', 'prompt']);
    expect(availableAttemptDetailsTabs(entry, attempt)).toEqual([
      'log',
      'transcript',
      'output',
      'details',
      'prompt',
    ]);
    expect(resolveAttemptDetailsTab(entry, attempt, 'details')).toBe('details');
    expect(resolveAttemptDetailsTab(entry, null, 'details')).toBe('log');
    expect(triggerAttemptTabChange('details', onTabChange)).toBe('details');
    expect(onTabChange).toHaveBeenCalledWith('details');
  });
});
