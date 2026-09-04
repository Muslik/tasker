import { useState } from 'react';

import { Button } from './ui/button.js';
import { Textarea } from './ui/textarea.js';
import { ActionAlert } from './ActionAlert.js';
import type {
  ExecutionRunView,
  OperatorTaskSummary,
  OperatorWorkflowProjection,
} from '../../server/operator-contracts.js';
import { restartTaskWorkflow, resumeTaskWorkflow } from '../api/index.js';
import { useWorkflowAction } from '../useWorkflowAction.js';
import { isDedicatedWaitKind } from './taskOperatorWaits.js';

export type TaskActionAvailability = {
  readonly resume: boolean;
  readonly restart: boolean;
};

export type TaskActionName = 'resume' | 'restart';

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
    projection.current?.status === 'waiting' && !isDedicatedWaitKind(projection.current.waitKind),
  restart: currentRun !== null && currentRun.status !== 'completed',
});

export type TaskActionsProps = {
  readonly task: OperatorTaskSummary;
  readonly projection: OperatorWorkflowProjection;
  readonly currentRun: ExecutionRunView | null;
  readonly onSettings?: () => void;
  readonly onRemove?: () => void;
  readonly compact?: boolean;
};

export const TaskActions = ({
  task,
  projection,
  currentRun,
  onSettings,
  onRemove,
  compact = false,
}: TaskActionsProps) => {
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
  const restart = useWorkflowAction(task, 'Restarting workflow', () => {
    if (currentRun === null) return Promise.reject(new Error('The active run is unavailable'));
    return restartTaskWorkflow(task.id, {
      expectedRunId: currentRun.runId,
      confirmation: 'restart_from_scratch',
    });
  });

  const busy = resume.isPending || restart.isPending;
  const error = resume.error ?? restart.error;
  const callbacks = {
    resume: () => {
      resume.mutate(undefined);
    },
    restart: () => {
      restart.mutate(undefined);
    },
  } satisfies Readonly<Record<TaskActionName, () => void>>;
  return (
    <div
      aria-label="Task actions"
      className={
        compact
          ? 'flex min-w-0 flex-1 flex-wrap items-center gap-2'
          : 'flex flex-wrap items-center justify-end gap-2'
      }
    >
      {compact && availability.resume ? (
        <Textarea
          aria-label="Resume guidance"
          className="min-h-8 min-w-48 flex-1 resize-none py-1.5 text-xs"
          disabled={busy}
          maxLength={10_000}
          placeholder="Optional resume guidance"
          value={guidance}
          onChange={(event) => {
            setGuidance(event.target.value);
          }}
        />
      ) : null}
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
      {onSettings === undefined ? null : (
        <Button disabled={busy} type="button" variant="outline" onClick={onSettings}>
          Task settings
        </Button>
      )}
      {onRemove === undefined ? null : (
        <Button
          disabled={busy}
          type="button"
          variant="outline"
          className="border-destructive/40 text-destructive hover:bg-destructive/10"
          onClick={onRemove}
        >
          Remove
        </Button>
      )}
      {availability.resume && !compact ? (
        <details className="w-full pt-2 text-right">
          <summary className="cursor-pointer text-xs text-muted-foreground">
            Add resume guidance
          </summary>
          <Textarea
            aria-label="Resume guidance"
            className="mt-2 min-h-20 w-full resize-y text-left"
            disabled={busy}
            maxLength={10_000}
            placeholder={'Optional guidance for the next attempt'}
            value={guidance}
            onChange={(event) => {
              setGuidance(event.target.value);
            }}
          />
        </details>
      ) : null}
      <ActionAlert error={error} className="basis-full" />
    </div>
  );
};
