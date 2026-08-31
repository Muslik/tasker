import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import type { OperatorTaskSummary } from '../../server/operator-contracts.js';
import {
  taskCurrentRunQueryOptions,
  taskExecutionAttemptQueryOptions,
  taskInvocationQueryOptions,
  taskInvocationsQueryOptions,
  taskProjectionQueryOptions,
  taskRunLogQueryOptions,
  invalidateTaskQueries,
} from '../api/index.js';
import { AttemptDetails, type AttemptDetailsTab } from './AttemptDetails.js';
import { AttemptsList, type AttemptSelection } from './AttemptsList.js';
import { CurrentAttemptStatus, type InvocationSelection } from './CurrentAttemptStatus.js';
import { InvocationTokens } from './InvocationTokens.js';
import { StatusChip } from './StatusChip.js';
import { TaskActions } from './TaskActions.js';
import { TaskOperatorSurfaces } from './TaskOperatorSurfaces.js';
import { WorkflowRail } from './WorkflowRail.js';

export type TaskCardProps = {
  readonly task: OperatorTaskSummary;
  readonly onStart?: () => void;
  readonly onRemove?: () => void;
};

export const triggerTaskInvocationOpen = (
  selection: InvocationSelection,
  selectAttempt: (selection: AttemptSelection) => void,
  selectTab: (tab: AttemptDetailsTab) => void,
): InvocationSelection => {
  selectAttempt(selection);
  selectTab('prompt');
  return selection;
};

export const SELECTED_TASK_POLL_INTERVAL_MS = 8_000;

export const shouldPollSelectedTask = (status: OperatorTaskSummary['status']): boolean =>
  status === 'running';

export const TaskCard = ({ task, onStart, onRemove }: TaskCardProps) => {
  const queryClient = useQueryClient();
  const [selectedAttempt, setSelectedAttempt] = useState<AttemptSelection | null>(null);
  const [selectedTab, setSelectedTab] = useState<AttemptDetailsTab>('log');
  const projectionQuery = useQuery(taskProjectionQueryOptions(task.id));
  const runLogQuery = useQuery(taskRunLogQueryOptions(task.id));
  const currentRunQuery = useQuery(taskCurrentRunQueryOptions(task.id));
  const invocationsQuery = useQuery(taskInvocationsQueryOptions(task.id));
  const selectedInvocationId = selectedAttempt?.invocationId ?? null;

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
  const invocationQuery = useQuery({
    ...(selectedInvocationId === null
      ? taskInvocationQueryOptions(task.id, 'unselected')
      : taskInvocationQueryOptions(task.id, selectedInvocationId)),
    enabled: selectedTab === 'prompt' && selectedInvocationId !== null,
  });

  useEffect(() => {
    if (!shouldPollSelectedTask(task.status)) return;
    const poll = (): void => {
      invalidateTaskQueries(queryClient, task.id, {
        includeRunLog: true,
        includeAttempts: true,
        includeInvocations: true,
      });
    };
    const timer = window.setInterval(poll, SELECTED_TASK_POLL_INTERVAL_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, [queryClient, task.id, task.status]);

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

  const openInvocation = (selection: InvocationSelection) => {
    triggerTaskInvocationOpen(selection, setSelectedAttempt, setSelectedTab);
  };
  const errors = [
    runLogQuery.error,
    currentRunQuery.error,
    invocationsQuery.error,
    attemptQuery.error,
    invocationQuery.error,
  ]
    .filter((error): error is Error => error instanceof Error)
    .map((error) => error.message);
  const attemptDetailsProps = {
    entry: selectedEntry,
    attempt: selectedEntry?.runtime === 'execution' ? (attemptQuery.data ?? null) : null,
    selectedTab,
    onTabChange: setSelectedTab,
    invocationDetail: invocationQuery.data ?? null,
    invocationDetailPending: selectedInvocationId !== null && invocationQuery.isPending,
    invocationDetailError: invocationQuery.error instanceof Error ? invocationQuery.error : null,
    invocationId: selectedInvocationId,
  };

  return (
    <article className="min-h-0 overflow-y-auto bg-background">
      <header className="sticky top-0 z-20 border-b bg-background/95 px-5 py-4 backdrop-blur">
        <div className="min-w-0">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold tracking-[0.16em] text-muted-foreground uppercase">
                {task.taskId}
              </span>
            </div>
            <h1 className="mt-2 text-xl font-semibold tracking-tight">{task.title}</h1>
          </div>
          <div className="mt-4">
            <CurrentAttemptStatus
              projection={projection}
              status={task.status}
              onOpenInvocation={openInvocation}
              actions={
                <TaskActions
                  task={task}
                  projection={projection}
                  currentRun={currentRunQuery.data ?? null}
                  {...(onStart === undefined ? {} : { onSettings: onStart })}
                  {...(onRemove === undefined ? {} : { onRemove })}
                />
              }
            />
          </div>
          {currentRunQuery.data?.settings?.operatorBrief ? (
            <details className="mt-3 rounded-lg border bg-card px-3 py-2">
              <summary className="cursor-pointer text-sm font-medium">Бриф оператора</summary>
              <p className="mt-2 whitespace-pre-wrap break-words text-sm text-muted-foreground">
                {currentRunQuery.data.settings.operatorBrief}
              </p>
            </details>
          ) : null}
        </div>
      </header>

      <div className="grid gap-4 p-5 xl:grid-cols-[minmax(16rem,0.72fr)_minmax(32rem,1.8fr)]">
        <div className="space-y-4">
          <WorkflowRail
            stages={projection.stages}
            currentNodeId={projection.current?.nodeId ?? null}
          />
          <InvocationTokens
            invocations={invocationsQuery.data ?? null}
            onOpenInvocation={openInvocation}
          />
        </div>
        <div className="space-y-4">
          <TaskOperatorSurfaces
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
            invocations={invocationsQuery.data?.invocations ?? null}
            selectedAttempt={selectedAttempt}
            onOpenInvocation={openInvocation}
            onSelectAttempt={(selection) => {
              setSelectedAttempt(selection);
              setSelectedTab('log');
            }}
          />
          <AttemptDetails {...attemptDetailsProps} />
        </div>
      </div>
    </article>
  );
};
