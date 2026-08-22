import { z } from 'zod';

import {
  ciObservationOutputSchema,
  pullRequestOutputSchema,
} from '../../harness/step-contracts.js';
import { ImplementationPlanSchema } from '../../planning/implementation-plan.js';
import { JsonValueSchema, type JsonValue } from '../../workflow/schema.js';
import { WorkflowChangeRequestSchema } from '../../workflow/execution-result.js';
import type { BitbucketPullRequestAdapter } from '../bitbucket/pull-request-adapter.js';
import type { PullRequestReviewEvidence } from '../bitbucket/review.js';
import type {
  IntegrationStepAdapter,
  IntegrationStepExecutionRequest,
  IntegrationStepExecutionResult,
} from '../execution.js';
import type { JenkinsBuildObserverAdapter } from '../jenkins/build-observer-adapter.js';
import type { JiraReviewReadyAdapter } from '../jira/review-ready-adapter.js';
import { PullRequestDraftSchema, type PullRequestDraft } from '../pull-request-draft.js';

const AcceptedPlanArtifactSchema = z
  .object({
    plan: ImplementationPlanSchema,
  })
  .loose();

const ReviewResolutionSchema = z
  .object({
    decision: z.enum(['approved', 'changes_requested']),
    reviewId: z.string().min(1),
  })
  .loose();

type PullRequestOutput = z.infer<typeof pullRequestOutputSchema>;
type CiObservationOutput = z.infer<typeof ciObservationOutputSchema>;

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

const pullRequestDraft = (request: IntegrationStepExecutionRequest): PullRequestDraft | null => {
  const accepted = AcceptedPlanArtifactSchema.safeParse(request.evidence.acceptedPlan);
  const gitPolicy = request.project?.git;
  if (!accepted.success || gitPolicy === undefined) return null;
  const plan = accepted.data.plan;
  const description = [
    plan.summary,
    '',
    '## Implementation plan',
    ...plan.steps.map((step) => `- **${step.title}** — ${step.objective}`),
    '',
    '## Acceptance',
    ...plan.acceptanceCriteria.map((criterion) => `- ${criterion.expected}`),
  ].join('\n');
  const commit =
    gitPolicy.commit.kind === 'task_key_subject'
      ? ({ kind: 'subject', subject: plan.title } as const)
      : ({
          kind: 'conventional',
          type:
            request.task.kind === 'bug' && gitPolicy.commit.allowedTypes.includes('fix')
              ? 'fix'
              : (gitPolicy.commit.allowedTypes[0] ?? 'chore'),
          scope: null,
          subject: plan.title,
        } as const);
  const parsed = PullRequestDraftSchema.safeParse({
    title: `${request.task.taskId}: ${request.task.title}`,
    description,
    commit,
    branchArtifacts: [],
  });
  return parsed.success ? parsed.data : null;
};

const latestReview = (
  reviews: readonly PullRequestReviewEvidence[],
): PullRequestReviewEvidence | null => reviews.at(-1) ?? null;

const waitingDetails = (
  phase: string,
  pullRequest: PullRequestOutput,
  extra: Readonly<Record<string, JsonValue>> = {},
): JsonValue => JsonValueSchema.parse({ phase, output: pullRequest, ...extra });

const continuationRequest = (
  request: IntegrationStepExecutionRequest,
  summary: string,
  objective: string,
  artifactIds: readonly string[],
) =>
  WorkflowChangeRequestSchema.parse({
    schemaVersion: 1,
    discoveredAtNodeId: request.nodeId,
    summary,
    evidenceArtifactIds: [...artifactIds],
    changes: [{ kind: 'task_scope_changed', objective }],
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
    const draft = pullRequestDraft(request);
    if (draft === null) {
      return {
        status: 'blocked',
        kind: 'configuration',
        summary: 'Delivery requires an accepted plan and snapshotted project Git policy',
        details: {
          acceptedPlan: request.evidence.acceptedPlan !== null,
          projectConfigured: request.project !== null,
        },
        artifactIds: [],
      };
    }

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
    const ciWait = this.ciWait(request, ci, pullRequest, artifactIds);
    if (ciWait !== null) return ciWait;

    if (request.task.origin === 'jira') {
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

    const resolution = ReviewResolutionSchema.safeParse(request.waitResolution);
    const review = latestReview(request.evidence.reviewInputs);
    const decision = resolution.success ? resolution.data.decision : review?.snapshot.decision;
    if (decision === 'approved') {
      return {
        status: 'completed',
        summary: `Pull request ${pullRequest.externalId} passed CI and human review`,
        output: pullRequest,
        artifactIds,
      };
    }
    if (decision === 'changes_requested') {
      return {
        status: 'continuation_required',
        summary: `Pull request ${pullRequest.externalId} has actionable human review feedback`,
        request: continuationRequest(
          request,
          `Human review ${resolution.success ? resolution.data.reviewId : (review?.reviewId ?? 'unknown')} requested changes`,
          'Address the actionable human review findings, re-run acceptance verification and independent review, then update the same pull request.',
          artifactIds,
        ),
        artifactIds,
      };
    }
    return {
      status: 'waiting',
      waitKind: 'code_review@1',
      summary: `Pull request ${pullRequest.externalId} passed CI and is waiting for human review`,
      details: waitingDetails('human_review', pullRequest),
      artifactIds,
    };
  }

  private ciWait(
    request: IntegrationStepExecutionRequest,
    ci: CiObservationOutput,
    pullRequest: PullRequestOutput,
    artifactIds: readonly string[],
  ): IntegrationStepExecutionResult | null {
    if (ci.status === 'passed') return null;
    if (ci.status === 'likely_caused_by_change') {
      return {
        status: 'continuation_required',
        summary: `Jenkins build #${String(ci.build.number)} failed because of the task change`,
        request: continuationRequest(
          request,
          `Jenkins build #${String(ci.build.number)} classified the failure as task-caused`,
          'Repair the exact CI failure, re-run acceptance verification and independent review, then update the same pull request.',
          artifactIds,
        ),
        artifactIds,
      };
    }
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
      details: waitingDetails('ci', pullRequest, { ci: JsonValueSchema.parse(ci) }),
      artifactIds,
    };
  }
}
