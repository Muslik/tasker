import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openSqliteLedger } from '../store/index.js';
import { BlockReceiptStore } from '../steps/index.js';
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
import { SubscriptionCliImplementationPlanner, nodeCommandRunner } from '../agents/index.js';
import { loadHarnessPack } from '../harness/index.js';
import { WorkflowGenerationSubjectSource } from '../planning/index.js';
import {
  BitbucketRepositoryClient,
  createManagedRepositoryStore,
  loadBitbucketRepositoryConfiguration,
  loadRepositoryCatalogConfiguration,
  UnconfiguredBitbucketRepositorySource,
} from '../workspace/index.js';
import { systemClock } from '../shared/clock.js';
import { LedgerAgentInvocationRecorder } from '../steps/index.js';
import { RetrospectiveStore } from './report.js';
import { CompletedRunLifecycleReader } from './completed-run-lifecycle.js';
import { TaskPresenceStore } from './task-presence.js';
import { TaskRemovalService } from './task-removal.js';
import { DependencyDeclarationStore } from './dependency-declaration.js';
import { DependencyDeclarationGenerationSubjectResolver } from './dependency-declaration-generation-subject.js';
import { DependencyOperatorService } from './dependency-operator-service.js';
import {
  connectTemporalTaskRunService,
  DEFAULT_TEMPORAL_CLIENT_CONFIGURATION,
  type TemporalClientConfiguration,
} from '../kernel/index.js';
import { buildOperatorApi } from './operator-api.js';
import { LedgerAgentInvocationReader } from './agent-invocation-reader.js';
import { EvidenceBundleStore } from './evidence-bundle.js';
import { LedgerExecutionActivityReader } from './execution-activity.js';
import { createImplementationPlanningCoordinator } from './planning-coordinator.js';
import { PlanningEvidenceReaderRegistry } from './planning-evidence.js';
import { PlanReviewStore } from './plan-review.js';
import { WorkflowFreezeStore } from './workflow-freeze.js';
import { createOperatorWorkflowService } from './operator-service.js';
import {
  PersistedGenerationSubjectResolver,
  PersistedGenerationSubjectRunStore,
} from './persisted-generation-subject.js';
import { VerifiedPackagePublicationStore } from './verified-package-publication.js';
import { NexusPackageObserver } from '../integrations/nexus/index.js';
import { TemporalTaskStepTraceStore } from '../steps/activities/transcript-store.js';
import {
  DockerWorkspaceCommandRunner,
  DockerWorkspaceRuntimeManager,
  DockerWorkspaceRuntimeStore,
  ManagedWorkspaceManager,
  loadDockerWorkspaceConfiguration,
  loadWorkspaceConfiguration,
  WorkspaceStore,
} from '../workspace/index.js';

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
  const retrospectives = new RetrospectiveStore(ledger.repository, systemClock);
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
  const dockerRuntimeStore = new DockerWorkspaceRuntimeStore(dockerConfiguration.runtimeStorePath);
  const dockerCommands = new DockerWorkspaceCommandRunner(
    dockerConfiguration,
    nodeCommandRunner,
    dockerRuntimeStore,
  );
  const workspaceStore = new WorkspaceStore(ledger.repository, systemClock);
  const workspaceManager = new ManagedWorkspaceManager(
    loadWorkspaceConfiguration(),
    workspaceStore,
    nodeCommandRunner,
  );
  const dockerRuntimeManager = new DockerWorkspaceRuntimeManager(
    dockerConfiguration,
    nodeCommandRunner,
    dockerCommands,
    dockerRuntimeStore,
    systemClock,
  );
  const dependencyDeclarations = new DependencyDeclarationStore(ledger.repository, systemClock);
  const subjects = new WorkflowGenerationSubjectSource(
    [
      new PersistedGenerationSubjectResolver(service),
      new DependencyDeclarationGenerationSubjectResolver(
        new JiraWorkflowGenerationSubjectResolver(jiraIssueService),
        dependencyDeclarations,
      ),
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
    planner: new SubscriptionCliImplementationPlanner(
      dockerCommands,
      new LedgerAgentInvocationRecorder(ledger.repository, systemClock),
    ),
    harnessPack,
  });
  const workflowFreezes = new WorkflowFreezeStore(ledger.repository, systemClock);
  const completedRuns = new CompletedRunLifecycleReader(
    retrospectives,
    workflowFreezes,
    implementationPlanning,
  );
  const verifiedPackagePublications = new VerifiedPackagePublicationStore(
    ledger.repository,
    systemClock,
  );
  const dependencyOperator = new DependencyOperatorService(
    dependencyDeclarations,
    ledger.repository,
    verifiedPackagePublications,
    new NexusPackageObserver(),
  );
  const temporalRuntime = await connectTemporalTaskRunService(temporalConfiguration);
  const taskPresence = new TaskPresenceStore(ledger.repository, systemClock);
  const taskRemoval = new TaskRemovalService(
    temporalRuntime.service,
    workspaceStore,
    dockerRuntimeManager,
    workspaceManager,
    taskPresence,
  );
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
    executionActivity: new LedgerExecutionActivityReader(ledger.repository),
    agentInvocations: new LedgerAgentInvocationReader(ledger.repository),
    ...(bitbucketReview === undefined ? {} : { bitbucketReview }),
    dependencyOperator,
    dependencyDeclarations,
    artifacts: ledger.repository,
    verifiedPackagePublications,
    temporalRunService: temporalRuntime.service,
    blockReceipts: new BlockReceiptStore(ledger.repository, systemClock),
    planReviews: new PlanReviewStore(ledger.repository, systemClock),
    retrospectives,
    completedRuns,
    taskPresence,
    taskRemoval,
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
