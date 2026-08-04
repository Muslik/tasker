import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openSqliteLedger } from '../ledger/index.js';
import {
  createJiraIssueService,
  JiraServerClient,
  loadJiraConfiguration,
} from '../integrations/index.js';
import {
  CodexCliImplementationPlanner,
  CodexCliWorkflowAnalyzer,
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
  connectTemporalTaskRunService,
  DEFAULT_TEMPORAL_CLIENT_CONFIGURATION,
  LedgerTemporalRunRegistry,
  type TemporalClientConfiguration,
} from '../temporal/index.js';
import { buildM1Api } from './m1-api.js';
import { LedgerExecutionActivityReader } from './execution-activity.js';
import { createImplementationPlanningCoordinator } from './implementation-planning.js';
import { createM1WorkflowService } from './m1-service.js';
import { CodexWorkflowGenerator, WorkflowGenerationSubjectSource } from './workflow-generator.js';
import { createWorkflowContinuationCoordinator } from './workflow-continuation.js';

const parsePort = (input: string | undefined): number => {
  const port = input === undefined ? 4311 : Number(input);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid TASKER_PORT: ${input ?? ''}`);
  }
  return port;
};

export const startM1Server = async (): Promise<void> => {
  const databasePath = resolve(process.env.TASKER_DB_PATH ?? '.tasker/m1-operator.sqlite');
  mkdirSync(dirname(databasePath), { recursive: true });

  const ledger = openSqliteLedger({ filename: databasePath, clock: systemClock });
  const service = createM1WorkflowService(ledger.repository, systemClock);
  const temporalConfiguration: TemporalClientConfiguration = {
    ...DEFAULT_TEMPORAL_CLIENT_CONFIGURATION,
    address: process.env.TASKER_TEMPORAL_ADDRESS ?? DEFAULT_TEMPORAL_CLIENT_CONFIGURATION.address,
    namespace:
      process.env.TASKER_TEMPORAL_NAMESPACE ?? DEFAULT_TEMPORAL_CLIENT_CONFIGURATION.namespace,
    taskQueue:
      process.env.TASKER_TEMPORAL_TASK_QUEUE ?? DEFAULT_TEMPORAL_CLIENT_CONFIGURATION.taskQueue,
  };
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
  const deterministicProviders = process.env.TASKER_WORKFLOW_PROVIDER === 'deterministic';
  const workflowAnalyzer = deterministicProviders
    ? undefined
    : new CodexCliWorkflowAnalyzer(nodeCommandRunner);
  const subjects = new WorkflowGenerationSubjectSource(
    resolve(process.env.TASKER_REPOSITORY_PATH ?? '.'),
    jiraIssueService,
    service,
  );
  const workflowGenerator = new CodexWorkflowGenerator(service, subjects, workflowAnalyzer);
  const implementationPlanning = createImplementationPlanningCoordinator({
    ledger: ledger.repository,
    clock: systemClock,
    workflows: service,
    subjects,
    planner: deterministicProviders
      ? new DeterministicImplementationPlanner()
      : new CodexCliImplementationPlanner(nodeCommandRunner),
  });
  const workflowContinuation = createWorkflowContinuationCoordinator({
    ledger: ledger.repository,
    clock: systemClock,
    workflows: service,
    subjects,
    ...(workflowAnalyzer === undefined ? {} : { analyzer: workflowAnalyzer }),
    repositories: repositoryCatalog,
  });
  const temporalRuntime = await connectTemporalTaskRunService(
    temporalConfiguration,
    new LedgerTemporalRunRegistry(ledger.repository),
  );
  const cockpitDirectory = resolve('dist/cockpit');
  const api = buildM1Api({
    service,
    jiraIssueService,
    logger: true,
    workflowGenerator,
    implementationPlanning,
    workflowContinuation,
    executionActivity: new LedgerExecutionActivityReader(ledger.repository),
    temporalRunService: temporalRuntime.service,
    ...(existsSync(cockpitDirectory) ? { cockpitDirectory } : {}),
  });

  const close = async (): Promise<void> => {
    await api.close();
    await temporalRuntime.connection.close();
    ledger.close();
  };

  process.once('SIGINT', () => void close());
  process.once('SIGTERM', () => void close());

  await api.listen({ host: '127.0.0.1', port: parsePort(process.env.TASKER_PORT) });
};

const isEntrypoint = process.argv[1] === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  await startM1Server();
}
