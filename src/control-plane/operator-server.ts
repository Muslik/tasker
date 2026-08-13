import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openSqliteLedger } from '../ledger/index.js';
import { BlockReceiptStore } from '../blocks/index.js';
import {
  BitbucketReviewClient,
  BitbucketReviewCoordinator,
  ConfluencePlanningEvidenceReader,
  createJiraIssueService,
  JiraPlanningEvidenceReader,
  JiraServerClient,
  loadConfluencePlanningEvidenceConfiguration,
  loadJiraConfiguration,
  loadLoopPlanningEvidenceConfiguration,
  LoopPlanningEvidenceReader,
  JiraWorkflowGenerationSubjectResolver,
  PullRequestReviewEvidenceStore,
} from '../integrations/index.js';
import {
  SubscriptionCliImplementationPlanner,
  SubscriptionCliWorkflowAnalyzer,
  nodeCommandRunner,
} from '../providers/index.js';
import { loadHarnessPack, resolveWorkflowAnalyzerProfile } from '../harness/index.js';
import { WorkflowGenerationSubjectSource } from '../planning/index.js';
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
  type TemporalClientConfiguration,
} from '../temporal/index.js';
import { buildOperatorApi } from './operator-api.js';
import { EvidenceBundleStore } from './evidence-bundle.js';
import { LedgerExecutionActivityReader } from './execution-activity.js';
import { createImplementationPlanningCoordinator } from './implementation-planning.js';
import { PlanningEvidenceReaderRegistry } from './planning-evidence.js';
import { PlanReviewStore } from './plan-review.js';
import { createOperatorWorkflowService } from './operator-service.js';
import {
  PersistedGenerationSubjectResolver,
  PersistedGenerationSubjectRunStore,
} from './persisted-generation-subject.js';
import { createWorkflowContinuationCoordinator } from './workflow-continuation.js';
import { TemporalTaskStepTraceStore } from '../temporal/activities/block-execution.js';
import {
  DockerWorkspaceCommandRunner,
  DockerWorkspaceRuntimeStore,
  loadDockerWorkspaceConfiguration,
} from '../workspaces/index.js';

const parsePort = (input: string | undefined): number => {
  const port = input === undefined ? 4311 : Number(input);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid TASKER_PORT: ${input ?? ''}`);
  }
  return port;
};

export const startOperatorServer = async (): Promise<void> => {
  const databasePath = resolve(process.env.TASKER_DB_PATH ?? '.tasker/operator.sqlite');
  mkdirSync(dirname(databasePath), { recursive: true });

  const ledger = openSqliteLedger({ filename: databasePath, clock: systemClock });
  const service = createOperatorWorkflowService(ledger.repository, systemClock);
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
  const jiraClient = new JiraServerClient(loadJiraConfiguration());
  const jiraIssueService = createJiraIssueService(ledger.repository, systemClock, jiraClient, {
    repositoryCatalog,
  });
  const harnessPack = loadHarnessPack();
  const dockerConfiguration = loadDockerWorkspaceConfiguration();
  const dockerCommands = new DockerWorkspaceCommandRunner(
    dockerConfiguration,
    nodeCommandRunner,
    new DockerWorkspaceRuntimeStore(dockerConfiguration.runtimeStorePath),
  );
  const continuationAnalyzer = new SubscriptionCliWorkflowAnalyzer(
    dockerCommands,
    (repositoryReference) => {
      const project = harnessPack.projects.find(
        (candidate) => candidate.repository === repositoryReference,
      );
      return resolveWorkflowAnalyzerProfile(
        harnessPack.company,
        project?.executionProfileOverrides ?? null,
      );
    },
  );
  const subjects = new WorkflowGenerationSubjectSource(
    [
      new PersistedGenerationSubjectResolver(service),
      new JiraWorkflowGenerationSubjectResolver(jiraIssueService),
    ],
    new PersistedGenerationSubjectRunStore(service),
  );
  const evidenceBundles = new EvidenceBundleStore(ledger.repository, systemClock);
  const evidenceReaders = new PlanningEvidenceReaderRegistry([
    new JiraPlanningEvidenceReader(jiraClient, systemClock),
    new ConfluencePlanningEvidenceReader(loadConfluencePlanningEvidenceConfiguration()),
    new LoopPlanningEvidenceReader(loadLoopPlanningEvidenceConfiguration()),
  ]);
  const implementationPlanning = createImplementationPlanningCoordinator({
    ledger: ledger.repository,
    clock: systemClock,
    workflows: service,
    subjects,
    evidenceBundles,
    evidenceReaders,
    planner: new SubscriptionCliImplementationPlanner(dockerCommands),
    harnessPack,
  });
  const workflowContinuation = createWorkflowContinuationCoordinator({
    ledger: ledger.repository,
    clock: systemClock,
    workflows: service,
    subjects,
    analyzer: continuationAnalyzer,
    repositories: repositoryCatalog,
  });
  const temporalRuntime = await connectTemporalTaskRunService(temporalConfiguration);
  const bitbucketReview =
    bitbucketConfiguration === null
      ? undefined
      : new BitbucketReviewCoordinator(
          new TemporalTaskStepTraceStore(ledger.repository, systemClock),
          new BitbucketReviewClient(bitbucketConfiguration),
          new PullRequestReviewEvidenceStore(ledger.repository, systemClock),
        );
  const cockpitDirectory = resolve('dist/cockpit');
  const api = buildOperatorApi({
    service,
    jiraIssueService,
    logger: true,
    implementationPlanning,
    workflowContinuation,
    executionActivity: new LedgerExecutionActivityReader(ledger.repository),
    ...(bitbucketReview === undefined ? {} : { bitbucketReview }),
    temporalRunService: temporalRuntime.service,
    blockReceipts: new BlockReceiptStore(ledger.repository, systemClock),
    planReviews: new PlanReviewStore(ledger.repository, systemClock),
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
  await startOperatorServer();
}
