import type {
  ExecutionRunView,
  OperatorTaskSummary,
  OperatorWorkflowProjection,
} from '../../server/operator-contracts.js';
import { TaskActions } from './TaskActions.js';
import type { InvocationSelection } from './CurrentAttemptStatus.js';
import { Button } from './ui/button.js';
import { getDedicatedWaitSurfaceTarget } from './taskOperatorWaits.js';

export type WaitBannerProps = {
  readonly task: OperatorTaskSummary;
  readonly projection: OperatorWorkflowProjection;
  readonly currentRun: ExecutionRunView | null;
  readonly onStart?: () => void;
  readonly onRemove?: () => void;
  readonly onOpenInvocation: (selection: InvocationSelection) => void;
};

export const WaitBanner = ({
  task,
  projection,
  currentRun,
  onStart,
  onRemove,
  onOpenInvocation,
}: WaitBannerProps) => {
  const current = projection.current;
  if (current?.status !== 'waiting') return null;
  const currentAttempt = projection.currentAttempt;
  const dedicatedTarget = getDedicatedWaitSurfaceTarget(current.waitKind);
  return (
    <section
      className="border-b border-amber-400/40 bg-amber-500/10 px-5 py-3"
      aria-label="Run waiting"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold uppercase tracking-[0.12em] text-amber-800 dark:text-amber-200">
            Waiting · {current.waitKind}
          </p>
          <p className="mt-1 whitespace-pre-wrap break-words text-sm text-foreground">
            {`waiting for ${current.waitKind} / ${current.reason ?? 'an operator or external condition'}`}
          </p>
        </div>
        {dedicatedTarget === null ? null : (
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              if (typeof document === 'undefined') return;
              const target = document.getElementById(dedicatedTarget.surfaceId);
              if (!(target instanceof HTMLElement)) return;
              target.scrollIntoView({ behavior: 'smooth', block: 'start' });
              target.focus({ preventScroll: true });
            }}
          >
            {dedicatedTarget.actionLabel}
          </Button>
        )}
        {currentAttempt === null ? null : (
          <button
            type="button"
            className="rounded-md border border-amber-700/20 bg-background px-2.5 py-1.5 text-xs font-medium text-foreground hover:bg-accent"
            onClick={() => {
              onOpenInvocation({
                nodeId: currentAttempt.nodeId,
                blockRun: currentAttempt.blockRun,
                invocationId: currentAttempt.latestInvocationId,
              });
            }}
          >
            Open invocation
          </button>
        )}
        <TaskActions
          task={task}
          projection={projection}
          currentRun={currentRun}
          {...(onStart === undefined ? {} : { onSettings: onStart })}
          {...(onRemove === undefined ? {} : { onRemove })}
          compact
        />
      </div>
    </section>
  );
};
