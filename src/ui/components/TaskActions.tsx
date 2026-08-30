import { useState } from 'react';

import { Button } from './ui/button.js';
import type {
  ExecutionRunView,
  OperatorTaskSummary,
  OperatorWorkflowProjection,
} from '../../server/operator-contracts.js';
import {
  approveTaskPlan,
  requestTaskPlanChanges,
  restartTaskWorkflow,
  resumeTaskWorkflow,
} from '../api/index.js';
import { useWorkflowAction } from '../useWorkflowAction.js';

const dedicatedWaitKinds = new Set([
  'human_clarification',
  'plan.approved@1',
  'workflow_change.review@1',
  'code_review@1',
  'dependency.available@1',
  'dependency.discovery@1',
  'research.document-review@1',
]);

export type TaskActionAvailability = {
  readonly resume: boolean;
  readonly planReview: boolean;
  readonly restart: boolean;
};

export type TaskActionName = 'resume' | 'approve' | 'requestChanges' | 'restart';

export const invokeTaskAction = (
  action: TaskActionName,
  callbacks: Readonly<Record<TaskActionName, () => void>>,
): void => {
  callbacks[action]();
};

export const getTaskActionAvailability = (
  projection: OperatorWorkflowProjection,
  currentRun: ExecutionRunView | null,
): TaskActionAvailability => ({
  resume:
    projection.current?.status === 'waiting' &&
    !dedicatedWaitKinds.has(projection.current.waitKind),
  planReview:
    currentRun?.runtime === 'bootstrap' &&
    currentRun.status === 'waiting' &&
    currentRun.wait.waitKind === 'plan.approved@1' &&
    currentRun.planning?.status === 'ready',
  restart: currentRun !== null && currentRun.status !== 'completed',
});

export type TaskActionsProps = {
  readonly task: OperatorTaskSummary;
  readonly projection: OperatorWorkflowProjection;
  readonly currentRun: ExecutionRunView | null;
};

export const TaskActions = ({ task, projection, currentRun }: TaskActionsProps) => {
  const [guidance, setGuidance] = useState('');
  const [restartConfirming, setRestartConfirming] = useState(false);
  const availability = getTaskActionAvailability(projection, currentRun);
  const trimmedGuidance = guidance.trim();

  const resume = useWorkflowAction(task, 'Resuming workflow', () => {
    if (currentRun === null) return Promise.reject(new Error('The active run is unavailable'));
    return resumeTaskWorkflow(
      task.id,
      trimmedGuidance.length === 0
        ? { expectedRunId: currentRun.runId }
        : { expectedRunId: currentRun.runId, guidance: trimmedGuidance },
    );
  });
  const approve = useWorkflowAction(task, 'Applying plan approval', () => {
    if (currentRun?.runtime !== 'bootstrap' || currentRun.planning?.status !== 'ready') {
      return Promise.reject(new Error('The current plan is unavailable'));
    }
    return approveTaskPlan(task.id, {
      expectedRunId: currentRun.runId,
      reviewId: crypto.randomUUID(),
      planArtifactId: currentRun.planning.artifactId,
      planAttempt: currentRun.planning.attempt,
      decision: 'approve',
    });
  });
  const requestChanges = useWorkflowAction(task, 'Sending plan feedback', () => {
    if (currentRun?.runtime !== 'bootstrap' || currentRun.planning?.status !== 'ready') {
      return Promise.reject(new Error('The current plan is unavailable'));
    }
    return requestTaskPlanChanges(task.id, {
      expectedRunId: currentRun.runId,
      reviewId: crypto.randomUUID(),
      planArtifactId: currentRun.planning.artifactId,
      planAttempt: currentRun.planning.attempt,
      decision: 'request_changes',
      guidance: trimmedGuidance,
      annotations: [],
    });
  });
  const restart = useWorkflowAction(task, 'Restarting workflow', () => {
    if (currentRun === null) return Promise.reject(new Error('The active run is unavailable'));
    return restartTaskWorkflow(task.id, {
      expectedRunId: currentRun.runId,
      confirmation: 'restart_from_scratch',
    });
  });

  const busy =
    resume.isPending || approve.isPending || requestChanges.isPending || restart.isPending;
  const error = resume.error ?? approve.error ?? requestChanges.error ?? restart.error;
  const callbacks = {
    resume: () => {
      resume.mutate(undefined);
    },
    approve: () => {
      approve.mutate(undefined);
    },
    requestChanges: () => {
      requestChanges.mutate(undefined);
    },
    restart: () => {
      restart.mutate(undefined);
    },
  } satisfies Readonly<Record<TaskActionName, () => void>>;
  if (!availability.resume && !availability.planReview && !availability.restart) return null;

  return (
    <section aria-label="Task actions" className="rounded-xl border bg-card p-4">
      <div className="flex flex-wrap items-center gap-2">
        {availability.resume ? (
          <Button
            disabled={busy}
            type="button"
            onClick={() => {
              invokeTaskAction('resume', callbacks);
            }}
          >
            {resume.isPending ? 'Resuming…' : 'Resume'}
          </Button>
        ) : null}
        {availability.planReview ? (
          <>
            <Button
              disabled={busy}
              type="button"
              onClick={() => {
                invokeTaskAction('approve', callbacks);
              }}
            >
              {approve.isPending ? 'Approving…' : 'Approve plan'}
            </Button>
            <Button
              disabled={busy || trimmedGuidance.length === 0}
              type="button"
              variant="outline"
              onClick={() => {
                invokeTaskAction('requestChanges', callbacks);
              }}
            >
              {requestChanges.isPending ? 'Sending…' : 'Request changes'}
            </Button>
          </>
        ) : null}
        {availability.restart ? (
          restartConfirming ? (
            <>
              <Button
                disabled={busy}
                type="button"
                variant="destructive"
                onClick={() => {
                  invokeTaskAction('restart', callbacks);
                }}
              >
                {restart.isPending ? 'Restarting…' : 'Confirm restart'}
              </Button>
              <Button
                disabled={busy}
                type="button"
                variant="ghost"
                onClick={() => {
                  setRestartConfirming(false);
                }}
              >
                Cancel
              </Button>
            </>
          ) : (
            <Button
              disabled={busy}
              type="button"
              variant="ghost"
              onClick={() => {
                setRestartConfirming(true);
              }}
            >
              Restart
            </Button>
          )
        ) : null}
      </div>
      {availability.resume || availability.planReview ? (
        <textarea
          aria-label={availability.planReview ? 'Plan review guidance' : 'Resume guidance'}
          className="mt-3 min-h-20 w-full resize-y"
          disabled={busy}
          maxLength={10_000}
          placeholder={
            availability.planReview
              ? 'Describe the changes the plan needs'
              : 'Optional guidance for the next attempt'
          }
          value={guidance}
          onChange={(event) => {
            setGuidance(event.target.value);
          }}
        />
      ) : null}
      {error === null ? null : <p className="mt-2 text-sm text-destructive">{error.message}</p>}
    </section>
  );
};
