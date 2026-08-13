import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import {
  createImplementationPlanningCoordinator,
  ImplementationPlanningStore,
} from '../control-plane/implementation-planning.js';
import { BlockReceiptStore } from '../blocks/index.js';
import { ContextDiscoveryService, EvidenceBundleStore } from '../control-plane/evidence-bundle.js';
import { PlanningTranscriptStore } from '../control-plane/planning-transcript.js';
import { createOperatorWorkflowService } from '../control-plane/operator-service.js';
import {
  PersistedGenerationSubjectResolver,
  PersistedGenerationSubjectRunStore,
} from '../control-plane/persisted-generation-subject.js';
import { BootstrapContextAssembler } from '../control-plane/bootstrap-context-assembly.js';
import { WorkflowFreezeStore } from '../control-plane/workflow-freeze.js';
import { PlanningEvidenceReaderRegistry } from '../control-plane/planning-evidence.js';
import { loadHarnessPack } from '../harness/index.js';
import {
  BitbucketPullRequestAdapter,
  BitbucketPullRequestClient,
  BitbucketReviewClient,
  BitbucketReviewReplyAdapter,
  ConfluencePlanningEvidenceReader,
  PullRequestReviewEvidenceStore,
  createJiraIssueService,
  ExternalEffectStore,
  IntegrationStepAdapterRegistry,
  type IntegrationStepAdapter,
  JenkinsBuildClient,
  JenkinsBuildObserverAdapter,
  JiraLifecycleClient,
  JiraPlanningEvidenceReader,
  JiraReviewReadyAdapter,
  JiraServerClient,
  JiraStartWorkAdapter,
  JiraWorkflowGenerationSubjectResolver,
  LoopPlanningEvidenceReader,
  loadConfluencePlanningEvidenceConfiguration,
  loadJenkinsBuildConfiguration,
  loadJiraConfiguration,
  loadLoopPlanningEvidenceConfiguration,
  loadGitCommitIdentity,
  loadExternalEffectTaskAuthorization,
  TaskScopedIntegrationAdapter,
} from '../integrations/index.js';
import { openSqliteLedger } from '../ledger/index.js';
import { WorkflowGenerationSubjectSource } from '../planning/index.js';
import { SubscriptionCliImplementationPlanner, nodeCommandRunner } from '../providers/index.js';
import {
  BitbucketRepositoryClient,
  createManagedRepositoryStore,
  loadBitbucketRepositoryConfiguration,
  loadRepositoryCatalogConfiguration,
  UnconfiguredBitbucketRepositorySource,
} from '../repositories/index.js';
import { systemClock } from '../shared/clock.js';
import {
  loadWorkspaceConfiguration,
  loadWorkspaceBootstrapConfiguration,
  loadDockerWorkspaceConfiguration,
  assertWorkspaceHarnessProvidesSkills,
  DockerWorkspaceCommandRunner,
  DockerWorkspaceRuntimeManager,
  DockerWorkspaceRuntimeStore,
  HarnessProfileWorkspaceBootstrapAdapter,
  GitWorkspaceMutationInspector,
  ManagedWorkspaceManager,
  WorkspaceBootstrapCoordinator,
  WorkspaceBootstrapStore,
  WorkspaceStore,
  loadWorkspaceHarnessPack,
  resolveWorkspaceRuntimePolicy,
} from '../workspaces/index.js';
import {
  createPlanningActivity,
  createTemporalActivityCommandRunner,
} from './activities/planning-activity.js';
import {
  SubscriptionCliTaskStepAgentRunner,
  createCurrentStepRegistry,
  createTaskExecutionActivity,
  LedgerTaskRunEvidenceSource,
  TemporalTaskStepTraceStore,
} from './activities/block-execution.js';
import { createWorkspaceActivity } from './activities/workspace-activity.js';
import { createBootstrapContextAssemblyActivity } from './activities/bootstrap-context-assembly-activity.js';
import { createBootstrapInvestigationActivity } from './activities/bootstrap-investigation-activity.js';
import { createWorkflowFreezeActivity } from './activities/workflow-freeze-activity.js';
import { WorkspaceMutationRecoveryStore } from './activities/workspace-mutation-recovery.js';
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
  const databasePath = resolve(process.env.TASKER_DB_PATH ?? '.tasker/operator.sqlite');
  mkdirSync(dirname(databasePath), { recursive: true });
  const ledger = openSqliteLedger({ filename: databasePath, clock: systemClock });
  const workflowService = createOperatorWorkflowService(ledger.repository, systemClock);
  const harnessPack = loadHarnessPack();
  const dockerConfiguration = loadDockerWorkspaceConfiguration();
  const dockerRuntimeStore = new DockerWorkspaceRuntimeStore(dockerConfiguration.runtimeStorePath);
  const dockerCommands = new DockerWorkspaceCommandRunner(
    dockerConfiguration,
    nodeCommandRunner,
    dockerRuntimeStore,
  );
  const dockerRuntimes = new DockerWorkspaceRuntimeManager(
    dockerConfiguration,
    nodeCommandRunner,
    dockerCommands,
    dockerRuntimeStore,
    systemClock,
  );
  const bitbucketConfiguration = loadBitbucketRepositoryConfiguration();
  const gitCommitIdentity = loadGitCommitIdentity();
  const bitbucketPullRequestEffectsEnabled =
    process.env.TASKER_ENABLE_BITBUCKET_PR_EFFECTS === 'true';
  const externalEffects = new ExternalEffectStore(ledger.repository, systemClock);
  const jenkinsConfiguration = loadJenkinsBuildConfiguration();
  const jiraConfiguration = loadJiraConfiguration();
  const jiraLifecycleEffectsEnabled = process.env.TASKER_ENABLE_JIRA_EFFECTS === 'true';
  const externalEffectAuthorization = loadExternalEffectTaskAuthorization(
    bitbucketPullRequestEffectsEnabled || jiraLifecycleEffectsEnabled,
  );
  const authorizeExternalEffect = (
    adapter: IntegrationStepAdapter,
  ): TaskScopedIntegrationAdapter => {
    if (externalEffectAuthorization.kind !== 'allowlist') {
      throw new Error('External effect adapter registration requires task authorization');
    }
    return new TaskScopedIntegrationAdapter(adapter, externalEffectAuthorization.taskReferences);
  };
  const jiraLifecycleClient =
    jiraConfiguration === null ? null : new JiraLifecycleClient(jiraConfiguration);
  const integrationAdapters = new IntegrationStepAdapterRegistry([
    ...(jenkinsConfiguration === null
      ? []
      : [
          new JenkinsBuildObserverAdapter(
            jenkinsConfiguration,
            nodeCommandRunner,
            new JenkinsBuildClient(jenkinsConfiguration),
          ),
        ]),
    ...(bitbucketConfiguration === null || !bitbucketPullRequestEffectsEnabled
      ? []
      : [
          authorizeExternalEffect(
            new BitbucketPullRequestAdapter(
              bitbucketConfiguration,
              gitCommitIdentity,
              dockerCommands,
              new BitbucketPullRequestClient(bitbucketConfiguration),
              externalEffects,
            ),
          ),
          authorizeExternalEffect(
            new BitbucketReviewReplyAdapter(
              new BitbucketReviewClient(bitbucketConfiguration),
              externalEffects,
            ),
          ),
        ]),
    ...(jiraLifecycleClient === null || !jiraLifecycleEffectsEnabled
      ? []
      : [
          authorizeExternalEffect(new JiraStartWorkAdapter(jiraLifecycleClient, externalEffects)),
          authorizeExternalEffect(new JiraReviewReadyAdapter(jiraLifecycleClient, externalEffects)),
        ]),
  ]);
  const repositoryCatalog = createManagedRepositoryStore(
    loadRepositoryCatalogConfiguration(),
    bitbucketConfiguration,
    bitbucketConfiguration === null
      ? new UnconfiguredBitbucketRepositorySource()
      : new BitbucketRepositoryClient(bitbucketConfiguration),
  );
  const jiraClient = new JiraServerClient(jiraConfiguration);
  const jiraIssueService = createJiraIssueService(ledger.repository, systemClock, jiraClient, {
    repositoryCatalog,
  });
  const subjects = new WorkflowGenerationSubjectSource(
    [
      new PersistedGenerationSubjectResolver(workflowService),
      new JiraWorkflowGenerationSubjectResolver(jiraIssueService),
    ],
    new PersistedGenerationSubjectRunStore(workflowService),
  );
  const planningTranscripts = new PlanningTranscriptStore(ledger.repository, systemClock);
  const planningStore = new ImplementationPlanningStore(ledger.repository, systemClock);
  const evidenceBundles = new EvidenceBundleStore(ledger.repository, systemClock);
  const evidenceReaders = new PlanningEvidenceReaderRegistry([
    new JiraPlanningEvidenceReader(jiraClient, systemClock),
    new ConfluencePlanningEvidenceReader(loadConfluencePlanningEvidenceConfiguration()),
    new LoopPlanningEvidenceReader(loadLoopPlanningEvidenceConfiguration()),
  ]);
  const workflowFreezes = new WorkflowFreezeStore(ledger.repository, systemClock);
  const temporalCommandRunner = createTemporalActivityCommandRunner(
    dockerCommands,
    planningTranscripts,
  );
  const contextDiscovery = new ContextDiscoveryService(evidenceBundles, systemClock);
  const planning = createImplementationPlanningCoordinator({
    ledger: ledger.repository,
    clock: systemClock,
    workflows: workflowService,
    subjects,
    evidenceBundles,
    evidenceReaders,
    harnessPack,
    planner: new SubscriptionCliImplementationPlanner(temporalCommandRunner),
  });
  const planningContexts = new BootstrapContextAssembler(subjects, contextDiscovery, planning);
  const executionTraces = new TemporalTaskStepTraceStore(ledger.repository, systemClock);
  const reviewEvidence = new PullRequestReviewEvidenceStore(ledger.repository, systemClock);
  const mutationRecovery = new WorkspaceMutationRecoveryStore(
    ledger.repository,
    systemClock,
    new GitWorkspaceMutationInspector(dockerCommands),
  );
  const workspaceStore = new WorkspaceStore(ledger.repository, systemClock);
  const blockReceipts = new BlockReceiptStore(ledger.repository, systemClock);
  const workspaces = new ManagedWorkspaceManager(
    loadWorkspaceConfiguration(),
    workspaceStore,
    nodeCommandRunner,
  );
  const bootstrapConfiguration = loadWorkspaceBootstrapConfiguration();
  assertWorkspaceHarnessProvidesSkills(
    loadWorkspaceHarnessPack(bootstrapConfiguration.harnessPackPath),
    harnessPack.steps.flatMap((step) =>
      step.block.executor.kind === 'agent' ? [...step.block.executor.skills] : [],
    ),
  );
  const bootstrapAdapter = new HarnessProfileWorkspaceBootstrapAdapter(
    {
      sourcePackPath: bootstrapConfiguration.harnessPackPath,
      snapshotStorePath: bootstrapConfiguration.snapshotStorePath,
    },
    nodeCommandRunner,
    systemClock,
  );
  const bootstrap = new WorkspaceBootstrapCoordinator(
    new WorkspaceBootstrapStore(ledger.repository),
    bootstrapAdapter,
  );
  try {
    const executionActivities = createTaskExecutionActivity({
      snapshots: planningStore,
      currentSteps: createCurrentStepRegistry(harnessPack),
      traces: executionTraces,
      mutationRecovery,
      receipts: blockReceipts,
      runtimes: dockerRuntimes,
      agentRunner: new SubscriptionCliTaskStepAgentRunner(dockerCommands),
      commands: dockerCommands,
      integrations: integrationAdapters,
      evidence: new LedgerTaskRunEvidenceSource(executionTraces, reviewEvidence),
      workspaces: workspaceStore,
    });
    const runtime = await connectTaskerTemporalWorker(configuration, {
      ...createWorkspaceActivity(subjects, workspaces, bootstrap, dockerRuntimes, {
        resolve: (repositoryReference) =>
          resolveWorkspaceRuntimePolicy(
            harnessPack.company,
            harnessPack.projects.find((project) => project.repository === repositoryReference) ??
              null,
          ),
      }),
      ...createBootstrapContextAssemblyActivity(planningContexts),
      ...createPlanningActivity(planning),
      ...createBootstrapInvestigationActivity(
        executionActivities,
        planningStore,
        blockReceipts,
        evidenceBundles,
      ),
      ...createWorkflowFreezeActivity(workflowFreezes),
      ...executionActivities,
    });
    try {
      const workerRun = runtime.worker.run();
      if (typeof process.send === 'function') {
        process.send({ type: 'tasker-worker-ready', taskQueue: configuration.taskQueue });
      }
      await workerRun;
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
