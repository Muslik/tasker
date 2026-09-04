import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type {
  ExecutionRunView,
  OperatorExecutionAttempt,
  OperatorTaskSummary,
  OperatorWorkflowProjection,
} from '../../server/operator-contracts.js';
import { operatorQueryKeys } from '../api/index.js';
import { ResearchDocumentReviewSurface } from './ResearchDocumentReviewSurface.js';

const task: OperatorTaskSummary = {
  id: 'jira:AVIA-77',
  taskId: 'AVIA-77',
  title: 'Publish research findings',
  origin: {
    kind: 'jira',
    issueKey: 'AVIA-77',
    issueType: 'Task',
    browseUrl: null,
    syncStatus: 'current',
    repositoryBinding: {
      status: 'missing',
      issueKey: 'AVIA-77',
      recordedAt: '2026-08-30T10:00:00.000Z',
    },
  },
  planning: { status: 'available' },
  status: 'waiting',
  attention: 'operator',
  currentStage: 'Waiting for document review',
  updatedAt: '2026-08-30T10:00:00.000Z',
};

const projection: OperatorWorkflowProjection = {
  schemaVersion: 9,
  taskReference: task.id,
  status: 'waiting',
  activeRuntime: 'execution',
  activeRunId: 'run-research',
  graphHash: null,
  current: {
    runtime: 'execution',
    nodeId: 'document-review',
    reference: 'research.document-review@1',
    blockRun: 4,
    transcript: null,
    status: 'waiting',
    waitKind: 'research.document-review@1',
    reason: 'Operator approval is required before publication.',
    intervention: {
      kind: 'typed_resolution',
      waitKind: 'research.document-review@1',
      details: null,
    },
  },
  currentAttempt: {
    latestInvocationId: 'invocation-research',
    nodeId: 'document-review',
    blockRun: 4,
    startedAt: '2026-08-30T10:00:00.000Z',
    waitingSince: '2026-08-30T10:05:00.000Z',
  },
  dependencies: [],
  stages: [],
  continuations: [],
};

const currentRun: ExecutionRunView = {
  runtime: 'execution',
  schemaVersion: 2,
  taskReference: task.id,
  workflowId: 'workflow-research',
  runId: 'run-research',
  workflowHash: 'b'.repeat(64),
  nodeStates: { 'document-review': 'waiting' },
  blockRuns: { 'document-review': 4 },
  loopIterations: {},
  continuations: [],
  retrospective: 'pending',
  status: 'waiting',
  currentNodeId: 'document-review',
  wait: {
    nodeId: 'document-review',
    waitKind: 'research.document-review@1',
    reason: 'Operator approval is required before publication.',
  },
  outcome: null,
};

const attempt: OperatorExecutionAttempt = {
  schemaVersion: 1,
  taskReference: task.id,
  workflowId: 'workflow-research',
  workflowRunId: 'run-research',
  nodeId: 'document-review',
  blockRun: 4,
  transcript: null,
  output: {
    schemaVersion: 4,
    operationId: 'op-research',
    workflowId: 'workflow-research',
    workflowRunId: 'run-research',
    nodeId: 'document-review',
    stepReference: 'research.document-review@1',
    stepAttempt: 1,
    runner: 'integration',
    command: null,
    args: [],
    cwd: '/tmp',
    exitCode: null,
    status: 'blocked',
    stdout: '',
    stderr: '',
    details: {
      kind: 'research_document_review',
      documentArtifactId: 'artifact-research',
      documentStorageHtml: '<h1>Research draft</h1><p>Draft content</p>',
    },
    usage: null,
    result: null,
    recordedAt: '2026-08-30T10:05:00.000Z',
  },
  evidence: [],
  workspaceChanges: null,
};

describe('ResearchDocumentReviewSurface', () => {
  it('renders the research document review controls for the typed wait', () => {
    const client = new QueryClient({
      defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY } },
    });
    client.setQueryData(operatorQueryKeys.attempt(task.id, 'document-review', 4), attempt);

    const html = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client },
        createElement(ResearchDocumentReviewSurface, { task, projection, currentRun }),
      ),
    );

    expect(html).toContain('Research document review');
    expect(html).toContain('Draft content');
    expect(html).toContain('Approve');
    expect(html).toContain('Request changes');
    expect(html).toContain('No annotations yet.');
  });
});
