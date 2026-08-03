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
import {
  connectTemporalTaskRunService,
  DEFAULT_TEMPORAL_CLIENT_CONFIGURATION,
  LedgerTemporalRunRegistry,
  type TemporalClientConfiguration,
} from '../temporal/index.js';
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

const parseExecutionRuntime = (input: string | undefined): 'legacy_stub' | 'temporal' => {
  const runtime = input ?? 'legacy_stub';
  if (runtime === 'legacy_stub' || runtime === 'temporal') return runtime;
  throw new Error(`Invalid TASKER_EXECUTION_RUNTIME: ${runtime}`);
};

export const startM1Server = async (): Promise<void> => {
  const databasePath = resolve(process.env.TASKER_DB_PATH ?? '.tasker/m1-operator.sqlite');
  mkdirSync(dirname(databasePath), { recursive: true });

  const ledger = openSqliteLedger({ filename: databasePath, clock: systemClock });
  const service = createM1WorkflowService(ledger.repository, systemClock);
  const executionRuntime = parseExecutionRuntime(process.env.TASKER_EXECUTION_RUNTIME);
  const legacyRunService =
    executionRuntime === 'legacy_stub'
      ? new DeterministicStubRunService(ledger.repository, service, systemClock)
      : null;
  const legacyScheduler =
    legacyRunService === null
      ? null
      : new DurableStubScheduler(legacyRunService, ledger.repository, systemClock, {
          capacity: parsePositiveInteger(
            process.env.TASKER_STUB_CAPACITY,
            2,
            'TASKER_STUB_CAPACITY',
          ),
          ownerId: `tasker-${String(process.pid)}`,
          leaseTimeoutMs: 15_000,
          pollIntervalMs: 250,
        });
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
  const temporalRuntime =
    executionRuntime === 'temporal'
      ? await connectTemporalTaskRunService(
          temporalConfiguration,
          new LedgerTemporalRunRegistry(ledger.repository),
        )
      : null;
  const workflowContinuation = createWorkflowContinuationCoordinator({
    ledger: ledger.repository,
    clock: systemClock,
    workflows: service,
    subjects,
    repositories: repositoryCatalog,
    ...(workflowAnalyzer === undefined ? {} : { analyzer: workflowAnalyzer }),
  });
  const cockpitDirectory = resolve('dist/cockpit');
  const commonApiOptions = {
    service,
    jiraIssueService,
    logger: true,
    workflowGenerator,
    implementationPlanning,
    workflowContinuation,
    ...(existsSync(cockpitDirectory) ? { cockpitDirectory } : {}),
  };
  const api = (() => {
    if (temporalRuntime !== null) {
      return buildM1Api({
        ...commonApiOptions,
        temporalRunService: temporalRuntime.service,
      });
    }
    if (legacyRunService === null || legacyScheduler === null) {
      throw new Error('Execution runtime bootstrap produced no runtime');
    }
    return buildM1Api({
      ...commonApiOptions,
      runService: legacyRunService,
      scheduler: legacyScheduler,
    });
  })();

  const close = async (): Promise<void> => {
    legacyScheduler?.stop();
    await api.close();
    await temporalRuntime?.connection.close();
    ledger.close();
  };

  process.once('SIGINT', () => void close());
  process.once('SIGTERM', () => void close());

  legacyScheduler?.start();
  await api.listen({ host: '127.0.0.1', port: parsePort(process.env.TASKER_PORT) });
};

const isEntrypoint = process.argv[1] === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  await startM1Server();
}
