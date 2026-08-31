import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import type {
  ExecutionRunView,
  OperatorTaskSummary,
  OperatorWorkflowProjection,
} from '../../server/operator-contracts.js';
import { WaitBanner } from './WaitBanner.js';

const task: OperatorTaskSummary = {
  id: 'jira:AVIA-11',
  taskId: 'AVIA-11',
  title: 'Review the latest implementation plan',
  origin: {
    kind: 'jira',
    issueKey: 'AVIA-11',
    issueType: 'Task',
    browseUrl: null,
    syncStatus: 'current',
    repositoryBinding: {
      status: 'missing',
      issueKey: 'AVIA-11',
      recordedAt: '2026-08-30T10:00:00.000Z',
    },
  },
  planning: { status: 'available' },
  status: 'plan_review',
  attention: 'operator',
  currentStage: 'Plan review required',
  updatedAt: '2026-08-30T10:00:00.000Z',
};

const currentRun = {
  runtime: 'bootstrap',
  schemaVersion: 2,
  taskReference: task.id,
  workflowId: 'workflow-plan',
  runId: 'run-plan',
  workflowHash: 'a'.repeat(64),
  nodeStates: { plan_review: 'waiting' },
  blockRuns: {},
  loopIterations: {},
  continuations: [],
  retrospective: 'pending',
  status: 'waiting',
  currentNodeId: 'plan_review',
  wait: {
    nodeId: 'plan_review',
    waitKind: 'plan.approved@1',
    reason: 'Operator review is required before implementation.',
  },
  outcome: null,
  planning: {
    status: 'ready',
    artifactId: 'implementation-plan:task:attempt-1',
    attempt: 1,
  },
} as unknown as ExecutionRunView;

const renderWaitBanner = (projection: OperatorWorkflowProjection) => {
  const client = new QueryClient();
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client },
      createElement(WaitBanner, {
        task,
        projection,
        currentRun,
        onOpenInvocation: vi.fn(),
      }),
    ),
  );
};

describe('WaitBanner', () => {
  it('shows a dedicated surface link instead of generic resume input for plan review waits', () => {
    const html = renderWaitBanner({
      schemaVersion: 9,
      taskReference: task.id,
      status: 'waiting',
      activeRuntime: 'bootstrap',
      activeRunId: 'run-plan',
      graphHash: null,
      current: {
        runtime: 'bootstrap',
        nodeId: 'plan_review',
        reference: 'plan.review@1',
        blockRun: null,
        transcript: null,
        status: 'waiting',
        waitKind: 'plan.approved@1',
        reason: 'Operator review is required before implementation.',
        intervention: {
          kind: 'typed_resolution',
          waitKind: 'plan.approved@1',
          details: null,
        },
      },
      currentAttempt: {
        latestInvocationId: 'invocation-plan',
        nodeId: 'plan_review',
        blockRun: 1,
        startedAt: '2026-08-30T10:00:00.000Z',
        waitingSince: '2026-08-30T10:05:00.000Z',
      },
      dependencies: [],
      stages: [],
      continuations: [],
    });

    expect(html).toContain('Open plan review');
    expect(html).not.toContain('Resume');
    expect(html).not.toContain('Resume guidance');
  });

  it('keeps the generic guidance and resume controls for non-dedicated waits', () => {
    const html = renderWaitBanner({
      schemaVersion: 9,
      taskReference: task.id,
      status: 'waiting',
      activeRuntime: 'execution',
      activeRunId: 'run-plan',
      graphHash: null,
      current: {
        runtime: 'execution',
        nodeId: 'deliver',
        reference: 'deliver.pull-request@1',
        blockRun: 2,
        transcript: null,
        status: 'waiting',
        waitKind: 'operator.input@1',
        reason: 'Choose the next recovery path.',
        intervention: { kind: 'operator_guidance' },
      },
      currentAttempt: {
        latestInvocationId: 'invocation-deliver',
        nodeId: 'deliver',
        blockRun: 2,
        startedAt: '2026-08-30T10:00:00.000Z',
        waitingSince: '2026-08-30T10:05:00.000Z',
      },
      dependencies: [],
      stages: [],
      continuations: [],
    });

    expect(html).toContain('Resume');
    expect(html).toContain('Optional resume guidance');
    expect(html).not.toContain('Open plan review');
  });
});
