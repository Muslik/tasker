import { afterEach, describe, expect, it } from 'vitest';

import {
  BitbucketReviewReplyAdapter,
  ExternalEffectStore,
  taskerReviewAcknowledgementMarker,
  type BitbucketReviewAcknowledgementObservation,
  type BitbucketReviewReplyPort,
  type BitbucketReviewReplyResult,
  type PullRequestReviewEvidence,
} from '../../../src/integrations/index.js';
import type { IntegrationStepExecutionRequest } from '../../../src/integrations/execution.js';
import { openSqliteLedger, type SqliteLedger } from '../../../src/store/index.js';
import { systemClock } from '../../../src/shared/clock.js';
import { makePlanningTaskSnapshot } from '../../support/planning.js';

const task = makePlanningTaskSnapshot('avia-13236-short-bug');

const review = (threadIds: readonly number[] = [41]): PullRequestReviewEvidence => ({
  schemaVersion: 1,
  taskReference: task.reference,
  workflowId: `tasker:${task.reference}`,
  workflowRunId: 'run-1',
  reviewId: 'bitbucket:ONETWOTRIP/front-avia:73:review-hash',
  importedAt: '2026-08-04T10:03:00.000Z',
  snapshot: {
    provider: 'bitbucket',
    projectKey: 'ONETWOTRIP',
    repositorySlug: 'front-avia',
    pullRequestId: 73,
    pullRequestUrl:
      'https://bitbucket.example/projects/ONETWOTRIP/repos/front-avia/pull-requests/73',
    decision: 'changes_requested',
    approvals: [],
    threads: threadIds.map((rootCommentId) => ({
      rootCommentId,
      anchor: { path: 'src/search.ts', line: 17, lineType: 'ADDED', orphaned: false },
      comments: [
        {
          id: rootCommentId,
          parentId: null,
          author: { displayName: 'Reviewer', slug: 'reviewer' },
          text: rootCommentId === 41 ? 'Исправьте пустой результат' : 'Handle mobile too',
          createdAt: '2026-08-04T10:00:00.000Z',
          resolved: false,
        },
      ],
    })),
  },
});

const pullRequestStep = {
  operationId: 'tasker:prepare-pr:attempt-2',
  nodeId: 'review-prepare-pr',
  stepReference: 'deliver.pull-request@1',
  status: 'completed' as const,
  summary: 'Pull request updated',
  artifactIds: [],
  predicateFacts: {},
  details: {
    output: {
      externalId: '73',
      status: 'open',
      provider: 'bitbucket',
      repository: 'ONETWOTRIP/front-avia',
      sourceBranch: 'tasker/avia-13236/run-1',
      targetBranch: 'main',
      url: 'https://bitbucket.example/projects/ONETWOTRIP/repos/front-avia/pull-requests/73',
    },
  },
  recordedAt: '2026-08-04T10:02:00.000Z',
};

const requestFor = (
  operationId: string,
  inputReview: PullRequestReviewEvidence,
): IntegrationStepExecutionRequest => ({
  operationId,
  nodeId: 'deliver-change',
  stepReference: 'review.acknowledge@1',
  taskReference: task.reference,
  task,
  taskSnapshot: task,
  stepInput: { objective: task.title, repository: task.repository, taskId: task.taskId },
  workspace: {
    schemaVersion: 1,
    workspaceId: 'a'.repeat(24),
    taskReference: task.reference,
    workflowId: `tasker:${task.reference}`,
    workflowRunId: 'run-1',
    repository: {
      reference: task.repository,
      sourcePath: '/workspace/front-avia',
      baseBranch: 'master',
      baseCommit: 'c'.repeat(40),
    },
    runnerId: 'test',
    path: '/worktrees/front-avia',
    branch: 'tasker/avia-13236/run-1',
    preparedAt: '2026-08-04T00:00:00.000Z',
  },
  operatorGuidance: null,
  waitResolution: null,
  evidence: {
    acceptedPlan: null,
    completedSteps: [pullRequestStep],
    reviewInputs: [inputReview],
  },
  policies: [],
  project: null,
  trackerStatusUpdates: 'enabled',
  runtime: {
    attempt: 1,
    cancellationSignal: new AbortController().signal,
    heartbeat: () => {},
  },
});

class StatefulReviewReplyPort implements BitbucketReviewReplyPort {
  public readonly acknowledged = new Set<string>();
  public readonly replyCalls: { rootCommentId: number; text: string }[] = [];
  public mode: 'normal' | 'forbidden-on-51' | 'lose-response' = 'normal';

  public hasAcknowledgement(input: {
    readonly marker: string;
  }): Promise<BitbucketReviewAcknowledgementObservation> {
    return Promise.resolve({
      status: 'observed',
      acknowledged: this.acknowledged.has(input.marker),
    });
  }

  public reply(input: {
    readonly rootCommentId: number;
    readonly text: string;
  }): Promise<BitbucketReviewReplyResult> {
    this.replyCalls.push(input);
    if (this.mode === 'forbidden-on-51' && input.rootCommentId === 51) {
      return Promise.resolve({
        status: 'failed',
        problem: {
          kind: 'access_blocked',
          message: 'Bitbucket returned 403. Enable VPN or check repository access',
          retryable: true,
          httpStatus: 403,
        },
      });
    }
    const marker = input.text.slice(input.text.indexOf('<!-- tasker-review:')).trim();
    this.acknowledged.add(marker);
    return Promise.resolve(
      this.mode === 'lose-response'
        ? {
            status: 'failed',
            problem: {
              kind: 'unavailable',
              message: 'response lost after request',
              retryable: true,
            },
          }
        : { status: 'replied', commentId: 1000 + input.rootCommentId },
    );
  }
}

let ledger: SqliteLedger | undefined;

afterEach(() => {
  ledger?.close();
  ledger = undefined;
});

const adapterFor = (replies: BitbucketReviewReplyPort): BitbucketReviewReplyAdapter => {
  ledger = openSqliteLedger({ filename: ':memory:', clock: systemClock });
  return new BitbucketReviewReplyAdapter(
    replies,
    new ExternalEffectStore(ledger.repository, systemClock),
  );
};

describe('Bitbucket review reply effect adapter', () => {
  it('posts one localized, marked reply per imported review thread', async () => {
    const replies = new StatefulReviewReplyPort();
    const adapter = adapterFor(replies);
    const evidence = review([41, 51]);

    const result = await adapter.execute(requestFor('workflow:acknowledge:attempt-1', evidence));

    expect(result).toMatchObject({
      status: 'completed',
      output: { externalId: evidence.reviewId, status: 'acknowledged' },
    });
    expect(replies.replyCalls).toHaveLength(2);
    expect(replies.replyCalls[0]).toMatchObject({
      rootCommentId: 41,
      text: `Изменения внесены в последнем обновлении.\n\n${taskerReviewAcknowledgementMarker(evidence.reviewId, 41)}`,
    });
    expect(replies.replyCalls[1]?.text).toContain('Changes applied in the latest update.');
  });

  it('reconciles a reply whose successful response was lost and never posts it twice', async () => {
    const replies = new StatefulReviewReplyPort();
    replies.mode = 'lose-response';
    const adapter = adapterFor(replies);
    const input = requestFor('workflow:acknowledge:attempt-1', review());

    const first = await adapter.execute(input);
    const repeated = await adapter.execute({ ...input, runtime: { ...input.runtime, attempt: 2 } });

    expect(first).toMatchObject({ status: 'completed' });
    expect(repeated).toEqual(first);
    expect(replies.replyCalls).toHaveLength(1);
  });

  it('resumes after a partial 403 without repeating already acknowledged threads', async () => {
    const replies = new StatefulReviewReplyPort();
    replies.mode = 'forbidden-on-51';
    const adapter = adapterFor(replies);
    const input = requestFor('workflow:acknowledge:attempt-1', review([41, 51]));

    const blocked = await adapter.execute(input);
    replies.mode = 'normal';
    const resumed = await adapter.execute({
      ...input,
      operationId: 'workflow:acknowledge:attempt-2',
      runtime: { ...input.runtime, attempt: 2 },
    });

    expect(blocked).toMatchObject({ status: 'blocked', kind: 'infrastructure' });
    expect(resumed).toMatchObject({ status: 'completed' });
    expect(replies.replyCalls.map(({ rootCommentId }) => rootCommentId)).toEqual([41, 51, 51]);
  });
});
