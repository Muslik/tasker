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
  resolveDependencyAvailable,
  resolveDependencyDiscovery,
  retrospectiveQueryOptions,
  resumeTaskWorkflow,
  syncCodeReview,
} from '../api/index.js';
import { CodeReviewControls, codeReviewNotice } from './CodeReviewControls.js';
import { DependencyWaitSurface, parsePackageNames } from './DependencyWaitSurface.js';
import { PlanReviewSurface } from './PlanReviewSurface.js';
import { PlanningClarificationSurface } from './PlanningClarificationSurface.js';
import { RetrospectiveSurface } from './RetrospectiveSurface.js';
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
  const settle = () => {
    invalidateTaskQueries(queryClient, task.id, { includeRunLog: true, includeAttempts: true });
  };
  const planMutation = useMutation({
    mutationFn: ({
      decision,
      guidance,
    }: {
      decision: 'approve' | 'request_changes';
      guidance: string;
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
          guidance,
          annotations: [],
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
  const dependencyMutation = useMutation({
    mutationFn: ({
      available,
      versions,
      provenance,
      discovery,
    }: {
      available: boolean;
      versions?: ReadonlyMap<string, string>;
      provenance?: { postId: string; url: string };
      discovery?: {
        producerTaskReference: string;
        producerRepository: string;
        packages: string;
        mode: 'final_only';
      };
    }) => {
      if (
        currentRun?.runtime !== 'execution' ||
        currentRun.status !== 'waiting' ||
        projection.current?.status !== 'waiting'
      )
        throw new Error('The dependency wait is unavailable');
      const action = projection.current.intervention;
      if (action.kind !== 'typed_resolution' || action.details === null)
        throw new Error('The dependency wait is unavailable');
      if (available && action.details.kind === 'dependency_available' && versions !== undefined) {
        return resolveDependencyAvailable(task.id, {
          expectedRunId: currentRun.runId,
          nodeId: projection.current.nodeId,
          waitKind: 'dependency.available@1',
          declarationId: action.details.declarationId,
          declarationRevision: action.details.declarationRevision,
          channel: action.details.channel,
          packages: action.details.packages.map((name) => ({
            name,
            version: versions.get(name) ?? '',
          })),
          ...(provenance?.postId === undefined || provenance.postId.length === 0
            ? {}
            : {
                provenance: {
                  kind: 'loop' as const,
                  postId: provenance.postId,
                  ...(provenance.url.length === 0 ? {} : { url: provenance.url }),
                },
              }),
        });
      }
      if (!available && action.details.kind === 'dependency_discovery' && discovery !== undefined) {
        return resolveDependencyDiscovery(task.id, {
          expectedRunId: currentRun.runId,
          nodeId: projection.current.nodeId,
          waitKind: 'dependency.discovery@1',
          requestArtifactId: action.details.requestArtifactId,
          producerTaskReference: discovery.producerTaskReference,
          producerRepository: discovery.producerRepository,
          packages: [...parsePackageNames(discovery.packages)],
          mode: discovery.mode,
        });
      }
      throw new Error('The dependency form does not match the active wait');
    },
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
  const error =
    [
      planMutation.error,
      clarificationMutation.error,
      codeReviewMutation.error,
      continuationMutation.error,
      dependencyMutation.error,
    ].find((item): item is Error => item instanceof Error)?.message ?? null;
  return (
    <div className="space-y-4">
      {bootstrapRun === null ? null : (
        <PlanningClarificationSurface
          run={bootstrapRun}
          pending={clarificationMutation.isPending}
          error={clarificationMutation.error?.message ?? null}
          onSubmit={(answers) => {
            clarificationMutation.mutate(answers);
          }}
        />
      )}
      {bootstrapRun === null ? null : (
        <PlanReviewSurface
          run={bootstrapRun}
          plan={planRecord}
          history={history.data ?? []}
          pending={planMutation.isPending}
          error={planMutation.error?.message ?? null}
          onReview={(decision, guidance) => {
            planMutation.mutate({ decision, guidance });
          }}
        />
      )}
      {currentRun === null || continuation === undefined ? null : (
        <WorkflowChangeReview
          run={currentRun}
          continuation={continuation}
          pending={continuationMutation.isPending}
          error={continuationMutation.error?.message ?? null}
          onDecision={(decision, guidance) => {
            continuationMutation.mutate({
              decision,
              ...(guidance === undefined ? {} : { guidance }),
            });
          }}
        />
      )}
      {currentRun === null ? null : (
        <CodeReviewControls
          run={currentRun}
          notice={
            codeReviewMutation.data === undefined ? null : codeReviewNotice(codeReviewMutation.data)
          }
          pending={codeReviewMutation.isPending}
          error={codeReviewMutation.error?.message ?? null}
          onSync={() => {
            codeReviewMutation.mutate('sync');
          }}
          onComplete={() => {
            codeReviewMutation.mutate('complete');
          }}
        />
      )}
      {typedAction === null ? null : (
        <DependencyWaitSurface
          action={typedAction}
          pending={dependencyMutation.isPending}
          error={dependencyMutation.error?.message ?? null}
          onAvailable={(versions, provenance) => {
            dependencyMutation.mutate({ available: true, versions, provenance });
          }}
          onDiscovery={(discovery) => {
            dependencyMutation.mutate({ available: false, discovery });
          }}
        />
      )}
      {task.status === 'done' ? <RetrospectiveSurface response={retrospective.data} /> : null}
      {error === null ? null : (
        <p className="sr-only" role="alert">
          {error}
        </p>
      )}
    </div>
  );
};
