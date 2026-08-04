import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { describe, expect, it } from 'vitest';

import {
  createImplementationPlanningCoordinator,
  createM1WorkflowService,
  ImplementationPlanningStore,
  WorkflowGenerationSubjectSource,
} from '../../src/control-plane/index.js';
import { loadHarnessPack } from '../../src/harness/index.js';
import { openSqliteLedger } from '../../src/ledger/index.js';
import { parseTaskFixture, planTaskWorkflow } from '../../src/planning/index.js';
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
  type ExecuteTaskStepInput,
  type ExecuteTaskStepResult,
  type TaskWorkflowActivities,
  WorkspaceMutationRecoveryStore,
} from '../../src/temporal/index.js';
import {
  createCurrentStepRegistry,
  createTaskExecutionActivity,
  TemporalTaskStepTraceStore,
  type TaskStepAgentRequest,
  type TaskStepAgentRunner,
} from '../../src/temporal/activities/block-execution.js';
import {
  GitWorkspaceMutationInspector,
  HarnessProfileWorkspaceBootstrapAdapter,
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

const completedStep = (input: ExecuteTaskStepInput): ExecuteTaskStepResult => ({
  status: 'completed',
  summary: `${input.uses} completed by the recovery smoke adapter`,
  predicateResults: { 'attempt.succeeded@1': true },
  artifactIds: [],
  transcriptId: null,
});

const agentCompletion = (summary: string) =>
  ok({
    stdout: '',
    stderr: '',
    finalMessage: {
      status: 'completed',
      output: { summary, artifacts: [] },
    },
  });

const waitForAbort = (signal: AbortSignal): Promise<never> =>
  new Promise((_, reject) => {
    const abort = (): void => {
      reject(
        signal.reason instanceof Error ? signal.reason : new Error('Activity delivery stopped'),
      );
    };
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });

describe('Temporal local mutation recovery', () => {
  it('continues a feature task in the same worktree after replacing its Worker', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tasker-temporal-local-mutation-'));
    const repositoryStorePath = join(root, 'application-data', 'repositories');
    const workspaceStorePath = join(root, 'application-data', 'worktrees');
    const repositoryPath = join(repositoryStorePath, 'front-avia');
    const sourceRelativePath = 'src/passenger-name.ts';
    const testRelativePath = 'test/passenger-name.test.ts';
    const sourcePath = join(repositoryPath, sourceRelativePath);
    mkdirSync(join(repositoryPath, 'src'), { recursive: true });
    mkdirSync(join(repositoryPath, 'test'), { recursive: true });
    writeFileSync(
      sourcePath,
      'export const normalizePassengerName = (value: string): string => value;\n',
      'utf8',
    );
    writeFileSync(
      join(repositoryPath, testRelativePath),
      [
        "import assert from 'node:assert/strict';",
        "import test from 'node:test';",
        '',
        "import { normalizePassengerName } from '../src/passenger-name.ts';",
        '',
        "test('normalizes a displayed passenger name', () => {",
        "  assert.equal(normalizePassengerName('  Ada   Lovelace  '), 'Ada Lovelace');",
        "  assert.equal(normalizePassengerName('   '), '');",
        '});',
        '',
      ].join('\n'),
      'utf8',
    );
    git(repositoryPath, ['init', '--quiet', '--initial-branch=main']);
    git(repositoryPath, ['add', '.']);
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

    const fixtureResult = parseTaskFixture({
      fixtureId: 'tasker-passenger-name-recovery',
      taskId: 'TASKER-16001',
      title: 'Normalize the displayed passenger name',
      description:
        'Trim surrounding whitespace, collapse internal whitespace, preserve empty values, and add regression coverage.',
      repository: 'onetwotrip/front-avia',
      translationIntent: 'none',
      family: 'feature_with_review',
      verification: 'full',
      expected: 'accepted',
      proposalVariant: 'valid',
    });
    if (!fixtureResult.ok) throw new Error('Disposable task fixture is invalid');
    const task = fixtureResult.value;
    const planned = planTaskWorkflow(task);
    if (!planned.ok) throw new Error('Disposable task workflow did not compile');

    const clock = makeAdjustableClock('2026-08-04T12:00:00.000Z');
    const ledger = openSqliteLedger({ filename: join(root, 'tasker.sqlite'), clock });
    const environment = await TestWorkflowEnvironment.createTimeSkipping();
    const workers: { worker: Worker; run: Promise<void> }[] = [];
    try {
      const workflowService = createM1WorkflowService(ledger.repository, clock);
      const savedSubject = workflowService.saveGenerationSubject(task.fixtureId, {
        schemaVersion: 1,
        repositoryPath,
        task,
        taskSnapshot: task,
      });
      if (!savedSubject.ok) throw new Error('Disposable task subject was not saved');
      const generated = workflowService.generateTask(task);
      if (!generated.ok) throw new Error('Disposable task workflow was not generated');

      const harnessPack = loadHarnessPack();
      const subjects = new WorkflowGenerationSubjectSource(
        repositoryPath,
        undefined,
        workflowService,
      );
      const planningStore = new ImplementationPlanningStore(ledger.repository, clock);
      const planning = createImplementationPlanningCoordinator({
        ledger: ledger.repository,
        clock,
        workflows: workflowService,
        subjects,
        harnessPack,
        planner: new DeterministicImplementationPlanner(),
      });
      const workspaceConfiguration: WorkspaceConfiguration = {
        repositoryStorePath,
        workspaceStorePath,
        runnerId: 'temporal-local-mutation-recovery-test',
      };
      const workspaces = new ManagedWorkspaceManager(
        workspaceConfiguration,
        new WorkspaceStore(ledger.repository, clock),
        nodeCommandRunner,
      );
      const bootstrap = new WorkspaceBootstrapCoordinator(
        new WorkspaceBootstrapStore(ledger.repository),
        new HarnessProfileWorkspaceBootstrapAdapter(
          {
            sourcePackPath: join(process.cwd(), 'harness/workspace'),
            snapshotStorePath: join(root, 'application-data', 'harness-snapshots'),
          },
          nodeCommandRunner,
          clock,
        ),
      );
      const traces = new TemporalTaskStepTraceStore(ledger.repository, clock);
      const mutationRecovery = new WorkspaceMutationRecoveryStore(
        ledger.repository,
        clock,
        new GitWorkspaceMutationInspector(nodeCommandRunner),
      );
      const taskQueue = `tasker-local-mutation-${String(process.pid)}-${String(Date.now())}`;
      const mutatedImplementation = [
        'export const normalizePassengerName = (value: string): string =>',
        "  value.trim().replace(/\\s+/gu, ' ');",
        '',
      ].join('\n');
      let resolveMutationObserved: (() => void) | null = null;
      const mutationObserved = new Promise<void>((resolve) => {
        resolveMutationObserved = resolve;
      });
      const firstRequests: TaskStepAgentRequest[] = [];
      const replacementRequests: TaskStepAgentRequest[] = [];
      const verificationCommands: string[] = [];

      const firstRunner: TaskStepAgentRunner = {
        provider: 'codex',
        run: async (request) => {
          firstRequests.push(request);
          if (!request.prompt.includes('"stepReference": "code.implement@1"')) {
            return agentCompletion('Task analysis completed');
          }
          writeFileSync(join(request.cwd, sourceRelativePath), mutatedImplementation, 'utf8');
          resolveMutationObserved?.();
          return waitForAbort(request.runtime.cancellationSignal);
        },
      };
      const replacementRunner: TaskStepAgentRunner = {
        provider: 'codex',
        run: (request) => {
          replacementRequests.push(request);
          if (request.prompt.includes('"stepReference": "verify.full@1"')) {
            execFileSync('node', ['--experimental-strip-types', '--test', testRelativePath], {
              cwd: request.cwd,
              stdio: 'pipe',
            });
            verificationCommands.push('test');
            execFileSync(
              join(process.cwd(), 'node_modules/.bin/tsc'),
              [
                '--noEmit',
                '--strict',
                '--target',
                'ES2022',
                '--module',
                'ESNext',
                join(request.cwd, sourceRelativePath),
              ],
              { cwd: request.cwd, stdio: 'pipe' },
            );
            verificationCommands.push('build');
            return Promise.resolve(agentCompletion('Tests and TypeScript build passed'));
          }
          return Promise.resolve(agentCompletion('Existing worktree mutation accepted'));
        },
      };

      const createActivities = (agentRunner: TaskStepAgentRunner): TaskWorkflowActivities => {
        const execution = createTaskExecutionActivity({
          snapshots: planningStore,
          currentSteps: createCurrentStepRegistry(harnessPack),
          traces,
          mutationRecovery,
          agentRunner,
          commands: nodeCommandRunner,
        });
        const executeStep = (input: ExecuteTaskStepInput): Promise<ExecuteTaskStepResult> =>
          input.uses === 'pr.prepare@1' || input.uses === 'ci.observe@1'
            ? Promise.resolve(completedStep(input))
            : execution.executeStep(input);

        return {
          ...createWorkspaceActivity(subjects, workspaces, bootstrap, planning),
          ...createPlanningActivity(planning),
          executeStep,
          executeWorkspaceReconciledStep: execution.executeWorkspaceReconciledStep,
          executeRemoteReconciledStep: (input) =>
            input.uses === 'pr.prepare@1'
              ? Promise.resolve(completedStep(input))
              : execution.executeRemoteReconciledStep(input),
          evaluatePredicate: execution.evaluatePredicate,
          linkWorkflowContinuation: () => Promise.resolve({ linked: true }),
        };
      };

      const startWorker = async (agentRunner: TaskStepAgentRunner): Promise<Worker> => {
        const worker = await Worker.create({
          connection: environment.nativeConnection,
          taskQueue,
          workflowsPath,
          activities: createActivities(agentRunner),
          maxCachedWorkflows: 0,
          shutdownGraceTime: 0,
          shutdownForceTime: '5 seconds',
        });
        workers.push({ worker, run: worker.run() });
        return worker;
      };

      const firstWorker = await startWorker(firstRunner);
      const service = new TemporalTaskRunService(environment.client, {
        address: 'test-server',
        namespace: 'default',
        taskQueue,
        queryTimeoutMs: 5_000,
        updateTimeoutMs: 5_000,
      });
      const started = await service.start({
        taskReference: task.fixtureId,
        workflowHash: planned.value.compiled.hash,
        graph: planned.value.compiled.graph,
        settings: { planApproval: 'automatic', planningStrategy: 'fast' },
      });
      expect(started.ok).toBe(true);
      await mutationObserved;

      firstWorker.shutdown();
      const firstWorkerRuntime = workers.find(({ worker }) => worker === firstWorker);
      if (firstWorkerRuntime === undefined) throw new Error('First Worker runtime was lost');
      await firstWorkerRuntime.run;
      await startWorker(replacementRunner);

      await expect
        .poll(async () => {
          const state = await service.read(task.fixtureId);
          return state.ok && state.value?.status === 'waiting' ? state.value.wait.waitKind : null;
        })
        .toBe('code_review@1');
      const state = await service.read(task.fixtureId);
      if (!state.ok || state.value?.executionContext.status !== 'ready') {
        throw new Error('Expected the recovered task to retain a ready execution context');
      }
      const implementationRequests = [
        ...firstRequests.filter((request) =>
          request.prompt.includes('"stepReference": "code.implement@1"'),
        ),
        ...replacementRequests.filter((request) =>
          request.prompt.includes('"stepReference": "code.implement@1"'),
        ),
      ];
      const operationId = implementationRequests[0]?.operationId;
      if (operationId === undefined) throw new Error('Implementation delivery was not recorded');

      expect(state.value.executionContext.bootstrap.profile).toBe('front-avia');
      expect(new Set(implementationRequests.map((request) => request.cwd))).toEqual(
        new Set([state.value.executionContext.workspace.path]),
      );
      expect(
        readFileSync(join(state.value.executionContext.workspace.path, sourceRelativePath), 'utf8'),
      ).toBe(mutatedImplementation);
      expect(
        git(state.value.executionContext.workspace.path, [
          'status',
          '--short',
          '--untracked-files=all',
        ]),
      ).toBe(`M ${sourceRelativePath}`);
      expect(firstRequests.filter((request) => request.operationId === operationId)).toHaveLength(
        1,
      );
      expect(
        replacementRequests.filter((request) => request.operationId === operationId),
      ).toHaveLength(1);
      expect(implementationRequests.map((request) => request.recovery.kind)).toEqual([
        'initial_delivery',
        'recovery_delivery',
      ]);
      expect(implementationRequests[1]?.recovery).toMatchObject({
        kind: 'recovery_delivery',
        changedSinceInitialDelivery: true,
        current: { changedPaths: [{ status: ' M', path: sourceRelativePath }] },
      });
      expect(verificationCommands).toEqual(['test', 'build']);
      expect(
        ledger.repository.readArtifact(`task-step-mutation-intent:${operationId}`),
      ).not.toBeNull();
      expect(
        ledger.repository.readArtifact(`task-step-output:${operationId}:artifact`),
      ).not.toBeNull();
    } finally {
      for (const runtime of workers.toReversed()) {
        if (runtime.worker.getState() === 'RUNNING') runtime.worker.shutdown();
        await runtime.run.catch(() => undefined);
      }
      await environment.teardown();
      ledger.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
