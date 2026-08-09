import { fileURLToPath } from 'node:url';
import { NativeConnection, Worker } from '@temporalio/worker';

import {
  DEFAULT_TEMPORAL_CLIENT_CONFIGURATION,
  type TemporalClientConfiguration,
} from './client.js';
import type { BootstrapWorkflowActivities } from './bootstrap-kernel/contracts.js';
import type { ExecutionWorkflowActivities } from './execution-kernel/contracts.js';

type TaskerTemporalActivities = BootstrapWorkflowActivities & ExecutionWorkflowActivities;

export interface TaskerTemporalWorkerOptions {
  readonly connection: NativeConnection;
  readonly namespace: string;
  readonly taskQueue: string;
  readonly workflowsPath: string;
  readonly activities: TaskerTemporalActivities;
}

export const createTaskerTemporalWorker = async (
  options: Pick<TaskerTemporalWorkerOptions, 'activities' | 'connection'> &
    Partial<Omit<TaskerTemporalWorkerOptions, 'activities' | 'connection'>>,
): Promise<Worker> =>
  Worker.create({
    connection: options.connection,
    namespace: options.namespace ?? DEFAULT_TEMPORAL_CLIENT_CONFIGURATION.namespace,
    taskQueue: options.taskQueue ?? DEFAULT_TEMPORAL_CLIENT_CONFIGURATION.taskQueue,
    workflowsPath:
      options.workflowsPath ?? fileURLToPath(new URL('./workflows/index.js', import.meta.url)),
    activities: options.activities,
  });

export const connectTaskerTemporalWorker = async (
  configuration: TemporalClientConfiguration,
  activities: TaskerTemporalActivities,
): Promise<{ readonly connection: NativeConnection; readonly worker: Worker }> => {
  const connection = await NativeConnection.connect({ address: configuration.address });
  return {
    connection,
    worker: await createTaskerTemporalWorker({
      connection,
      namespace: configuration.namespace,
      taskQueue: configuration.taskQueue,
      activities,
    }),
  };
};
