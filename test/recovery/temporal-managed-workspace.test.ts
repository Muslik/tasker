import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { describe, expect, it } from 'vitest';

import {
  createImplementationPlanningCoordinator,
  createM1WorkflowService,
  WorkflowGenerationSubjectSource,
} from '../../src/control-plane/index.js';
import { openSqliteLedger } from '../../src/ledger/index.js';
import {
  findTaskFixture,
  planTaskWorkflow,
  RunPlanningSnapshotSchema,
} from '../../src/planning/index.js';
import {
  DeterministicImplementationPlanner,
  nodeCommandRunner,
} from '../../src/providers/index.js';
import { makeAdjustableClock } from '../../src/shared/clock.js';
import { ok } from '../../src/shared/outcome.js';
import {
  createPlanningActivity,
  createWorkspaceActivity,
  TemporalTaskRunService,
} from '../../src/temporal/index.js';
import { testTaskWorkflowActivities } from '../helpers/temporal-activities.js';
import { recordTestEvidenceBundle } from '../helpers/evidence.js';
import {
  ManagedWorkspaceManager,
  WorkspaceBootstrapCoordinator,
  WorkspaceBootstrapStore,
  WorkspaceStore,
  type WorkspaceConfiguration,
} from '../../src/workspaces/index.js';

const workflowsPath = fileURLToPath(
  new URL('../../src/temporal/workflows/task-workflow.ts', import.meta.url),
);

const git = (cwd: string, args: readonly string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

describe('Temporal managed workspace', () => {
  it('snapshots planning input from the durable worktree prepared inside the run', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tasker-temporal-workspace-'));
    const repositoryStorePath = join(root, 'application-data', 'repositories');
    const workspaceStorePath = join(root, 'application-data', 'worktrees');
    const repositoryPath = join(repositoryStorePath, 'fixture');
    mkdirSync(repositoryPath, { recursive: true });
    git(repositoryPath, ['init', '--quiet', '--initial-branch=main']);
    writeFileSync(join(repositoryPath, 'feature.txt'), 'before\n', 'utf8');
    git(repositoryPath, ['add', 'feature.txt']);
    git(repositoryPath, [
      '-c',
      'user.name=Tasker Test',
      '-c',
      'user.email=tasker@example.test',
      'commit',
      '--quiet',
      '-m',
      'fixture',
    ]);

    const clock = makeAdjustableClock('2026-08-03T12:00:00.000Z');
    const ledger = openSqliteLedger({ filename: join(root, 'tasker.sqlite'), clock });
    const environment = await TestWorkflowEnvironment.createTimeSkipping();
    let worker: Worker | null = null;
    let workerRun: Promise<void> | null = null;
    try {
      const taskReference = 'avia-13236-short-bug';
      const fixture = findTaskFixture(taskReference);
      if (fixture === undefined) throw new Error('Missing workspace fixture');
      const planned = planTaskWorkflow(fixture);
      if (!planned.ok) throw new Error('Workspace fixture did not compile');
      const workflowService = createM1WorkflowService(ledger.repository, clock);
      const generated = workflowService.generate(taskReference);
      if (!generated.ok) throw new Error('Workspace fixture did not generate');
      recordTestEvidenceBundle(ledger.repository, clock, taskReference);
      const subjects = new WorkflowGenerationSubjectSource(repositoryPath);
      const planning = createImplementationPlanningCoordinator({
        ledger: ledger.repository,
        clock,
        workflows: workflowService,
        subjects,
        planner: new DeterministicImplementationPlanner(),
      });
      const workspaceConfiguration: WorkspaceConfiguration = {
        repositoryStorePath,
        workspaceStorePath,
        runnerId: 'temporal-recovery-test',
      };
      const workspaces = new ManagedWorkspaceManager(
        workspaceConfiguration,
        new WorkspaceStore(ledger.repository, clock),
        nodeCommandRunner,
      );
      const bootstrap = new WorkspaceBootstrapCoordinator(
        new WorkspaceBootstrapStore(ledger.repository),
        {
          inspect: () => Promise.resolve(ok({ status: 'absent' as const })),
          apply: (workspace, operationId) =>
            Promise.resolve(
              ok({
                status: 'ready' as const,
                receipt: {
                  schemaVersion: 1 as const,
                  operationId,
                  workspaceId: workspace.workspaceId,
                  adapterId: 'recovery-test',
                  adapterVersion: '1',
                  profile: 'fixture',
                  files: [],
                  completedAt: clock.now(),
                },
              }),
            ),
        },
      );
      const taskQueue = `tasker-workspace-${String(process.pid)}-${String(Date.now())}`;
      worker = await Worker.create({
        connection: environment.nativeConnection,
        taskQueue,
        workflowsPath,
        activities: {
          ...testTaskWorkflowActivities,
          ...createWorkspaceActivity(subjects, workspaces, bootstrap, planning),
          ...createPlanningActivity(planning),
        },
        maxCachedWorkflows: 0,
      });
      workerRun = worker.run();
      const service = new TemporalTaskRunService(environment.client, {
        address: 'test-server',
        namespace: 'default',
        taskQueue,
        queryTimeoutMs: 5_000,
        updateTimeoutMs: 5_000,
      });

      const started = await service.start({
        taskReference,
        workflowHash: planned.value.compiled.hash,
        graph: planned.value.compiled.graph,
        settings: { planApproval: 'automatic', planningStrategy: 'fast' },
      });
      expect(started.ok).toBe(true);
      await expect
        .poll(async () => {
          const state = await service.read(taskReference);
          return state.ok && state.value?.status === 'waiting' ? state.value.wait.waitKind : null;
        })
        .toBe('code_review@1');
      const state = await service.read(taskReference);
      if (!state.ok || state.value?.executionContext.status !== 'ready') {
        throw new Error('Expected a ready managed execution context');
      }
      const context = state.value.executionContext;
      const artifact = ledger.repository.readArtifact(context.planningSnapshot.artifactId);
      if (artifact === null) throw new Error('Missing planning snapshot artifact');
      const snapshot = RunPlanningSnapshotSchema.parse(artifact.payload);

      expect(context.workspace.path.startsWith(workspaceStorePath)).toBe(true);
      expect(snapshot.repository).toEqual({
        workspaceId: context.workspace.workspaceId,
        reference: fixture.repository,
        path: context.workspace.path,
      });
      expect(context.workspace.repository.sourcePath).not.toBe(context.workspace.path);
    } finally {
      worker?.shutdown();
      if (workerRun !== null) await workerRun;
      await environment.teardown();
      ledger.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
