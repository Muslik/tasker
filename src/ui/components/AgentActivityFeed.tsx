import { AlertTriangle, CheckCircle2, CircleDot, Terminal } from 'lucide-react';

import type {
  OperatorRunLogEntry,
  OperatorRunLogResponse,
} from '../../server/operator-contracts.js';
import { parseAgentActivityFeed, type AgentActivityEvent } from '../lib/agent-activity-feed.js';
import { cn } from '../lib/utils.js';
import { formatOperatorTimestamp } from './operatorUiFormat.js';

const attemptLabel = (entry: OperatorRunLogEntry): string =>
  entry.runtime === 'bootstrap' && entry.runner === 'planner'
    ? 'Planning'
    : entry.reference.replaceAll('.', ' ');

const statusClass = (status: OperatorRunLogEntry['status']): string => {
  switch (status) {
    case 'completed':
      return 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-200';
    case 'blocked':
    case 'workflow_change_required':
      return 'bg-amber-500/15 text-amber-700 dark:text-amber-200';
    case 'running':
      return 'bg-sky-500/15 text-sky-700 dark:text-sky-200';
  }
};

const EventRow = ({ event }: { readonly event: AgentActivityEvent }) => {
  if (event.kind === 'message') {
    return (
      <li className="flex gap-3 rounded-xl border border-primary/20 bg-primary/5 px-4 py-3">
        <CircleDot className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-primary">
            {event.title}
          </p>
          <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-6 text-foreground">
            {event.detail}
          </p>
        </div>
      </li>
    );
  }
  if (event.kind === 'command') {
    const resultLabel =
      event.status === 'running' ? 'running' : `exit ${String(event.exitCode ?? 0)}`;
    return (
      <li className="rounded-lg border border-border bg-muted/25">
        <details>
          <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 text-xs hover:bg-muted/45 [&::-webkit-details-marker]:hidden">
            <Terminal className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            <code className="min-w-0 flex-1 truncate text-foreground" title={event.command}>
              {event.command}
            </code>
            <span
              className={cn(
                'shrink-0 rounded-full border px-2 py-0.5 font-medium tabular-nums',
                event.status === 'failed'
                  ? 'border-red-300/70 bg-red-500/10 text-red-700 dark:text-red-200'
                  : 'border-border text-muted-foreground',
              )}
            >
              {resultLabel}
            </span>
          </summary>
          <div className="space-y-3 border-t px-3 py-3 text-xs">
            <div>
              <h4 className="font-medium text-muted-foreground">Input</h4>
              <pre className="tasker-code-block mt-1 whitespace-pre-wrap break-words">
                {event.input.length > 0 ? event.input : event.command}
              </pre>
            </div>
            <div>
              <h4 className="font-medium text-muted-foreground">Output</h4>
              <pre className="tasker-code-block mt-1 whitespace-pre-wrap break-words">
                {event.output.length > 0 ? event.output : 'No output recorded'}
              </pre>
            </div>
          </div>
        </details>
      </li>
    );
  }
  return (
    <li
      className={cn(
        'flex gap-2 rounded-lg border px-3 py-2 text-xs leading-5',
        event.kind === 'error'
          ? 'border-destructive/30 bg-destructive/10 text-destructive'
          : 'border-amber-400/30 bg-amber-500/10 text-amber-800 dark:text-amber-200',
      )}
    >
      {event.kind === 'error' ? (
        <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
      ) : (
        <CheckCircle2 className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
      )}
      <span className="break-words">{event.message}</span>
    </li>
  );
};

export type AgentActivityFeedProps = {
  readonly runLog: OperatorRunLogResponse | null;
  readonly className?: string;
};

export const AgentActivityFeed = ({ runLog, className }: AgentActivityFeedProps) => {
  const entries = runLog?.entries ?? [];
  return (
    <section className={cn('space-y-4', className)} aria-label="Agent activity feed">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">Agent activity</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Provider messages and commands, in the order they happened.
          </p>
        </div>
        <span className="text-xs tabular-nums text-muted-foreground">
          {entries.length} attempt{entries.length === 1 ? '' : 's'}
        </span>
      </div>
      {entries.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
          No provider activity recorded yet.
        </div>
      ) : (
        <ol className="space-y-5">
          {entries.map((entry) => {
            const parsed = parseAgentActivityFeed(entry.rawLog, entry.blockRun);
            const events = parsed.attempts[0]?.events ?? [];
            return (
              <li key={entry.id} className="space-y-2">
                <header className="flex flex-wrap items-center gap-2 border-b pb-2">
                  <span className="size-2 rounded-full bg-primary" aria-hidden="true" />
                  <h3 className="text-sm font-medium">{attemptLabel(entry)}</h3>
                  <span className="text-xs text-muted-foreground">attempt {entry.blockRun}</span>
                  <span
                    className={cn(
                      'rounded-full px-2 py-0.5 text-[11px] font-medium',
                      statusClass(entry.status),
                    )}
                  >
                    {entry.status.replaceAll('_', ' ')}
                  </span>
                  {entry.startedAt === null ? null : (
                    <time
                      className="ml-auto text-[11px] tabular-nums text-muted-foreground"
                      dateTime={entry.startedAt}
                    >
                      {formatOperatorTimestamp(entry.startedAt)}
                    </time>
                  )}
                </header>
                {events.length === 0 ? (
                  <p className="rounded-lg border border-dashed border-border px-3 py-3 text-xs text-muted-foreground">
                    {entry.resultSummary ?? 'No readable provider events recorded.'}
                  </p>
                ) : (
                  <ol className="space-y-2 pl-2">
                    {events.map((event, index) => (
                      <EventRow event={event} key={`${entry.id}-${event.kind}-${String(index)}`} />
                    ))}
                  </ol>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
};
