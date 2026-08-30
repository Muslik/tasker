import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  BitbucketReviewClient,
  BitbucketReviewCoordinator,
  PullRequestReviewEvidenceStore,
  taskerReviewAcknowledgementMarker,
  type BitbucketReviewPort,
  type BitbucketReviewSnapshot,
  type TaskRunStepEvidence,
} from '../../../src/integrations/index.js';
import { openSqliteLedger, type SqliteLedger } from '../../../src/store/index.js';
import { ok } from '../../../src/shared/outcome.js';

const configuration = {
  baseUrl: 'https://bitbucket.example',
  token: 'secret',
  requestTimeoutMs: 1_000,
};

let ledger: SqliteLedger | undefined;

afterEach(() => {
  ledger?.close();
  ledger = undefined;
});

const response = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const humanComment = {
  id: 41,
  text: 'Handle the empty result explicitly',
  author: { displayName: 'Reviewer', slug: 'reviewer' },
  createdDate: Date.parse('2026-08-04T10:00:00.000Z'),
  comments: [
    {
      id: 42,
      text: 'This also affects mobile webview',
      author: { displayName: 'Second reviewer', slug: 'second' },
      createdDate: Date.parse('2026-08-04T10:01:00.000Z'),
      comments: [],
    },
  ],
};

const snapshot = (decision: BitbucketReviewSnapshot['decision']): BitbucketReviewSnapshot => ({
  provider: 'bitbucket',
  projectKey: 'ONETWOTRIP',
  repositorySlug: 'front-avia',
  pullRequestId: 73,
  pullRequestUrl: 'https://bitbucket.example/projects/ONETWOTRIP/repos/front-avia/pull-requests/73',
  decision,
  approvals: [],
  threads:
    decision === 'changes_requested'
      ? [
          {
            rootCommentId: 41,
            anchor: { path: 'src/search.ts', line: 17, lineType: 'ADDED', orphaned: false },
            comments: [
              {
                id: 41,
                parentId: null,
                author: { displayName: 'Reviewer', slug: 'reviewer' },
                text: 'Handle the empty result explicitly',
                createdAt: '2026-08-04T10:00:00.000Z',
                resolved: false,
              },
            ],
          },
        ]
      : [],
});

describe('Bitbucket review intake', () => {
  it('imports paginated nested unresolved threads with exact anchors and ignores bot roots', async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response({
          values: [
            {
              action: 'COMMENTED',
              comment: humanComment,
              commentAnchor: {
                path: 'src/search.ts',
                line: 17,
                lineType: 'ADDED',
                orphaned: false,
              },
            },
            {
              action: 'COMMENTED',
              comment: {
                ...humanComment,
                id: 99,
                author: { displayName: 'code_review_bot', slug: 'bot' },
                comments: [],
              },
            },
          ],
          isLastPage: false,
          nextPageStart: 2,
        }),
      )
      .mockResolvedValueOnce(
        response({
          values: [
            {
              action: 'APPROVED',
              user: { displayName: 'Reviewer', slug: 'reviewer' },
              createdDate: Date.parse('2026-08-04T10:02:00.000Z'),
            },
          ],
          isLastPage: true,
        }),
      );
    const client = new BitbucketReviewClient(configuration, fetchImplementation);

    const result = await client.observe({
      projectKey: 'ONETWOTRIP',
      repositorySlug: 'front-avia',
      pullRequestId: 73,
      pullRequestUrl:
        'https://bitbucket.example/projects/ONETWOTRIP/repos/front-avia/pull-requests/73',
    });

    expect(result).toMatchObject({
      status: 'observed',
      snapshot: {
        decision: 'changes_requested',
        threads: [
          {
            rootCommentId: 41,
            anchor: { path: 'src/search.ts', line: 17, lineType: 'ADDED', orphaned: false },
            comments: [
              { id: 41, parentId: null, author: { displayName: 'Reviewer' } },
              { id: 42, parentId: 41, author: { displayName: 'Second reviewer' } },
            ],
          },
        ],
      },
    });
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    expect(fetchImplementation.mock.calls[1]?.[0]).toContain('start=2');
  });

  it('classifies VPN/access 403 without fabricating an empty review', async () => {
    const client = new BitbucketReviewClient(
      configuration,
      vi.fn<typeof fetch>().mockResolvedValue(response({}, 403)),
    );

    await expect(
      client.observe({
        projectKey: 'ONETWOTRIP',
        repositorySlug: 'front-avia',
        pullRequestId: 73,
        pullRequestUrl: null,
      }),
    ).resolves.toMatchObject({
      status: 'failed',
      problem: { kind: 'access_blocked', retryable: true, httpStatus: 403 },
    });
  });

  it('posts a reply to the root comment using the supported Bitbucket comments endpoint', async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response({ id: 142, text: 'reply' }));
    const client = new BitbucketReviewClient(configuration, fetchImplementation);

    const result = await client.reply({
      projectKey: 'ONETWOTRIP',
      repositorySlug: 'front-avia',
      pullRequestId: 73,
      rootCommentId: 41,
      text: 'Changes applied.',
    });

    expect(result).toEqual({ status: 'replied', commentId: 142 });
    expect(fetchImplementation).toHaveBeenCalledWith(
      'https://bitbucket.example/rest/api/1.0/projects/ONETWOTRIP/repos/front-avia/pull-requests/73/comments',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ text: 'Changes applied.', parent: { id: 41 } }),
      }),
    );
  });

  it('keeps a thread quiet while the Tasker acknowledgement is its latest comment', async () => {
    const marker = taskerReviewAcknowledgementMarker(
      'bitbucket:ONETWOTRIP/front-avia:73:review-hash',
      41,
    );
    const acknowledged = {
      ...humanComment,
      comments: [
        ...humanComment.comments,
        {
          id: 43,
          text: `Changes applied.\n\n${marker}`,
          author: { displayName: 'Tasker', slug: 'tasker' },
          createdDate: Date.parse('2026-08-04T10:02:00.000Z'),
          comments: [],
        },
      ],
    };
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        response({ values: [{ action: 'COMMENTED', comment: acknowledged }], isLastPage: true }),
      );
    const client = new BitbucketReviewClient(configuration, fetchImplementation);

    const result = await client.observe({
      projectKey: 'ONETWOTRIP',
      repositorySlug: 'front-avia',
      pullRequestId: 73,
      pullRequestUrl: null,
    });

    expect(result).toMatchObject({
      status: 'observed',
      snapshot: { decision: 'pending', threads: [] },
    });
  });

  it('makes an acknowledged thread actionable when a reviewer follows up', async () => {
    const marker = taskerReviewAcknowledgementMarker(
      'bitbucket:ONETWOTRIP/front-avia:73:review-hash',
      41,
    );
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      response({
        values: [
          {
            action: 'COMMENTED',
            comment: {
              ...humanComment,
              comments: [
                ...humanComment.comments,
                {
                  id: 43,
                  text: `Changes applied.\n\n${marker}`,
                  author: { displayName: 'Tasker', slug: 'tasker' },
                  createdDate: Date.parse('2026-08-04T10:02:00.000Z'),
                  comments: [],
                },
                {
                  id: 44,
                  text: 'This is still broken on mobile',
                  author: { displayName: 'Reviewer', slug: 'reviewer' },
                  createdDate: Date.parse('2026-08-04T10:03:00.000Z'),
                  comments: [],
                },
              ],
            },
          },
        ],
        isLastPage: true,
      }),
    );
    const client = new BitbucketReviewClient(configuration, fetchImplementation);

    const result = await client.observe({
      projectKey: 'ONETWOTRIP',
      repositorySlug: 'front-avia',
      pullRequestId: 73,
      pullRequestUrl: null,
    });

    expect(result).toMatchObject({
      status: 'observed',
      snapshot: { decision: 'changes_requested', threads: [{ rootCommentId: 41 }] },
    });
  });

  it('deduplicates the same imported review and makes it available to revision evidence', async () => {
    ledger = openSqliteLedger({ filename: ':memory:' });
    const store = new PullRequestReviewEvidenceStore(ledger.repository, {
      now: () => '2026-08-04T10:03:00.000Z',
    });
    const reviewPort: BitbucketReviewPort = {
      observe: () =>
        Promise.resolve({ status: 'observed', snapshot: snapshot('changes_requested') }),
    };
    const prOutput = {
      externalId: '73',
      status: 'open',
      provider: 'bitbucket',
      repository: 'ONETWOTRIP/front-avia',
      sourceBranch: 'tasker/AVIA-13236/run-1',
      targetBranch: 'main',
      url: 'https://bitbucket.example/projects/ONETWOTRIP/repos/front-avia/pull-requests/73',
    } as const;
    const step: TaskRunStepEvidence = {
      operationId: 'tasker:jira:AVIA-13236:prepare-pr:attempt-1',
      nodeId: 'prepare-pr',
      stepReference: 'deliver.pull-request@1',
      status: 'completed',
      summary: 'PR ready',
      artifactIds: [],
      details: { output: prOutput },
      recordedAt: '2026-08-04T10:02:00.000Z',
    };
    const coordinator = new BitbucketReviewCoordinator(
      { readRunStepEvidence: () => ok([step]) },
      reviewPort,
      store,
    );
    const input = {
      taskReference: 'jira:AVIA-13236',
      workflowId: 'tasker:jira:AVIA-13236',
      workflowRunId: 'run-1',
    };

    const first = await coordinator.sync(input);
    const repeated = await coordinator.sync(input);
    const stored = store.list(input.workflowId);

    expect(first).toMatchObject({ ok: true, value: { status: 'changes_requested' } });
    expect(repeated).toEqual(first);
    expect(stored.ok).toBe(true);
    if (stored.ok) {
      expect(stored.value).toHaveLength(1);
      expect(stored.value[0]?.reviewId).toEqual(expect.any(String));
    }
  });
});
