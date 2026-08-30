import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';

import type {
  ExecutionRunView,
  OperatorTaskSummary,
  OperatorWorkflowProjection,
} from '../control-plane/operator-contracts.js';
import {
  captureTaskListSnapshot,
  invalidateTaskQueries,
  operatorQueryKeys,
  restoreTaskListSnapshot,
  updateTaskInTaskList,
  type TaskListSnapshot,
} from './api/index.js';

type OptimisticSnapshot = {
  readonly taskList: TaskListSnapshot;
  readonly projection: OperatorWorkflowProjection | undefined;
  readonly currentRun: ExecutionRunView | null | undefined;
};

const setRunningProjection = (
  projection: OperatorWorkflowProjection | undefined,
): OperatorWorkflowProjection | undefined => {
  if (projection?.current?.status !== 'waiting') return projection;
  return {
    ...projection,
    status: 'running',
    current: {
      ...projection.current,
      status: 'running',
      waitKind: null,
      reason: null,
      intervention: null,
    },
  };
};

const setRunningRun = (
  run: ExecutionRunView | null | undefined,
): ExecutionRunView | null | undefined =>
  run?.status === 'waiting' ? { ...run, status: 'running', wait: null } : run;

const beginOptimisticAction = async (
  queryClient: QueryClient,
  task: OperatorTaskSummary,
  currentStage: string,
): Promise<OptimisticSnapshot> => {
  await Promise.all([
    queryClient.cancelQueries({ queryKey: operatorQueryKeys.taskList() }),
    queryClient.cancelQueries({ queryKey: operatorQueryKeys.projection(task.id) }),
    queryClient.cancelQueries({ queryKey: operatorQueryKeys.currentRun(task.id) }),
  ]);
  const taskList = captureTaskListSnapshot(queryClient);
  const projection = queryClient.getQueryData<OperatorWorkflowProjection>(
    operatorQueryKeys.projection(task.id),
  );
  const currentRun = queryClient.getQueryData<ExecutionRunView | null>(
    operatorQueryKeys.currentRun(task.id),
  );

  updateTaskInTaskList(queryClient, task.id, (current) => ({
    ...current,
    status: 'running',
    attention: 'none',
    currentStage,
  }));
  queryClient.setQueryData(operatorQueryKeys.projection(task.id), setRunningProjection(projection));
  queryClient.setQueryData(operatorQueryKeys.currentRun(task.id), setRunningRun(currentRun));
  return { taskList, projection, currentRun };
};

const restoreSnapshot = (
  queryClient: QueryClient,
  taskReference: string,
  snapshot: OptimisticSnapshot,
): void => {
  restoreTaskListSnapshot(queryClient, snapshot.taskList);
  if (snapshot.projection === undefined) {
    queryClient.removeQueries({
      queryKey: operatorQueryKeys.projection(taskReference),
      exact: true,
    });
  } else {
    queryClient.setQueryData(operatorQueryKeys.projection(taskReference), snapshot.projection);
  }
  if (snapshot.currentRun === undefined) {
    queryClient.removeQueries({
      queryKey: operatorQueryKeys.currentRun(taskReference),
      exact: true,
    });
  } else {
    queryClient.setQueryData(operatorQueryKeys.currentRun(taskReference), snapshot.currentRun);
  }
};

export const useWorkflowAction = (
  task: OperatorTaskSummary,
  currentStage: string,
  action: () => Promise<ExecutionRunView>,
) => {
  const queryClient = useQueryClient();
  return useMutation<ExecutionRunView, Error, undefined, OptimisticSnapshot>({
    mutationFn: action,
    onMutate: () => beginOptimisticAction(queryClient, task, currentStage),
    onError: (_error, _variables, snapshot) => {
      if (snapshot !== undefined) restoreSnapshot(queryClient, task.id, snapshot);
    },
    onSuccess: (run) => {
      queryClient.setQueryData(operatorQueryKeys.currentRun(task.id), run);
    },
    onSettled: () => {
      invalidateTaskQueries(queryClient, task.id, { includeRunLog: true, includeAttempts: true });
    },
  });
};
