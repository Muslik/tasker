import type {
  OperatorTaskInvocationListResponse,
  OperatorTaskInvocationListRow,
} from '../../server/operator-contracts.js';
import { cn } from '../lib/utils.js';
import type { InvocationSelection } from './CurrentAttemptStatus.js';
import { Badge } from './ui/badge.js';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table.js';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip.js';
import {
  formatOperatorCost,
  formatOperatorDurationMs,
  formatOperatorInteger,
  formatOperatorPromptKb,
  formatOperatorUsd,
} from './operatorUiFormat.js';

type FailureReason = Readonly<{
  summary: string;
  detail: string;
}>;

export type InvocationTokensRowView = Readonly<{
  source: OperatorTaskInvocationListRow;
  invocationId: string;
  status: OperatorTaskInvocationListRow['status'];
  stepLabel: string;
  blockRun: string;
  model: string;
  duration: string;
  promptKb: string;
  inputTokens: string;
  outputTokens: string;
  cachedTokens: string;
  cost: string;
  promptSpike: boolean;
  failureReason: FailureReason | null;
  hasRecordedUsage: boolean;
  selection: InvocationSelection;
}>;

const invocationStatusTone: Record<OperatorTaskInvocationListRow['status'], string> = {
  completed:
    'border-emerald-200/80 bg-emerald-500/10 text-emerald-700 dark:border-emerald-400/40 dark:bg-emerald-400/15 dark:text-emerald-200',
  waiting:
    'border-amber-200/80 bg-amber-500/10 text-amber-700 dark:border-amber-400/40 dark:bg-amber-400/15 dark:text-amber-200',
  failed:
    'border-red-200/80 bg-red-500/10 text-red-700 dark:border-red-400/40 dark:bg-red-400/15 dark:text-red-200',
};

const baselinePromptBytesByNode = (
  invocations: readonly OperatorTaskInvocationListRow[],
): ReadonlyMap<string, number> => {
  const baselines = new Map<string, number>();
  const chronologicallyFirst = [...invocations].sort(
    (left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt),
  );
  for (const row of chronologicallyFirst) {
    if (row.scope !== 'execution' || row.nodeId === null || baselines.has(row.nodeId)) continue;
    baselines.set(row.nodeId, row.promptBytes);
  }
  return baselines;
};

const invocationStatusLabel = (status: OperatorTaskInvocationListRow['status']): string =>
  status[0]?.toUpperCase().concat(status.slice(1)) ?? status;

const hasRecordedUsage = (row: OperatorTaskInvocationListRow): boolean =>
  [
    row.usage.inputTokens,
    row.usage.cachedInputTokens,
    row.usage.outputTokens,
    row.usage.reasoningOutputTokens,
  ].some((value) => value !== null && value > 0);

const failureReasonFor = (row: OperatorTaskInvocationListRow): FailureReason | null => {
  if (row.status !== 'failed') return null;
  if (!hasRecordedUsage(row) && row.cost.source === 'unrated') {
    return {
      summary: 'Failed before usage was recorded',
      detail: 'This invocation failed before provider token or cost telemetry was recorded.',
    };
  }
  if ((row.usage.outputTokens ?? 0) === 0) {
    return {
      summary: 'Failed before model output',
      detail: 'This invocation failed before any model output tokens were recorded.',
    };
  }
  return {
    summary: 'Failed after partial output',
    detail:
      'This invocation failed after partial provider output. Open the invocation prompt for the full artifact details.',
  };
};

export const invocationSelectionFor = (
  row: OperatorTaskInvocationListRow,
): InvocationSelection => ({
  nodeId: row.nodeId,
  blockRun: row.blockRun,
  invocationId: row.invocationId,
});

export const triggerInvocationSelection = (
  row: OperatorTaskInvocationListRow,
  onOpenInvocation?: (selection: InvocationSelection) => void,
): InvocationSelection => {
  const selection = invocationSelectionFor(row);
  onOpenInvocation?.(selection);
  return selection;
};

export const buildInvocationTokensRows = (
  response: OperatorTaskInvocationListResponse | null,
): readonly InvocationTokensRowView[] => {
  if (response === null) return [];

  const baselines = baselinePromptBytesByNode(response.invocations);
  return response.invocations.map((row) => {
    const baseline = row.nodeId === null ? null : (baselines.get(row.nodeId) ?? null);
    return {
      source: row,
      invocationId: row.invocationId,
      status: row.status,
      stepLabel: row.scope === 'planning' ? 'Planning' : (row.nodeId ?? 'Unknown node'),
      blockRun: row.blockRun === null ? '\u2014' : String(row.blockRun),
      model: row.model,
      duration: formatOperatorDurationMs(row.durationMs),
      promptKb: formatOperatorPromptKb(row.promptBytes),
      inputTokens: formatOperatorInteger(row.usage.inputTokens),
      outputTokens: formatOperatorInteger(row.usage.outputTokens),
      cachedTokens: formatOperatorInteger(row.usage.cachedInputTokens),
      cost: formatOperatorCost(row.cost),
      promptSpike: row.scope === 'execution' && baseline !== null && row.promptBytes > baseline * 2,
      failureReason: failureReasonFor(row),
      hasRecordedUsage: hasRecordedUsage(row),
      selection: invocationSelectionFor(row),
    };
  });
};

export type InvocationTokensProps = {
  invocations: OperatorTaskInvocationListResponse | null;
  onOpenInvocation?: (selection: InvocationSelection) => void;
  className?: string;
};

export function InvocationTokens({
  invocations,
  onOpenInvocation,
  className,
}: InvocationTokensProps) {
  const rows = buildInvocationTokensRows(invocations);

  return (
    <section aria-label="Tokens" className={cn('tasker-panel', className)}>
      <div className="tasker-panel-header">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Invocation tokens</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Exact duration, usage, and cost for every persisted operator invocation.
          </p>
        </div>
        <dl className="tasker-summary-grid text-xs tabular-nums">
          <div>
            <dt>Invocations</dt>
            <dd>{invocations?.totals.invocationCount.toLocaleString('en-US') ?? '0'}</dd>
          </div>
          <div>
            <dt>Total tokens</dt>
            <dd>{invocations?.totals.totalTokens.toLocaleString('en-US') ?? '0'}</dd>
          </div>
          <div>
            <dt>Cost USD</dt>
            <dd>{invocations === null ? '$0' : formatOperatorUsd(invocations.totals.costUsd)}</dd>
          </div>
          <div>
            <dt>Unrated</dt>
            <dd>{invocations?.totals.unratedCount.toLocaleString('en-US') ?? '0'}</dd>
          </div>
        </dl>
      </div>
      {rows.length === 0 ? (
        <p className="px-4 py-4 text-sm text-muted-foreground">
          No invocation artifacts have been recorded yet.
        </p>
      ) : (
        <div className="tasker-scroll-shell px-4 py-3">
          <Table className="tasker-fixed-table w-[86rem] table-fixed text-xs tabular-nums">
            <TableHeader>
              <TableRow className="text-left uppercase tracking-[0.08em] text-muted-foreground">
                <TableHead className="w-28 pr-4 font-medium">Status</TableHead>
                <TableHead className="pr-4 font-medium">Step / node</TableHead>
                <TableHead className="w-24 pr-4 font-medium">Block run</TableHead>
                <TableHead className="w-40 pr-4 font-medium">Model</TableHead>
                <TableHead className="w-28 pr-4 font-medium">Duration</TableHead>
                <TableHead className="w-28 pr-4 font-medium">Prompt</TableHead>
                <TableHead className="w-24 pr-4 font-medium">In</TableHead>
                <TableHead className="w-24 pr-4 font-medium">Out</TableHead>
                <TableHead className="w-24 pr-4 font-medium">Cached</TableHead>
                <TableHead className="w-24 pr-4 font-medium">Cost</TableHead>
                <TableHead className="w-64 font-medium">Failure</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow
                  key={row.invocationId}
                  className={cn(
                    'border-b border-border/60 align-top last:border-0',
                    row.status === 'failed' && 'bg-red-500/4 opacity-70',
                    row.promptSpike && 'bg-amber-500/10',
                  )}
                  title={
                    row.promptSpike ? 'Prompt grew to more than 2× its node baseline' : undefined
                  }
                >
                  <TableCell className="py-2 pr-4">
                    <Badge className={cn(invocationStatusTone[row.status])}>
                      {invocationStatusLabel(row.status)}
                    </Badge>
                  </TableCell>
                  <TableCell className="py-2 pr-4 text-foreground">
                    <button
                      type="button"
                      className="rounded-md text-left font-medium text-foreground transition hover:text-primary"
                      onClick={() => triggerInvocationSelection(row.source, onOpenInvocation)}
                    >
                      {row.stepLabel}
                    </button>
                  </TableCell>
                  <TableCell className="py-2 pr-4 text-foreground">{row.blockRun}</TableCell>
                  <TableCell className="py-2 pr-4 text-foreground">
                    <Tooltip>
                      <TooltipTrigger className="block max-w-full truncate">
                        {row.model}
                      </TooltipTrigger>
                      <TooltipContent>{row.model}</TooltipContent>
                    </Tooltip>
                  </TableCell>
                  <TableCell className="py-2 pr-4 text-foreground">{row.duration}</TableCell>
                  <TableCell
                    className={cn(
                      'py-2 pr-4 text-foreground',
                      row.promptSpike && 'font-semibold text-amber-700 dark:text-amber-300',
                    )}
                  >
                    {row.promptKb}
                  </TableCell>
                  <TableCell className="py-2 pr-4 text-foreground">{row.inputTokens}</TableCell>
                  <TableCell className="py-2 pr-4 text-foreground">{row.outputTokens}</TableCell>
                  <TableCell className="py-2 pr-4 text-foreground">{row.cachedTokens}</TableCell>
                  <TableCell
                    className={cn(
                      'py-2 pr-4 text-foreground',
                      row.status === 'failed' && row.cost === '\u2014' && 'text-muted-foreground',
                    )}
                  >
                    {row.cost}
                  </TableCell>
                  <TableCell className="py-2 text-foreground">
                    {row.failureReason === null ? (
                      <span className="text-muted-foreground">\u2014</span>
                    ) : (
                      <details className="tasker-reason-toggle" title={row.failureReason.detail}>
                        <summary>{row.failureReason.summary}</summary>
                        <p className="mt-2 text-xs leading-5 text-muted-foreground">
                          {row.failureReason.detail}
                        </p>
                      </details>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}
