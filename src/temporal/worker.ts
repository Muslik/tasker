import { fileURLToPath } from 'node:url';
import { NativeConnection, Worker } from '@temporalio/worker';

import {
  DEFAULT_TEMPORAL_CLIENT_CONFIGURATION,
  type TemporalClientConfiguration,
} from './client.js';
import type { TaskWorkflowActivities } from './contracts.js';
import { stubTaskWorkflowActivities } from './activities/stub-activities.js';

export interface TaskerTemporalWorkerOptions {
  readonly connection: NativeConnection;
  readonly namespace: string;
  readonly taskQueue: string;
  readonly workflowsPath: string;
  readonly activities: TaskWorkflowActivities;
}

export const createTaskerTemporalWorker = async (
  options: Partial<Omit<TaskerTemporalWorkerOptions, 'connection'>> & {
    readonly connection: NativeConnection;
  },
): Promise<Worker> =>
  Worker.create({
    connection: options.connection,
    namespace: options.namespace ?? DEFAULT_TEMPORAL_CLIENT_CONFIGURATION.namespace,
    taskQueue: options.taskQueue ?? DEFAULT_TEMPORAL_CLIENT_CONFIGURATION.taskQueue,
    workflowsPath:
      options.workflowsPath ??
      fileURLToPath(new URL('./workflows/task-workflow.js', import.meta.url)),
    activities: options.activities ?? stubTaskWorkflowActivities,
  });

export const connectTaskerTemporalWorker = async (
  configuration: TemporalClientConfiguration = DEFAULT_TEMPORAL_CLIENT_CONFIGURATION,
): Promise<{ readonly connection: NativeConnection; readonly worker: Worker }> => {
  const connection = await NativeConnection.connect({ address: configuration.address });
  return {
    connection,
    worker: await createTaskerTemporalWorker({
      connection,
      namespace: configuration.namespace,
      taskQueue: configuration.taskQueue,
    }),
  };
};
