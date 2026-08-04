import { z } from 'zod';

import { JsonValueSchema, type JsonValue } from '../../workflow/schema.js';
import type {
  IntegrationStepAdapter,
  IntegrationStepExecutionRequest,
  IntegrationStepExecutionResult,
} from '../execution.js';
import type { ExternalEffectStore, ExternalEffectStoreError } from '../effects.js';
import {
  pullRequestReferenceFrom,
  taskerReviewAcknowledgementMarker,
  type BitbucketReviewProblem,
  type BitbucketReviewReplyPort,
  type PullRequestReviewEvidence,
} from './review.js';

const ReviewReplyReceiptSchema = z
  .object({
    reviewId: z.string().min(1),
    rootCommentId: z.number().int().positive(),
    marker: z.string().min(1),
    commentId: z.number().int().positive().nullable(),
  })
  .strict();

const effectFailure = (
  error: ExternalEffectStoreError,
  artifactIds: readonly string[],
): IntegrationStepExecutionResult => ({
  status: 'blocked',
  kind: 'unknown_outcome',
  summary: `Review acknowledgement journal is unavailable: ${error.kind}`,
  details: JsonValueSchema.parse(error),
  artifactIds,
});

const problemResult = (
  problem: BitbucketReviewProblem,
  artifactIds: readonly string[],
  outcomeMayBeUnknown = false,
): IntegrationStepExecutionResult => ({
  status: 'blocked',
  kind: outcomeMayBeUnknown
    ? 'unknown_outcome'
    : problem.kind === 'access_blocked' || problem.kind === 'unavailable'
      ? 'infrastructure'
      : problem.kind === 'auth_failed'
        ? 'configuration'
        : 'invalid_request',
  summary: problem.message,
  details: JsonValueSchema.parse(problem),
  artifactIds,
});

const latestReview = (
  reviews: readonly PullRequestReviewEvidence[],
): PullRequestReviewEvidence | null => reviews.at(-1) ?? null;

const acknowledgementText = (thread: PullRequestReviewEvidence['snapshot']['threads'][number]) => {
  const latest = thread.comments.reduce((current, comment) =>
    comment.createdAt > current.createdAt ? comment : current,
  );
  return /\p{Script=Cyrillic}/u.test(latest.text)
    ? 'Изменения внесены в последнем обновлении.'
    : 'Changes applied in the latest update.';
};

export class BitbucketReviewReplyAdapter implements IntegrationStepAdapter {
  public readonly id = 'bitbucket.review-reply@1';

  public constructor(
    private readonly replies: BitbucketReviewReplyPort,
    private readonly effects: ExternalEffectStore,
  ) {}

  public async execute(
    request: IntegrationStepExecutionRequest,
  ): Promise<IntegrationStepExecutionResult> {
    const review = latestReview(request.evidence.reviewInputs);
    if (review === null || review.snapshot.decision !== 'changes_requested') {
      return {
        status: 'blocked',
        kind: 'invalid_request',
        summary: 'Review acknowledgement requires the latest changes-requested evidence',
        details: { reviewCount: request.evidence.reviewInputs.length },
        artifactIds: [],
      };
    }
    const pullRequest = pullRequestReferenceFrom(request.evidence.completedSteps);
    if (
      pullRequest === null ||
      pullRequest.provider !== 'bitbucket' ||
      pullRequest.repository !==
        `${review.snapshot.projectKey}/${review.snapshot.repositorySlug}` ||
      pullRequest.externalId !== String(review.snapshot.pullRequestId)
    ) {
      return {
        status: 'blocked',
        kind: 'remote_conflict',
        summary: 'Review evidence no longer matches the current pull request',
        details: {
          reviewId: review.reviewId,
          pullRequest: pullRequest === null ? null : pullRequest,
        },
        artifactIds: [],
      };
    }

    const artifactIds: string[] = [];
    for (const thread of review.snapshot.threads) {
      const result = await this.acknowledgeThread(request, review, thread, artifactIds);
      if (result !== null) return result;
    }
    return {
      status: 'completed',
      summary: `Acknowledged ${String(review.snapshot.threads.length)} pull-request review thread(s)`,
      output: {
        externalId: review.reviewId,
        status: 'acknowledged',
      },
      artifactIds,
    };
  }

  private async acknowledgeThread(
    request: IntegrationStepExecutionRequest,
    review: PullRequestReviewEvidence,
    thread: PullRequestReviewEvidence['snapshot']['threads'][number],
    artifactIds: string[],
  ): Promise<IntegrationStepExecutionResult | null> {
    const effectId = `reply-thread-${String(thread.rootCommentId)}`;
    const marker = taskerReviewAcknowledgementMarker(review.reviewId, thread.rootCommentId);
    const text = `${acknowledgementText(thread)}\n\n${marker}`;
    const identity: JsonValue = {
      provider: 'bitbucket',
      projectKey: review.snapshot.projectKey,
      repositorySlug: review.snapshot.repositorySlug,
      pullRequestId: review.snapshot.pullRequestId,
      reviewId: review.reviewId,
      rootCommentId: thread.rootCommentId,
      marker,
      text,
    };
    const prepared = this.effects.prepare({
      operationId: request.operationId,
      effectId,
      effectKind: 'bitbucket.review.reply',
      identity,
    });
    const intentArtifactId = this.effects.intentArtifactId(request.operationId, effectId);
    if (!prepared.ok) return effectFailure(prepared.error, artifactIds);
    artifactIds.push(intentArtifactId);
    const receipt = this.effects.readReceipt(request.operationId, effectId);
    if (!receipt.ok) return effectFailure(receipt.error, artifactIds);
    if (receipt.value !== null) {
      const parsed = ReviewReplyReceiptSchema.safeParse(receipt.value.result);
      if (!parsed.success || parsed.data.marker !== marker) {
        return {
          status: 'blocked',
          kind: 'unknown_outcome',
          summary: 'Stored review acknowledgement receipt is corrupt',
          details: { effectId },
          artifactIds,
        };
      }
      artifactIds.push(this.effects.receiptArtifactId(request.operationId, effectId));
      return null;
    }

    const probe = await this.replies.hasAcknowledgement({
      projectKey: review.snapshot.projectKey,
      repositorySlug: review.snapshot.repositorySlug,
      pullRequestId: review.snapshot.pullRequestId,
      marker,
    });
    if (probe.status === 'failed') return problemResult(probe.problem, artifactIds);
    if (probe.acknowledged) {
      return this.recordApplied(
        request,
        review.reviewId,
        thread.rootCommentId,
        marker,
        null,
        artifactIds,
      );
    }

    const reply = await this.replies.reply({
      projectKey: review.snapshot.projectKey,
      repositorySlug: review.snapshot.repositorySlug,
      pullRequestId: review.snapshot.pullRequestId,
      rootCommentId: thread.rootCommentId,
      text,
    });
    if (reply.status === 'replied') {
      return this.recordApplied(
        request,
        review.reviewId,
        thread.rootCommentId,
        marker,
        reply.commentId,
        artifactIds,
      );
    }
    if (reply.problem.kind !== 'unavailable' && reply.problem.kind !== 'invalid_response') {
      return problemResult(reply.problem, artifactIds);
    }
    const reconciliation = await this.replies.hasAcknowledgement({
      projectKey: review.snapshot.projectKey,
      repositorySlug: review.snapshot.repositorySlug,
      pullRequestId: review.snapshot.pullRequestId,
      marker,
    });
    if (reconciliation.status === 'observed' && reconciliation.acknowledged) {
      return this.recordApplied(
        request,
        review.reviewId,
        thread.rootCommentId,
        marker,
        null,
        artifactIds,
      );
    }
    return problemResult(reply.problem, artifactIds, true);
  }

  private recordApplied(
    request: IntegrationStepExecutionRequest,
    reviewId: string,
    rootCommentId: number,
    marker: string,
    commentId: number | null,
    artifactIds: string[],
  ): IntegrationStepExecutionResult | null {
    const effectId = `reply-thread-${String(rootCommentId)}`;
    const applied = this.effects.recordApplied({
      operationId: request.operationId,
      effectId,
      effectKind: 'bitbucket.review.reply',
      result: ReviewReplyReceiptSchema.parse({ reviewId, rootCommentId, marker, commentId }),
    });
    if (!applied.ok) return effectFailure(applied.error, artifactIds);
    artifactIds.push(this.effects.receiptArtifactId(request.operationId, effectId));
    return null;
  }
}
