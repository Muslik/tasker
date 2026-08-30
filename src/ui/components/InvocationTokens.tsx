import type {
  OperatorTaskInvocationListResponse,
  OperatorTaskInvocationListRow,
} from '../../server/operator-contracts.js';
import { cn } from '../lib/utils.js';
import type { InvocationSelection } from './CurrentAttemptStatus.js';

export type InvocationTokensRowView = Readonly<{
  source: OperatorTaskInvocationListRow;
  invocationId: string;
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
  selection: InvocationSelection | null;
}>;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const formatDurationMs = (durationMs: number): string => {
  if (durationMs < MINUTE_MS) return '<1m';
  if (durationMs < HOUR_MS) return `${String(Math.floor(durationMs / MINUTE_MS))}m`;

  if (durationMs < DAY_MS) {
    const hours = Math.floor(durationMs / HOUR_MS);
    const minutes = Math.floor((durationMs % HOUR_MS) / MINUTE_MS);
    return minutes === 0 ? `${String(hours)}h` : `${String(hours)}h ${String(minutes)}m`;
  }

  const days = Math.floor(durationMs / DAY_MS);
  const hours = Math.floor((durationMs % DAY_MS) / HOUR_MS);
  return hours === 0 ? `${String(days)}d` : `${String(days)}d ${String(hours)}h`;
};

const formatInteger = (value: number | null): string =>
  value === null ? '\u2014' : value.toLocaleString('en-US');

const formatCostUsd = (
  cost: OperatorTaskInvocationListRow['cost'],
  minimumFractionDigits = 2,
): string =>
  cost.source === 'unrated'
    ? '\u2014'
    : `$${cost.amountUsd.toLocaleString('en-US', {
        minimumFractionDigits,
        maximumFractionDigits: 4,
      })}`;

const formatPromptKb = (promptBytes: number): string => (promptBytes / 1024).toFixed(1);

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

export const invocationSelectionFor = (
  row: OperatorTaskInvocationListRow,
): InvocationSelection | null =>
  row.nodeId === null || row.blockRun === null
    ? null
    : {
        nodeId: row.nodeId,
        blockRun: row.blockRun,
        invocationId: row.invocationId,
      };

export const triggerInvocationSelection = (
  row: OperatorTaskInvocationListRow,
  onOpenInvocation?: (selection: InvocationSelection) => void,
): InvocationSelection | null => {
  const selection = invocationSelectionFor(row);
  if (selection === null) return null;
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
      stepLabel: row.scope === 'planning' ? 'Planning' : (row.nodeId ?? 'Unknown node'),
      blockRun: row.blockRun === null ? '\u2014' : String(row.blockRun),
      model: row.model,
      duration: formatDurationMs(row.durationMs),
      promptKb: formatPromptKb(row.promptBytes),
      inputTokens: formatInteger(row.usage.inputTokens),
      outputTokens: formatInteger(row.usage.outputTokens),
      cachedTokens: formatInteger(row.usage.cachedInputTokens),
      cost: formatCostUsd(row.cost),
      promptSpike: row.scope === 'execution' && baseline !== null && row.promptBytes > baseline * 2,
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
    <section
      aria-label="Tokens"
      className={cn('rounded-2xl border border-border bg-card text-card-foreground', className)}
    >
      <div className="border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold text-foreground">Tokens</h2>
        <div className="mt-3 grid grid-cols-2 gap-2 text-xs tabular-nums sm:grid-cols-4">
          <div className="rounded-lg border border-border/70 bg-muted/30 px-3 py-2">
            <div className="text-muted-foreground">Invocations</div>
            <div className="mt-1 font-medium text-foreground">
              {invocations?.totals.invocationCount.toLocaleString('en-US') ?? '0'}
            </div>
          </div>
          <div className="rounded-lg border border-border/70 bg-muted/30 px-3 py-2">
            <div className="text-muted-foreground">Total tokens</div>
            <div className="mt-1 font-medium text-foreground">
              {invocations?.totals.totalTokens.toLocaleString('en-US') ?? '0'}
            </div>
          </div>
          <div className="rounded-lg border border-border/70 bg-muted/30 px-3 py-2">
            <div className="text-muted-foreground">Cost USD</div>
            <div className="mt-1 font-medium text-foreground">
              {invocations === null
                ? '$0.00'
                : `$${invocations.totals.costUsd.toLocaleString('en-US', {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 4,
                  })}`}
            </div>
          </div>
          <div className="rounded-lg border border-border/70 bg-muted/30 px-3 py-2">
            <div className="text-muted-foreground">Unrated</div>
            <div className="mt-1 font-medium text-foreground">
              {invocations?.totals.unratedCount.toLocaleString('en-US') ?? '0'}
            </div>
          </div>
        </div>
      </div>
      {rows.length === 0 ? (
        <p className="px-4 py-4 text-sm text-muted-foreground">
          No invocation artifacts have been recorded yet.
        </p>
      ) : (
        <div className="overflow-x-auto px-4 py-3">
          <table className="min-w-full text-xs tabular-nums">
            <thead>
              <tr className="border-b border-border text-left uppercase tracking-[0.08em] text-muted-foreground">
                <th className="pb-2 pr-4 font-medium">Step / node</th>
                <th className="pb-2 pr-4 font-medium">Block run</th>
                <th className="pb-2 pr-4 font-medium">Model</th>
                <th className="pb-2 pr-4 font-medium">Duration</th>
                <th className="pb-2 pr-4 font-medium">Prompt KB</th>
                <th className="pb-2 pr-4 font-medium">In</th>
                <th className="pb-2 pr-4 font-medium">Out</th>
                <th className="pb-2 pr-4 font-medium">Cached</th>
                <th className="pb-2 font-medium">Cost</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.invocationId}
                  className={cn(
                    'border-b border-border/60 last:border-0',
                    row.promptSpike && 'bg-amber-500/10',
                  )}
                  title={
                    row.promptSpike ? 'Prompt grew to more than 2× its node baseline' : undefined
                  }
                >
                  <td className="py-2 pr-4 text-foreground">
                    {row.selection === null ? (
                      <span>{row.stepLabel}</span>
                    ) : (
                      <button
                        type="button"
                        className="rounded-md text-left font-medium text-foreground transition hover:text-primary"
                        onClick={() => triggerInvocationSelection(row.source, onOpenInvocation)}
                      >
                        {row.stepLabel}
                      </button>
                    )}
                  </td>
                  <td className="py-2 pr-4 text-foreground">{row.blockRun}</td>
                  <td className="max-w-44 py-2 pr-4 text-foreground">
                    <span className="block truncate">{row.model}</span>
                  </td>
                  <td className="py-2 pr-4 text-foreground">{row.duration}</td>
                  <td
                    className={cn(
                      'py-2 pr-4 text-foreground',
                      row.promptSpike && 'font-semibold text-amber-700 dark:text-amber-300',
                    )}
                  >
                    {row.promptKb}
                  </td>
                  <td className="py-2 pr-4 text-foreground">{row.inputTokens}</td>
                  <td className="py-2 pr-4 text-foreground">{row.outputTokens}</td>
                  <td className="py-2 pr-4 text-foreground">{row.cachedTokens}</td>
                  <td className="py-2 text-foreground">{row.cost}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
