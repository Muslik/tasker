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

const [control, jira, ledgerModule, planning, providers, repositories, shared, temporal] =
  await Promise.all([
    import('../dist/control-plane/index.js'),
    import('../dist/integrations/index.js'),
    import('../dist/ledger/index.js'),
    import('../dist/planning/index.js'),
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
const workflowGenerator = new control.CodexWorkflowGenerator(
  service,
  subjects,
  undefined,
  contextDiscovery,
);
const deterministicPlanner = new providers.DeterministicImplementationPlanner();
const e2eAnalyzer = {
  analyze: async (request) => {
    const snapshot = request.taskSnapshot;
    const parentSnapshot =
      snapshot !== null && typeof snapshot === 'object' && !Array.isArray(snapshot)
        ? (snapshot.parentTaskSnapshot ?? snapshot)
        : snapshot;
    const proposal = planning.analyzeTaskFixture(parentSnapshot);
    if (!proposal.ok) {
      return shared.err({
        kind: 'invalid_analyzer_output',
        issues: ['E2E analyzer could not reconstruct the fixture proposal.'],
      });
    }
    const source = JSON.parse(
      JSON.stringify(proposal.value.source, (_key, value) =>
        value !== null &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        value.kind === 'step' &&
        value.uses === 'code.implement@1'
          ? { ...value, with: { ...value.with, repository: 'twiket/ui-kit' } }
          : value,
      ),
    );
    return shared.ok({
      output: planning.WorkflowAnalyzerOutputSchema.parse({
        assemblyDecisions: proposal.value.assemblyDecisions,
        source,
        verificationPlan: proposal.value.verificationPlan,
      }),
      receipt: providers.WorkflowAnalyzerReceiptSchema.parse({
        status: 'completed',
        provider: 'codex_cli',
        analyzerVersion: 'codex-cli@1',
        cliVersion: 'temporal-e2e@1',
        model: 'deterministic',
        serviceTier: 'fast',
        sessionId: 'temporal-e2e-workflow-revision',
        promptHash: '0'.repeat(64),
        durationMs: 0,
        usage: {
          inputTokens: 0,
          cachedInputTokens: 0,
          outputTokens: 0,
          reasoningOutputTokens: 0,
        },
        hypotheticalApiCostUsd: null,
      }),
      stderr: '',
    });
  },
};
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
      if (JSON.stringify(request.context.workflow).includes('twiket/ui-kit')) return result;
      return {
        ...result,
        value: {
          ...result.value,
          decision: {
            status: 'workflow_change_required',
            request: {
              reason: 'The reproduced defect belongs to the shared seat component.',
              discoveredRepositories: ['twiket/ui-kit'],
              requiredCapabilities: ['repository.read', 'workspace.write', 'command.run'],
              evidence: ['The seat implementation resolves from @ott/ui-kit.'],
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
const workflowDraftRevisions = new control.WorkflowDraftRevisionCoordinator(
  service,
  subjects,
  e2eAnalyzer,
  contextDiscovery,
  repositoryCatalog,
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
const runRegistry = new temporal.LedgerTemporalRunRegistry(ledger.repository);
const temporalRunService = new temporal.TemporalTaskRunService(
  temporalEnvironment.client,
  {
    address: 'e2e-test-server',
    namespace: 'default',
    taskQueue,
    queryTimeoutMs: 5_000,
    updateTimeoutMs: 5_000,
  },
  runRegistry,
);
const workflowsPath = resolve('dist/temporal/workflows/task-workflow.js');
const planningActivity = temporal.createPlanningActivity(implementationPlanning);

const workspaceIdFor = (taskReference) =>
  Buffer.from(taskReference).toString('hex').slice(0, 24).padEnd(24, '0');

const completeStep = async (input) => ({
  status: 'completed',
  summary: `${input.uses} completed`,
  predicateResults: { 'attempt.succeeded@1': true },
  artifactIds: [],
  transcriptId: null,
});

const workflowActivities = {
  ...planningActivity,
  ...temporal.createWorkflowDraftRevisionActivity(workflowDraftRevisions, implementationPlanning),
  ...temporal.createWorkflowFreezeActivity(workflowFreezes),
  prepareTaskWorkspace: async (input) => {
    const subject = subjects.resolve(input.taskReference);
    if (!subject.ok) {
      throw new Error(`missing subject for ${input.taskReference}`);
    }
    const workspaceId = workspaceIdFor(input.taskReference);
    const workspace = {
      schemaVersion: 1,
      workspaceId,
      taskReference: input.taskReference,
      workflowId: input.workflowId,
      workflowRunId: input.workflowRunId,
      workflowHash: input.workflowHash,
      repository: {
        reference: subject.value.task.repository,
        sourcePath: subject.value.repositoryPath,
        baseCommit: '0'.repeat(40),
      },
      runnerId: 'temporal-e2e',
      path: resolve('.tasker/e2e-workspaces', input.taskReference),
      branch: `tasker/${input.taskReference}`,
      preparedAt: '2026-08-03T00:00:00.000Z',
    };
    const planningSnapshot = implementationPlanning.createRunSnapshot(
      input.taskReference,
      input.workflowHash,
      {
        workspaceId,
        reference: subject.value.task.repository,
        path: workspace.path,
      },
    );
    if (!planningSnapshot.ok) {
      throw new Error(`planning snapshot failed: ${planningSnapshot.error.kind}`);
    }
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
      planningSnapshot: planningSnapshot.value,
    };
  },
  executeStep: completeStep,
  executeReadOnlyStep: completeStep,
  executeWorkspaceReconciledStep: completeStep,
  executeRemoteReconciledStep: completeStep,
  evaluatePredicate: async (input) => input.facts[input.reference] ?? true,
  linkWorkflowContinuation: async (input) => {
    const linked = workflowContinuation.linkExecution(input.parentTaskReference, {
      taskReference: input.childTaskReference,
      runId: input.childRunId,
    });
    if (!linked.ok) {
      throw new Error(`continuation link failed: ${linked.error.kind}`);
    }
    return { linked: true };
  },
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
  workflowGenerator,
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
