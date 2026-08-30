import { describe, expect, it, vi, afterEach } from 'vitest';

import { ApiError } from './http.js';
import {
  approveTaskPlan,
  requestTaskPlanChanges,
  restartTaskWorkflow,
  resumeTaskWorkflow,
} from './workflow-actions.js';

const bootstrapRunFixture = () => ({
  runtime: 'bootstrap' as const,
  schemaVersion: 3 as const,
  taskReference: 'jira:AVIA-1',
  workflowId: 'wf-1',
  runId: 'run-1',
  workflowHash: null,
  settings: {
    planReview: 'required' as const,
    planningStrategy: 'auto' as const,
    trackerStatusUpdates: 'enabled' as const,
  },
  phase: 'plan_review' as const,
  workspaceContext: null,
  context: null,
  draft: null,
  planning: null,
  activeTranscriptOperationId: null,
  freezeReceipt: null,
  executionWorkflowId: null,
  nodeStates: {},
  attempts: {},
  status: 'waiting' as const,
  currentNodeId: 'plan_review',
  wait: {
    nodeId: 'plan_review',
    waitKind: 'plan.approved@1',
    reason: 'Review required',
  },
  outcome: null,
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('workflow actions', () => {
  it('posts exact command payloads to the existing workflow endpoints', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify(bootstrapRunFixture()), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await resumeTaskWorkflow('jira:AVIA-1', { expectedRunId: 'run-1', guidance: 'Resume now' });
    await approveTaskPlan('jira:AVIA-1', {
      expectedRunId: 'run-1',
      reviewId: 'review-1',
      planArtifactId: 'plan-1',
      planAttempt: 2,
      decision: 'approve',
    });
    await requestTaskPlanChanges('jira:AVIA-1', {
      expectedRunId: 'run-1',
      reviewId: 'review-2',
      planArtifactId: 'plan-2',
      planAttempt: 3,
      decision: 'request_changes',
      guidance: 'Tighten validation.',
      annotations: [],
    });
    await restartTaskWorkflow('jira:AVIA-1', {
      expectedRunId: 'run-1',
      confirmation: 'restart_from_scratch',
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      '/api/workflows/jira%3AAVIA-1/resume',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ expectedRunId: 'run-1', guidance: 'Resume now' }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/workflows/jira%3AAVIA-1/plan-review',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          expectedRunId: 'run-1',
          reviewId: 'review-1',
          planArtifactId: 'plan-1',
          planAttempt: 2,
          decision: 'approve',
        }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      '/api/workflows/jira%3AAVIA-1/plan-review',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          expectedRunId: 'run-1',
          reviewId: 'review-2',
          planArtifactId: 'plan-2',
          planAttempt: 3,
          decision: 'request_changes',
          guidance: 'Tighten validation.',
          annotations: [],
        }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      '/api/workflows/jira%3AAVIA-1/restart',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          expectedRunId: 'run-1',
          confirmation: 'restart_from_scratch',
        }),
      }),
    );
  });

  it('surfaces structured API errors from failed workflow actions', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ error: 'stale_run', message: 'Refresh first' }), {
          status: 409,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    await expect(
      restartTaskWorkflow('jira:AVIA-1', {
        expectedRunId: 'run-1',
        confirmation: 'restart_from_scratch',
      }),
    ).rejects.toEqual(new ApiError(409, 'stale_run', 'Refresh first'));
  });
});
