import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import type { OperatorTaskSummary } from '../server/operator-contracts.js';
import { taskListQueryOptions, taskProjectionQueryOptions } from './api/index.js';
import { TaskCard } from './components/TaskCard.js';
import { TaskQueue } from './components/TaskQueue.js';
import { RealtimeBridge } from './RealtimeBridge.js';

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
  const [selectedReference, setSelectedReference] = useState(taskReferenceFromHash);
  const taskListQuery = useQuery(taskListQueryOptions());
  const tasks = taskListQuery.data?.tasks ?? [];
  const selectedTask = resolveSelectedTask(tasks, selectedReference);
  const selectedId = selectedTask?.id ?? 'unselected';
  const selectedProjectionQuery = useQuery({
    ...taskProjectionQueryOptions(selectedId),
    enabled: selectedTask !== null,
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
        <span className="text-xs tabular-nums text-muted-foreground">
          {tasks.length} {tasks.length === 1 ? 'task' : 'tasks'}
        </span>
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
          <TaskCard key={selectedTask.id} task={selectedTask} />
        )}
      </main>
    </div>
  );
};
