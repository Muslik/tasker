import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type {
  ExecutionRunView,
  OperatorTaskSummary,
  OperatorWorkflowContinuation,
  OperatorWorkflowProjection,
} from '../../server/operator-contracts.js';
import { invalidateTaskQueries } from '../api/query.js';
import {
  answerPlanningClarification,
  completeCodeReview,
  implementationPlanQueryOptions,
  planReviewHistoryQueryOptions,
  reviewPlan,
  reviewWorkflowChange,
  retrospectiveQueryOptions,
  retrospectivePatternsQueryOptions,
  setRetrospectiveProposalStatus,
  resumeTaskWorkflow,
  syncCodeReview,
} from '../api/index.js';
import type { PlanReviewAnnotationInput } from '../lib/plan-review-feedback.js';
import { CodeReviewControls, codeReviewNotice } from './CodeReviewControls.js';
import { DependencyWaitSurface } from './DependencyWaitSurface.js';
import { PlanReviewSurface } from './PlanReviewSurface.js';
import { PlanningClarificationSurface } from './PlanningClarificationSurface.js';
import { ResearchDocumentReviewSurface } from './ResearchDocumentReviewSurface.js';
import { RetrospectiveSurface } from './RetrospectiveSurface.js';
import { useDependencyMutation } from './taskOperatorMutations.js';
import { WorkflowChangeReview } from './WorkflowChangeReview.js';

export const TaskOperatorSurfaces = ({
  task,
  projection,
  currentRun,
}: {
  readonly task: OperatorTaskSummary;
  readonly projection: OperatorWorkflowProjection;
  readonly currentRun: ExecutionRunView | null;
}) => {
  const queryClient = useQueryClient();
  const plan = useQuery(implementationPlanQueryOptions(task.id));
  const history = useQuery(planReviewHistoryQueryOptions(task.id));
  const retrospective = useQuery({
    ...retrospectiveQueryOptions(task.id),
    enabled: task.status === 'done',
  });
  const retrospectivePatterns = useQuery({
    ...retrospectivePatternsQueryOptions(),
    enabled: task.status === 'done',
  });
  const settle = () => {
    invalidateTaskQueries(queryClient, task.id, { includeRunLog: true, includeAttempts: true });
  };
  const proposalMutation = useMutation({
    mutationFn: ({
      proposalId,
      status,
    }: {
      proposalId: string;
      status: 'approved' | 'dismissed';
    }) => setRetrospectiveProposalStatus(task.id, proposalId, status),
    onSettled: settle,
  });
  const planMutation = useMutation({
    mutationFn: ({
      decision,
      guidance,
      annotations,
    }: {
      decision: 'approve' | 'request_changes';
      guidance: string;
      annotations: readonly PlanReviewAnnotationInput[];
    }) => {
      if (currentRun?.runtime !== 'bootstrap' || currentRun.planning?.status !== 'ready')
        throw new Error('The current plan is unavailable');
      if (decision === 'request_changes')
        return reviewPlan(task.id, {
          expectedRunId: currentRun.runId,
          reviewId: crypto.randomUUID(),
          planArtifactId: currentRun.planning.artifactId,
          planAttempt: currentRun.planning.attempt,
          decision: 'request_changes',
          ...(guidance.trim().length === 0 ? {} : { guidance: guidance.trim() }),
          annotations: [...annotations],
        });
      return reviewPlan(task.id, {
        expectedRunId: currentRun.runId,
        reviewId: crypto.randomUUID(),
        planArtifactId: currentRun.planning.artifactId,
        planAttempt: currentRun.planning.attempt,
        decision: 'approve',
      });
    },
    onSettled: settle,
  });
  const clarificationMutation = useMutation({
    mutationFn: (answers: readonly { questionId: string; answer: string }[]) => {
      if (currentRun?.runtime !== 'bootstrap' || currentRun.wait === null)
        throw new Error('Planning clarification is unavailable');
      return answerPlanningClarification(task.id, {
        expectedRunId: currentRun.runId,
        answers: [...answers],
      });
    },
    onSettled: settle,
  });
  const codeReviewMutation = useMutation({
    mutationFn: (action: 'sync' | 'complete') => {
      if (currentRun === null) throw new Error('The active run is unavailable');
      return action === 'sync'
        ? syncCodeReview(task.id, { expectedRunId: currentRun.runId })
        : completeCodeReview(task.id, { expectedRunId: currentRun.runId });
    },
    onSettled: settle,
  });
  const continuationMutation = useMutation({
    mutationFn: ({
      decision,
      guidance,
    }: {
      decision: 'accept' | 'reject' | 'dismiss';
      guidance?: string;
    }) => {
      if (currentRun === null || currentRun.status !== 'waiting')
        throw new Error('The active run is unavailable');
      if (decision === 'dismiss')
        return resumeTaskWorkflow(task.id, {
          expectedRunId: currentRun.runId,
          dismissWorkflowChange: true,
          guidance: guidance ?? 'Dismissed by operator',
        });
      const continuation = projection.continuations.find(
        (item) => item.status === 'awaiting_review',
      ) as (OperatorWorkflowContinuation & { readonly status: 'awaiting_review' }) | undefined;
      if (continuation === undefined) throw new Error('No workflow change is awaiting review');
      if (decision === 'reject')
        return reviewWorkflowChange(task.id, {
          expectedRunId: currentRun.runId,
          continuationId: continuation.continuationId,
          decision,
          guidance: guidance ?? '',
        });
      return reviewWorkflowChange(task.id, {
        expectedRunId: currentRun.runId,
        continuationId: continuation.continuationId,
        decision: 'accept',
      });
    },
    onSettled: settle,
  });
  const dependencyMutation = useDependencyMutation({
    task,
    projection,
    currentRun,
    onSettled: settle,
  });
  const planRecord = plan.data?.status === 'ready' ? plan.data : null;
  const bootstrapRun = currentRun?.runtime === 'bootstrap' ? currentRun : null;
  const continuation = projection.continuations.find(
    (item) => item.status === 'awaiting_review',
  ) as (OperatorWorkflowContinuation & { readonly status: 'awaiting_review' }) | undefined;
  const typedAction =
    projection.current?.status === 'waiting' &&
    projection.current.intervention.kind === 'typed_resolution'
      ? projection.current.intervention
      : null;
  return (
    <div className="space-y-4">
      {bootstrapRun === null ? null : (
        <div id="planning-clarification-surface" tabIndex={-1} className="scroll-mt-24">
          <PlanningClarificationSurface
            run={bootstrapRun}
            pending={clarificationMutation.isPending}
            error={clarificationMutation.error}
            onSubmit={(answers) => {
              clarificationMutation.mutate(answers);
            }}
          />
        </div>
      )}
      {bootstrapRun === null ? null : (
        <div id="plan-review-surface" tabIndex={-1} className="scroll-mt-24">
          <PlanReviewSurface
            run={bootstrapRun}
            plan={planRecord}
            planPending={plan.isPending}
            planError={plan.error}
            onRetryPlan={() => {
              void plan.refetch();
            }}
            history={history.data ?? []}
            historyPending={history.isPending}
            historyError={history.error}
            onRetryHistory={() => {
              void history.refetch();
            }}
            pending={planMutation.isPending}
            error={planMutation.error}
            onReview={(decision, guidance, annotations) => {
              planMutation.mutate({ decision, guidance, annotations });
            }}
          />
        </div>
      )}
      {currentRun === null || continuation === undefined ? null : (
        <div id="workflow-change-review-surface" tabIndex={-1} className="scroll-mt-24">
          <WorkflowChangeReview
            run={currentRun}
            continuation={continuation}
            pending={continuationMutation.isPending}
            error={continuationMutation.error}
            onDecision={(decision, guidance) => {
              continuationMutation.mutate({
                decision,
                ...(guidance === undefined ? {} : { guidance }),
              });
            }}
          />
        </div>
      )}
      {currentRun === null ? null : (
        <div id="research-document-review-surface" tabIndex={-1} className="scroll-mt-24">
          <ResearchDocumentReviewSurface
            task={task}
            projection={projection}
            currentRun={currentRun}
          />
        </div>
      )}
      {currentRun === null ? null : (
        <div id="code-review-surface" tabIndex={-1} className="scroll-mt-24">
          <CodeReviewControls
            run={currentRun}
            notice={
              codeReviewMutation.data === undefined
                ? null
                : codeReviewNotice(codeReviewMutation.data)
            }
            pending={codeReviewMutation.isPending}
            error={codeReviewMutation.error}
            onSync={() => {
              codeReviewMutation.mutate('sync');
            }}
            onComplete={() => {
              codeReviewMutation.mutate('complete');
            }}
          />
        </div>
      )}
      {typedAction === null ? null : (
        <div id="dependency-wait-surface" tabIndex={-1} className="scroll-mt-24">
          <DependencyWaitSurface
            action={typedAction}
            pending={dependencyMutation.isPending}
            error={dependencyMutation.error}
            onAvailable={(versions, provenance) => {
              dependencyMutation.mutate({ available: true, versions, provenance });
            }}
            onDiscovery={(discovery) => {
              dependencyMutation.mutate({ available: false, discovery });
            }}
          />
        </div>
      )}
      {task.status === 'done' ? (
        <RetrospectiveSurface
          response={retrospective.data}
          {...(retrospectivePatterns.data === undefined
            ? {}
            : { patterns: retrospectivePatterns.data })}
          onProposalStatus={(proposalId, status) => {
            proposalMutation.mutate({ proposalId, status });
          }}
          proposalPending={proposalMutation.isPending}
          proposalError={proposalMutation.error}
          proposalErrorProposalId={proposalMutation.variables?.proposalId ?? null}
        />
      ) : null}
    </div>
  );
};
