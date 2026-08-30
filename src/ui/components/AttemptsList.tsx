import type {
  OperatorRunLogEntry,
  OperatorRunLogResponse,
  OperatorTaskInvocationListRow,
} from '../../control-plane/operator-contracts.js';
import { cn } from '../../cockpit/lib/utils.js';
import { formatDuration } from '../lib/format.js';

export type AttemptSelection = Readonly<{
  nodeId: string;
  blockRun: number;
  invocationId: string | null;
}>;

export type ResolvedAttemptSelection = Readonly<{
  nodeId: string;
  blockRun: number;
  invocationId: string;
}>;

export type AttemptGroup = Readonly<{
  nodeId: string;
  label: string;
  reference: string;
  attempts: readonly AttemptRow[];
}>;

export type AttemptRow = Readonly<{
  entry: OperatorRunLogEntry;
  selection: AttemptSelection;
}>;

export type AttemptsListProps = {
  runLog: OperatorRunLogResponse | null;
  invocations?: readonly OperatorTaskInvocationListRow[] | null;
  selectedAttempt?: AttemptSelection | null;
  onSelectAttempt?: (selection: AttemptSelection) => void;
  onOpenInvocation?: (selection: ResolvedAttemptSelection) => void;
  className?: string;
};

const statusTone: Record<OperatorRunLogEntry['status'], string> = {
  running: 'bg-amber-500/10 text-amber-800 dark:text-amber-300',
  completed: 'bg-emerald-500/10 text-emerald-800 dark:text-emerald-300',
  blocked: 'bg-rose-500/10 text-rose-800 dark:text-rose-300',
  workflow_change_required: 'bg-sky-500/10 text-sky-800 dark:text-sky-300',
};

const humanizeReference = (entry: OperatorRunLogEntry): string => {
  if (entry.runtime === 'bootstrap' && entry.runner === 'planner') return 'Planning';
  return entry.reference
    .replace(/@[\d.]+$/u, '')
    .replace(/[._-]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
};

const formatTimestamp = (value: string | null): string =>
  value === null ? '\u2014' : value.replace('T', ' ').replace('.000Z', 'Z');

export const resolveAttemptInvocation = (
  entry: OperatorRunLogEntry,
  invocations: readonly OperatorTaskInvocationListRow[] | null | undefined,
): OperatorTaskInvocationListRow | null => {
  if (entry.runtime !== 'execution' || invocations === null || invocations === undefined) {
    return null;
  }

  let latest: OperatorTaskInvocationListRow | null = null;
  for (const invocation of invocations) {
    if (
      invocation.scope !== 'execution' ||
      invocation.nodeId !== entry.nodeId ||
      invocation.blockRun !== entry.blockRun
    ) {
      continue;
    }
    if (latest === null || Date.parse(invocation.finishedAt) > Date.parse(latest.finishedAt)) {
      latest = invocation;
    }
  }
  return latest;
};

export const attemptSelectionFor = (
  entry: OperatorRunLogEntry,
  invocations?: readonly OperatorTaskInvocationListRow[] | null,
): AttemptSelection => ({
  nodeId: entry.nodeId,
  blockRun: entry.blockRun,
  invocationId: resolveAttemptInvocation(entry, invocations)?.invocationId ?? null,
});

export const triggerAttemptSelection = (
  entry: OperatorRunLogEntry,
  invocations?: readonly OperatorTaskInvocationListRow[] | null,
  onSelectAttempt?: (selection: AttemptSelection) => void,
): AttemptSelection => {
  const selection = attemptSelectionFor(entry, invocations);
  onSelectAttempt?.(selection);
  return selection;
};

export const triggerAttemptPromptOpen = (
  entry: OperatorRunLogEntry,
  invocations?: readonly OperatorTaskInvocationListRow[] | null,
  onOpenInvocation?: (selection: ResolvedAttemptSelection) => void,
): ResolvedAttemptSelection | null => {
  const selection = attemptSelectionFor(entry, invocations);
  if (selection.invocationId === null) return null;
  const resolved = { ...selection, invocationId: selection.invocationId };
  onOpenInvocation?.(resolved);
  return resolved;
};

export const groupAttemptsByStep = (
  runLog: OperatorRunLogResponse | null,
  invocations?: readonly OperatorTaskInvocationListRow[] | null,
): readonly AttemptGroup[] => {
  if (runLog === null) return [];
  const groups = new Map<string, AttemptGroup>();
  for (const entry of runLog.entries) {
    const selection = attemptSelectionFor(entry, invocations);
    const row: AttemptRow = { entry, selection };
    const current = groups.get(entry.nodeId);
    if (current === undefined) {
      groups.set(entry.nodeId, {
        nodeId: entry.nodeId,
        label: humanizeReference(entry),
        reference: entry.reference,
        attempts: [row],
      });
      continue;
    }
    groups.set(entry.nodeId, { ...current, attempts: [...current.attempts, row] });
  }
  return [...groups.values()].map((group) => ({
    ...group,
    attempts: [...group.attempts].sort((left, right) => left.entry.blockRun - right.entry.blockRun),
  }));
};

export function AttemptsList({
  runLog,
  invocations = null,
  selectedAttempt = null,
  onSelectAttempt,
  onOpenInvocation,
  className,
}: AttemptsListProps) {
  const groups = groupAttemptsByStep(runLog, invocations);

  if (groups.length === 0) {
    return (
      <section
        aria-label="Attempts by step"
        className={cn(
          'rounded-2xl border border-border bg-card p-4 text-sm text-muted-foreground',
          className,
        )}
      >
        No bootstrap or execution attempts have been recorded yet.
      </section>
    );
  }

  return (
    <section
      aria-label="Attempts by step"
      className={cn('rounded-2xl border border-border bg-card text-card-foreground', className)}
    >
      <div className="border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold text-foreground">Attempts</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Grouped by workflow step, with status and elapsed time.
        </p>
      </div>
      <div className="divide-y divide-border">
        {groups.map((group) => (
          <section
            key={group.nodeId}
            aria-labelledby={`attempt-step-${group.nodeId}`}
            className="px-4 py-3"
          >
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <h3
                  id={`attempt-step-${group.nodeId}`}
                  className="text-sm font-medium text-foreground"
                >
                  {group.label}
                </h3>
                <p className="text-xs text-muted-foreground">{group.reference}</p>
              </div>
              <div className="text-xs tabular-nums text-muted-foreground">
                {group.attempts.length} attempt(s)
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full border-separate border-spacing-0 text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-[0.08em] text-muted-foreground">
                    <th className="pb-2 pr-4 font-medium">Attempt</th>
                    <th className="pb-2 pr-4 font-medium">Status</th>
                    <th className="pb-2 pr-4 font-medium">Started</th>
                    <th className="pb-2 pr-4 font-medium">Duration</th>
                    <th className="pb-2 pr-4 font-medium">Runtime</th>
                    <th className="pb-2 font-medium">Summary</th>
                    <th className="pb-2 pl-4 font-medium">Prompt</th>
                  </tr>
                </thead>
                <tbody>
                  {group.attempts.map(({ entry, selection }) => {
                    const selected =
                      selectedAttempt?.nodeId === selection.nodeId &&
                      selectedAttempt.blockRun === selection.blockRun;
                    return (
                      <tr
                        key={entry.id}
                        className={cn('border-t border-border/60', selected && 'bg-accent/60')}
                      >
                        <td className="py-2 pr-4">
                          <button
                            type="button"
                            aria-pressed={selected}
                            aria-label={`Show ${group.label} attempt ${String(entry.blockRun)}`}
                            className={cn(
                              'rounded-md px-2 py-1 text-left text-sm font-medium tabular-nums text-foreground outline-none ring-ring transition focus-visible:ring-2',
                              selected
                                ? 'bg-accent text-accent-foreground'
                                : 'hover:bg-muted hover:text-foreground',
                            )}
                            onClick={() =>
                              triggerAttemptSelection(entry, invocations, onSelectAttempt)
                            }
                          >
                            #{String(entry.blockRun)}
                          </button>
                        </td>
                        <td className="py-2 pr-4">
                          <span
                            className={cn(
                              'inline-flex rounded-full px-2 py-0.5 text-xs font-medium capitalize',
                              statusTone[entry.status],
                            )}
                          >
                            {entry.status.replaceAll('_', ' ')}
                          </span>
                        </td>
                        <td className="py-2 pr-4 text-xs tabular-nums text-muted-foreground">
                          {formatTimestamp(entry.startedAt)}
                        </td>
                        <td className="py-2 pr-4 text-xs tabular-nums text-foreground">
                          {formatDuration(entry.startedAt, entry.completedAt)}
                        </td>
                        <td className="py-2 pr-4 text-xs text-muted-foreground">
                          {[entry.runtime, entry.runner]
                            .filter((value) => value !== null)
                            .join(' / ')}
                        </td>
                        <td className="py-2 text-xs text-muted-foreground">
                          {entry.resultSummary ??
                            (entry.rawLog.trim().length > 0 ? 'Raw log captured' : '\u2014')}
                        </td>
                        <td className="py-2 pl-4 text-xs">
                          {selection.invocationId === null ? (
                            <span className="text-muted-foreground">
                              {entry.runtime === 'bootstrap'
                                ? 'Planning only'
                                : entry.status === 'running'
                                  ? 'Pending'
                                  : 'Unavailable'}
                            </span>
                          ) : (
                            <button
                              type="button"
                              className="rounded-md border border-border px-2 py-1 font-medium text-foreground transition hover:bg-muted"
                              onClick={() =>
                                triggerAttemptPromptOpen(entry, invocations, onOpenInvocation)
                              }
                            >
                              Prompt
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        ))}
      </div>
    </section>
  );
}
