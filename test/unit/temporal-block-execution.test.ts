import { createHash } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadHarnessPack } from '../../src/harness/index.js';
import { openSqliteLedger, type SqliteLedger } from '../../src/ledger/index.js';
import { findTaskFixture } from '../../src/planning/index.js';
import { RunPlanningSnapshotSchema } from '../../src/planning/run-planning-snapshot.js';
import type { CommandRunner } from '../../src/providers/command-runner.js';
import { ok } from '../../src/shared/outcome.js';
import { systemClock } from '../../src/shared/clock.js';
import {
  createCurrentStepRegistry,
  executeRegisteredTaskStep,
  TemporalTaskStepTraceStore,
  type TaskStepAgentRunner,
} from '../../src/temporal/activities/block-execution.js';

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

const pack = loadHarnessPack();
const fixture = findTaskFixture('avia-13236-short-bug');
if (fixture === undefined) throw new Error('Missing avia-13236-short-bug fixture');
const translationFixture = findTaskFixture('avia-14001-translation-component');
if (translationFixture === undefined) {
  throw new Error('Missing avia-14001-translation-component fixture');
}

const project = pack.projects.find((candidate) => candidate.repository === fixture.repository);
if (project === undefined) throw new Error('Missing harness project for fixture repository');

const stubWorkspace = {
  schemaVersion: 1 as const,
  workspaceId: 'b'.repeat(24),
  taskReference: 'task-ref',
  workflowId: 'tasker:task-ref',
  workflowRunId: 'run-1',
  workflowHash: 'a'.repeat(64),
  repository: {
    reference: fixture.repository,
    sourcePath: '/tmp/source',
    baseCommit: 'c'.repeat(40),
  },
  runnerId: 'test-runner',
  path: '/tmp/worktree',
  branch: 'tasker/task-ref',
  preparedAt: '2026-08-03T00:00:00.000Z',
};

const makeSnapshot = (
  stepReference: string,
  options: {
    readonly promptContent?: string;
    readonly task?: typeof fixture;
    readonly repositoryReference?: string;
    readonly workspacePath?: string;
    readonly workspaceId?: string;
  } = {},
) => {
  const promptContent = options.promptContent ?? 'SNAPSHOT PROMPT';
  const task = options.task ?? fixture;
  const repositoryReference = options.repositoryReference ?? fixture.repository;
  const workspacePath = options.workspacePath ?? stubWorkspace.path;
  const workspaceId = options.workspaceId ?? stubWorkspace.workspaceId;
  const current = pack.steps.find((step) => step.reference === stepReference);
  if (current === undefined) throw new Error(`Missing harness step ${stepReference}`);
  const snapshotProject = pack.projects.find(
    (candidate) => candidate.repository === repositoryReference,
  );
  if (snapshotProject === undefined) {
    throw new Error(`Missing harness project for ${repositoryReference}`);
  }
  const { guidance, ...projectManifest } = snapshotProject;
  const step =
    current.execution.kind === 'agent'
      ? {
          reference: current.reference,
          execution: {
            kind: 'agent' as const,
            skills: current.execution.skills,
            prompt: {
              relativePath: current.prompt?.relativePath ?? 'prompt.md',
              content: promptContent,
              contentSha256: sha256(promptContent),
            },
          },
        }
      : current.execution.kind === 'process'
        ? {
            reference: current.reference,
            execution: {
              kind: 'process' as const,
              executor: current.execution.executor,
              command:
                snapshotProject.processCommands[current.execution.executor] ??
                pack.company.processCommands[current.execution.executor] ??
                'unconfigured process executor',
            },
          }
        : {
            reference: current.reference,
            execution: {
              kind: 'integration' as const,
              adapter: current.execution.adapter,
            },
          };
  return RunPlanningSnapshotSchema.parse({
    schemaVersion: 1,
    taskReference: 'task-ref',
    workflowHash: 'a'.repeat(64),
    task,
    taskSnapshot: task,
    workflow: {},
    repository: {
      workspaceId,
      reference: repositoryReference,
      path: workspacePath,
    },
    harness: {
      company: pack.company,
      project: {
        manifest: projectManifest,
        guidance,
      },
      implementationPlannerPrompt: pack.prompts.implementationPlanner,
      steps: [step],
    },
    createdAt: '2026-08-03T00:00:00.000Z',
  });
};

describe('temporal block execution activity', () => {
  let ledger: SqliteLedger;

  afterEach(() => {
    ledger.close();
  });

  it('uses the snapshotted agent prompt instead of the current harness prompt path', async () => {
    ledger = openSqliteLedger({ filename: ':memory:', clock: systemClock });
    const traces = new TemporalTaskStepTraceStore(ledger.repository, systemClock);
    const prompts: string[] = [];
    const agentRunner: TaskStepAgentRunner = {
      run: (request) => {
        prompts.push(request.prompt);
        return Promise.resolve(
          ok({
            stdout: '',
            stderr: '',
            finalMessage: {
              status: 'completed',
              output: {
                summary: 'Verification completed',
                artifacts: [],
              },
            },
          }),
        );
      },
    };

    const result = await executeRegisteredTaskStep(
      {
        taskReference: 'task-ref',
        workflowId: stubWorkspace.workflowId,
        workflowRunId: stubWorkspace.workflowRunId,
        workflowHash: stubWorkspace.workflowHash,
        nodeId: 'verify-targeted',
        stepAttempt: 1,
        uses: 'verify.targeted@1',
        workspace: stubWorkspace,
        planningSnapshot: {
          artifactId: 'planning-snapshot:test',
          checksum: 'd'.repeat(64),
        },
        operatorGuidance: 'VPN is enabled; retry the same verification without restarting.',
        input: {
          profile: 'targeted',
          taskId: fixture.taskId,
        },
      },
      {
        snapshots: {
          readRunSnapshot: () => ok(makeSnapshot('verify.targeted@1')),
        },
        currentSteps: createCurrentStepRegistry(pack),
        traces,
        agentRunner,
        commands: {
          run: vi.fn(),
        },
      },
      {
        attempt: 1,
        cancellationSignal: new AbortController().signal,
        heartbeat: () => {},
      },
    );

    expect(result).toMatchObject({
      status: 'completed',
      summary: 'Verification completed',
    });
    expect(prompts[0]).toContain('SNAPSHOT PROMPT');
    expect(prompts[0]).toContain('VPN is enabled; retry the same verification');
  });

  it('resolves a registered process command from the immutable snapshot project policy', async () => {
    ledger = openSqliteLedger({ filename: ':memory:', clock: systemClock });
    const traces = new TemporalTaskStepTraceStore(ledger.repository, systemClock);
    const commands: CommandRunner['run'] = vi.fn(() =>
      Promise.resolve({
        status: 'exited' as const,
        exitCode: 0,
        stdout: 'extract ok\n',
        stderr: '',
        durationMs: 3,
      }),
    );

    const componentWorkspace = {
      ...stubWorkspace,
      workspaceId: 'e'.repeat(24),
      workflowId: 'tasker:component-task',
      workflowRunId: 'run-2',
      repository: {
        ...stubWorkspace.repository,
        reference: 'twiket/ui-kit',
      },
    };

    const result = await executeRegisteredTaskStep(
      {
        taskReference: 'task-ref',
        workflowId: componentWorkspace.workflowId,
        workflowRunId: componentWorkspace.workflowRunId,
        workflowHash: componentWorkspace.workflowHash,
        nodeId: 'extract-translation-keys',
        stepAttempt: 1,
        uses: 'translations.extract@1',
        workspace: componentWorkspace,
        planningSnapshot: {
          artifactId: 'planning-snapshot:test',
          checksum: 'd'.repeat(64),
        },
        operatorGuidance: null,
        input: {
          repository: 'twiket/ui-kit',
          taskId: translationFixture.taskId,
        },
      },
      {
        snapshots: {
          readRunSnapshot: () =>
            ok(
              makeSnapshot('translations.extract@1', {
                task: translationFixture,
                repositoryReference: 'twiket/ui-kit',
                workspacePath: componentWorkspace.path,
                workspaceId: componentWorkspace.workspaceId,
              }),
            ),
        },
        currentSteps: createCurrentStepRegistry(pack),
        traces,
        agentRunner: {
          run: vi.fn(),
        },
        commands: { run: commands },
      },
      {
        attempt: 1,
        cancellationSignal: new AbortController().signal,
        heartbeat: () => {},
      },
    );

    expect(result).toMatchObject({ status: 'completed' });
    expect(commands).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'pnpm',
        args: ['translations:extract'],
        cwd: componentWorkspace.path,
      }),
    );
  });

  it('uses the snapshotted development publish command for shared component tasks', async () => {
    ledger = openSqliteLedger({ filename: ':memory:', clock: systemClock });
    const traces = new TemporalTaskStepTraceStore(ledger.repository, systemClock);
    const commands: CommandRunner['run'] = vi.fn(() =>
      Promise.resolve({
        status: 'exited' as const,
        exitCode: 0,
        stdout: 'publish ok\n',
        stderr: '',
        durationMs: 3,
      }),
    );

    const componentWorkspace = {
      ...stubWorkspace,
      workspaceId: 'f'.repeat(24),
      workflowId: 'tasker:component-task',
      workflowRunId: 'run-3',
      repository: {
        ...stubWorkspace.repository,
        reference: 'twiket/ui-kit',
      },
    };

    const result = await executeRegisteredTaskStep(
      {
        taskReference: 'task-ref',
        workflowId: componentWorkspace.workflowId,
        workflowRunId: componentWorkspace.workflowRunId,
        workflowHash: componentWorkspace.workflowHash,
        nodeId: 'publish-development-package',
        stepAttempt: 1,
        uses: 'component.dev_publish@1',
        workspace: componentWorkspace,
        planningSnapshot: {
          artifactId: 'planning-snapshot:test',
          checksum: 'd'.repeat(64),
        },
        operatorGuidance: null,
        input: {
          repository: 'twiket/ui-kit',
          taskId: translationFixture.taskId,
        },
      },
      {
        snapshots: {
          readRunSnapshot: () =>
            ok(
              makeSnapshot('component.dev_publish@1', {
                task: translationFixture,
                repositoryReference: 'twiket/ui-kit',
                workspacePath: componentWorkspace.path,
                workspaceId: componentWorkspace.workspaceId,
              }),
            ),
        },
        currentSteps: createCurrentStepRegistry(pack),
        traces,
        agentRunner: {
          run: vi.fn(),
        },
        commands: {
          run: commands,
        },
      },
      {
        attempt: 1,
        cancellationSignal: new AbortController().signal,
        heartbeat: () => {},
      },
    );

    expect(result).toMatchObject({ status: 'completed' });
    expect(commands).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'pnpm',
        args: ['component:publish-dev'],
        cwd: componentWorkspace.path,
      }),
    );
  });
});
