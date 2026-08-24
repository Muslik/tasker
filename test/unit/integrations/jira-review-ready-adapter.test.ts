import { afterEach, describe, expect, it } from 'vitest';

import { loadHarnessPack } from '../../../src/harness/index.js';
import { pullRequestOutputSchema } from '../../../src/harness/step-contracts.js';
import {
  ExternalEffectStore,
  JiraReviewReadyAdapter,
  type JiraAttachmentObservation,
  type JiraAttachmentPort,
  type JiraCommentObservation,
  type JiraFieldValueObservation,
  type JiraLifecycleIssue,
  type JiraLifecycleMutation,
  type JiraLifecycleObservation,
  type JiraLifecyclePort,
  type JiraLifecycleTransitionField,
  type JiraTransitionObservation,
} from '../../../src/integrations/index.js';
import type {
  IntegrationEvidenceReader,
  IntegrationStepExecutionRequest,
} from '../../../src/integrations/execution.js';
import { openSqliteLedger, type SqliteLedger } from '../../../src/ledger/index.js';
import { systemClock } from '../../../src/shared/clock.js';
import { makePlanningTaskSnapshot } from '../../support/planning.js';

const task = makePlanningTaskSnapshot('avia-12536-feature-review', {
  origin: 'jira',
  reference: 'jira:AVIA-12536',
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
  nodeId: 'deliver-change',
  stepReference: 'jira.review-ready@1',
  taskReference: task.reference,
  task,
  taskSnapshot: { origin: 'jira', issue: { issueKey: task.taskId } },
  stepInput: { objective: task.title, repository: task.repository, taskId: task.taskId },
  workspace: {
    schemaVersion: 1,
    workspaceId: 'a'.repeat(24),
    taskReference: task.reference,
    workflowId: `tasker:${task.reference}`,
    workflowRunId: 'run-1',
    repository: {
      reference: task.repository,
      sourcePath: '/repositories/front-avia',
      baseBranch: 'master',
      baseCommit: 'c'.repeat(40),
    },
    runnerId: 'test',
    path: '/worktrees/front-avia',
    branch: 'tasker/avia-12536/run-1',
    preparedAt: '2026-08-04T00:00:00.000Z',
  },
  operatorGuidance: null,
  waitResolution: null,
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

const executeReviewReady = (
  adapter: JiraReviewReadyAdapter,
  request: IntegrationStepExecutionRequest,
) => {
  const step = request.evidence.completedSteps[0];
  const parsed = pullRequestOutputSchema.parse(
    step === undefined ||
      typeof step.details !== 'object' ||
      step.details === null ||
      Array.isArray(step.details)
      ? null
      : step.details.output,
  );
  return adapter.executeForPullRequest(request, parsed);
};

class StatefulJiraReviewPort implements JiraLifecyclePort, JiraAttachmentPort {
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
  public attachments: {
    readonly id: string;
    readonly filename: string;
    readonly mimeType: string;
    readonly size: number;
  }[] = [];
  public fieldValues: Record<string, null | number | string> = {};
  public transitionFields: readonly JiraLifecycleTransitionField[] = [];
  public readonly transitionCalls: string[] = [];
  public readonly commentCalls: string[] = [];
  public readonly updateCommentCalls: { readonly id: string; readonly body: string }[] = [];
  public readonly fieldObservationCalls: string[][] = [];
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
          ? [
              {
                id: '31',
                name: 'Ready for review',
                toStatus: 'Code Review',
                fields: this.transitionFields,
              },
            ]
          : [],
    });
  }

  public observeFieldValues(
    _issueKey: string,
    fieldIds: readonly string[],
  ): Promise<JiraFieldValueObservation> {
    this.fieldObservationCalls.push([...fieldIds]);
    return Promise.resolve({ status: 'observed', values: this.fieldValues });
  }

  public listComments(): Promise<JiraCommentObservation> {
    return Promise.resolve({ status: 'observed', comments: this.comments });
  }

  public listAttachments(): Promise<JiraAttachmentObservation> {
    return Promise.resolve({ status: 'observed', attachments: this.attachments });
  }

  public uploadAttachment(
    _issueKey: string,
    attachment: {
      readonly filename: string;
      readonly mimeType: string;
      readonly content: Uint8Array;
    },
  ): Promise<JiraLifecycleMutation> {
    this.attachments.push({
      id: String(this.attachments.length + 1),
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      size: attachment.content.byteLength,
    });
    return Promise.resolve({ status: 'accepted' });
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

  public updateComment(
    _issueKey: string,
    commentId: string,
    body: string,
  ): Promise<JiraLifecycleMutation> {
    this.updateCommentCalls.push({ id: commentId, body });
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
    this.comments = this.comments.map((comment) =>
      comment.id === commentId ? { ...comment, body } : comment,
    );
    return Promise.resolve({ status: 'accepted' });
  }
}

let ledger: SqliteLedger | undefined;

afterEach(() => {
  ledger?.close();
  ledger = undefined;
});

const adapterFor = (
  jira: JiraLifecyclePort & JiraAttachmentPort,
  evidence: IntegrationEvidenceReader | null = null,
): JiraReviewReadyAdapter => {
  ledger = openSqliteLedger({ filename: ':memory:', clock: systemClock });
  return new JiraReviewReadyAdapter(
    jira,
    new ExternalEffectStore(ledger.repository, systemClock),
    evidence,
  );
};

describe('Jira review-ready effect adapter', () => {
  it('publishes one current bug after-video and references it from the managed fix comment', async () => {
    const jira = new StatefulJiraReviewPort();
    jira.issue = { ...jira.issue, issueKey: 'AVIA-12045', issueType: 'Bug' };
    const bugTask = {
      ...makePlanningTaskSnapshot('avia-13236-short-bug', {
        origin: 'jira',
        reference: 'jira:AVIA-12045',
      }),
      taskId: 'AVIA-12045',
    } as const;
    const baseRequest = requestFor('workflow:jira-bug-review:attempt-1');
    const request: IntegrationStepExecutionRequest = {
      ...baseRequest,
      taskReference: bugTask.reference,
      task: bugTask,
      stepInput: {
        objective: bugTask.title,
        repository: bugTask.repository,
        taskId: bugTask.taskId,
      },
      evidence: {
        ...baseRequest.evidence,
        completedSteps: [
          ...baseRequest.evidence.completedSteps,
          {
            operationId: 'workflow:verify:attempt-1',
            nodeId: 'verify-change',
            stepReference: 'verify.acceptance@1',
            status: 'completed',
            summary: 'Bug verified',
            artifactIds: ['evidence:after-video'],
            details: { output: { decision: 'accepted' } },
            recordedAt: '2026-08-04T00:00:30.000Z',
          },
        ],
      },
    };
    const content = new TextEncoder().encode('video');
    const evidence: IntegrationEvidenceReader = {
      read: (artifactId) =>
        Promise.resolve(
          artifactId === 'evidence:after-video'
            ? {
                status: 'found' as const,
                artifact: {
                  artifactId,
                  relativePath: 'AVIA-12045-fixed.mp4',
                  mimeType: 'video/mp4',
                  contentSha256: 'a'.repeat(64),
                  content,
                },
              }
            : { status: 'not_evidence' as const },
        ),
    };
    const adapter = adapterFor(jira, evidence);

    const first = await executeReviewReady(adapter, request);
    const redelivered = await executeReviewReady(adapter, request);

    expect(first).toMatchObject({ status: 'completed' });
    expect(redelivered).toMatchObject({ status: 'completed' });
    expect(jira.attachments).toEqual([
      {
        id: '1',
        filename: 'AVIA-12045-fixed.mp4',
        mimeType: 'video/mp4',
        size: content.byteLength,
      },
    ]);
    expect(jira.commentCalls).toEqual([
      `Исправлено — видео: [^AVIA-12045-fixed.mp4]\n\nPR: [73|${pullRequestUrl}]`,
    ]);
  });

  it('blocks bug delivery before Jira mutation when Verify produced no publishable after evidence', async () => {
    const jira = new StatefulJiraReviewPort();
    jira.issue = { ...jira.issue, issueKey: 'AVIA-12045', issueType: 'Bug' };
    const bugTask = {
      ...makePlanningTaskSnapshot('avia-13236-short-bug', {
        origin: 'jira',
        reference: 'jira:AVIA-12045',
      }),
      taskId: 'AVIA-12045',
    } as const;
    const baseRequest = requestFor('workflow:jira-bug-review:missing-evidence');
    const request: IntegrationStepExecutionRequest = {
      ...baseRequest,
      taskReference: bugTask.reference,
      task: bugTask,
      stepInput: {
        objective: bugTask.title,
        repository: bugTask.repository,
        taskId: bugTask.taskId,
      },
    };
    const evidence: IntegrationEvidenceReader = {
      read: () => Promise.resolve({ status: 'not_evidence' }),
    };

    const result = await executeReviewReady(adapterFor(jira, evidence), request);

    expect(result).toMatchObject({ status: 'blocked', kind: 'verification' });
    if (result.status !== 'blocked') throw new Error('Expected missing evidence to block');
    expect(result.summary).toContain('requires exactly one current');
    expect(jira.transitionCalls).toEqual([]);
    expect(jira.commentCalls).toEqual([]);
    expect(jira.attachments).toEqual([]);
  });

  it('updates the single managed review comment left by a previous run', async () => {
    const jira = new StatefulJiraReviewPort();
    jira.issue = { ...jira.issue, status: 'Code Review' };
    jira.comments = [
      {
        id: '9',
        body: 'PR ready for review: [72|https://bitbucket.example/pull-requests/72]',
      },
    ];

    const result = await executeReviewReady(
      adapterFor(jira),
      requestFor('workflow:jira-review:new-run-attempt-1'),
    );

    expect(result).toMatchObject({ status: 'completed' });
    expect(jira.commentCalls).toEqual([]);
    expect(jira.updateCommentCalls).toEqual([
      { id: '9', body: `PR ready for review: [73|${pullRequestUrl}]` },
    ]);
    expect(jira.comments).toEqual([
      { id: '9', body: `PR ready for review: [73|${pullRequestUrl}]` },
    ]);
  });

  it('fails closed when Jira contains multiple managed review comments', async () => {
    const jira = new StatefulJiraReviewPort();
    jira.issue = { ...jira.issue, status: 'Code Review' };
    jira.comments = [
      {
        id: '8',
        body: 'PR ready for review: [71|https://bitbucket.example/pull-requests/71]',
      },
      {
        id: '9',
        body: 'PR ready for review: [72|https://bitbucket.example/pull-requests/72]',
      },
    ];

    const result = await executeReviewReady(
      adapterFor(jira),
      requestFor('workflow:jira-review:ambiguous-comments-attempt-1'),
    );

    expect(result).toMatchObject({
      status: 'blocked',
      kind: 'remote_conflict',
      details: { commentIds: ['8', '9'] },
    });
    expect(jira.commentCalls).toEqual([]);
    expect(jira.updateCommentCalls).toEqual([]);
  });

  it('surfaces missing required transition fields before mutating Jira and resumes in place', async () => {
    const jira = new StatefulJiraReviewPort();
    jira.transitionFields = [
      {
        id: 'customfield_12345',
        name: 'Development estimate',
        required: true,
        hasDefaultValue: false,
        operations: ['set'],
      },
    ];
    const adapter = adapterFor(jira);

    const blocked = await executeReviewReady(adapter, requestFor('workflow:jira-review:attempt-1'));

    expect(blocked).toMatchObject({
      status: 'blocked',
      kind: 'invalid_request',
      summary: 'Jira requires fields before Ready for review can run: Development estimate',
      details: {
        issueKey: 'AVIA-12536',
        transitionId: '31',
        transitionName: 'Ready for review',
        toStatus: 'Code Review',
        missingFields: [
          {
            id: 'customfield_12345',
            name: 'Development estimate',
            operations: ['set'],
          },
        ],
      },
      artifactIds: [],
    });
    expect(jira.transitionCalls).toEqual([]);
    expect(jira.commentCalls).toEqual([]);

    jira.fieldValues.customfield_12345 = 3;
    const resumed = await executeReviewReady(adapter, requestFor('workflow:jira-review:attempt-2'));

    expect(resumed).toMatchObject({ status: 'completed' });
    expect(jira.fieldObservationCalls).toEqual([['customfield_12345'], ['customfield_12345']]);
    expect(jira.transitionCalls).toEqual(['31']);
    expect(jira.commentCalls).toHaveLength(1);
  });

  it('moves the issue to code review and posts one compact pull-request comment', async () => {
    const jira = new StatefulJiraReviewPort();

    const result = await executeReviewReady(
      adapterFor(jira),
      requestFor('workflow:jira-review:attempt-1'),
    );

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

    const first = await executeReviewReady(adapter, request);
    const redelivered = await executeReviewReady(adapter, request);

    expect(first).toMatchObject({ status: 'completed' });
    expect(redelivered).toMatchObject({ status: 'completed' });
    expect(jira.commentCalls).toHaveLength(1);
    expect(jira.comments).toHaveLength(1);
  });

  it('resumes after a comment 403 without repeating the completed transition', async () => {
    const jira = new StatefulJiraReviewPort();
    jira.mode = 'forbidden-comment';
    const adapter = adapterFor(jira);

    const blocked = await executeReviewReady(adapter, requestFor('workflow:jira-review:attempt-1'));
    jira.mode = 'normal';
    const resumed = await executeReviewReady(adapter, requestFor('workflow:jira-review:attempt-2'));

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

    const first = await executeReviewReady(adapter, requestFor('workflow:jira-review:attempt-1'));
    const resumed = await executeReviewReady(adapter, requestFor('workflow:jira-review:attempt-2'));

    expect(first).toMatchObject({ status: 'completed' });
    expect(resumed).toMatchObject({ status: 'completed' });
    expect(jira.commentCalls).toEqual([]);
    expect(jira.comments).toHaveLength(1);
  });

  it('requires a concrete pull-request URL before observing or mutating Jira', async () => {
    const jira = new StatefulJiraReviewPort();

    const result = await executeReviewReady(
      adapterFor(jira),
      requestFor('workflow:jira-review:attempt-1', null),
    );

    expect(result).toMatchObject({ status: 'blocked', kind: 'verification' });
    expect(jira.observeCalls).toBe(0);
    expect(jira.transitionCalls).toEqual([]);
    expect(jira.commentCalls).toEqual([]);
  });
});
