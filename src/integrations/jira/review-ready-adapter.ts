import { z } from 'zod';

import { pullRequestOutputSchema } from '../../harness/step-definitions.js';
import { JsonValueSchema, type JsonValue } from '../../workflow/schema.js';
import type {
  IntegrationStepAdapter,
  IntegrationStepExecutionRequest,
  IntegrationStepExecutionResult,
} from '../execution.js';
import type { ExternalEffectStore, ExternalEffectStoreError } from '../effects.js';
import { JiraIssueKeySchema, type JiraIssueKey } from './contracts.js';
import {
  jiraLifecyclePolicyConfiguration,
  preflightJiraTransition,
  sameJiraValue,
  type JiraLifecycleIssue,
  type JiraLifecyclePort,
  type JiraLifecycleProblem,
  type JiraLifecycleTransition,
} from './lifecycle.js';

type BlockedIntegrationResult = Extract<
  IntegrationStepExecutionResult,
  { readonly status: 'blocked' }
>;

const blocked = (
  kind: BlockedIntegrationResult['kind'],
  summary: string,
  details: JsonValue,
  artifactIds: readonly string[] = [],
): BlockedIntegrationResult => ({ status: 'blocked', kind, summary, details, artifactIds });

const journalFailure = (
  error: ExternalEffectStoreError,
  artifactIds: readonly string[],
): BlockedIntegrationResult =>
  blocked(
    'unknown_outcome',
    `Jira review-ready journal is unavailable: ${error.kind}`,
    JsonValueSchema.parse(error),
    artifactIds,
  );

const problemResult = (
  problem: JiraLifecycleProblem,
  artifactIds: readonly string[],
  unknownOutcome = false,
): BlockedIntegrationResult =>
  blocked(
    unknownOutcome
      ? 'unknown_outcome'
      : problem.kind === 'access_blocked' || problem.kind === 'unavailable'
        ? 'infrastructure'
        : problem.kind === 'auth_failed'
          ? 'configuration'
          : 'invalid_request',
    problem.message,
    JsonValueSchema.parse(problem),
    artifactIds,
  );

const statusIndex = (path: readonly string[], status: string): number =>
  path.findIndex((candidate) => sameJiraValue(candidate, status));

const pullRequestFrom = (request: IntegrationStepExecutionRequest) => {
  for (let index = request.evidence.completedSteps.length - 1; index >= 0; index -= 1) {
    const completed = request.evidence.completedSteps[index];
    if (completed?.stepReference !== 'pr.prepare@1' || completed.status !== 'completed') continue;
    const parsed = z.object({ output: pullRequestOutputSchema }).safeParse(completed.details);
    if (parsed.success) return parsed.data.output;
  }
  return null;
};

const transitionReceipt = (
  issueKey: JiraIssueKey,
  fromStatus: string,
  toStatus: string,
  transitionId: string,
): JsonValue => ({ issueKey, fromStatus, toStatus, transitionId });

const commentReceipt = (
  issueKey: JiraIssueKey,
  commentId: string,
  pullRequestUrl: string,
): JsonValue => ({ issueKey, commentId, pullRequestUrl });

export class JiraReviewReadyAdapter implements IntegrationStepAdapter {
  public readonly id = 'jira.review-ready@1';

  public constructor(
    private readonly jira: JiraLifecyclePort,
    private readonly effects: ExternalEffectStore,
  ) {}

  public async execute(
    request: IntegrationStepExecutionRequest,
  ): Promise<IntegrationStepExecutionResult> {
    const configured = jiraLifecyclePolicyConfiguration(request);
    if (!configured.success) {
      return blocked('configuration', 'Jira lifecycle policy is missing or invalid', {
        issues: configured.error.issues.map((issue) => issue.message),
      });
    }
    if (request.task.origin !== 'jira') {
      return blocked('invalid_request', 'Jira review-ready cannot run for a non-Jira task', {
        taskOrigin: request.task.origin,
      });
    }
    const issueKey = JiraIssueKeySchema.safeParse(request.task.taskId);
    if (!issueKey.success) {
      return blocked('invalid_request', 'Task does not carry a valid Jira issue key', {
        taskId: request.task.taskId,
      });
    }
    const pullRequest = pullRequestFrom(request);
    if (pullRequest?.url === null || pullRequest === null) {
      return blocked(
        'verification',
        'A durable pull-request URL is required before Jira can enter code review',
        { taskId: request.task.taskId },
      );
    }

    const artifactIds: string[] = [];
    const observation = await this.jira.observeIssue(issueKey.data);
    if (observation.status === 'failed') return problemResult(observation.problem, artifactIds);
    const transitioned = await this.ensureTargetStatus(
      request,
      observation.issue,
      configured.data.reviewReady.statusPath,
      artifactIds,
    );
    if (transitioned.status === 'blocked') return transitioned;

    const commentBody = `${configured.data.reviewReady.commentPrefix}: [${pullRequest.externalId}|${pullRequest.url}]`;
    const commented = await this.ensurePullRequestComment(
      request,
      issueKey.data,
      pullRequest.url,
      configured.data.reviewReady.commentPrefix,
      commentBody,
      artifactIds,
    );
    if (commented.status === 'blocked') return commented;

    return {
      status: 'completed',
      summary: `Jira ${issueKey.data} is ready for review in ${transitioned.issue.status}`,
      output: { externalId: issueKey.data, status: transitioned.issue.status },
      artifactIds,
    };
  }

  private async ensureTargetStatus(
    request: IntegrationStepExecutionRequest,
    initialIssue: JiraLifecycleIssue,
    statusPath: readonly string[],
    artifactIds: string[],
  ): Promise<
    | { readonly status: 'transitioned'; readonly issue: JiraLifecycleIssue }
    | BlockedIntegrationResult
  > {
    const targetStatus = statusPath.at(-1);
    if (targetStatus === undefined) {
      return blocked('configuration', 'Jira review-ready status path is empty', {}, artifactIds);
    }
    let issue = initialIssue;
    while (!sameJiraValue(issue.status, targetStatus)) {
      const fromIndex = statusIndex(statusPath, issue.status);
      const toStatus = statusPath[fromIndex + 1];
      if (fromIndex < 0 || toStatus === undefined) {
        return blocked(
          'remote_conflict',
          `Jira status ${issue.status} cannot enter the configured review path`,
          { issueKey: issue.issueKey, status: issue.status, statusPath: [...statusPath] },
          artifactIds,
        );
      }
      const transitioned = await this.ensureTransition(
        request,
        issue,
        fromIndex,
        toStatus,
        statusPath,
        artifactIds,
      );
      if (transitioned.status === 'blocked') return transitioned;
      issue = transitioned.issue;
    }
    return { status: 'transitioned', issue };
  }

  private async ensureTransition(
    request: IntegrationStepExecutionRequest,
    issue: JiraLifecycleIssue,
    fromIndex: number,
    toStatus: string,
    statusPath: readonly string[],
    artifactIds: string[],
  ): Promise<
    | { readonly status: 'transitioned'; readonly issue: JiraLifecycleIssue }
    | BlockedIntegrationResult
  > {
    const effectId = `review-transition-${String(fromIndex)}-${String(fromIndex + 1)}`;
    let receipt = this.effects.readReceipt(request.operationId, effectId);
    if (!receipt.ok) return journalFailure(receipt.error, artifactIds);
    let selectedTransition: JiraLifecycleTransition | null = null;

    if (receipt.value === null) {
      const transitions = await this.jira.listTransitions(issue.issueKey);
      if (transitions.status === 'failed') return problemResult(transitions.problem, artifactIds);
      const matches = transitions.transitions.filter((candidate) =>
        sameJiraValue(candidate.toStatus, toStatus),
      );
      if (matches.length !== 1 || matches[0] === undefined) {
        return blocked(
          'invalid_request',
          `Jira exposes ${String(matches.length)} transitions from ${issue.status} to ${toStatus}`,
          {
            issueKey: issue.issueKey,
            availableTransitions: transitions.transitions.map(({ id, name, toStatus: target }) => ({
              id,
              name,
              toStatus: target,
            })),
          },
          artifactIds,
        );
      }
      selectedTransition = matches[0];
      const preflight = await this.preflightTransition(
        issue.issueKey,
        selectedTransition,
        artifactIds,
      );
      if (preflight !== null) return preflight;

      const prepared = this.effects.prepare({
        operationId: request.operationId,
        effectId,
        effectKind: 'jira.issue.transition',
        identity: { issueKey: issue.issueKey, fromStatus: issue.status, toStatus },
      });
      if (!prepared.ok) return journalFailure(prepared.error, artifactIds);
      artifactIds.push(this.effects.intentArtifactId(request.operationId, effectId));
      receipt = this.effects.readReceipt(request.operationId, effectId);
      if (!receipt.ok) return journalFailure(receipt.error, artifactIds);
    }

    if (receipt.value === null) {
      if (selectedTransition === null) {
        return blocked('unknown_outcome', 'Jira transition selection was lost before mutation', {
          issueKey: issue.issueKey,
          toStatus,
        });
      }
      const mutation = await this.jira.transition(issue.issueKey, selectedTransition.id);
      if (
        mutation.status === 'failed' &&
        mutation.problem.kind !== 'unavailable' &&
        mutation.problem.kind !== 'invalid_response'
      ) {
        return problemResult(mutation.problem, artifactIds);
      }
      const observed = await this.jira.observeIssue(issue.issueKey);
      const reached =
        observed.status === 'observed' &&
        statusIndex(statusPath, observed.issue.status) >= fromIndex + 1;
      if (!reached) {
        return mutation.status === 'failed'
          ? problemResult(mutation.problem, artifactIds, true)
          : blocked(
              'unknown_outcome',
              `Jira accepted the transition but ${toStatus} could not be confirmed`,
              { issueKey: issue.issueKey, transitionId: selectedTransition.id, toStatus },
              artifactIds,
            );
      }
      const applied = this.effects.recordApplied({
        operationId: request.operationId,
        effectId,
        effectKind: 'jira.issue.transition',
        result: transitionReceipt(issue.issueKey, issue.status, toStatus, selectedTransition.id),
      });
      if (!applied.ok) return journalFailure(applied.error, artifactIds);
      artifactIds.push(this.effects.receiptArtifactId(request.operationId, effectId));
      return { status: 'transitioned', issue: observed.issue };
    }

    artifactIds.push(this.effects.receiptArtifactId(request.operationId, effectId));
    const observed = await this.jira.observeIssue(issue.issueKey);
    if (observed.status === 'failed') return problemResult(observed.problem, artifactIds, true);
    if (statusIndex(statusPath, observed.issue.status) < fromIndex + 1) {
      return blocked(
        'remote_conflict',
        'Jira status no longer matches the recorded review transition',
        { issueKey: issue.issueKey, status: observed.issue.status, expectedAtLeast: toStatus },
        artifactIds,
      );
    }
    return { status: 'transitioned', issue: observed.issue };
  }

  private async preflightTransition(
    issueKey: JiraIssueKey,
    transition: JiraLifecycleTransition,
    artifactIds: readonly string[],
  ): Promise<BlockedIntegrationResult | null> {
    const preflight = await preflightJiraTransition(this.jira, issueKey, transition);
    if (preflight.status === 'failed') return problemResult(preflight.problem, artifactIds);
    if (preflight.status === 'ready') return null;

    return blocked(
      'invalid_request',
      `Jira requires fields before ${transition.name} can run: ${preflight.fields
        .map(({ name }) => name)
        .join(', ')}`,
      {
        issueKey,
        transitionId: transition.id,
        transitionName: transition.name,
        toStatus: transition.toStatus,
        missingFields: preflight.fields.map(({ id, name, operations }) => ({
          id,
          name,
          operations: [...operations],
        })),
      },
      artifactIds,
    );
  }

  private async ensurePullRequestComment(
    request: IntegrationStepExecutionRequest,
    issueKey: JiraIssueKey,
    pullRequestUrl: string,
    commentPrefix: string,
    body: string,
    artifactIds: string[],
  ): Promise<{ readonly status: 'commented' } | BlockedIntegrationResult> {
    const effectId = 'publish-pull-request-comment';
    const prepared = this.effects.prepare({
      operationId: request.operationId,
      effectId,
      effectKind: 'jira.issue.comment',
      identity: { issueKey, pullRequestUrl, body },
    });
    if (!prepared.ok) return journalFailure(prepared.error, artifactIds);
    artifactIds.push(this.effects.intentArtifactId(request.operationId, effectId));
    const receipt = this.effects.readReceipt(request.operationId, effectId);
    if (!receipt.ok) return journalFailure(receipt.error, artifactIds);

    const before = await this.jira.listComments(issueKey);
    if (before.status === 'failed') {
      return problemResult(before.problem, artifactIds, receipt.value !== null);
    }
    const managedPrefix = `${commentPrefix}:`;
    const managedComments = before.comments.filter((comment) =>
      comment.body.trimStart().startsWith(managedPrefix),
    );
    if (managedComments.length > 1) {
      return blocked(
        'remote_conflict',
        'Jira contains multiple Tasker-managed pull-request comments',
        {
          issueKey,
          commentPrefix,
          commentIds: managedComments.map(({ id }) => id),
        },
        artifactIds,
      );
    }
    const existing = before.comments.find((comment) => comment.body.includes(pullRequestUrl));
    if (receipt.value !== null) {
      if (existing === undefined) {
        return blocked(
          'remote_conflict',
          'The Jira pull-request comment no longer matches its recorded receipt',
          { issueKey, pullRequestUrl },
          artifactIds,
        );
      }
      artifactIds.push(this.effects.receiptArtifactId(request.operationId, effectId));
      return { status: 'commented' };
    }

    let confirmed = existing;
    if (confirmed === undefined) {
      const previousManagedComment = managedComments[0];
      const mutation =
        previousManagedComment === undefined
          ? await this.jira.comment(issueKey, body)
          : await this.jira.updateComment(issueKey, previousManagedComment.id, body);
      if (
        mutation.status === 'failed' &&
        mutation.problem.kind !== 'unavailable' &&
        mutation.problem.kind !== 'invalid_response'
      ) {
        return problemResult(mutation.problem, artifactIds);
      }
      const after = await this.jira.listComments(issueKey);
      if (after.status === 'failed') return problemResult(after.problem, artifactIds, true);
      const managedAfter = after.comments.filter((comment) =>
        comment.body.trimStart().startsWith(managedPrefix),
      );
      if (managedAfter.length > 1) {
        return blocked(
          'remote_conflict',
          'Jira contains multiple Tasker-managed pull-request comments after mutation',
          {
            issueKey,
            commentPrefix,
            commentIds: managedAfter.map(({ id }) => id),
          },
          artifactIds,
        );
      }
      confirmed = managedAfter.find((comment) => comment.body.includes(pullRequestUrl));
      if (confirmed === undefined) {
        return mutation.status === 'failed'
          ? problemResult(mutation.problem, artifactIds, true)
          : blocked(
              'unknown_outcome',
              'Jira accepted the pull-request comment but it could not be confirmed',
              { issueKey, pullRequestUrl },
              artifactIds,
            );
      }
      if (previousManagedComment !== undefined && confirmed.id !== previousManagedComment.id) {
        return blocked(
          'remote_conflict',
          'Jira did not preserve the managed pull-request comment identity',
          {
            issueKey,
            expectedCommentId: previousManagedComment.id,
            observedCommentId: confirmed.id,
          },
          artifactIds,
        );
      }
    }

    const applied = this.effects.recordApplied({
      operationId: request.operationId,
      effectId,
      effectKind: 'jira.issue.comment',
      result: commentReceipt(issueKey, confirmed.id, pullRequestUrl),
    });
    if (!applied.ok) return journalFailure(applied.error, artifactIds);
    artifactIds.push(this.effects.receiptArtifactId(request.operationId, effectId));
    return { status: 'commented' };
  }
}
