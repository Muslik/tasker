import type { OperatorTaskSummary } from '../../server/operator-contracts.js';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '../lib/utils.js';
import { formatElapsed } from '../lib/format.js';
import { StatusChip } from './StatusChip.js';

type TaskQueueIndicator = {
  readonly label: string;
  readonly className: string;
};

export type TaskQueueItemViewModel = {
  readonly task: OperatorTaskSummary;
  readonly selected: boolean;
  readonly currentNodeId: string | null;
  readonly elapsed: string;
  readonly indicator: TaskQueueIndicator | null;
  readonly select: () => void;
};

export type TaskQueueProps = {
  readonly tasks: readonly OperatorTaskSummary[];
  readonly selectedTaskReference: string | null;
  readonly selectedNodeId?: string | null;
  readonly onSelect: (taskReference: string) => void;
  readonly collapsed?: boolean;
  readonly onToggleCollapsed?: () => void;
};

const statusDotClass = (task: OperatorTaskSummary): string => {
  if (task.attention === 'operator' || task.status === 'needs_attention') return 'bg-orange-400';
  switch (task.status) {
    case 'running':
      return 'bg-sky-400';
    case 'waiting':
    case 'plan_review':
    case 'code_review':
      return 'bg-amber-400';
    case 'done':
      return 'bg-emerald-400';
    case 'failed':
    case 'workflow_rejected':
      return 'bg-red-400';
    case 'backlog':
    case 'planned':
    case 'queued':
      return 'bg-muted-foreground/50';
  }
};

const buildIndicator = (task: OperatorTaskSummary): TaskQueueIndicator | null => {
  if (task.attention === 'operator' || task.status === 'needs_attention') {
    return {
      label: 'Operator action',
      className:
        'border-orange-200/80 bg-orange-500/10 text-orange-700 dark:border-orange-400/40 dark:bg-orange-400/15 dark:text-orange-200',
    };
  }

  switch (task.status) {
    case 'backlog':
    case 'planned':
    case 'workflow_rejected':
    case 'queued':
    case 'running':
    case 'done':
    case 'failed':
      return null;
    case 'waiting':
      return {
        label: 'Waiting',
        className:
          'border-amber-200/80 bg-amber-500/10 text-amber-700 dark:border-amber-400/40 dark:bg-amber-400/15 dark:text-amber-200',
      };
    case 'plan_review':
      return {
        label: 'Plan review',
        className:
          'border-amber-200/80 bg-amber-500/10 text-amber-700 dark:border-amber-400/40 dark:bg-amber-400/15 dark:text-amber-200',
      };
    case 'code_review':
      return {
        label: 'Code review',
        className:
          'border-violet-200/80 bg-violet-500/10 text-violet-700 dark:border-violet-400/40 dark:bg-violet-400/15 dark:text-violet-200',
      };
  }
};

export const buildTaskQueueItems = (
  props: TaskQueueProps,
  now = Date.now(),
): readonly TaskQueueItemViewModel[] =>
  props.tasks.map((task) => {
    const selected = task.id === props.selectedTaskReference;

    return {
      task,
      selected,
      currentNodeId: selected ? (props.selectedNodeId ?? null) : null,
      elapsed: formatElapsed(task.updatedAt, now),
      indicator: buildIndicator(task),
      select: () => {
        props.onSelect(task.id);
      },
    };
  });

export const TaskQueue = ({ collapsed = false, onToggleCollapsed, ...props }: TaskQueueProps) => {
  const items = buildTaskQueueItems(props);

  return (
    <aside
      aria-label="Task queue"
      className={cn(
        'flex h-full min-h-0 w-full flex-col border-r border-border',
        'bg-[linear-gradient(180deg,rgba(248,250,252,0.96),rgba(248,250,252,0.82))]',
        'dark:bg-[linear-gradient(180deg,rgba(15,23,42,0.96),rgba(15,23,42,0.82))]',
      )}
    >
      {collapsed ? (
        <div className="flex min-h-0 flex-1 flex-col items-center gap-3 py-3">
          <button
            type="button"
            aria-label="Expand task queue"
            title="Expand task queue"
            className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={onToggleCollapsed}
          >
            <ChevronRight className="size-4" />
          </button>
          <span className="text-xs font-semibold tabular-nums text-foreground">{items.length}</span>
          <ol
            className="flex min-h-0 flex-col items-center gap-3 overflow-y-auto"
            aria-label="Task statuses"
          >
            {items.map(({ task, selected, select }) => (
              <li key={task.id}>
                <button
                  type="button"
                  aria-label={`Select task ${task.taskId}: ${task.title}`}
                  aria-pressed={selected}
                  title={`${task.taskId}: ${task.title}`}
                  className="rounded-full p-1.5 hover:bg-muted"
                  onClick={select}
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      'block size-2.5 rounded-full',
                      statusDotClass(task),
                      selected && 'ring-2 ring-ring ring-offset-2 ring-offset-background',
                    )}
                  />
                </button>
              </li>
            ))}
          </ol>
        </div>
      ) : (
        <>
          <div className="flex items-start justify-between gap-3 border-b border-border/80 px-4 py-3">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-muted-foreground">
                Task queue
              </p>
              <p className="mt-1 text-sm text-foreground">{items.length} active tasks</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Stage, status, and latest activity stay readable while the selected task remains
                pinned.
              </p>
            </div>
            <button
              type="button"
              aria-label="Collapse task queue"
              title="Collapse task queue"
              className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={onToggleCollapsed}
            >
              <ChevronLeft className="size-4" />
            </button>
          </div>
          <ol
            className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-3"
            data-testid="task-queue"
          >
            {items.map(({ task, selected, currentNodeId, elapsed, indicator, select }) => (
              <li key={task.id}>
                <button
                  aria-current={selected ? 'true' : undefined}
                  aria-label={`Select task ${task.taskId}: ${task.title}`}
                  aria-pressed={selected}
                  className={cn(
                    'relative w-full rounded-xl border px-3 py-3 text-left transition-colors',
                    'hover:border-border/80 hover:bg-background/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/40',
                    selected
                      ? 'border-sky-200 bg-background shadow-sm dark:border-sky-400/40 dark:bg-slate-900/80'
                      : 'border-border/60 bg-background/40',
                  )}
                  data-task-reference={task.id}
                  type="button"
                  onClick={select}
                >
                  {selected ? (
                    <span
                      aria-hidden="true"
                      className="absolute inset-y-3 left-0 w-0.5 rounded-r-full bg-sky-500"
                    />
                  ) : null}
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-[11px] font-semibold tracking-[0.18em] text-muted-foreground">
                        {task.taskId}
                      </p>
                      <p className="mt-1 line-clamp-2 text-sm font-medium leading-5 text-foreground">
                        {task.title}
                      </p>
                    </div>
                    <StatusChip status={task.status} />
                  </div>
                  <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
                    {indicator === null ? null : (
                      <span
                        className={cn(
                          'col-span-2 inline-flex w-fit items-center rounded-full border px-2 py-0.5 font-medium',
                          indicator.className,
                        )}
                      >
                        {indicator.label}
                      </span>
                    )}
                    <dt>Stage</dt>
                    <dd className="truncate text-foreground/80">{task.currentStage}</dd>
                    <dt>Updated</dt>
                    <dd>
                      <time dateTime={task.updatedAt ?? undefined}>{elapsed}</time>
                    </dd>
                  </dl>
                  {currentNodeId === null ? null : (
                    <p className="mt-3 border-t border-border/60 pt-2 text-[11px] text-foreground/80">
                      Current node: <code>{currentNodeId}</code>
                    </p>
                  )}
                </button>
              </li>
            ))}
          </ol>
        </>
      )}
    </aside>
  );
};
