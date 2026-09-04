import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';

import { getHarnessPack } from '../../harness/index.js';
import {
  PullRequestDeliveryAdapter,
  type IntegrationStepExecutionRequest,
  type IntegrationStepExecutionResult,
} from '../index.js';
import type { PullRequestDraft } from '../pull-request-draft.js';
import {
  makePlanningTaskSnapshot,
  makeReadyPlanningDecision,
} from '../../../test/support/planning.js';

const task = makePlanningTaskSnapshot('avia-13236-short-bug');
const project = getHarnessPack().projects.find(
  (candidate) => candidate.repository === task.repository,
);
if (project === undefined) throw new Error(`Missing harness project ${task.repository}`);
const planningDecision = makeReadyPlanningDecision();
if (planningDecision.status !== 'ready') throw new Error('Expected ready planning fixture');
const workspacePath = mkdtempSync(join(tmpdir(), 'tasker-delivery-draft-'));
mkdirSync(join(workspacePath, '.tasker', 'pull-request'), { recursive: true });
writeFileSync(
  join(workspacePath, '.tasker', 'pull-request', 'draft.json'),
  `${JSON.stringify(
    {
      title: `${task.taskId}: ${task.title}`,
      description: 'Repair the reported behavior\n\n## AI assistance\n\nFull Generation (>80%)',
      commit: { kind: 'subject', subject: 'Repair the reported behavior' },
      branchArtifacts: ['.ai/workspace/AVIA-13236/README.md'],
    },
    null,
    2,
  )}\n`,
  'utf8',
);

afterAll(() => {
  rmSync(workspacePath, { recursive: true, force: true });
});

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
    path: workspacePath,
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
  trackerStatusUpdates: 'enabled',
  runtime: {
    attempt: 1,
    cancellationSignal: new AbortController().signal,
    heartbeat: vi.fn(),
  },
});

const adapter = (
  ciStatus: 'passed' | 'likely_caused_by_change' = 'passed',
  jira: ConstructorParameters<typeof PullRequestDeliveryAdapter>[2] = null,
) => {
  type ExecuteDraft = (
    request: IntegrationStepExecutionRequest,
    draft: PullRequestDraft,
  ) => Promise<IntegrationStepExecutionResult>;
  const executeDraft = vi.fn<ExecuteDraft>(() =>
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
    delivery: new PullRequestDeliveryAdapter({ executeDraft }, { execute: observeCi }, jira),
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
    expect(fixture.executeDraft).toHaveBeenCalledOnce();
    const draft = fixture.executeDraft.mock.calls[0]?.[1];
    expect(draft).toMatchObject({
      title: `${task.taskId}: ${task.title}`,
      commit: { kind: 'subject', subject: 'Repair the reported behavior' },
      branchArtifacts: ['.ai/workspace/AVIA-13236/README.md'],
    });
    expect(draft?.description).toContain('## AI assistance');
  });

  it('completes the same semantic block from a typed approval resolution', async () => {
    const executeForPullRequest = vi.fn(() =>
      Promise.resolve({
        status: 'completed' as const,
        summary: 'Jira review-ready state published',
        output: pullRequestOutput,
        artifactIds: ['jira-review-ready'],
      }),
    );
    const fixture = adapter('passed', { executeForPullRequest });
    const approved = request({ decision: 'approved', reviewId: 'operator:review-1' });

    const result = await fixture.delivery.execute({
      ...approved,
      task: { ...approved.task, origin: 'jira' },
    });

    expect(result).toMatchObject({
      status: 'completed',
      output: pullRequestOutput,
    });
    expect(executeForPullRequest).not.toHaveBeenCalled();
  });

  it('does not repeat Jira review-ready effects after the code-review wait was published', async () => {
    const executeForPullRequest = vi.fn(() =>
      Promise.resolve({
        status: 'completed' as const,
        summary: 'Jira review-ready state published',
        output: pullRequestOutput,
        artifactIds: ['jira-review-ready'],
      }),
    );
    const fixture = adapter('passed', { executeForPullRequest });
    const initial = request();
    const result = await fixture.delivery.execute({
      ...initial,
      task: { ...initial.task, origin: 'jira' },
      evidence: {
        ...initial.evidence,
        completedSteps: [
          {
            operationId: 'delivery:previous',
            nodeId: 'deliver-change',
            stepReference: 'deliver.pull-request@1',
            status: 'blocked',
            summary: 'Waiting for human review',
            artifactIds: ['jira-review-ready'],
            predicateFacts: {},
            details: { phase: 'human_review', output: pullRequestOutput },
            recordedAt: '2026-08-24T00:00:00.000Z',
          },
        ],
      },
    });

    expect(result).toMatchObject({ status: 'waiting', waitKind: 'code_review@1' });
    expect(executeForPullRequest).not.toHaveBeenCalled();
  });

  it('returns task-caused CI as a frozen-loop repair outcome', async () => {
    const fixture = adapter('likely_caused_by_change');

    const result = await fixture.delivery.execute(request());

    expect(result).toMatchObject({
      status: 'completed',
      output: {
        outcome: 'repair_required',
        repair: { kind: 'ci', summary: 'Jenkins build #73 classified the failure as task-caused' },
        ci: {
          build: { number: 73 },
          failures: [{ name: 'Flight card with 2+ transfers: desktop' }],
        },
      },
    });
  });

  it('returns human review changes as the same frozen-loop repair outcome', async () => {
    const fixture = adapter();

    const result = await fixture.delivery.execute(
      request({ decision: 'changes_requested', reviewId: 'bitbucket:review-7' }),
    );

    expect(result).toMatchObject({
      status: 'completed',
      output: {
        outcome: 'repair_required',
        repair: {
          kind: 'human_review',
          reviewId: 'bitbucket:review-7',
        },
      },
    });
  });
});
