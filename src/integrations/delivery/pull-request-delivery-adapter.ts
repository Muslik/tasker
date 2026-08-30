import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { z } from 'zod';

import {
  ciObservationOutputSchema,
  deliveryOutputSchema,
  pullRequestOutputSchema,
} from '../../harness/step-contracts.js';
import { JsonValueSchema, type JsonValue } from '../../workflow/schema.js';
import type { BitbucketPullRequestAdapter } from '../bitbucket/pull-request-adapter.js';
import type { PullRequestReviewEvidence } from '../bitbucket/review.js';
import type {
  IntegrationStepAdapter,
  IntegrationStepExecutionRequest,
  IntegrationStepExecutionResult,
} from '../execution.js';
import type { JenkinsBuildObserverAdapter } from '../jenkins/build-observer-adapter.js';
import type { JiraReviewReadyAdapter } from '../jira/review-ready-adapter.js';
import { PullRequestDraftSchema } from '../pull-request-draft.js';

const ReviewResolutionSchema = z
  .object({
    decision: z.enum(['approved', 'changes_requested']),
    reviewId: z.string().min(1),
  })
  .loose();

type PullRequestOutput = z.infer<typeof pullRequestOutputSchema>;
type CiObservationOutput = z.infer<typeof ciObservationOutputSchema>;
type DeliveryOutput = z.infer<typeof deliveryOutputSchema>;

const combineArtifacts = (
  current: readonly string[],
  next: readonly string[],
): readonly string[] => [...new Set([...current, ...next])];

const relay = (
  result: Extract<
    IntegrationStepExecutionResult,
    { readonly status: 'blocked' | 'continuation_required' | 'waiting' }
  >,
  artifactIds: readonly string[],
): IntegrationStepExecutionResult => ({
  ...result,
  artifactIds: combineArtifacts(artifactIds, result.artifactIds),
});

const invalidOutput = (
  operation: string,
  issues: readonly string[],
  artifactIds: readonly string[],
): IntegrationStepExecutionResult => ({
  status: 'blocked',
  kind: 'unknown_outcome',
  summary: `${operation} returned an invalid durable result`,
  details: { operation, issues: [...issues] },
  artifactIds,
});

const readPullRequestDraft = async (
  request: IntegrationStepExecutionRequest,
): Promise<
  | { readonly ok: true; readonly draft: z.infer<typeof PullRequestDraftSchema> }
  | { readonly ok: false; readonly reason: string }
> => {
  const path = join(request.workspace.path, '.tasker', 'pull-request', 'draft.json');
  try {
    const parsed = PullRequestDraftSchema.safeParse(JSON.parse(await readFile(path, 'utf8')));
    return parsed.success
      ? { ok: true, draft: parsed.data }
      : {
          ok: false,
          reason: parsed.error.issues
            .map((issue) => `${issue.path.map(String).join('.')}: ${issue.message}`)
            .join('; '),
        };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : 'Pull-request draft cannot be read',
    };
  }
};

const latestReview = (
  reviews: readonly PullRequestReviewEvidence[],
): PullRequestReviewEvidence | null => reviews.at(-1) ?? null;

const waitingDetails = (
  phase: string,
  pullRequest: PullRequestOutput,
  extra: Readonly<Record<string, JsonValue>> = {},
): JsonValue => JsonValueSchema.parse({ phase, output: pullRequest, ...extra });

const reviewReadyWasPublished = (request: IntegrationStepExecutionRequest): boolean =>
  request.evidence.completedSteps.some(
    ({ stepReference, details }) =>
      stepReference === 'deliver.pull-request@1' &&
      typeof details === 'object' &&
      details !== null &&
      !Array.isArray(details) &&
      details.phase === 'human_review',
  );

const deliveryOutput = (
  pullRequest: PullRequestOutput,
  ci: CiObservationOutput,
  repair: DeliveryOutput['repair'],
): DeliveryOutput =>
  deliveryOutputSchema.parse({
    ...pullRequest,
    outcome: repair === null ? 'accepted' : 'repair_required',
    ci,
    repair,
  });

export class PullRequestDeliveryAdapter implements IntegrationStepAdapter {
  public readonly id = 'delivery.pull-request@1';

  public constructor(
    private readonly pullRequests: Pick<BitbucketPullRequestAdapter, 'executeDraft'>,
    private readonly ci: Pick<JenkinsBuildObserverAdapter, 'execute'>,
    private readonly jira: Pick<JiraReviewReadyAdapter, 'executeForPullRequest'> | null,
  ) {}

  public async execute(
    request: IntegrationStepExecutionRequest,
  ): Promise<IntegrationStepExecutionResult> {
    const preparedDraft = await readPullRequestDraft(request);
    if (!preparedDraft.ok) {
      return {
        status: 'blocked',
        kind: 'configuration',
        summary: 'Delivery requires the agent-authored pull-request draft',
        details: { path: '.tasker/pull-request/draft.json', reason: preparedDraft.reason },
        artifactIds: [],
      };
    }
    const draft = preparedDraft.draft;

    const published = await this.pullRequests.executeDraft(request, draft);
    if (published.status !== 'completed') return published;
    let artifactIds = [...published.artifactIds];
    const parsedPullRequest = pullRequestOutputSchema.safeParse(published.output);
    if (!parsedPullRequest.success) {
      return invalidOutput(
        'Pull-request publication',
        parsedPullRequest.error.issues.map((issue) => issue.message),
        artifactIds,
      );
    }
    const pullRequest = parsedPullRequest.data;

    const observed = await this.ci.execute(request);
    if (observed.status !== 'completed') return relay(observed, artifactIds);
    artifactIds = [...combineArtifacts(artifactIds, observed.artifactIds)];
    const parsedCi = ciObservationOutputSchema.safeParse(observed.output);
    if (!parsedCi.success) {
      return invalidOutput(
        'Jenkins observation',
        parsedCi.error.issues.map((issue) => issue.message),
        artifactIds,
      );
    }
    const ci = parsedCi.data;
    if (ci.status === 'likely_caused_by_change') {
      return {
        status: 'completed',
        summary: `Jenkins build #${String(ci.build.number)} requires a task repair`,
        output: deliveryOutput(pullRequest, ci, {
          kind: 'ci',
          summary: `Jenkins build #${String(ci.build.number)} classified the failure as task-caused`,
        }),
        artifactIds,
      };
    }
    const ciWait = this.ciWait(ci, pullRequest, artifactIds);
    if (ciWait !== null) return ciWait;

    const resolution = ReviewResolutionSchema.safeParse(request.waitResolution);
    const review = latestReview(request.evidence.reviewInputs);
    const decision = resolution.success ? resolution.data.decision : review?.snapshot.decision;
    if (decision === 'approved') {
      return {
        status: 'completed',
        summary: `Pull request ${pullRequest.externalId} passed CI and human review`,
        output: deliveryOutput(pullRequest, ci, null),
        artifactIds,
      };
    }
    if (decision === 'changes_requested') {
      return {
        status: 'completed',
        summary: `Pull request ${pullRequest.externalId} has actionable human review feedback`,
        output: deliveryOutput(pullRequest, ci, {
          kind: 'human_review',
          reviewId: resolution.success ? resolution.data.reviewId : (review?.reviewId ?? 'unknown'),
          summary: 'Address the actionable human review findings on the same pull request',
        }),
        artifactIds,
      };
    }

    if (request.task.origin === 'jira' && !reviewReadyWasPublished(request)) {
      if (this.jira === null) {
        return {
          status: 'blocked',
          kind: 'configuration',
          summary: 'Jira review-ready operation is not configured',
          details: waitingDetails('jira_review_ready', pullRequest),
          artifactIds,
        };
      }
      const reviewReady = await this.jira.executeForPullRequest(request, pullRequest);
      if (reviewReady.status !== 'completed') return relay(reviewReady, artifactIds);
      artifactIds = [...combineArtifacts(artifactIds, reviewReady.artifactIds)];
    }
    return {
      status: 'waiting',
      waitKind: 'code_review@1',
      summary: `Pull request ${pullRequest.externalId} passed CI and is waiting for human review`,
      category: 'dependency',
      retryable: false,
      details: waitingDetails('human_review', pullRequest),
      artifactIds,
    };
  }

  private ciWait(
    ci: CiObservationOutput,
    pullRequest: PullRequestOutput,
    artifactIds: readonly string[],
  ): IntegrationStepExecutionResult | null {
    if (ci.status === 'passed') return null;
    const waitKind =
      ci.status === 'likely_flaky'
        ? 'ci_retry@1'
        : ci.status === 'infrastructure'
          ? 'ci_infrastructure@1'
          : 'ci_unknown@1';
    return {
      status: 'waiting',
      waitKind,
      summary: `Jenkins build #${String(ci.build.number)} requires ${ci.status.replaceAll('_', ' ')}`,
      category: 'infrastructure',
      retryable: true,
      details: waitingDetails('ci', pullRequest, { ci: JsonValueSchema.parse(ci) }),
      artifactIds,
    };
  }
}
