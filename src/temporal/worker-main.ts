import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { createImplementationPlanningCoordinator } from '../control-plane/implementation-planning.js';
import { createM1WorkflowService } from '../control-plane/m1-service.js';
import { WorkflowGenerationSubjectSource } from '../control-plane/workflow-generator.js';
import {
  createJiraIssueService,
  JiraServerClient,
  loadJiraConfiguration,
} from '../integrations/index.js';
import { openSqliteLedger } from '../ledger/index.js';
import {
  CodexCliImplementationPlanner,
  DeterministicImplementationPlanner,
  nodeCommandRunner,
} from '../providers/index.js';
import {
  BitbucketRepositoryClient,
  createManagedRepositoryStore,
  loadBitbucketRepositoryConfiguration,
  loadRepositoryCatalogConfiguration,
  UnconfiguredBitbucketRepositorySource,
} from '../repositories/index.js';
import { systemClock } from '../shared/clock.js';
import {
  createPlanningActivity,
  createTemporalActivityCommandRunner,
} from './activities/planning-activity.js';
import { stubTaskWorkflowActivities } from './activities/stub-activities.js';
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
  const databasePath = resolve(process.env.TASKER_DB_PATH ?? '.tasker/m1-operator.sqlite');
  mkdirSync(dirname(databasePath), { recursive: true });
  const ledger = openSqliteLedger({ filename: databasePath, clock: systemClock });
  const workflowService = createM1WorkflowService(ledger.repository, systemClock);
  const bitbucketConfiguration = loadBitbucketRepositoryConfiguration();
  const repositoryCatalog = createManagedRepositoryStore(
    loadRepositoryCatalogConfiguration(),
    bitbucketConfiguration,
    bitbucketConfiguration === null
      ? new UnconfiguredBitbucketRepositorySource()
      : new BitbucketRepositoryClient(bitbucketConfiguration),
  );
  const jiraIssueService = createJiraIssueService(
    ledger.repository,
    systemClock,
    new JiraServerClient(loadJiraConfiguration()),
    { repositoryCatalog },
  );
  const subjects = new WorkflowGenerationSubjectSource(
    resolve(process.env.TASKER_REPOSITORY_PATH ?? '.'),
    jiraIssueService,
  );
  const deterministicProvider = process.env.TASKER_WORKFLOW_PROVIDER === 'deterministic';
  const planning = createImplementationPlanningCoordinator({
    ledger: ledger.repository,
    clock: systemClock,
    workflows: workflowService,
    subjects,
    planner: deterministicProvider
      ? new DeterministicImplementationPlanner()
      : new CodexCliImplementationPlanner(createTemporalActivityCommandRunner(nodeCommandRunner)),
  });
  try {
    const runtime = await connectTaskerTemporalWorker(configuration, {
      ...stubTaskWorkflowActivities,
      ...createPlanningActivity(planning),
    });
    try {
      await runtime.worker.run();
    } finally {
      await runtime.connection.close();
    }
  } finally {
    ledger.close();
  }
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await startTaskerTemporalWorker();
}
