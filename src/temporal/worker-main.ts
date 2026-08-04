import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import {
  createImplementationPlanningCoordinator,
  ImplementationPlanningStore,
} from '../control-plane/implementation-planning.js';
import { PlanningTranscriptStore } from '../control-plane/planning-transcript.js';
import { createM1WorkflowService } from '../control-plane/m1-service.js';
import { WorkflowGenerationSubjectSource } from '../control-plane/workflow-generator.js';
import { createWorkflowContinuationCoordinator } from '../control-plane/workflow-continuation.js';
import { loadHarnessPack } from '../harness/index.js';
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
  loadWorkspaceConfiguration,
  loadWorkspaceBootstrapConfiguration,
  assertWorkspaceHarnessProvidesSkills,
  CommandWorkspaceBootstrapAdapter,
  HarnessProfileWorkspaceBootstrapAdapter,
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
  TemporalTaskStepTraceStore,
} from './activities/block-execution.js';
import { createWorkspaceActivity } from './activities/workspace-activity.js';
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
    workflowService,
  );
  const deterministicProvider = process.env.TASKER_WORKFLOW_PROVIDER === 'deterministic';
  const planningTranscripts = new PlanningTranscriptStore(ledger.repository, systemClock);
  const planningStore = new ImplementationPlanningStore(ledger.repository, systemClock);
  const planning = createImplementationPlanningCoordinator({
    ledger: ledger.repository,
    clock: systemClock,
    workflows: workflowService,
    subjects,
    harnessPack,
    planner: deterministicProvider
      ? new DeterministicImplementationPlanner()
      : new CodexCliImplementationPlanner(
          createTemporalActivityCommandRunner(nodeCommandRunner, planningTranscripts),
        ),
  });
  const workflowContinuation = createWorkflowContinuationCoordinator({
    ledger: ledger.repository,
    clock: systemClock,
    workflows: workflowService,
    subjects,
    repositories: repositoryCatalog,
  });
  const executionTraces = new TemporalTaskStepTraceStore(ledger.repository, systemClock);
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
      ...createWorkspaceActivity(subjects, workspaces, bootstrap, planning),
      ...createPlanningActivity(planning),
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
        agentRunner: new CodexCliTaskStepAgentRunner(nodeCommandRunner),
        commands: nodeCommandRunner,
      }),
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
