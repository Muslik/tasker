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
import { DeterministicStubRunService, DurableStubScheduler } from '../runner/index.js';
import { buildM1Api } from './m1-api.js';
import { createImplementationPlanningCoordinator } from './implementation-planning.js';
import { createWorkflowContinuationCoordinator } from './workflow-continuation.js';
import { createM1WorkflowService } from './m1-service.js';
import { CodexWorkflowGenerator, WorkflowGenerationSubjectSource } from './workflow-generator.js';

const parsePort = (input: string | undefined): number => {
  const port = input === undefined ? 4311 : Number(input);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid TASKER_PORT: ${input ?? ''}`);
  }
  return port;
};

const parsePositiveInteger = (
  input: string | undefined,
  fallback: number,
  name: string,
): number => {
  const value = input === undefined ? fallback : Number(input);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid ${name}: ${input ?? ''}`);
  return value;
};

export const startM1Server = async (): Promise<void> => {
  const databasePath = resolve(process.env.TASKER_DB_PATH ?? '.tasker/m1-operator.sqlite');
  mkdirSync(dirname(databasePath), { recursive: true });

  const ledger = openSqliteLedger({ filename: databasePath, clock: systemClock });
  const service = createM1WorkflowService(ledger.repository, systemClock);
  const runService = new DeterministicStubRunService(ledger.repository, service, systemClock);
  const scheduler = new DurableStubScheduler(runService, ledger.repository, systemClock, {
    capacity: parsePositiveInteger(process.env.TASKER_STUB_CAPACITY, 2, 'TASKER_STUB_CAPACITY'),
    ownerId: `tasker-${String(process.pid)}`,
    leaseTimeoutMs: 15_000,
    pollIntervalMs: 250,
  });
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
    repositories: repositoryCatalog,
    ...(workflowAnalyzer === undefined ? {} : { analyzer: workflowAnalyzer }),
  });
  const cockpitDirectory = resolve('dist/cockpit');
  const api = buildM1Api({
    service,
    jiraIssueService,
    logger: true,
    workflowGenerator,
    implementationPlanning,
    workflowContinuation,
    runService,
    scheduler,
    ...(existsSync(cockpitDirectory) ? { cockpitDirectory } : {}),
  });

  const close = async (): Promise<void> => {
    scheduler.stop();
    await api.close();
    ledger.close();
  };

  process.once('SIGINT', () => void close());
  process.once('SIGTERM', () => void close());

  scheduler.start();
  await api.listen({ host: '127.0.0.1', port: parsePort(process.env.TASKER_PORT) });
};

const isEntrypoint = process.argv[1] === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  await startM1Server();
}
