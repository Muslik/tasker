import { useEffect, useState, type ReactNode } from 'react';

import type {
  OperatorTaskSummary,
  OperatorWorkflowProjection,
} from '../../server/operator-contracts.js';
import { cn } from '../lib/utils.js';
import { formatDuration } from '../lib/format.js';
import { StatusChip } from './StatusChip.js';

export type InvocationSelection = Readonly<{
  nodeId: string;
  blockRun: number;
  invocationId: string;
}>;

export type CurrentAttemptStatusView = Readonly<{
  node: string;
  blockRun: string;
  elapsed: string;
  waitLine: string | null;
  selection: InvocationSelection | null;
}>;

const formatTimestamp = (value: string | null): string =>
  value === null ? '\u2014' : value.replace('T', ' ').replace('.000Z', 'Z');

const bootstrapStage = (
  projection: Pick<OperatorWorkflowProjection, 'current'> &
    Partial<Pick<OperatorWorkflowProjection, 'stages'>>,
): string | null => {
  if (projection.current?.runtime !== 'bootstrap') return null;
  return (
    projection.stages?.find((stage) => stage.id === projection.current?.nodeId)?.label ??
    projection.stages?.find((stage) => stage.status === projection.current?.status)?.label ??
    null
  );
};

export const buildCurrentAttemptStatusView = (
  projection: Pick<OperatorWorkflowProjection, 'current' | 'currentAttempt'> &
    Partial<Pick<OperatorWorkflowProjection, 'stages'>>,
  now = Date.now(),
): CurrentAttemptStatusView => {
  const currentAttempt = projection.currentAttempt;
  const current = projection.current;
  const startedAt = currentAttempt?.startedAt ?? current?.startedAt ?? null;
  const stage = bootstrapStage(projection);
  const selection =
    currentAttempt === null
      ? null
      : {
          nodeId: currentAttempt.nodeId,
          blockRun: currentAttempt.blockRun,
          invocationId: currentAttempt.latestInvocationId,
        };
  const waitTarget =
    current?.status === 'waiting'
      ? [current.waitKind, current.reason].filter((value) => value !== null).join(' / ')
      : '';

  return {
    node:
      currentAttempt?.nodeId ??
      (stage === null
        ? (current?.nodeId ?? 'No active node')
        : `${stage} — ${current?.status === 'waiting' ? 'waiting' : 'preparing'}`),
    blockRun: currentAttempt === null ? '\u2014' : String(currentAttempt.blockRun),
    elapsed: startedAt === null ? 'No active attempt' : formatDuration(startedAt, null, now),
    waitLine:
      current?.status === 'waiting' && (currentAttempt?.waitingSince ?? startedAt) !== null
        ? `waiting for ${waitTarget} since ${formatTimestamp(currentAttempt?.waitingSince ?? startedAt)} (${formatDuration(currentAttempt?.waitingSince ?? startedAt, null, now)})`
        : null,
    selection,
  };
};

export const triggerCurrentAttemptOpen = (
  selection: InvocationSelection | null,
  onOpenInvocation?: (selection: InvocationSelection) => void,
): InvocationSelection | null => {
  if (selection === null) return null;
  onOpenInvocation?.(selection);
  return selection;
};

export type CurrentAttemptStatusProps = {
  projection: Pick<OperatorWorkflowProjection, 'current' | 'currentAttempt'> &
    Partial<Pick<OperatorWorkflowProjection, 'stages'>>;
  status?: OperatorTaskSummary['status'];
  actions?: ReactNode;
  onOpenInvocation?: (selection: InvocationSelection) => void;
  className?: string;
};

export function CurrentAttemptStatus({
  projection,
  status,
  actions,
  onOpenInvocation,
  className,
}: CurrentAttemptStatusProps) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNow(Date.now());
    }, 1_000);
    return () => {
      window.clearInterval(timer);
    };
  }, []);

  const view = buildCurrentAttemptStatusView(projection, now);

  return (
    <section className={cn('min-w-0 space-y-3', className)}>
      <div className="flex flex-wrap items-center gap-3">
        {status === undefined ? null : <StatusChip status={status} />}
        <dl className="flex min-w-0 flex-1 flex-wrap items-center gap-x-5 gap-y-2 text-xs tabular-nums">
          <div>
            <dt className="text-muted-foreground">Current node/stage</dt>
            <dd className="mt-1 max-w-64 truncate font-medium text-foreground">{view.node}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Block run</dt>
            <dd className="mt-1 font-medium text-foreground">{view.blockRun}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Elapsed</dt>
            <dd className="mt-1 font-medium text-foreground">{view.elapsed}</dd>
          </div>
        </dl>
        {actions}
      </div>
      {view.waitLine === null ? null : (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-400/50 bg-amber-500/10 px-3 py-2.5">
          <p className="min-w-0 flex-1 whitespace-pre-wrap text-sm text-foreground">
            {view.waitLine}
          </p>
          <button
            type="button"
            className="rounded-md border border-amber-700/20 bg-background px-2.5 py-1.5 text-xs font-medium text-foreground transition hover:bg-accent hover:text-accent-foreground"
            onClick={() => triggerCurrentAttemptOpen(view.selection, onOpenInvocation)}
          >
            Open invocation
          </button>
        </div>
      )}
    </section>
  );
}
