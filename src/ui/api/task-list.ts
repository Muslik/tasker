import { queryOptions, type QueryClient } from '@tanstack/react-query';

import {
  OperatorTaskListResponseSchema,
  type OperatorTaskListResponse,
  type OperatorTaskSummary,
} from '../../control-plane/operator-contracts.js';
import { getJson } from './http.js';
import { operatorQueryKeys } from './query.js';

export const fetchTaskList = async (): Promise<OperatorTaskListResponse> =>
  getJson('/api/operator/tasks', OperatorTaskListResponseSchema);

export const taskListQueryOptions = () =>
  queryOptions({
    queryKey: operatorQueryKeys.taskList(),
    queryFn: fetchTaskList,
  });

export interface TaskListSnapshot {
  readonly previous: OperatorTaskListResponse | undefined;
}

export const captureTaskListSnapshot = (queryClient: QueryClient): TaskListSnapshot => ({
  previous: queryClient.getQueryData<OperatorTaskListResponse>(operatorQueryKeys.taskList()),
});

export const restoreTaskListSnapshot = (
  queryClient: QueryClient,
  snapshot: TaskListSnapshot,
): void => {
  if (snapshot.previous === undefined) {
    queryClient.removeQueries({ queryKey: operatorQueryKeys.taskList(), exact: true });
    return;
  }

  queryClient.setQueryData(operatorQueryKeys.taskList(), snapshot.previous);
};

export const updateTaskInTaskList = (
  queryClient: QueryClient,
  taskReference: string,
  update: (task: OperatorTaskSummary) => OperatorTaskSummary,
): TaskListSnapshot => {
  const snapshot = captureTaskListSnapshot(queryClient);
  if (snapshot.previous === undefined) return snapshot;

  const taskIndex = snapshot.previous.tasks.findIndex((task) => task.id === taskReference);
  if (taskIndex < 0) return snapshot;

  const tasks = [...snapshot.previous.tasks];
  const currentTask = tasks[taskIndex];
  if (currentTask === undefined) return snapshot;
  tasks[taskIndex] = update(currentTask);
  queryClient.setQueryData<OperatorTaskListResponse>(operatorQueryKeys.taskList(), {
    ...snapshot.previous,
    tasks,
  });

  return snapshot;
};
