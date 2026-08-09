import { Buffer } from 'node:buffer';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { TextEncoder } from 'node:util';

import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';

const databasePath = resolve('.tasker/e2e.sqlite');
const apiPort = Number(process.env.TASKER_E2E_API_PORT ?? '4311');
if (!Number.isSafeInteger(apiPort) || apiPort < 1 || apiPort > 65_535) {
  throw new Error(`Invalid TASKER_E2E_API_PORT: ${process.env.TASKER_E2E_API_PORT ?? ''}`);
}
mkdirSync(dirname(databasePath), { recursive: true });

for (const filename of [databasePath, `${databasePath}-shm`, `${databasePath}-wal`]) {
  rmSync(filename, { force: true });
}

process.env.TASKER_DB_PATH = databasePath;
process.env.TASKER_PORT = String(apiPort);
process.env.TASKER_WORKFLOW_PROVIDER = 'deterministic';

const [control, jira, ledgerModule, providers, repositories, shared, temporal] = await Promise.all([
  import('../dist/control-plane/index.js'),
  import('../dist/integrations/index.js'),
  import('../dist/ledger/index.js'),
  import('../dist/providers/index.js'),
  import('../dist/repositories/index.js'),
  import('../dist/shared/index.js'),
  import('../dist/temporal/index.js'),
]);

const ledger = ledgerModule.openSqliteLedger({ filename: databasePath, clock: shared.systemClock });
const service = control.createM1WorkflowService(ledger.repository, shared.systemClock);
const snapshot = jira.JiraIssueSnapshotSchema.parse({
  schemaVersion: 1,
  issueKey: 'AVIA-13235',
  issueId: '325225',
  browseUrl: 'https://jira.twiket.com/browse/AVIA-13235',
  summary: 'Seat map uses the wrong color for the leg-space arrow',
  description:
    'h3. Environment\nWeb and mobile\n\nh3. Steps\n# Open seat selection\n# Find an exit-row seat\n\nh3. Expected result\nThe arrow matches the seat back.',
  issueType: 'Bug',
  status: 'In Release',
  priority: 'None',
  labels: ['bug_verified', 'frontend', 'seats_selection'],
  assignee: { displayName: 'Dzhabrail Markhiev' },
  reporter: { displayName: 'Dzhabrail Markhiev' },
  repositoryHint: 'module:src/features/additionalServices/selectSeats',
  createdAt: '2026-07-30T09:46:36.136Z',
  updatedAt: '2026-07-31T10:12:04.077Z',
  syncedAt: '2026-08-01T19:15:00.000Z',
  attachments: [
    {
      id: '245370',
      filename: 'seatmap-legspace-arrow.mp4',
      mimeType: 'video/mp4',
      size: 543651,
      createdAt: '2026-07-30T09:46:47.388Z',
      contentUrl: 'https://jira.twiket.com/secure/attachment/245370/seatmap-legspace-arrow.mp4',
    },
    {
      id: '245379',
      filename: 'fix-before-after.png',
      mimeType: 'image/png',
      size: 19837,
      createdAt: '2026-07-30T10:04:32.754Z',
      contentUrl: 'https://jira.twiket.com/secure/attachment/245379/fix-before-after.png',
    },
  ],
  comments: [
    {
      id: '1094745',
      author: { displayName: 'Dzhabrail Markhiev' },
      body: 'Fixed — video: [^seatmap-legspace-arrow.mp4]\n\nPR: [729|https://bitbucket.twiket.com/pull-requests/729]',
      createdAt: '2026-07-30T10:14:14.190Z',
      updatedAt: '2026-07-30T10:30:23.432Z',
    },
  ],
  links: [],
});
const repositoryCatalog = new repositories.StaticRepositoryCatalog([
  {
    repositoryId: 'front-avia',
    remoteUrl: 'ssh://git@bitbucket.twiket.com/onetwotrip/front-avia.git',
    checkout: { runnerId: 'e2e', path: resolve('.') },
    checkoutPaths: [resolve('.')],
    aliases: ['front-avia', 'onetwotrip/front-avia'],
  },
  {
    repositoryId: 'ui-kit',
    remoteUrl: 'ssh://git@bitbucket.twiket.com/twiket/ui-kit.git',
    checkout: { runnerId: 'e2e', path: resolve('.') },
    checkoutPaths: [resolve('.')],
    aliases: ['ui-kit', 'twiket/ui-kit'],
  },
]);
const jiraIssueService = jira.createJiraIssueService(
  ledger.repository,
  shared.systemClock,
  {
    fetchIssue: async () => ({ ok: true, value: snapshot }),
    fetchAttachment: async (contentUrl) =>
      contentUrl.endsWith('.png')
        ? {
            ok: true,
            value: {
              bytes: new TextEncoder().encode(
                '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="160"><rect width="320" height="160" fill="#172026"/><rect x="72" y="38" width="176" height="84" rx="12" fill="#2dd4bf" opacity=".2"/><path d="M120 80h80m-20-18 20 18-20 18" stroke="#5eead4" stroke-width="8" fill="none"/><text x="16" y="145" fill="#94a3b8" font-family="sans-serif" font-size="12">before / after</text></svg>',
              ),
              contentType: 'image/svg+xml',
            },
          }
        : {
            ok: true,
            value: { bytes: new Uint8Array([1, 2, 3]), contentType: 'video/mp4' },
          },
  },
  {
    repositoryCatalog,
  },
);
const subjects = new control.WorkflowGenerationSubjectSource(
  resolve('.'),
  jiraIssueService,
  service,
);
const evidenceBundles = new control.EvidenceBundleStore(ledger.repository, shared.systemClock);
const contextDiscovery = new control.ContextDiscoveryService(evidenceBundles, shared.systemClock);
const deterministicPlanner = new providers.DeterministicImplementationPlanner();
const e2ePlanner = {
  plan: async (request) => {
    const result = await deterministicPlanner.plan(request);
    const snapshot = request.context.taskSnapshot;
    if (
      !result.ok ||
      snapshot === null ||
      typeof snapshot !== 'object' ||
      Array.isArray(snapshot)
    ) {
      return result;
    }
    if (snapshot.fixtureId === 'avia-13236-short-bug') {
      if (result.value.decision?.status !== 'ready') return result;
      const source = JSON.parse(
        JSON.stringify(result.value.decision.workflow.source, (_key, value) =>
          value !== null &&
          typeof value === 'object' &&
          !Array.isArray(value) &&
          value.kind === 'step' &&
          value.uses === 'code.implement@1'
            ? { ...value, with: { ...value.with, repository: 'twiket/ui-kit' } }
            : value,
        ),
      );
      return {
        ...result,
        value: {
          ...result.value,
          decision: {
            ...result.value.decision,
            workflow: {
              ...result.value.decision.workflow,
              source,
              assemblyDecisions: [
                ...result.value.decision.workflow.assemblyDecisions,
                {
                  id: 'planner-cross-repository-owner',
                  title: 'Shared component owner selected',
                  source: 'planner:repository-analysis',
                  reason: 'The affected implementation belongs to twiket/ui-kit.',
                  effect: 'Run the implementation block against the owning repository.',
                },
              ],
            },
          },
        },
      };
    }
    if (request.context.operatorGuidance !== null) return result;
    if (snapshot.fixtureId !== 'avia-14002-inline-copy') return result;
    return {
      ...result,
      value: {
        ...result.value,
        decision: {
          status: 'needs_clarification',
          questions: [
            {
              id: 'copy-owner',
              question: 'Should this copy stay local to the application?',
              reason: 'The answer determines whether execution stays in this repository.',
            },
          ],
        },
      },
    };
  },
};
const implementationPlanning = control.createImplementationPlanningCoordinator({
  ledger: ledger.repository,
  clock: shared.systemClock,
  workflows: service,
  subjects,
  planner: e2ePlanner,
  evidenceBundles,
});
const planningContexts = new control.BootstrapContextAssembler(
  subjects,
  contextDiscovery,
  implementationPlanning,
);
const workflowFreezes = new control.WorkflowFreezeStore(ledger.repository, shared.systemClock);
const workflowContinuation = control.createWorkflowContinuationCoordinator({
  ledger: ledger.repository,
  clock: shared.systemClock,
  workflows: service,
  subjects,
  repositories: repositoryCatalog,
});

const taskQueue = `tasker-e2e-${String(process.pid)}`;
const temporalEnvironment = await TestWorkflowEnvironment.createTimeSkipping();
const temporalRunService = new temporal.TemporalTaskRunService(temporalEnvironment.client, {
  address: 'e2e-test-server',
  namespace: 'default',
  taskQueue,
  queryTimeoutMs: 5_000,
  updateTimeoutMs: 5_000,
});
const workflowsPath = resolve('dist/temporal/workflows/index.js');
const planningActivity = temporal.createPlanningActivity(implementationPlanning);

const workspaceIdFor = (taskReference) =>
  Buffer.from(taskReference).toString('hex').slice(0, 24).padEnd(24, '0');

const dockerRuntimeFor = (workspace) => ({
  schemaVersion: 1,
  workspaceId: workspace.workspaceId,
  workspacePath: workspace.path,
  repositorySourcePath: workspace.repository.sourcePath,
  policyHash: '1'.repeat(64),
  policy: {
    engine: 'docker',
    image: { kind: 'prebuilt', reference: 'tasker/workspace:e2e' },
    workspaceMountPath: '/workspace',
    environment: {},
    bootstrap: [],
    cacheVolumes: [],
    services: [],
  },
  image: 'tasker/workspace:e2e',
  imageId: 'sha256:temporal-e2e',
  networkName: `tasker-network-${workspace.workspaceId}`,
  volumes: [],
  services: [],
  environment: {},
  initializedVolumes: [],
  completedBootstrap: [],
  status: 'ready',
  preparedAt: '2026-08-03T00:00:00.000Z',
  updatedAt: '2026-08-03T00:00:00.000Z',
});

const workflowActivities = {
  ...planningActivity,
  ...temporal.createBootstrapContextAssemblyActivity(planningContexts),
  ...temporal.createWorkflowFreezeActivity(workflowFreezes),
  prepareTaskWorkspace: async (input) => {
    const subject = subjects.resolve(input.taskReference);
    if (!subject.ok) {
      throw new Error(`missing subject for ${input.taskReference}`);
    }
    const workspaceId = workspaceIdFor(input.taskReference);
    const workspacePath = subject.value.repositoryPath;
    const workspace = {
      schemaVersion: 1,
      workspaceId,
      taskReference: input.taskReference,
      workflowId: input.workflowId,
      workflowRunId: input.workflowRunId,
      repository: {
        reference: subject.value.task.repository,
        sourcePath: subject.value.repositoryPath,
        baseCommit: '0'.repeat(40),
      },
      runnerId: 'temporal-e2e',
      path: workspacePath,
      branch: `tasker/${input.taskReference}`,
      preparedAt: '2026-08-03T00:00:00.000Z',
    };
    return {
      workspace,
      bootstrap: {
        schemaVersion: 1,
        operationId: `workspace:${workspaceId}:bootstrap@1`,
        workspaceId,
        adapterId: 'temporal-e2e',
        adapterVersion: '1',
        profile: 'fixture',
        files: [],
        completedAt: '2026-08-03T00:00:00.000Z',
      },
      runtime: dockerRuntimeFor(workspace),
    };
  },
  runExecutionBlock: async (input) => ({
    status: 'completed',
    summary: `${input.uses} completed`,
    predicateFacts: { 'attempt.succeeded@1': true },
    receiptReference: `e2e:block:${input.workflowId}:${input.nodeId}:${String(input.blockRun)}`,
  }),
  evaluateExecutionPredicate: async (input) => input.facts[input.reference] ?? true,
};
const worker = await Worker.create({
  connection: temporalEnvironment.nativeConnection,
  taskQueue,
  workflowsPath,
  activities: workflowActivities,
  maxCachedWorkflows: 0,
});
const workerRun = worker.run();

const api = control.buildM1Api({
  service,
  jiraIssueService,
  implementationPlanning,
  workflowContinuation,
  temporalRunService,
});

const close = async () => {
  worker.shutdown();
  await workerRun;
  await temporalEnvironment.teardown();
  await api.close();
  ledger.close();
};
process.once('SIGINT', () => void close());
process.once('SIGTERM', () => void close());

await api.listen({ host: '127.0.0.1', port: apiPort });
