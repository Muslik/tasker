import { fileURLToPath } from 'node:url';

import { connectTaskerTemporalWorker } from './worker.js';
import { DEFAULT_TEMPORAL_CLIENT_CONFIGURATION } from './client.js';

const configuration = {
  ...DEFAULT_TEMPORAL_CLIENT_CONFIGURATION,
  address: process.env.TASKER_TEMPORAL_ADDRESS ?? DEFAULT_TEMPORAL_CLIENT_CONFIGURATION.address,
  namespace:
    process.env.TASKER_TEMPORAL_NAMESPACE ?? DEFAULT_TEMPORAL_CLIENT_CONFIGURATION.namespace,
  taskQueue:
    process.env.TASKER_TEMPORAL_TASK_QUEUE ?? DEFAULT_TEMPORAL_CLIENT_CONFIGURATION.taskQueue,
};

export const startTaskerTemporalWorker = async (): Promise<void> => {
  const runtime = await connectTaskerTemporalWorker(configuration);

  try {
    await runtime.worker.run();
  } finally {
    await runtime.connection.close();
  }
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await startTaskerTemporalWorker();
}
