import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import type {
  OperatorActivityResponse,
  OperatorTaskSummary,
  OperatorWorkflowProjection,
} from '../../control-plane/operator-contracts.js';
import {
  taskActivityQueryOptions,
  taskCurrentRunQueryOptions,
  taskExecutionAttemptQueryOptions,
  taskProjectionQueryOptions,
  taskRunLogQueryOptions,
} from '../api/index.js';
import { formatDuration } from '../lib/format.js';
import { AttemptDetails, type AttemptDetailsTab } from './AttemptDetails.js';
import { AttemptsList, type AttemptSelection } from './AttemptsList.js';
import { StatusChip } from './StatusChip.js';
import { TaskActions } from './TaskActions.js';
import { WorkflowRail } from './WorkflowRail.js';

export type TaskHeaderView = {
  readonly node: string;
  readonly attempt: string;
  readonly timeInState: string;
  readonly waitReason: string | null;
};

export const buildTaskHeaderView = (
  projection: OperatorWorkflowProjection,
  activity: OperatorActivityResponse | undefined,
  updatedAt: string | null,
  now = Date.now(),
): TaskHeaderView => {
  const latestActivity = activity?.entries.at(-1)?.occurredAt ?? updatedAt;
  return {
    node: projection.current?.nodeId ?? 'No active node',
    attempt:
      projection.current?.blockRun === null || projection.current?.blockRun === undefined
        ? '—'
        : String(projection.current.blockRun),
    timeInState: formatDuration(latestActivity, null, now),
    waitReason:
      projection.current?.status === 'waiting'
        ? (projection.current.reason ?? 'The workflow is waiting for operator input.')
        : null,
  };
};

export type TaskCardProps = {
  readonly task: OperatorTaskSummary;
};

export const TaskCard = ({ task }: TaskCardProps) => {
  const [selectedAttempt, setSelectedAttempt] = useState<AttemptSelection | null>(null);
  const [selectedTab, setSelectedTab] = useState<AttemptDetailsTab>('log');
  const projectionQuery = useQuery(taskProjectionQueryOptions(task.id));
  const activityQuery = useQuery(taskActivityQueryOptions(task.id));
  const runLogQuery = useQuery(taskRunLogQueryOptions(task.id));
  const currentRunQuery = useQuery(taskCurrentRunQueryOptions(task.id));

  const selectedEntry =
    selectedAttempt === null
      ? null
      : (runLogQuery.data?.entries.find(
          (entry) =>
            entry.nodeId === selectedAttempt.nodeId && entry.blockRun === selectedAttempt.blockRun,
        ) ?? null);
  const attemptIdentity = selectedAttempt ?? { nodeId: 'unselected', blockRun: 1 };
  const attemptQuery = useQuery({
    ...taskExecutionAttemptQueryOptions(task.id, attemptIdentity),
    enabled: selectedEntry?.runtime === 'execution',
  });

  const projection = projectionQuery.data;
  if (projection === undefined) {
    return (
      <article className="grid h-full place-items-center p-6">
        <div className="max-w-md rounded-xl border bg-card p-6 text-center">
          <StatusChip status={task.status} />
          <h1 className="mt-3 text-lg font-semibold">{task.title}</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {projectionQuery.isPending
              ? 'Loading the workflow projection…'
              : projectionQuery.error.message}
          </p>
        </div>
      </article>
    );
  }

  const header = buildTaskHeaderView(projection, activityQuery.data, task.updatedAt);
  const errors = [activityQuery.error, runLogQuery.error, currentRunQuery.error, attemptQuery.error]
    .filter((error): error is Error => error instanceof Error)
    .map((error) => error.message);

  return (
    <article className="min-h-0 overflow-y-auto bg-background">
      <header className="sticky top-0 z-20 border-b bg-background/95 px-5 py-4 backdrop-blur">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold tracking-[0.16em] text-muted-foreground uppercase">
                {task.taskId}
              </span>
              <StatusChip status={task.status} />
            </div>
            <h1 className="mt-2 text-xl font-semibold tracking-tight">{task.title}</h1>
            <p className="mt-1 text-sm text-muted-foreground">{task.currentStage}</p>
          </div>
          <dl className="grid grid-cols-3 gap-x-5 gap-y-2 text-right text-xs tabular-nums">
            <div>
              <dt className="text-muted-foreground">Current node</dt>
              <dd className="mt-1 max-w-48 truncate font-medium text-foreground">{header.node}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Attempt</dt>
              <dd className="mt-1 font-medium text-foreground">{header.attempt}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Time in state</dt>
              <dd className="mt-1 font-medium text-foreground">{header.timeInState}</dd>
            </div>
          </dl>
        </div>
        {header.waitReason === null ? null : (
          <div className="mt-4 rounded-lg border border-amber-400/50 bg-amber-500/10 px-3 py-2.5">
            <p className="text-xs font-semibold text-amber-800 dark:text-amber-200">Wait reason</p>
            <p className="mt-1 whitespace-pre-wrap text-sm text-foreground">{header.waitReason}</p>
          </div>
        )}
      </header>

      <div className="grid gap-4 p-5 xl:grid-cols-[minmax(16rem,0.72fr)_minmax(32rem,1.8fr)]">
        <div className="space-y-4">
          <WorkflowRail
            stages={projection.stages}
            currentNodeId={projection.current?.nodeId ?? null}
          />
          <section aria-label="Tokens" className="rounded-xl border border-dashed bg-card p-4">
            <h2 className="text-sm font-semibold">Tokens</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Token totals will appear here when the operator API exposes them.
            </p>
          </section>
        </div>
        <div className="space-y-4">
          <TaskActions
            task={task}
            projection={projection}
            currentRun={currentRunQuery.data ?? null}
          />
          {errors.length === 0 ? null : (
            <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
              {errors.join(' ')}
            </div>
          )}
          <AttemptsList
            runLog={runLogQuery.data ?? null}
            selectedAttempt={selectedAttempt}
            onSelectAttempt={(selection) => {
              setSelectedAttempt(selection);
              setSelectedTab('log');
            }}
          />
          <AttemptDetails
            entry={selectedEntry}
            attempt={selectedEntry?.runtime === 'execution' ? (attemptQuery.data ?? null) : null}
            selectedTab={selectedTab}
            onTabChange={setSelectedTab}
          />
        </div>
      </div>
    </article>
  );
};
