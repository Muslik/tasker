import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import {
  createImplementationPlanningCoordinator,
  ImplementationPlanningStore,
} from '../control-plane/implementation-planning.js';
import { ContextDiscoveryService, EvidenceBundleStore } from '../control-plane/evidence-bundle.js';
import { PlanningTranscriptStore } from '../control-plane/planning-transcript.js';
import { createM1WorkflowService } from '../control-plane/m1-service.js';
import {
  CodexWorkflowGenerator,
  WorkflowGenerationSubjectSource,
} from '../control-plane/workflow-generator.js';
import { createWorkflowContinuationCoordinator } from '../control-plane/workflow-continuation.js';
import { WorkflowDraftRevisionCoordinator } from '../control-plane/workflow-draft-revision.js';
import { WorkflowFreezeStore } from '../control-plane/workflow-freeze.js';
import { loadHarnessPack } from '../harness/index.js';
import {
  AiAssistanceInitializeAdapter,
  AiAssistanceRecordPlanAdapter,
  AiAssistanceValidateAdapter,
  BitbucketPullRequestAdapter,
  BitbucketPullRequestClient,
  BitbucketReviewClient,
  BitbucketReviewReplyAdapter,
  PullRequestReviewEvidenceStore,
  createJiraIssueService,
  ExternalEffectStore,
  IntegrationStepAdapterRegistry,
  type IntegrationStepAdapter,
  JenkinsBuildClient,
  JenkinsBuildObserverAdapter,
  JiraLifecycleClient,
  JiraReviewReadyAdapter,
  JiraReproductionEvidenceAdapter,
  JiraServerClient,
  JiraStartWorkAdapter,
  loadJenkinsBuildConfiguration,
  loadJiraConfiguration,
  loadExternalEffectTaskAuthorization,
  TaskScopedIntegrationAdapter,
} from '../integrations/index.js';
import { openSqliteLedger } from '../ledger/index.js';
import {
  CodexCliWorkflowAnalyzer,
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
  loadWorkspaceConfiguration,
  loadWorkspaceBootstrapConfiguration,
  assertWorkspaceHarnessProvidesSkills,
  CommandWorkspaceBootstrapAdapter,
  HarnessProfileWorkspaceBootstrapAdapter,
  GitWorkspaceMutationInspector,
  ManagedWorkspaceManager,
  WorkspaceBootstrapCoordinator,
  WorkspaceBootstrapStore,
  WorkspaceStore,
  loadWorkspaceHarnessPack,
} from '../workspaces/index.js';
import {
  createPlanningActivity,
  createTemporalActivityCommandRunner,
} from './activities/planning-activity.js';
import {
  CodexCliTaskStepAgentRunner,
  createCurrentStepRegistry,
  createTaskExecutionActivity,
  LedgerTaskRunEvidenceSource,
  TemporalTaskStepTraceStore,
} from './activities/block-execution.js';
import { createWorkspaceActivity } from './activities/workspace-activity.js';
import { createWorkflowAssemblyActivity } from './activities/workflow-assembly-activity.js';
import { createWorkflowDraftRevisionActivity } from './activities/workflow-draft-revision-activity.js';
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
  const databasePath = resolve(process.env.TASKER_DB_PATH ?? '.tasker/m1-operator.sqlite');
  mkdirSync(dirname(databasePath), { recursive: true });
  const ledger = openSqliteLedger({ filename: databasePath, clock: systemClock });
  const workflowService = createM1WorkflowService(ledger.repository, systemClock);
  const harnessPack = loadHarnessPack();
  const bitbucketConfiguration = loadBitbucketRepositoryConfiguration();
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
    new AiAssistanceInitializeAdapter(externalEffects),
    new AiAssistanceRecordPlanAdapter(externalEffects),
    new AiAssistanceValidateAdapter(),
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
              nodeCommandRunner,
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
          authorizeExternalEffect(
            new JiraReproductionEvidenceAdapter(jiraLifecycleClient, externalEffects),
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
  const jiraIssueService = createJiraIssueService(
    ledger.repository,
    systemClock,
    new JiraServerClient(jiraConfiguration),
    { repositoryCatalog },
  );
  const subjects = new WorkflowGenerationSubjectSource(
    resolve(process.env.TASKER_REPOSITORY_PATH ?? '.'),
    jiraIssueService,
    workflowService,
  );
  const deterministicProvider = process.env.TASKER_WORKFLOW_PROVIDER === 'deterministic';
  const planningTranscripts = new PlanningTranscriptStore(ledger.repository, systemClock);
  const planningStore = new ImplementationPlanningStore(ledger.repository, systemClock);
  const evidenceBundles = new EvidenceBundleStore(ledger.repository, systemClock);
  const workflowFreezes = new WorkflowFreezeStore(ledger.repository, systemClock);
  const temporalCommandRunner = createTemporalActivityCommandRunner(
    nodeCommandRunner,
    planningTranscripts,
  );
  const workflowAnalyzer = deterministicProvider
    ? undefined
    : new CodexCliWorkflowAnalyzer(temporalCommandRunner);
  const contextDiscovery = new ContextDiscoveryService(evidenceBundles, systemClock);
  const workflowGenerator = new CodexWorkflowGenerator(
    workflowService,
    subjects,
    workflowAnalyzer,
    contextDiscovery,
  );
  const workflowDraftRevisions = new WorkflowDraftRevisionCoordinator(
    workflowService,
    subjects,
    workflowAnalyzer,
    contextDiscovery,
    repositoryCatalog,
  );
  const planning = createImplementationPlanningCoordinator({
    ledger: ledger.repository,
    clock: systemClock,
    workflows: workflowService,
    subjects,
    evidenceBundles,
    harnessPack,
    planner: deterministicProvider
      ? new DeterministicImplementationPlanner()
      : new CodexCliImplementationPlanner(temporalCommandRunner),
  });
  const workflowContinuation = createWorkflowContinuationCoordinator({
    ledger: ledger.repository,
    clock: systemClock,
    workflows: workflowService,
    subjects,
    repositories: repositoryCatalog,
  });
  const executionTraces = new TemporalTaskStepTraceStore(ledger.repository, systemClock);
  const reviewEvidence = new PullRequestReviewEvidenceStore(ledger.repository, systemClock);
  const mutationRecovery = new WorkspaceMutationRecoveryStore(
    ledger.repository,
    systemClock,
    new GitWorkspaceMutationInspector(nodeCommandRunner),
  );
  const workspaces = new ManagedWorkspaceManager(
    loadWorkspaceConfiguration(),
    new WorkspaceStore(ledger.repository, systemClock),
    nodeCommandRunner,
  );
  const bootstrapConfiguration = loadWorkspaceBootstrapConfiguration();
  if (bootstrapConfiguration.command === null) {
    assertWorkspaceHarnessProvidesSkills(
      loadWorkspaceHarnessPack(bootstrapConfiguration.harnessPackPath),
      harnessPack.steps.flatMap((step) =>
        step.execution.kind === 'agent' ? [...step.execution.skills] : [],
      ),
    );
  }
  const bootstrapAdapter =
    bootstrapConfiguration.command === null
      ? new HarnessProfileWorkspaceBootstrapAdapter(
          {
            sourcePackPath: bootstrapConfiguration.harnessPackPath,
            snapshotStorePath: bootstrapConfiguration.snapshotStorePath,
          },
          nodeCommandRunner,
          systemClock,
        )
      : new CommandWorkspaceBootstrapAdapter(bootstrapConfiguration, nodeCommandRunner);
  const bootstrap = new WorkspaceBootstrapCoordinator(
    new WorkspaceBootstrapStore(ledger.repository),
    bootstrapAdapter,
  );
  try {
    const runtime = await connectTaskerTemporalWorker(configuration, {
      ...createWorkflowAssemblyActivity(workflowGenerator),
      ...createWorkspaceActivity(subjects, workspaces, bootstrap, planning),
      ...createPlanningActivity(planning),
      ...createWorkflowDraftRevisionActivity(workflowDraftRevisions, planning),
      ...createWorkflowFreezeActivity(workflowFreezes),
      linkWorkflowContinuation: (input) => {
        const linked = workflowContinuation.linkExecution(input.parentTaskReference, {
          taskReference: input.childTaskReference,
          runId: input.childRunId,
        });
        if (!linked.ok) {
          throw new Error(`Workflow continuation link failed: ${linked.error.kind}`);
        }
        return Promise.resolve({ linked: true });
      },
      ...createTaskExecutionActivity({
        snapshots: planningStore,
        currentSteps: createCurrentStepRegistry(harnessPack),
        traces: executionTraces,
        mutationRecovery,
        agentRunner: new CodexCliTaskStepAgentRunner(nodeCommandRunner),
        commands: nodeCommandRunner,
        integrations: integrationAdapters,
        evidence: new LedgerTaskRunEvidenceSource(planningStore, executionTraces, reviewEvidence),
      }),
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
