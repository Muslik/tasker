import { describe, expect, it, vi } from 'vitest';

import { getHarnessPack } from '../../../src/harness/index.js';
import {
  PullRequestDeliveryAdapter,
  type IntegrationStepExecutionRequest,
} from '../../../src/integrations/index.js';
import { makePlanningTaskSnapshot, makeReadyPlanningDecision } from '../../support/planning.js';

const task = makePlanningTaskSnapshot('avia-13236-short-bug');
const project = getHarnessPack().projects.find(
  (candidate) => candidate.repository === task.repository,
);
if (project === undefined) throw new Error(`Missing harness project ${task.repository}`);
const planningDecision = makeReadyPlanningDecision();
if (planningDecision.status !== 'ready') throw new Error('Expected ready planning fixture');

const pullRequestOutput = {
  externalId: '42',
  status: 'open' as const,
  provider: 'bitbucket',
  repository: task.repository,
  sourceBranch: 'AVIA-13236',
  targetBranch: 'master',
  url: 'https://bitbucket.example/projects/ONETWOTRIP/repos/front-avia/pull-requests/42',
};

const ciOutput = (status: 'passed' | 'likely_caused_by_change') => ({
  externalId: '73',
  status,
  provider: 'jenkins',
  build: {
    number: 73,
    url: 'https://jenkins.example/job/front-avia/73',
    revision: 'a'.repeat(40),
    result: status === 'passed' ? 'SUCCESS' : 'FAILURE',
    durationMs: 1_000,
  },
  stages: status === 'passed' ? [] : [{ name: 'UI tests', status: 'FAILED' }],
  failures:
    status === 'passed'
      ? []
      : [
          {
            uid: 'visual-case-1',
            name: 'Flight card with 2+ transfers: desktop',
            status: 'failed',
            message: '543 pixels differ from the stored snapshot',
            flaky: false,
            attachments: [
              {
                name: 'Flight card diff',
                type: 'application/vnd.allure.image.diff',
                source: 'flight-card.imagediff',
              },
            ],
          },
        ],
});

const request = (
  waitResolution: IntegrationStepExecutionRequest['waitResolution'] = null,
): IntegrationStepExecutionRequest => ({
  operationId: 'delivery:test:1',
  nodeId: 'deliver-change',
  stepReference: 'deliver.pull-request@1',
  taskReference: task.reference,
  task,
  taskSnapshot: task,
  stepInput: { objective: task.title, repository: task.repository, taskId: task.taskId },
  workspace: {
    schemaVersion: 1,
    workspaceId: 'a'.repeat(24),
    taskReference: task.reference,
    workflowId: 'tasker:test',
    workflowRunId: 'run-1',
    repository: {
      reference: task.repository,
      sourcePath: '/tmp/source',
      baseBranch: 'master',
      baseCommit: 'b'.repeat(40),
    },
    runnerId: 'test',
    path: '/tmp/worktree',
    branch: task.taskId,
    preparedAt: '2026-08-23T00:00:00.000Z',
  },
  operatorGuidance: null,
  waitResolution,
  evidence: {
    acceptedPlan: { plan: planningDecision.plan },
    completedSteps: [],
    reviewInputs: [],
  },
  policies: [],
  project,
  runtime: {
    attempt: 1,
    cancellationSignal: new AbortController().signal,
    heartbeat: vi.fn(),
  },
});

const adapter = (ciStatus: 'passed' | 'likely_caused_by_change' = 'passed') => {
  const executeDraft = vi.fn(() =>
    Promise.resolve({
      status: 'completed' as const,
      summary: 'PR published',
      output: pullRequestOutput,
      artifactIds: ['pull-request-receipt'],
    }),
  );
  const observeCi = vi.fn(() =>
    Promise.resolve({
      status: 'completed' as const,
      summary: 'CI observed',
      output: ciOutput(ciStatus),
      artifactIds: ['ci-observation'],
    }),
  );
  return {
    executeDraft,
    delivery: new PullRequestDeliveryAdapter({ executeDraft }, { execute: observeCi }, null),
  };
};

describe('pull-request semantic delivery', () => {
  it('publishes once, observes CI, then owns the durable human-review wait', async () => {
    const fixture = adapter();

    const result = await fixture.delivery.execute(request());

    expect(result).toMatchObject({
      status: 'waiting',
      waitKind: 'code_review@1',
      details: { phase: 'human_review', output: pullRequestOutput },
      artifactIds: ['pull-request-receipt', 'ci-observation'],
    });
    expect(fixture.executeDraft).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        title: `${task.taskId}: ${task.title}`,
        commit: { kind: 'subject', subject: 'Repair the reported behavior' },
      }),
    );
  });

  it('completes the same semantic block from a typed approval resolution', async () => {
    const fixture = adapter();

    const result = await fixture.delivery.execute(
      request({ decision: 'approved', reviewId: 'operator:review-1' }),
    );

    expect(result).toMatchObject({
      status: 'completed',
      output: pullRequestOutput,
    });
  });

  it('keeps task-caused CI evidence on the Delivery block instead of emitting ci.repair', async () => {
    const fixture = adapter('likely_caused_by_change');

    const result = await fixture.delivery.execute(request());

    expect(result).toMatchObject({
      status: 'continuation_required',
      request: { discoveredAtNodeId: 'deliver-change' },
    });
    if (result.status !== 'continuation_required') {
      throw new Error('Expected task-caused CI continuation');
    }
    expect(result.request.changes[0]).toMatchObject({ kind: 'task_scope_changed' });
    const change = result.request.changes[0];
    if (change?.kind !== 'task_scope_changed') throw new Error('Expected task scope change');
    expect(change.objective).toContain('Jenkins build #73');
    expect(change.objective).toContain('Flight card with 2+ transfers: desktop');
    expect(change.objective).toContain('543 pixels differ');
    expect(change.objective).toContain('flight-card.imagediff');
  });
});
