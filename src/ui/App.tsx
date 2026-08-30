import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import type { OperatorTaskSummary } from '../server/operator-contracts.js';
import {
  generateTask,
  jiraIssueQueryOptions,
  repositoriesQueryOptions,
  restoreTask,
  previewJiraIssue,
  removeTask,
  syncJiraIssue,
  taskListQueryOptions,
  taskProjectionQueryOptions,
} from './api/index.js';
import { TaskCard } from './components/TaskCard.js';
import { TaskQueue } from './components/TaskQueue.js';
import { RealtimeBridge } from './RealtimeBridge.js';
import { JiraTaskLaunchDialog, type JiraTaskLaunchInput } from './components/TaskDialogs.js';
import { RemoveTaskDialog } from './components/RemoveTaskDialog.js';

export const taskReferenceFromHash = (): string | null => {
  if (typeof window === 'undefined') return null;
  return new URLSearchParams(window.location.hash.slice(1)).get('task');
};

export const resolveSelectedTask = (
  tasks: readonly OperatorTaskSummary[],
  taskReference: string | null,
): OperatorTaskSummary | null =>
  tasks.find((task) => task.id === taskReference) ?? tasks.at(0) ?? null;

const writeTaskReference = (taskReference: string): void => {
  const nextHash = `task=${encodeURIComponent(taskReference)}`;
  if (window.location.hash.slice(1) !== nextHash) window.location.hash = nextHash;
};

export const App = () => {
  const queryClient = useQueryClient();
  const [selectedReference, setSelectedReference] = useState(taskReferenceFromHash);
  const [launchMode, setLaunchMode] = useState<'add' | 'start' | null>(null);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [operationError, setOperationError] = useState<string | null>(null);
  const taskListQuery = useQuery(taskListQueryOptions());
  const tasks = taskListQuery.data?.tasks ?? [];
  const selectedTask = resolveSelectedTask(tasks, selectedReference);
  const selectedId = selectedTask?.id ?? 'unselected';
  const selectedProjectionQuery = useQuery({
    ...taskProjectionQueryOptions(selectedId),
    enabled: selectedTask !== null,
  });
  const repositoriesQuery = useQuery(repositoriesQueryOptions());
  const issueKey = selectedTask?.origin.kind === 'jira' ? selectedTask.origin.issueKey : '';
  const selectedIssueQuery = useQuery({
    ...jiraIssueQueryOptions(issueKey),
    enabled: issueKey.length > 0 && launchMode === 'start',
  });
  const launchMutation = useMutation({
    mutationFn: async (input: JiraTaskLaunchInput) => {
      const issue = await syncJiraIssue(
        input.issueKey,
        input.repository.length === 0 ? undefined : input.repository,
      );
      const normalizedKey = issue.status === 'unavailable' ? issue.issueKey : issue.issue.issueKey;
      const taskReference = `jira:${normalizedKey}`;
      await restoreTask(taskReference);
      if (input.startImmediately) await generateTask(taskReference, { settings: input.settings });
      return taskReference;
    },
    onSuccess: async (taskReference) => {
      await queryClient.invalidateQueries({ queryKey: ['operator'] });
      setLaunchMode(null);
      setOperationError(null);
      selectTask(taskReference);
    },
    onError: (error: Error) => {
      setOperationError(error.message);
    },
  });
  const removeMutation = useMutation({
    mutationFn: async () => {
      if (selectedTask === null) throw new Error('No task is selected');
      await removeTask(selectedTask.id, selectedTask.taskId);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['operator', 'task-list'] });
      setRemoveOpen(false);
      setSelectedReference(null);
      setOperationError(null);
    },
    onError: (error: Error) => {
      setOperationError(error.message);
    },
  });

  useEffect(() => {
    const onHashChange = (): void => {
      setSelectedReference(taskReferenceFromHash());
    };
    window.addEventListener('hashchange', onHashChange);
    return () => {
      window.removeEventListener('hashchange', onHashChange);
    };
  }, []);

  const selectTask = (taskReference: string): void => {
    setSelectedReference(taskReference);
    writeTaskReference(taskReference);
  };

  return (
    <div className="grid h-full grid-rows-[3.25rem_minmax(0,1fr)] bg-background text-foreground">
      {taskListQuery.data === undefined ? null : (
        <RealtimeBridge initialSequence={taskListQuery.data.streamCursor} />
      )}
      <header className="flex items-center justify-between border-b bg-card px-4">
        <div className="flex items-baseline gap-3">
          <h1 className="text-sm font-semibold tracking-tight">Tasker Operator</h1>
          <span className="text-xs text-muted-foreground">Rebuild foundation</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs tabular-nums text-muted-foreground">
            {tasks.length} {tasks.length === 1 ? 'task' : 'tasks'}
          </span>
          <button
            type="button"
            className="rounded-md border px-2.5 py-1.5 text-xs font-medium hover:bg-muted"
            onClick={() => {
              setOperationError(null);
              setLaunchMode('add');
            }}
          >
            Add Jira task
          </button>
        </div>
      </header>
      <main className="grid min-h-0 grid-rows-[15rem_minmax(0,1fr)] md:grid-cols-[minmax(17rem,21rem)_minmax(0,1fr)] md:grid-rows-1">
        <TaskQueue
          tasks={tasks}
          selectedTaskReference={selectedTask?.id ?? null}
          selectedNodeId={selectedProjectionQuery.data?.current?.nodeId ?? null}
          onSelect={selectTask}
        />
        {taskListQuery.isPending ? (
          <section className="grid place-items-center p-8 text-sm text-muted-foreground">
            Loading operator tasks…
          </section>
        ) : taskListQuery.error !== null ? (
          <section className="grid place-items-center p-8">
            <div className="max-w-md rounded-xl border border-destructive/40 bg-destructive/10 p-5">
              <h2 className="font-semibold text-destructive">Task queue unavailable</h2>
              <p className="mt-2 text-sm text-muted-foreground">{taskListQuery.error.message}</p>
            </div>
          </section>
        ) : selectedTask === null ? (
          <section className="grid place-items-center p-8 text-center">
            <div>
              <h2 className="text-lg font-semibold">No operator tasks</h2>
              <p className="mt-2 text-sm text-muted-foreground">
                Tasks will appear here when they enter the operator queue.
              </p>
            </div>
          </section>
        ) : (
          <TaskCard
            key={selectedTask.id}
            task={selectedTask}
            onStart={() => {
              setLaunchMode('start');
            }}
            onRemove={() => {
              setRemoveOpen(true);
            }}
          />
        )}
      </main>
      <JiraTaskLaunchDialog
        open={launchMode !== null}
        mode={launchMode ?? 'add'}
        repositories={repositoriesQuery.data ?? []}
        {...(selectedIssueQuery.data?.status === 'current' ||
        selectedIssueQuery.data?.status === 'stale'
          ? { initialIssue: selectedIssueQuery.data.issue }
          : {})}
        initialRepository={
          selectedTask?.origin.kind === 'jira' &&
          selectedTask.origin.repositoryBinding.status === 'resolved'
            ? selectedTask.origin.repositoryBinding.reference
            : ''
        }
        pending={launchMutation.isPending}
        error={operationError}
        onClose={() => {
          setLaunchMode(null);
        }}
        onResolveIssue={fetchJiraIssueSnapshot}
        onSubmit={(input) => launchMutation.mutateAsync(input).then(() => undefined)}
      />
      {selectedTask === null || !removeOpen ? null : (
        <RemoveTaskDialog
          task={selectedTask}
          pending={removeMutation.isPending}
          error={operationError}
          onClose={() => {
            setRemoveOpen(false);
          }}
          onConfirm={() => {
            removeMutation.mutate();
          }}
        />
      )}
    </div>
  );
};

const fetchJiraIssueSnapshot = async (issueKey: string) => {
  return previewJiraIssue(issueKey);
};
