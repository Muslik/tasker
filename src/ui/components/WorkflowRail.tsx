import { ChevronDown, CircleDot, Timer } from 'lucide-react';

import type {
  OperatorTaskInvocationListResponse,
  OperatorWorkflowStage,
  OperatorWorkflowStep,
  WorkflowNodeStatus,
} from '../../server/operator-contracts.js';
import { cn } from '../lib/utils.js';
import { formatOperatorDurationMs, formatOperatorUsd } from './operatorUiFormat.js';

const statusTone = {
  planned: 'border-border bg-muted text-muted-foreground',
  running: 'border-sky-400 bg-sky-500/15 text-sky-700 dark:text-sky-200',
  waiting: 'border-amber-400 bg-amber-500/15 text-amber-700 dark:text-amber-200',
  succeeded: 'border-emerald-400 bg-emerald-500/15 text-emerald-700 dark:text-emerald-200',
  skipped: 'border-border bg-muted text-muted-foreground',
  failed: 'border-red-400 bg-red-500/15 text-red-700 dark:text-red-200',
} satisfies Record<WorkflowNodeStatus, string>;

const statusLabel = (status: WorkflowNodeStatus): string =>
  status === 'succeeded' ? 'Complete' : status.charAt(0).toUpperCase() + status.slice(1);

const compactTokens = (tokens: number): string => {
  if (tokens < 1_000) return String(tokens);
  if (tokens < 1_000_000) return `${(tokens / 1_000).toFixed(tokens < 10_000 ? 1 : 0)}k`;
  return `${(tokens / 1_000_000).toFixed(tokens < 10_000_000 ? 1 : 0)}m`;
};

export type WorkflowRailTotals = Readonly<{
  totalTokens: number;
  durationMs: number;
  costUsd: number;
  unrated: boolean;
}>;

export const workflowRailTotals = (
  invocations: OperatorTaskInvocationListResponse | null | undefined,
): WorkflowRailTotals => {
  if (invocations === null || invocations === undefined) {
    return { totalTokens: 0, durationMs: 0, costUsd: 0, unrated: false };
  }
  return {
    totalTokens: invocations.totals.totalTokens,
    durationMs: invocations.invocations.reduce((sum, row) => sum + row.durationMs, 0),
    costUsd: invocations.totals.costUsd,
    unrated: invocations.totals.unratedCount > 0,
  };
};

const stepTokens = (
  step: OperatorWorkflowStep,
  invocations: OperatorTaskInvocationListResponse | null | undefined,
): number => {
  if (step.kind === 'wait' || invocations === null || invocations === undefined) return 0;
  return invocations.invocations
    .filter((row) => row.nodeId === step.id)
    .reduce((sum, row) => sum + (row.usage.inputTokens ?? 0) + (row.usage.outputTokens ?? 0), 0);
};

const WorkflowSteps = ({
  stage,
  currentNodeId,
  invocations,
}: {
  readonly stage: OperatorWorkflowStage;
  readonly currentNodeId: string | null;
  readonly invocations: OperatorTaskInvocationListResponse | null | undefined;
}) => (
  <ol className="mt-2 space-y-1.5">
    {stage.steps.map((step) => {
      const active = step.id === currentNodeId;
      const tokens = stepTokens(step, invocations);
      return (
        <li
          className={cn(
            'flex min-w-0 items-center gap-2 rounded-md border px-2.5 py-2 text-xs',
            active ? statusTone[step.status] : 'border-transparent bg-muted/40',
          )}
          data-current={active || undefined}
          key={step.id}
        >
          <CircleDot className="size-3 shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate">{step.label}</span>
          {tokens > 0 ? (
            <span className="shrink-0 rounded bg-background/60 px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground">
              {compactTokens(tokens)}
            </span>
          ) : null}
          {step.kind !== 'wait' && step.attempts > 0 ? (
            <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
              Attempt {String(step.attempts)}
            </span>
          ) : null}
        </li>
      );
    })}
  </ol>
);

const WorkflowRailContent = ({ stages, currentNodeId, invocations }: WorkflowRailProps) => (
  <>
    {stages.length === 0 ? (
      <p className="px-4 py-6 text-sm text-muted-foreground">No workflow has been projected yet.</p>
    ) : (
      <ol className="divide-y">
        {stages.map((stage, stageIndex) => (
          <li className="grid grid-cols-[1rem_1fr] gap-3 px-4 py-3" key={stage.key}>
            <div className="relative flex justify-center pt-1">
              <span
                aria-hidden="true"
                className={cn(
                  'relative z-10 size-2.5 rounded-full border-2',
                  statusTone[stage.status],
                )}
              />
              {stageIndex < stages.length - 1 ? (
                <span
                  aria-hidden="true"
                  className="absolute top-3 h-[calc(100%+1.5rem)] w-px bg-border"
                />
              ) : null}
            </div>
            <div className="min-w-0">
              <div className="flex items-center justify-between gap-3">
                <h3 className="truncate text-sm font-medium">{stage.label}</h3>
                <span className="shrink-0 text-[11px] text-muted-foreground">
                  {statusLabel(stage.status)}
                </span>
              </div>
              {stage.steps.length === 0 ? null : (
                <WorkflowSteps
                  stage={stage}
                  currentNodeId={currentNodeId}
                  invocations={invocations}
                />
              )}
            </div>
          </li>
        ))}
      </ol>
    )}
  </>
);

export type WorkflowRailProps = {
  readonly stages: readonly OperatorWorkflowStage[];
  readonly currentNodeId: string | null;
  readonly invocations?: OperatorTaskInvocationListResponse | null;
};

export const WorkflowRail = ({ stages, currentNodeId, invocations = null }: WorkflowRailProps) => {
  const totals = workflowRailTotals(invocations);
  const body = (
    <WorkflowRailContent stages={stages} currentNodeId={currentNodeId} invocations={invocations} />
  );
  return (
    <section
      aria-label="Workflow stages"
      className="min-w-0 border-l border-border bg-card text-card-foreground"
    >
      <header className="border-b px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold">Workflow</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">Stages, steps, and live spend</p>
          </div>
          <div className="hidden items-center gap-1 text-[10px] text-muted-foreground xl:flex">
            <Timer className="size-3" aria-hidden="true" />
            {formatOperatorDurationMs(totals.durationMs)}
          </div>
        </div>
        <div className="mt-3 grid grid-cols-3 gap-2 border-t pt-3 text-[11px] tabular-nums">
          <div>
            <span className="block text-muted-foreground">Tokens</span>
            <strong>{compactTokens(totals.totalTokens)}</strong>
          </div>
          <div>
            <span className="block text-muted-foreground">Agent time</span>
            <strong>{formatOperatorDurationMs(totals.durationMs)}</strong>
          </div>
          <div>
            <span className="block text-muted-foreground">API</span>
            <strong>{totals.unrated ? 'Unrated' : formatOperatorUsd(totals.costUsd)}</strong>
          </div>
        </div>
      </header>
      <div className="hidden xl:block">{body}</div>
      <details className="xl:hidden">
        <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-sm font-medium hover:bg-muted/40 [&::-webkit-details-marker]:hidden">
          <span>Show workflow steps</span>
          <ChevronDown className="size-4 text-muted-foreground" />
        </summary>
        <div className="border-t">{body}</div>
      </details>
      <details className="border-t px-4 py-3 text-xs">
        <summary className="cursor-pointer font-medium text-muted-foreground">
          Token details
        </summary>
        <p className="mt-2 leading-5 text-muted-foreground">
          {invocations?.totals.invocationCount.toLocaleString('en-US') ?? '0'} invocations ·{' '}
          {invocations?.totals.inputTokens.toLocaleString('en-US') ?? '0'} input ·{' '}
          {invocations?.totals.outputTokens.toLocaleString('en-US') ?? '0'} output
        </p>
      </details>
    </section>
  );
};
