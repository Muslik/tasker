import { mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { TextEncoder } from 'node:util';

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

const [control, jira, ledgerModule, providers, repositories, shared] = await Promise.all([
  import('../dist/control-plane/index.js'),
  import('../dist/integrations/index.js'),
  import('../dist/ledger/index.js'),
  import('../dist/providers/index.js'),
  import('../dist/repositories/index.js'),
  import('../dist/shared/index.js'),
]);

const ledger = ledgerModule.openSqliteLedger({ filename: databasePath, clock: shared.systemClock });
const service = control.createM1WorkflowService(ledger.repository, shared.systemClock);
const runService = new control.DeterministicStubRunService(
  ledger.repository,
  service,
  shared.systemClock,
);
const scheduler = new control.DurableStubScheduler(
  runService,
  ledger.repository,
  shared.systemClock,
  {
    capacity: 2,
    ownerId: `e2e-${String(process.pid)}`,
    leaseTimeoutMs: 1_000,
    pollIntervalMs: 10,
  },
);
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
const subjects = new control.WorkflowGenerationSubjectSource(resolve('.'), jiraIssueService);
const workflowGenerator = new control.CodexWorkflowGenerator(service, subjects);
const deterministicPlanner = new providers.DeterministicImplementationPlanner();
const e2ePlanner = {
  plan: async (request) => {
    const result = await deterministicPlanner.plan(request);
    const snapshot = request.context.taskSnapshot;
    if (
      !result.ok ||
      request.context.operatorGuidance !== null ||
      snapshot === null ||
      typeof snapshot !== 'object' ||
      Array.isArray(snapshot)
    ) {
      return result;
    }
    if (snapshot.fixtureId === 'avia-13236-short-bug') {
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
});
const workflowContinuation = control.createWorkflowContinuationCoordinator({
  ledger: ledger.repository,
  clock: shared.systemClock,
  workflows: service,
  subjects,
  repositories: repositoryCatalog,
});
const api = control.buildM1Api({
  service,
  jiraIssueService,
  workflowGenerator,
  implementationPlanning,
  workflowContinuation,
  runService,
  scheduler,
});

const close = async () => {
  scheduler.stop();
  await api.close();
  ledger.close();
};
process.once('SIGINT', () => void close());
process.once('SIGTERM', () => void close());

scheduler.start();
await api.listen({ host: '127.0.0.1', port: apiPort });
