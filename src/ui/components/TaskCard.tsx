import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import type {
  ExecutionRunView,
  OperatorRunLogResponse,
  OperatorTaskInvocationListResponse,
  OperatorTaskSummary,
  OperatorWorkflowProjection,
} from '../../server/operator-contracts.js';
import {
  invalidateTaskQueries,
  taskCurrentRunQueryOptions,
  taskExecutionAttemptQueryOptions,
  taskInvocationQueryOptions,
  taskInvocationsQueryOptions,
  taskProjectionQueryOptions,
  taskRunLogQueryOptions,
} from '../api/index.js';
import { AgentActivityFeed } from './AgentActivityFeed.js';
import { AttemptDetails, type AttemptDetailsTab } from './AttemptDetails.js';
import { AttemptsList, type AttemptSelection } from './AttemptsList.js';
import { CurrentAttemptStatus, type InvocationSelection } from './CurrentAttemptStatus.js';
import { InvocationTokens } from './InvocationTokens.js';
import { StatusChip } from './StatusChip.js';
import { TaskActions } from './TaskActions.js';
import { TaskOperatorSurfaces } from './TaskOperatorSurfaces.js';
import { WaitBanner } from './WaitBanner.js';
import { WorkflowRail } from './WorkflowRail.js';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './ui/collapsible.js';

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

type RunViewProps = {
  readonly task: OperatorTaskSummary;
  readonly projection: OperatorWorkflowProjection;
  readonly currentRun: ExecutionRunView | null;
  readonly runLog: OperatorRunLogResponse | null;
  readonly invocations: OperatorTaskInvocationListResponse | null;
  readonly errors: readonly string[];
  readonly onStart?: () => void;
  readonly onRemove?: () => void;
};

const TaskRunView = ({
  task,
  projection,
  currentRun,
  runLog,
  invocations,
  onStart,
  onRemove,
  errors,
}: RunViewProps) => {
  const [selectedAttempt, setSelectedAttempt] = useState<AttemptSelection | null>(null);
  const [selectedTab, setSelectedTab] = useState<AttemptDetailsTab>('log');
  const selectedInvocationId = selectedAttempt?.invocationId ?? null;
  const selectedAttemptIdentity =
    selectedAttempt !== null && selectedAttempt.nodeId !== null && selectedAttempt.blockRun !== null
      ? { nodeId: selectedAttempt.nodeId, blockRun: selectedAttempt.blockRun }
      : null;
  const selectedEntry =
    selectedAttemptIdentity === null
      ? null
      : (runLog?.entries.find(
          (entry) =>
            entry.nodeId === selectedAttemptIdentity.nodeId &&
            entry.blockRun === selectedAttemptIdentity.blockRun,
        ) ?? null);
  const attemptIdentity = selectedAttemptIdentity ?? { nodeId: 'unselected', blockRun: 1 };
  const attemptQuery = useQuery({
    ...taskExecutionAttemptQueryOptions(task.id, attemptIdentity),
    enabled: selectedEntry?.runtime === 'execution',
  });
  const invocationQuery = useQuery({
    ...(selectedInvocationId === null
      ? taskInvocationQueryOptions(task.id, 'unselected')
      : taskInvocationQueryOptions(task.id, selectedInvocationId)),
    enabled: selectedInvocationId !== null,
  });
  const openInvocation = (selection: InvocationSelection): void => {
    triggerTaskInvocationOpen(selection, setSelectedAttempt, setSelectedTab);
  };
  const detailErrors = [attemptQuery.error, invocationQuery.error]
    .filter((error): error is Error => error instanceof Error)
    .map((error) => error.message);

  return (
    <div className="grid min-h-0 min-w-0 grid-cols-1 grid-rows-[minmax(0,1fr)_auto] xl:grid-cols-[minmax(0,1fr)_23rem] xl:grid-rows-1">
      <section className="min-h-0 min-w-0 overflow-y-auto bg-background">
        <header className="sticky top-0 z-20 border-b bg-background/95 px-5 py-4 backdrop-blur">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <span className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                {task.taskId}
              </span>
              <h1 className="mt-2 text-xl font-semibold tracking-tight">{task.title}</h1>
            </div>
            <CurrentAttemptStatus
              projection={projection}
              status={task.status}
              showWaitLine={false}
              onOpenInvocation={openInvocation}
              actions={
                projection.current?.status === 'waiting' ? null : (
                  <TaskActions
                    task={task}
                    projection={projection}
                    currentRun={currentRun}
                    {...(onStart === undefined ? {} : { onSettings: onStart })}
                    {...(onRemove === undefined ? {} : { onRemove })}
                  />
                )
              }
            />
          </div>
          {currentRun?.settings?.operatorBrief ? (
            <details className="mt-3 rounded-lg border bg-card px-3 py-2">
              <summary className="cursor-pointer text-sm font-medium">Бриф оператора</summary>
              <p className="mt-2 whitespace-pre-wrap break-words text-sm text-muted-foreground">
                {currentRun.settings.operatorBrief}
              </p>
            </details>
          ) : null}
        </header>
        <WaitBanner
          task={task}
          projection={projection}
          currentRun={currentRun}
          {...(onStart === undefined ? {} : { onStart })}
          {...(onRemove === undefined ? {} : { onRemove })}
          onOpenInvocation={openInvocation}
        />
        <div className="space-y-6 p-5">
          <TaskOperatorSurfaces task={task} projection={projection} currentRun={currentRun} />
          <AgentActivityFeed runLog={runLog} />
          {errors.length + detailErrors.length === 0 ? null : (
            <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
              {[...errors, ...detailErrors].join(' ')}
            </div>
          )}
          <details>
            <summary className="cursor-pointer text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              Attempts and invocation details
            </summary>
            <div className="mt-4 space-y-4">
              <AttemptsList
                runLog={runLog}
                invocations={invocations?.invocations ?? null}
                selectedAttempt={selectedAttempt}
                onOpenInvocation={openInvocation}
                onSelectAttempt={(selection) => {
                  setSelectedAttempt(selection);
                  setSelectedTab('log');
                }}
              />
              <AttemptDetails
                entry={selectedEntry}
                attempt={
                  selectedEntry?.runtime === 'execution' ? (attemptQuery.data ?? null) : null
                }
                selectedTab={selectedTab}
                onTabChange={setSelectedTab}
                invocationDetail={invocationQuery.data ?? null}
                invocationDetailPending={selectedInvocationId !== null && invocationQuery.isPending}
                invocationDetailError={
                  invocationQuery.error instanceof Error ? invocationQuery.error : null
                }
                invocationId={selectedInvocationId}
              />
            </div>
          </details>
        </div>
      </section>
      <aside className="min-h-0 min-w-0 overflow-y-auto border-t border-border bg-card xl:border-l xl:border-t-0">
        <WorkflowRail
          stages={projection.stages}
          currentNodeId={projection.current?.nodeId ?? null}
          invocations={invocations}
        />
        <Collapsible defaultOpen className="border-t px-4 py-3">
          <CollapsibleTrigger className="text-sm font-medium">
            Token details table
          </CollapsibleTrigger>
          <CollapsibleContent>
            <InvocationTokens
              invocations={invocations}
              onOpenInvocation={openInvocation}
              className="mt-3"
            />
          </CollapsibleContent>
        </Collapsible>
      </aside>
    </div>
  );
};

export const TaskCard = ({ task, onStart, onRemove }: TaskCardProps) => {
  const queryClient = useQueryClient();
  const projectionQuery = useQuery(taskProjectionQueryOptions(task.id));
  const runLogQuery = useQuery(taskRunLogQueryOptions(task.id));
  const currentRunQuery = useQuery(taskCurrentRunQueryOptions(task.id));
  const invocationsQuery = useQuery(taskInvocationsQueryOptions(task.id));

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
      <article className="grid min-h-0 min-w-0 place-items-center p-6">
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

  const errors = [runLogQuery.error, currentRunQuery.error, invocationsQuery.error]
    .filter((error): error is Error => error instanceof Error)
    .map((error) => error.message);

  return (
    <article className="min-h-0 min-w-0">
      <TaskRunView
        task={task}
        projection={projection}
        currentRun={currentRunQuery.data ?? null}
        runLog={runLogQuery.data ?? null}
        invocations={invocationsQuery.data ?? null}
        errors={errors}
        {...(onStart === undefined ? {} : { onStart })}
        {...(onRemove === undefined ? {} : { onRemove })}
      />
    </article>
  );
};
