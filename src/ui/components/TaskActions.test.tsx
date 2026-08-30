import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import type {
  ExecutionRunView,
  OperatorTaskSummary,
  OperatorWorkflowProjection,
} from '../../control-plane/operator-contracts.js';
import { TaskActions, invokeTaskAction } from './TaskActions.js';

const task: OperatorTaskSummary = {
  id: 'jira:AVIA-1',
  taskId: 'AVIA-1',
  title: 'Repair checkout flow',
  origin: {
    kind: 'jira',
    issueKey: 'AVIA-1',
    issueType: 'Task',
    browseUrl: null,
    syncStatus: 'current',
    repositoryBinding: {
      status: 'missing',
      issueKey: 'AVIA-1',
      recordedAt: '2026-08-30T10:00:00.000Z',
    },
  },
  planning: { status: 'available' },
  status: 'waiting',
  attention: 'operator',
  currentStage: 'Waiting for guidance',
  updatedAt: '2026-08-30T10:00:00.000Z',
};

const projection: OperatorWorkflowProjection = {
  schemaVersion: 8,
  taskReference: task.id,
  status: 'waiting',
  activeRuntime: 'execution',
  activeRunId: 'run-1',
  graphHash: null,
  current: {
    runtime: 'execution',
    nodeId: 'deliver-pr',
    reference: 'deliver.pull-request@1',
    blockRun: 2,
    transcript: null,
    status: 'waiting',
    waitKind: 'operator.input@1',
    reason: 'Choose the recovery path',
    intervention: { kind: 'operator_guidance' },
  },
  dependencies: [],
  stages: [],
  continuations: [],
};

const currentRun: ExecutionRunView = {
  runtime: 'execution',
  schemaVersion: 2,
  taskReference: task.id,
  workflowId: 'workflow-1',
  runId: 'run-1',
  workflowHash: 'a'.repeat(64),
  nodeStates: { 'deliver-pr': 'waiting' },
  blockRuns: { 'deliver-pr': 2 },
  loopIterations: {},
  continuations: [],
  retrospective: 'pending',
  status: 'waiting',
  currentNodeId: 'deliver-pr',
  wait: {
    nodeId: 'deliver-pr',
    waitKind: 'operator.input@1',
    reason: 'Choose the recovery path',
  },
  outcome: null,
};

describe('TaskActions', () => {
  it('renders resume guidance and restart controls for a generic wait', () => {
    const client = new QueryClient();
    const html = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client },
        createElement(TaskActions, { task, projection, currentRun }),
      ),
    );

    expect(html).toContain('Resume');
    expect(html).toContain('Optional guidance for the next attempt');
    expect(html).toContain('Restart');
    expect(html).not.toContain('Approve plan');
  });

  it('dispatches the selected action through the presentational seam', () => {
    const callbacks = {
      resume: vi.fn(),
      approve: vi.fn(),
      requestChanges: vi.fn(),
      restart: vi.fn(),
    };

    invokeTaskAction('resume', callbacks);

    expect(callbacks.resume).toHaveBeenCalledOnce();
    expect(callbacks.approve).not.toHaveBeenCalled();
  });
});
