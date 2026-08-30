import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import {
  createImplementationPlanningCoordinator,
  ImplementationPlanningStore,
} from '../control-plane/implementation-planning.js';
import { DependencyDeclarationStore } from '../control-plane/dependency-declaration.js';
import { DependencyDeclarationGenerationSubjectResolver } from '../control-plane/dependency-declaration-generation-subject.js';
import { VerifiedPackagePublicationStore } from '../control-plane/verified-package-publication.js';
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
import { loadHarnessPack, resolveWorkflowAnalyzerProfile } from '../harness/index.js';
import {
  BitbucketPullRequestAdapter,
  BitbucketPullRequestClient,
  ConfluencePlanningEvidenceReader,
  DependencyAwaitPackagesAdapter,
  PullRequestReviewEvidenceStore,
  PullRequestDeliveryAdapter,
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
import {
  SubscriptionCliImplementationPlanner,
  SubscriptionCliWorkflowAnalyzer,
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
import { LedgerAgentInvocationRecorder } from '../observability/index.js';
import { RetrospectiveStore } from '../retrospective/index.js';
import {
  loadWorkspaceConfiguration,
  loadWorkspaceBootstrapConfiguration,
  loadDockerWorkspaceConfiguration,
  loadTaskStepFilesystemConfiguration,
  assertWorkspaceHarnessSkillBindings,
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
import { TaskStepFilesystemStore } from './activities/task-step-filesystem.js';
import { TaskStepEvidenceStore } from './activities/task-step-evidence.js';
import { TaskStepIntegrationEvidenceSink } from './activities/integration-evidence-sink.js';
import { createWorkspaceActivity } from './activities/workspace-activity.js';
import { createBootstrapContextAssemblyActivity } from './activities/bootstrap-context-assembly-activity.js';
import { createBootstrapInvestigationActivity } from './activities/bootstrap-investigation-activity.js';
import { createWorkflowFreezeActivity } from './activities/workflow-freeze-activity.js';
import { createTaskAdmissionActivity } from './activities/task-admission-activity.js';
import { WorkspaceMutationRecoveryStore } from './activities/workspace-mutation-recovery.js';
import { createExecutionContinuationActivity } from './activities/execution-continuation-activity.js';
import { createExecutionRetrospectiveActivity } from './activities/execution-retrospective-activity.js';
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
  const taskStepFilesystem = new TaskStepFilesystemStore(
    loadTaskStepFilesystemConfiguration().rootPath,
  );
  const taskStepEvidence = new TaskStepEvidenceStore(ledger.repository, systemClock);
  const integrationEvidence = new TaskStepIntegrationEvidenceSink(
    taskStepFilesystem,
    taskStepEvidence,
  );
  const dependencyDeclarations = new DependencyDeclarationStore(ledger.repository, systemClock);
  const verifiedPackagePublications = new VerifiedPackagePublicationStore(
    ledger.repository,
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
  const jenkinsBuildObserver =
    jenkinsConfiguration === null
      ? null
      : new JenkinsBuildObserverAdapter(
          jenkinsConfiguration,
          dockerCommands,
          new JenkinsBuildClient(jenkinsConfiguration),
          undefined,
          integrationEvidence,
        );
  const bitbucketPullRequests =
    bitbucketConfiguration === null || !bitbucketPullRequestEffectsEnabled
      ? null
      : new BitbucketPullRequestAdapter(
          bitbucketConfiguration,
          gitCommitIdentity,
          dockerCommands,
          new BitbucketPullRequestClient(bitbucketConfiguration),
          externalEffects,
        );
  const jiraReviewReady =
    jiraLifecycleClient === null || !jiraLifecycleEffectsEnabled
      ? null
      : new JiraReviewReadyAdapter(jiraLifecycleClient, externalEffects, taskStepEvidence);
  const jiraStartWork =
    jiraLifecycleClient === null || !jiraLifecycleEffectsEnabled
      ? null
      : new JiraStartWorkAdapter(jiraLifecycleClient, externalEffects);
  const integrationAdapters = new IntegrationStepAdapterRegistry([
    new DependencyAwaitPackagesAdapter(dependencyDeclarations, verifiedPackagePublications),
    ...(bitbucketPullRequests === null || jenkinsBuildObserver === null
      ? []
      : [
          authorizeExternalEffect(
            new PullRequestDeliveryAdapter(
              bitbucketPullRequests,
              jenkinsBuildObserver,
              jiraReviewReady,
            ),
          ),
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
      new DependencyDeclarationGenerationSubjectResolver(
        new JiraWorkflowGenerationSubjectResolver(jiraIssueService),
        dependencyDeclarations,
      ),
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
  const continuationAnalyzer = new SubscriptionCliWorkflowAnalyzer(
    temporalCommandRunner,
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
  const planning = createImplementationPlanningCoordinator({
    ledger: ledger.repository,
    clock: systemClock,
    workflows: workflowService,
    subjects,
    evidenceBundles,
    evidenceReaders,
    harnessPack,
    planner: new SubscriptionCliImplementationPlanner(
      temporalCommandRunner,
      new LedgerAgentInvocationRecorder(ledger.repository, systemClock),
    ),
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
  const retrospectives = new RetrospectiveStore(ledger.repository, systemClock);
  const workspaces = new ManagedWorkspaceManager(
    loadWorkspaceConfiguration(),
    workspaceStore,
    nodeCommandRunner,
    bitbucketConfiguration === null
      ? {}
      : {
          GIT_CONFIG_COUNT: '1',
          GIT_CONFIG_KEY_0: 'http.extraHeader',
          GIT_CONFIG_VALUE_0: `Authorization: Bearer ${bitbucketConfiguration.token}`,
        },
  );
  const bootstrapConfiguration = loadWorkspaceBootstrapConfiguration();
  assertWorkspaceHarnessSkillBindings(
    loadWorkspaceHarnessPack(bootstrapConfiguration.harnessPackPath),
    {
      stepBound: [
        ...harnessPack.company.systemPrompts.implementationPlannerSkills,
        ...harnessPack.steps.flatMap((step) =>
          step.block.executor.kind === 'agent' ? [...step.block.executor.skills] : [],
        ),
      ],
      policyBound: harnessPack.policies.flatMap((policy) =>
        policy.agentSkills.map((binding) => binding.skill),
      ),
    },
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
      agentRunner: new SubscriptionCliTaskStepAgentRunner(
        dockerCommands,
        taskStepFilesystem,
        taskStepEvidence,
      ),
      commands: dockerCommands,
      integrations: integrationAdapters,
      evidence: new LedgerTaskRunEvidenceSource(executionTraces, reviewEvidence),
      workspaces: workspaceStore,
    });
    const runtime = await connectTaskerTemporalWorker(configuration, {
      ...createWorkspaceActivity(subjects, workspaces, bootstrap, dockerRuntimes, {
        resolveRuntime: (repositoryReference) =>
          resolveWorkspaceRuntimePolicy(
            harnessPack.company,
            harnessPack.projects.find((project) => project.repository === repositoryReference) ??
              null,
          ),
        resolveGit: (repositoryReference) => {
          const project = harnessPack.projects.find(
            (candidate) => candidate.repository === repositoryReference,
          );
          if (project === undefined) {
            throw new Error(`Project Git policy is missing for ${repositoryReference}`);
          }
          return project.git;
        },
      }),
      ...createBootstrapContextAssemblyActivity(planningContexts),
      ...createPlanningActivity(planning),
      ...createBootstrapInvestigationActivity(
        executionActivities,
        planningStore,
        blockReceipts,
        evidenceBundles,
      ),
      ...createTaskAdmissionActivity(planningStore, workspaceStore, jiraStartWork),
      ...createWorkflowFreezeActivity(workflowFreezes),
      ...createExecutionContinuationActivity(
        ledger.repository,
        systemClock,
        planningStore,
        continuationAnalyzer,
        contextDiscovery,
        dependencyDeclarations,
      ),
      ...createExecutionRetrospectiveActivity(retrospectives),
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
