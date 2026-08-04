import { afterEach, describe, expect, it } from 'vitest';

import { loadHarnessPack } from '../../../src/harness/index.js';
import {
  ExternalEffectStore,
  JiraReviewReadyAdapter,
  type JiraCommentObservation,
  type JiraLifecycleIssue,
  type JiraLifecycleMutation,
  type JiraLifecycleObservation,
  type JiraLifecyclePort,
  type JiraTransitionObservation,
} from '../../../src/integrations/index.js';
import type { IntegrationStepExecutionRequest } from '../../../src/integrations/execution.js';
import { openSqliteLedger, type SqliteLedger } from '../../../src/ledger/index.js';
import { findTaskFixture, TaskFixtureSchema } from '../../../src/planning/index.js';
import { systemClock } from '../../../src/shared/clock.js';

const sourceTask = findTaskFixture('avia-12536-feature-review');
if (sourceTask === undefined) throw new Error('Missing feature test fixture');
const task = TaskFixtureSchema.parse({
  ...sourceTask,
  origin: 'jira',
  fixtureId: 'jira:AVIA-12536',
});
const jiraPolicy = loadHarnessPack().policies.find(({ id }) => id === 'jira-lifecycle');
if (jiraPolicy === undefined) throw new Error('Missing Jira lifecycle policy');

const pullRequestUrl =
  'https://bitbucket.example/projects/ONETWOTRIP/repos/front-avia/pull-requests/73';

const requestFor = (
  operationId: string,
  url: string | null = pullRequestUrl,
): IntegrationStepExecutionRequest => ({
  operationId,
  stepReference: 'jira.review-ready@1',
  taskReference: task.fixtureId,
  task,
  taskSnapshot: { origin: 'jira', issue: { issueKey: task.taskId } },
  stepInput: { objective: task.title, repository: task.repository, taskId: task.taskId },
  workspace: {
    schemaVersion: 1,
    workspaceId: 'a'.repeat(24),
    taskReference: task.fixtureId,
    workflowId: `tasker:${task.fixtureId}`,
    workflowRunId: 'run-1',
    workflowHash: 'b'.repeat(64),
    repository: {
      reference: task.repository,
      sourcePath: '/repositories/front-avia',
      baseCommit: 'c'.repeat(40),
    },
    runnerId: 'test',
    path: '/worktrees/front-avia',
    branch: 'tasker/avia-12536/run-1',
    preparedAt: '2026-08-04T00:00:00.000Z',
  },
  operatorGuidance: null,
  evidence: {
    acceptedPlan: null,
    completedSteps: [
      {
        operationId: 'workflow:pr:attempt-1',
        nodeId: 'prepare-pr',
        stepReference: 'pr.prepare@1',
        status: 'completed',
        summary: 'Pull request ready',
        artifactIds: ['pull-request:73'],
        details: {
          output: {
            externalId: '73',
            status: 'open',
            provider: 'bitbucket',
            repository: task.repository,
            sourceBranch: 'tasker/avia-12536/run-1',
            targetBranch: 'master',
            url,
          },
        },
        recordedAt: '2026-08-04T00:01:00.000Z',
      },
    ],
    reviewInputs: [],
  },
  policies: [jiraPolicy],
  project: null,
  runtime: {
    attempt: 1,
    cancellationSignal: new AbortController().signal,
    heartbeat: () => {},
  },
});

class StatefulJiraReviewPort implements JiraLifecyclePort {
  public issue: JiraLifecycleIssue = {
    issueKey: 'AVIA-12536',
    issueType: 'Task',
    status: 'In Progress',
    labels: [],
    assignee: {
      accountName: 'dzhabrail.markhiev@onetwotrip.com',
      displayName: 'Dzhabrail Markhiev',
    },
  };
  public comments: { readonly id: string; readonly body: string }[] = [];
  public readonly transitionCalls: string[] = [];
  public readonly commentCalls: string[] = [];
  public observeCalls = 0;
  public mode: 'normal' | 'forbidden-transition' | 'forbidden-comment' | 'lose-comment-response' =
    'normal';

  public observeIssue(): Promise<JiraLifecycleObservation> {
    this.observeCalls += 1;
    return Promise.resolve({ status: 'observed', issue: this.issue });
  }

  public listTransitions(): Promise<JiraTransitionObservation> {
    return Promise.resolve({
      status: 'observed',
      transitions:
        this.issue.status === 'In Progress'
          ? [{ id: '31', name: 'Ready for review', toStatus: 'Code Review' }]
          : [],
    });
  }

  public listComments(): Promise<JiraCommentObservation> {
    return Promise.resolve({ status: 'observed', comments: this.comments });
  }

  public assign(): Promise<JiraLifecycleMutation> {
    return Promise.resolve({ status: 'accepted' });
  }

  public transition(_issueKey: string, transitionId: string): Promise<JiraLifecycleMutation> {
    this.transitionCalls.push(transitionId);
    if (this.mode === 'forbidden-transition') {
      return Promise.resolve({
        status: 'failed',
        problem: {
          kind: 'access_blocked',
          message: 'Jira returned 403. VPN required',
          retryable: true,
          httpStatus: 403,
        },
      });
    }
    this.issue = { ...this.issue, status: 'Code Review' };
    return Promise.resolve({ status: 'accepted' });
  }

  public comment(_issueKey: string, body: string): Promise<JiraLifecycleMutation> {
    this.commentCalls.push(body);
    if (this.mode === 'forbidden-comment') {
      return Promise.resolve({
        status: 'failed',
        problem: {
          kind: 'access_blocked',
          message: 'Jira returned 403. VPN required',
          retryable: true,
          httpStatus: 403,
        },
      });
    }
    this.comments.push({ id: String(this.comments.length + 1), body });
    return Promise.resolve(
      this.mode === 'lose-comment-response'
        ? {
            status: 'failed',
            problem: {
              kind: 'unavailable',
              message: 'response lost after request',
              retryable: true,
            },
          }
        : { status: 'accepted' },
    );
  }
}

let ledger: SqliteLedger | undefined;

afterEach(() => {
  ledger?.close();
  ledger = undefined;
});

const adapterFor = (jira: JiraLifecyclePort): JiraReviewReadyAdapter => {
  ledger = openSqliteLedger({ filename: ':memory:', clock: systemClock });
  return new JiraReviewReadyAdapter(jira, new ExternalEffectStore(ledger.repository, systemClock));
};

describe('Jira review-ready effect adapter', () => {
  it('moves the issue to code review and posts one compact pull-request comment', async () => {
    const jira = new StatefulJiraReviewPort();

    const result = await adapterFor(jira).execute(requestFor('workflow:jira-review:attempt-1'));

    expect(result).toMatchObject({
      status: 'completed',
      output: { externalId: 'AVIA-12536', status: 'Code Review' },
    });
    expect(jira.transitionCalls).toEqual(['31']);
    expect(jira.commentCalls).toEqual([`PR ready for review: [73|${pullRequestUrl}]`]);
  });

  it('reconciles a lost comment response and does not publish the link twice', async () => {
    const jira = new StatefulJiraReviewPort();
    jira.issue = { ...jira.issue, status: 'Code Review' };
    jira.mode = 'lose-comment-response';
    const adapter = adapterFor(jira);
    const request = requestFor('workflow:jira-review:attempt-1');

    const first = await adapter.execute(request);
    const redelivered = await adapter.execute(request);

    expect(first).toMatchObject({ status: 'completed' });
    expect(redelivered).toMatchObject({ status: 'completed' });
    expect(jira.commentCalls).toHaveLength(1);
    expect(jira.comments).toHaveLength(1);
  });

  it('resumes after a comment 403 without repeating the completed transition', async () => {
    const jira = new StatefulJiraReviewPort();
    jira.mode = 'forbidden-comment';
    const adapter = adapterFor(jira);

    const blocked = await adapter.execute(requestFor('workflow:jira-review:attempt-1'));
    jira.mode = 'normal';
    const resumed = await adapter.execute(requestFor('workflow:jira-review:attempt-2'));

    expect(blocked).toMatchObject({ status: 'blocked', kind: 'infrastructure' });
    expect(resumed).toMatchObject({ status: 'completed' });
    expect(jira.transitionCalls).toEqual(['31']);
    expect(jira.commentCalls).toHaveLength(2);
    expect(jira.comments).toHaveLength(1);
  });

  it('does not duplicate an existing pull-request comment across new attempts', async () => {
    const jira = new StatefulJiraReviewPort();
    jira.issue = { ...jira.issue, status: 'Code Review' };
    jira.comments = [{ id: '9', body: `Existing PR: [73|${pullRequestUrl}]` }];
    const adapter = adapterFor(jira);

    const first = await adapter.execute(requestFor('workflow:jira-review:attempt-1'));
    const resumed = await adapter.execute(requestFor('workflow:jira-review:attempt-2'));

    expect(first).toMatchObject({ status: 'completed' });
    expect(resumed).toMatchObject({ status: 'completed' });
    expect(jira.commentCalls).toEqual([]);
    expect(jira.comments).toHaveLength(1);
  });

  it('requires a concrete pull-request URL before observing or mutating Jira', async () => {
    const jira = new StatefulJiraReviewPort();

    const result = await adapterFor(jira).execute(
      requestFor('workflow:jira-review:attempt-1', null),
    );

    expect(result).toMatchObject({ status: 'blocked', kind: 'verification' });
    expect(jira.observeCalls).toBe(0);
    expect(jira.transitionCalls).toEqual([]);
    expect(jira.commentCalls).toEqual([]);
  });
});
