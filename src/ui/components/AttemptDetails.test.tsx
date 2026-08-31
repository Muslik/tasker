import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import type {
  OperatorExecutionAttempt,
  OperatorRunLogEntry,
  OperatorTaskInvocationDetail,
} from '../../server/operator-contracts.js';
import {
  AttemptDetails,
  availableAttemptDetailsTabs,
  resolveAttemptDetailsTab,
  triggerAttemptTabChange,
} from './AttemptDetails.js';
import { summarizeProviderEventLine } from './attemptDetailsSupport.js';

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
    schemaVersion: 4,
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

const invocationDetail: OperatorTaskInvocationDetail = {
  schemaVersion: 1,
  invocationId: 'invocation-deliver-1',
  taskReference: 'TASK-1',
  prompt: 'Run the task.',
  promptBytes: 13,
  provider: 'codex',
  profile: 'default',
  profileSha256: 'a'.repeat(64),
  model: 'gpt-5.4',
  effort: 'high',
  serviceTier: 'fast',
  argv: ['codex', 'exec', '--json'],
  skills: ['typescript-design'],
  inputEvidenceArtifactIds: ['artifact-1'],
  startedAt: '2026-08-30T10:03:00.000Z',
  finishedAt: '2026-08-30T10:03:05.000Z',
  durationMs: 5_000,
  status: 'completed',
  exitStatus: { kind: 'exited', exitCode: 0 },
  usage: {
    inputTokens: 11,
    cachedInputTokens: 2,
    outputTokens: 5,
    reasoningOutputTokens: 3,
  },
  cost: { source: 'provider_reported', amountUsd: 0.34 },
  references: {
    kind: 'execution',
    workflowId: 'workflow-1',
    runId: 'run-1',
    nodeId: 'deliver-pr',
    blockRun: 1,
    providerAttempt: 1,
    transcriptId: 'transcript-1',
    outputArtifactIds: ['artifact-1'],
    receiptArtifactId: null,
  },
};

const planningInvocationDetail: OperatorTaskInvocationDetail = {
  schemaVersion: 1,
  invocationId: 'invocation-planning-1',
  taskReference: 'TASK-1',
  prompt: 'Plan the implementation.',
  promptBytes: 24,
  provider: 'claude',
  profile: 'planner',
  profileSha256: 'b'.repeat(64),
  model: 'claude-opus',
  effort: 'medium',
  serviceTier: null,
  argv: ['claude', 'plan'],
  skills: ['plan'],
  inputEvidenceArtifactIds: ['artifact-plan-1'],
  startedAt: '2026-08-30T09:00:00.000Z',
  finishedAt: '2026-08-30T09:00:10.000Z',
  durationMs: 10_000,
  status: 'completed',
  exitStatus: { kind: 'exited', exitCode: 0 },
  usage: {
    inputTokens: 20,
    cachedInputTokens: 0,
    outputTokens: 8,
    reasoningOutputTokens: 5,
  },
  cost: { source: 'unrated' },
  references: {
    kind: 'planning',
    planningEpisodeId: 'planning-episode-1',
    planningAttempt: 1,
    invocationNumber: 1,
    operationId: 'planning-op-1',
    transcriptId: 'planning-transcript-1',
    outputArtifactIds: ['artifact-plan-2'],
    receiptArtifactId: null,
  },
};

describe('AttemptDetails', () => {
  it('renders the invocation prompt panel inside the prompt tab in SSR', () => {
    const html = renderToStaticMarkup(
      createElement(AttemptDetails, {
        entry,
        attempt,
        invocationId: invocationDetail.invocationId,
        invocationDetail,
        selectedTab: 'prompt',
      }),
    );

    expect(html).toContain('Attempt #1');
    expect(html).toContain('data-outcome="completed"');
    expect(html).toContain('Copy prompt');
    expect(html).toContain('codex exec --json');
    expect(html).toContain('Run the task.');
    expect(html).toContain('13 bytes');
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

  it('renders invocation details without a run-log entry for planning invocations', () => {
    const html = renderToStaticMarkup(
      createElement(AttemptDetails, {
        entry: null,
        invocationId: planningInvocationDetail.invocationId,
        invocationDetail: planningInvocationDetail,
        selectedTab: 'prompt',
      }),
    );

    expect(html).toContain('Copy prompt');
    expect(html).toContain('Plan the implementation.');
    expect(html).toContain('claude plan');
    expect(html).toContain('20 in');
  });

  it('summarizes provider JSONL output and highlights structured details', () => {
    expect(summarizeProviderEventLine('{"type":"item.completed","item":{"text":"Finished"}}')).toBe(
      'item.completed: Finished',
    );

    const output = attempt.output;
    if (output === null) throw new Error('Expected output fixture');
    const html = renderToStaticMarkup(
      createElement(AttemptDetails, {
        entry,
        attempt: {
          ...attempt,
          output: {
            ...output,
            stdout: '{"type":"item.completed","item":{"text":"Finished"}}\n',
          },
        },
        selectedTab: 'details',
      }),
    );

    expect(html).toContain('tasker-json-key');
  });
});
