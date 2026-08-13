import { createHash } from 'node:crypto';

import { z } from 'zod';

import type { LedgerRepository } from '../../ledger/repository.js';
import type { Clock } from '../../shared/clock.js';
import { err, ok, type Outcome } from '../../shared/outcome.js';
import type { BitbucketRepositoryConfiguration } from '../../repositories/bitbucket.js';
import type { TaskRunStepEvidence } from '../execution.js';
import { pullRequestOutputSchema } from '../../harness/step-contracts.js';

const RawUserSchema = z
  .object({
    displayName: z.string().min(1),
    slug: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
  })
  .loose();

type RawComment = {
  readonly id: number;
  readonly text: string;
  readonly author: z.infer<typeof RawUserSchema>;
  readonly createdDate: number;
  readonly resolvedDate?: number | null | undefined;
  readonly comments: readonly RawComment[];
};

const RawCommentSchema: z.ZodType<RawComment> = z.lazy(() =>
  z
    .object({
      id: z.number().int().positive(),
      text: z.string(),
      author: RawUserSchema,
      createdDate: z.number().int().nonnegative(),
      resolvedDate: z.number().int().nonnegative().nullable().optional(),
      comments: z.array(RawCommentSchema).default([]),
    })
    .loose(),
);

const RawActivitySchema = z
  .object({
    action: z.string().min(1),
    comment: RawCommentSchema.optional(),
    commentAnchor: z
      .object({
        path: z.string().min(1).optional(),
        line: z.number().int().positive().optional(),
        lineType: z.string().min(1).optional(),
        orphaned: z.boolean().optional(),
      })
      .loose()
      .optional(),
    user: RawUserSchema.optional(),
    createdDate: z.number().int().nonnegative().optional(),
  })
  .loose();

const RawActivityPageSchema = z
  .object({
    values: z.array(RawActivitySchema),
    isLastPage: z.boolean(),
    nextPageStart: z.number().int().nonnegative().optional(),
  })
  .loose();

export const BitbucketReviewCommentSchema = z
  .object({
    id: z.number().int().positive(),
    parentId: z.number().int().positive().nullable(),
    author: z
      .object({ displayName: z.string().min(1), slug: z.string().min(1).nullable() })
      .strict(),
    text: z.string(),
    createdAt: z.iso.datetime(),
    resolved: z.boolean(),
  })
  .strict();

export const BitbucketReviewThreadSchema = z
  .object({
    rootCommentId: z.number().int().positive(),
    anchor: z
      .object({
        path: z.string().min(1).nullable(),
        line: z.number().int().positive().nullable(),
        lineType: z.string().min(1).nullable(),
        orphaned: z.boolean(),
      })
      .strict(),
    comments: z.array(BitbucketReviewCommentSchema).min(1),
  })
  .strict();

export const BitbucketReviewSnapshotSchema = z
  .object({
    provider: z.literal('bitbucket'),
    projectKey: z.string().min(1),
    repositorySlug: z.string().min(1),
    pullRequestId: z.number().int().positive(),
    pullRequestUrl: z.url().nullable(),
    decision: z.enum(['approved', 'changes_requested', 'pending']),
    approvals: z.array(
      z
        .object({
          author: z.string().min(1),
          createdAt: z.iso.datetime().nullable(),
        })
        .strict(),
    ),
    threads: z.array(BitbucketReviewThreadSchema),
  })
  .strict();

export type BitbucketReviewSnapshot = z.infer<typeof BitbucketReviewSnapshotSchema>;

export type BitbucketReviewProblem = {
  readonly kind:
    | 'access_blocked'
    | 'auth_failed'
    | 'invalid_request'
    | 'invalid_response'
    | 'not_found'
    | 'unavailable';
  readonly message: string;
  readonly retryable: boolean;
  readonly httpStatus?: number;
};

export type BitbucketReviewObservation =
  | { readonly status: 'observed'; readonly snapshot: BitbucketReviewSnapshot }
  | { readonly status: 'failed'; readonly problem: BitbucketReviewProblem };

export interface BitbucketReviewPort {
  observe(input: {
    readonly projectKey: string;
    readonly repositorySlug: string;
    readonly pullRequestId: number;
    readonly pullRequestUrl: string | null;
  }): Promise<BitbucketReviewObservation>;
}

export type BitbucketReviewReplyResult =
  | { readonly status: 'replied'; readonly commentId: number }
  | { readonly status: 'failed'; readonly problem: BitbucketReviewProblem };

export type BitbucketReviewAcknowledgementObservation =
  | { readonly status: 'observed'; readonly acknowledged: boolean }
  | { readonly status: 'failed'; readonly problem: BitbucketReviewProblem };

export interface BitbucketReviewReplyPort {
  reply(input: {
    readonly projectKey: string;
    readonly repositorySlug: string;
    readonly pullRequestId: number;
    readonly rootCommentId: number;
    readonly text: string;
  }): Promise<BitbucketReviewReplyResult>;
  hasAcknowledgement(input: {
    readonly projectKey: string;
    readonly repositorySlug: string;
    readonly pullRequestId: number;
    readonly marker: string;
  }): Promise<BitbucketReviewAcknowledgementObservation>;
}

const TASKER_REVIEW_MARKER_PREFIX = '<!-- tasker-review:';

export const taskerReviewAcknowledgementMarker = (
  reviewId: string,
  rootCommentId: number,
): string => `${TASKER_REVIEW_MARKER_PREFIX}${reviewId}:thread-${String(rootCommentId)} -->`;

export const isTaskerReviewAcknowledgement = (text: string): boolean =>
  text.includes(TASKER_REVIEW_MARKER_PREFIX);

const BOT_MARKERS = ['_bot', 'bot_', 'jenkins', 'code_review_bot'] as const;

const isBot = (displayName: string): boolean => {
  const normalized = displayName.toLowerCase();
  return BOT_MARKERS.some((marker) => normalized.includes(marker));
};

const normalizedUser = (user: z.infer<typeof RawUserSchema>) => ({
  displayName: user.displayName,
  slug: user.slug ?? user.name ?? null,
});

const flattenComments = (
  comment: RawComment,
  parentId: number | null = null,
): z.infer<typeof BitbucketReviewCommentSchema>[] => [
  {
    id: comment.id,
    parentId,
    author: normalizedUser(comment.author),
    text: comment.text,
    createdAt: new Date(comment.createdDate).toISOString(),
    resolved: comment.resolvedDate !== undefined && comment.resolvedDate !== null,
  },
  ...comment.comments.flatMap((child) => flattenComments(child, comment.id)),
];

const latestComment = (
  comments: readonly z.infer<typeof BitbucketReviewCommentSchema>[],
): z.infer<typeof BitbucketReviewCommentSchema> | undefined =>
  comments.reduce<z.infer<typeof BitbucketReviewCommentSchema> | undefined>(
    (latest, comment) =>
      latest === undefined || comment.createdAt > latest.createdAt ? comment : latest,
    undefined,
  );

const problemForStatus = (status: number): BitbucketReviewProblem => {
  if (status === 400) {
    return {
      kind: 'invalid_request',
      message: 'Bitbucket rejected the review comment payload',
      retryable: false,
      httpStatus: status,
    };
  }
  if (status === 401) {
    return {
      kind: 'auth_failed',
      message: 'Bitbucket rejected the configured token',
      retryable: false,
      httpStatus: status,
    };
  }
  if (status === 403) {
    return {
      kind: 'access_blocked',
      message: 'Bitbucket returned 403. Enable VPN or check repository access',
      retryable: true,
      httpStatus: status,
    };
  }
  if (status === 404) {
    return {
      kind: 'not_found',
      message: 'Bitbucket pull request was not found',
      retryable: false,
      httpStatus: status,
    };
  }
  return {
    kind: 'unavailable',
    message: `Bitbucket review request failed with HTTP ${String(status)}`,
    retryable: status >= 500,
    httpStatus: status,
  };
};

type ActivityLoadResult =
  | { readonly status: 'loaded'; readonly activities: readonly z.infer<typeof RawActivitySchema>[] }
  | { readonly status: 'failed'; readonly problem: BitbucketReviewProblem };

export class BitbucketReviewClient implements BitbucketReviewPort, BitbucketReviewReplyPort {
  public constructor(
    private readonly configuration: BitbucketRepositoryConfiguration,
    private readonly fetchImplementation: typeof fetch = fetch,
  ) {}

  public async observe(input: {
    readonly projectKey: string;
    readonly repositorySlug: string;
    readonly pullRequestId: number;
    readonly pullRequestUrl: string | null;
  }): Promise<BitbucketReviewObservation> {
    const loaded = await this.loadActivities(input);
    if (loaded.status === 'failed') return loaded;
    const activities = loaded.activities;

    const threads = activities
      .flatMap((activity) => {
        if (
          activity.action !== 'COMMENTED' ||
          activity.comment === undefined ||
          isBot(activity.comment.author.displayName) ||
          (activity.comment.resolvedDate !== undefined && activity.comment.resolvedDate !== null)
        ) {
          return [];
        }
        const comments = flattenComments(activity.comment);
        if (isTaskerReviewAcknowledgement(latestComment(comments)?.text ?? '')) return [];
        const anchor = activity.commentAnchor;
        return [
          BitbucketReviewThreadSchema.parse({
            rootCommentId: activity.comment.id,
            anchor: {
              path: anchor?.path ?? null,
              line: anchor?.line ?? null,
              lineType: anchor?.lineType ?? null,
              orphaned: anchor?.orphaned ?? false,
            },
            comments,
          }),
        ];
      })
      .sort((left, right) => left.rootCommentId - right.rootCommentId);
    const approvals = activities
      .filter((activity) => activity.action === 'APPROVED' && activity.user !== undefined)
      .map((activity) => ({
        author: (activity.user as z.infer<typeof RawUserSchema>).displayName,
        createdAt:
          activity.createdDate === undefined ? null : new Date(activity.createdDate).toISOString(),
      }));
    return {
      status: 'observed',
      snapshot: BitbucketReviewSnapshotSchema.parse({
        provider: 'bitbucket',
        projectKey: input.projectKey,
        repositorySlug: input.repositorySlug,
        pullRequestId: input.pullRequestId,
        pullRequestUrl: input.pullRequestUrl,
        decision:
          threads.length > 0 ? 'changes_requested' : approvals.length > 0 ? 'approved' : 'pending',
        approvals,
        threads,
      }),
    };
  }

  public async reply(input: {
    readonly projectKey: string;
    readonly repositorySlug: string;
    readonly pullRequestId: number;
    readonly rootCommentId: number;
    readonly text: string;
  }): Promise<BitbucketReviewReplyResult> {
    const response = await this.request(`${this.pullRequestPath(input)}/comments`, {
      method: 'POST',
      body: JSON.stringify({ text: input.text, parent: { id: input.rootCommentId } }),
    });
    if (response.status === 'failed') return response;
    const parsed = z.object({ id: z.number().int().positive() }).loose().safeParse(response.body);
    return parsed.success
      ? { status: 'replied', commentId: parsed.data.id }
      : {
          status: 'failed',
          problem: {
            kind: 'invalid_response',
            message: 'Bitbucket returned an invalid review reply',
            retryable: true,
          },
        };
  }

  public async hasAcknowledgement(input: {
    readonly projectKey: string;
    readonly repositorySlug: string;
    readonly pullRequestId: number;
    readonly marker: string;
  }): Promise<BitbucketReviewAcknowledgementObservation> {
    const loaded = await this.loadActivities(input);
    if (loaded.status === 'failed') return loaded;
    return {
      status: 'observed',
      acknowledged: loaded.activities.some(
        (activity) =>
          activity.comment !== undefined &&
          flattenComments(activity.comment).some((comment) => comment.text.includes(input.marker)),
      ),
    };
  }

  private async loadActivities(input: {
    readonly projectKey: string;
    readonly repositorySlug: string;
    readonly pullRequestId: number;
  }): Promise<ActivityLoadResult> {
    const activities: z.infer<typeof RawActivitySchema>[] = [];
    let start: number | undefined;
    do {
      const query = new URLSearchParams({ limit: '200' });
      if (start !== undefined) query.set('start', String(start));
      const response = await this.request(
        `${this.pullRequestPath(input)}/activities?${query.toString()}`,
      );
      if (response.status === 'failed') return response;
      const parsed = RawActivityPageSchema.safeParse(response.body);
      if (!parsed.success) {
        return {
          status: 'failed',
          problem: {
            kind: 'invalid_response',
            message: 'Bitbucket returned an invalid review activity page',
            retryable: false,
          },
        };
      }
      activities.push(...parsed.data.values);
      start = parsed.data.isLastPage ? undefined : parsed.data.nextPageStart;
      if (!parsed.data.isLastPage && start === undefined) {
        return {
          status: 'failed',
          problem: {
            kind: 'invalid_response',
            message: 'Bitbucket review pagination omitted nextPageStart',
            retryable: false,
          },
        };
      }
    } while (start !== undefined);

    return { status: 'loaded', activities };
  }

  private async request(
    path: string,
    init: Pick<RequestInit, 'body' | 'method'> = {},
  ): Promise<
    | { readonly status: 'ok'; readonly body: unknown }
    | { readonly status: 'failed'; readonly problem: BitbucketReviewProblem }
  > {
    try {
      const response = await this.fetchImplementation(`${this.configuration.baseUrl}${path}`, {
        ...init,
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${this.configuration.token}`,
          ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        signal: AbortSignal.timeout(this.configuration.requestTimeoutMs),
      });
      if (!response.ok) return { status: 'failed', problem: problemForStatus(response.status) };
      return { status: 'ok', body: await response.json() };
    } catch {
      return {
        status: 'failed',
        problem: {
          kind: 'unavailable',
          message: 'Bitbucket review request failed before a response was received',
          retryable: true,
        },
      };
    }
  }

  private pullRequestPath(input: {
    readonly projectKey: string;
    readonly repositorySlug: string;
    readonly pullRequestId: number;
  }): string {
    return `/rest/api/1.0/projects/${encodeURIComponent(input.projectKey)}/repos/${encodeURIComponent(input.repositorySlug)}/pull-requests/${String(input.pullRequestId)}`;
  }
}

export const PullRequestReviewEvidenceSchema = z
  .object({
    schemaVersion: z.literal(1),
    taskReference: z.string().min(1),
    workflowId: z.string().min(1),
    workflowRunId: z.string().min(1),
    reviewId: z.string().min(1),
    importedAt: z.iso.datetime(),
    snapshot: BitbucketReviewSnapshotSchema,
  })
  .strict();

export type PullRequestReviewEvidence = z.infer<typeof PullRequestReviewEvidenceSchema>;

export type PullRequestReviewEvidenceStoreError =
  | { readonly kind: 'artifact_corrupt'; readonly artifactId: string }
  | { readonly kind: 'artifact_missing'; readonly artifactId: string }
  | { readonly kind: 'ledger_conflict' };

const canonicalSnapshot = (snapshot: BitbucketReviewSnapshot): string => JSON.stringify(snapshot);

export class PullRequestReviewEvidenceStore {
  public constructor(
    private readonly ledger: LedgerRepository,
    private readonly clock: Clock,
  ) {}

  public record(input: {
    readonly taskReference: string;
    readonly workflowId: string;
    readonly workflowRunId: string;
    readonly snapshot: BitbucketReviewSnapshot;
  }): Outcome<PullRequestReviewEvidence, PullRequestReviewEvidenceStoreError> {
    const fingerprint = createHash('sha256')
      .update(canonicalSnapshot(input.snapshot))
      .digest('hex');
    const reviewId = `bitbucket:${input.snapshot.projectKey}/${input.snapshot.repositorySlug}:${String(input.snapshot.pullRequestId)}:${fingerprint.slice(0, 16)}`;
    const aggregateId = `pull-request-reviews:${input.workflowId}`;
    const artifactId = `${aggregateId}:${fingerprint}`;
    const existing = this.ledger.readArtifact(artifactId);
    if (existing !== null) {
      const parsed = PullRequestReviewEvidenceSchema.safeParse(existing.payload);
      return parsed.success ? ok(parsed.data) : err({ kind: 'artifact_corrupt', artifactId });
    }
    const importedAt = this.clock.now();
    const evidence = PullRequestReviewEvidenceSchema.parse({
      schemaVersion: 1,
      ...input,
      reviewId,
      importedAt,
    });
    const expectedVersion = this.ledger.listEvents(aggregateId).length;
    const committed = this.ledger.transact({
      aggregate: {
        aggregateId,
        expectedVersion,
        events: [
          {
            eventId: `event:${artifactId}`,
            eventType: 'PullRequestReviewImported',
            eventSchemaVersion: 1,
            payload: { artifactId },
            actor: 'integration',
          },
        ],
      },
      artifacts: [
        {
          artifactId,
          artifactKind: 'pull-request-review',
          storageUri: `ledger://artifacts/${artifactId}`,
          payload: evidence,
          metadata: {
            taskReference: input.taskReference,
            workflowId: input.workflowId,
            pullRequestId: input.snapshot.pullRequestId,
          },
          createdAt: importedAt,
        },
      ],
      timestamp: importedAt,
    });
    if (committed.ok) return ok(evidence);
    const raced = this.ledger.readArtifact(artifactId);
    if (raced === null) return err({ kind: 'ledger_conflict' });
    const parsed = PullRequestReviewEvidenceSchema.safeParse(raced.payload);
    return parsed.success ? ok(parsed.data) : err({ kind: 'artifact_corrupt', artifactId });
  }

  public list(
    workflowId: string,
  ): Outcome<readonly PullRequestReviewEvidence[], PullRequestReviewEvidenceStoreError> {
    const aggregateId = `pull-request-reviews:${workflowId}`;
    const evidence: PullRequestReviewEvidence[] = [];
    for (const event of this.ledger.listEvents(aggregateId)) {
      const pointer = z.object({ artifactId: z.string().min(1) }).safeParse(event.payload);
      if (!pointer.success) return err({ kind: 'artifact_corrupt', artifactId: event.eventId });
      const artifact = this.ledger.readArtifact(pointer.data.artifactId);
      if (artifact === null) {
        return err({ kind: 'artifact_missing', artifactId: pointer.data.artifactId });
      }
      const parsed = PullRequestReviewEvidenceSchema.safeParse(artifact.payload);
      if (!parsed.success) {
        return err({ kind: 'artifact_corrupt', artifactId: pointer.data.artifactId });
      }
      evidence.push(parsed.data);
    }
    return ok(evidence);
  }
}

export const pullRequestReferenceFrom = (
  steps: readonly TaskRunStepEvidence[],
): z.infer<typeof pullRequestOutputSchema> | null => {
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index];
    if (step?.stepReference !== 'pr.prepare@1' || step.status !== 'completed') continue;
    const details = z.object({ output: pullRequestOutputSchema }).safeParse(step.details);
    if (details.success) return details.data.output;
  }
  return null;
};

export type BitbucketReviewSyncResult =
  | { readonly status: 'pending'; readonly pullRequestUrl: string | null }
  | {
      readonly status: 'approved' | 'changes_requested';
      readonly reviewId: string;
      readonly evidence: PullRequestReviewEvidence;
    };

export type BitbucketReviewSyncError =
  | { readonly kind: 'pull_request_evidence_missing' }
  | { readonly kind: 'invalid_pull_request_evidence' }
  | { readonly kind: 'review_failed'; readonly problem: BitbucketReviewProblem }
  | { readonly kind: 'store_failed'; readonly error: PullRequestReviewEvidenceStoreError };

export class BitbucketReviewCoordinator {
  public constructor(
    private readonly traces: {
      readRunStepEvidence(workflowId: string): Outcome<readonly TaskRunStepEvidence[], unknown>;
    },
    private readonly reviews: BitbucketReviewPort,
    private readonly evidence: PullRequestReviewEvidenceStore,
  ) {}

  public async sync(input: {
    readonly taskReference: string;
    readonly workflowId: string;
    readonly workflowRunId: string;
  }): Promise<Outcome<BitbucketReviewSyncResult, BitbucketReviewSyncError>> {
    const steps = this.traces.readRunStepEvidence(input.workflowId);
    if (!steps.ok) return err({ kind: 'invalid_pull_request_evidence' });
    const pullRequest = pullRequestReferenceFrom(steps.value);
    if (pullRequest === null) return err({ kind: 'pull_request_evidence_missing' });
    const [projectKey, repositorySlug, extra] = pullRequest.repository.split('/');
    const pullRequestId = Number(pullRequest.externalId);
    if (
      projectKey === undefined ||
      projectKey.length === 0 ||
      repositorySlug === undefined ||
      repositorySlug.length === 0 ||
      extra !== undefined ||
      !Number.isSafeInteger(pullRequestId) ||
      pullRequestId < 1
    ) {
      return err({ kind: 'invalid_pull_request_evidence' });
    }
    const observed = await this.reviews.observe({
      projectKey,
      repositorySlug,
      pullRequestId,
      pullRequestUrl: pullRequest.url,
    });
    if (observed.status === 'failed') {
      return err({ kind: 'review_failed', problem: observed.problem });
    }
    if (observed.snapshot.decision === 'pending') {
      return ok({ status: 'pending', pullRequestUrl: observed.snapshot.pullRequestUrl });
    }
    const recorded = this.evidence.record({ ...input, snapshot: observed.snapshot });
    return recorded.ok
      ? ok({
          status: observed.snapshot.decision,
          reviewId: recorded.value.reviewId,
          evidence: recorded.value,
        })
      : err({ kind: 'store_failed', error: recorded.error });
  }
}
