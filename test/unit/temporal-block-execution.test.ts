import { createHash } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadHarnessPack } from '../../src/harness/index.js';
import { IntegrationStepAdapterRegistry } from '../../src/integrations/index.js';
import { openSqliteLedger, type SqliteLedger } from '../../src/ledger/index.js';
import { findTaskFixture } from '../../src/planning/index.js';
import { RunPlanningSnapshotSchema } from '../../src/planning/run-planning-snapshot.js';
import type { CommandRunner } from '../../src/providers/command-runner.js';
import { err, ok } from '../../src/shared/outcome.js';
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

const mutationRecovery = {
  prepare: () =>
    Promise.resolve(
      ok({
        kind: 'initial_delivery' as const,
        intentArtifactId: 'task-step-mutation-intent:test',
        baseline: {
          fingerprint: '1'.repeat(64),
          trackedDiffSha256: '2'.repeat(64),
          changedPaths: [],
          changedPathsTruncated: false,
        },
      }),
    ),
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
    schemaVersion: 3,
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
      implementationPlanner: {
        prompt: pack.prompts.implementationPlanner,
        skills: ['jira', 'confluence', 'loop'],
      },
      policies: pack.policies,
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

  it('uses the snapshotted prompt and skills for an agent attempt', async () => {
    ledger = openSqliteLedger({ filename: ':memory:', clock: systemClock });
    const traces = new TemporalTaskStepTraceStore(ledger.repository, systemClock);
    const prompts: string[] = [];
    const selectedSkills: (readonly string[])[] = [];
    const agentRunner: TaskStepAgentRunner = {
      provider: 'codex',
      run: (request) => {
        prompts.push(request.prompt);
        selectedSkills.push(request.skills);
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
        activityDelivery: { kind: 'workspace_reconciled' },
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
        mutationRecovery,
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
    expect(selectedSkills).toEqual([['jenkins', 'test-design']]);
  });

  it('returns the durable result without invoking the agent again after response loss', async () => {
    ledger = openSqliteLedger({ filename: ':memory:', clock: systemClock });
    const traces = new TemporalTaskStepTraceStore(ledger.repository, systemClock);
    const run = vi.fn<TaskStepAgentRunner['run']>(() =>
      Promise.resolve(
        ok({
          stdout: '',
          stderr: '',
          finalMessage: {
            status: 'completed',
            output: { summary: 'Implementation completed', artifacts: [] },
          },
        }),
      ),
    );
    const input = {
      taskReference: 'task-ref',
      workflowId: stubWorkspace.workflowId,
      workflowRunId: stubWorkspace.workflowRunId,
      workflowHash: stubWorkspace.workflowHash,
      nodeId: 'implement-feature',
      stepAttempt: 1,
      uses: 'code.implement@1',
      activityDelivery: { kind: 'workspace_reconciled' as const },
      workspace: stubWorkspace,
      planningSnapshot: {
        artifactId: 'planning-snapshot:test',
        checksum: 'd'.repeat(64),
      },
      operatorGuidance: null,
      input: {
        objective: 'Normalize passenger names',
        repository: fixture.repository,
        taskId: fixture.taskId,
      },
    };
    const dependencies = {
      snapshots: {
        readRunSnapshot: () => ok(makeSnapshot('code.implement@1')),
      },
      currentSteps: createCurrentStepRegistry(pack),
      traces,
      mutationRecovery,
      agentRunner: { provider: 'codex' as const, run },
      commands: { run: vi.fn() },
    };
    const runtime = {
      attempt: 1,
      cancellationSignal: new AbortController().signal,
      heartbeat: () => {},
    };

    const first = await executeRegisteredTaskStep(input, dependencies, runtime);
    const replacement = await executeRegisteredTaskStep(input, dependencies, {
      ...runtime,
      attempt: 2,
    });

    expect(replacement).toEqual(first);
    expect(first.artifactIds).toEqual([
      'task-step-output:tasker:task-ref:implement-feature:attempt-1:artifact',
      'task-step-mutation-intent:test',
    ]);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('does not repeat a controlled blocked provider result after response loss', async () => {
    ledger = openSqliteLedger({ filename: ':memory:', clock: systemClock });
    const traces = new TemporalTaskStepTraceStore(ledger.repository, systemClock);
    const run = vi.fn<TaskStepAgentRunner['run']>(() =>
      Promise.resolve(
        err({
          kind: 'provider_failed',
          exitCode: 1,
          message: 'Provider stopped after reporting a controlled failure',
          stdout: '',
          stderr: 'controlled failure',
        }),
      ),
    );
    const input = {
      taskReference: 'task-ref',
      workflowId: stubWorkspace.workflowId,
      workflowRunId: stubWorkspace.workflowRunId,
      workflowHash: stubWorkspace.workflowHash,
      nodeId: 'implement-feature',
      stepAttempt: 1,
      uses: 'code.implement@1',
      activityDelivery: { kind: 'workspace_reconciled' as const },
      workspace: stubWorkspace,
      planningSnapshot: {
        artifactId: 'planning-snapshot:test',
        checksum: 'd'.repeat(64),
      },
      operatorGuidance: null,
      input: {
        objective: 'Normalize passenger names',
        repository: fixture.repository,
        taskId: fixture.taskId,
      },
    };
    const dependencies = {
      snapshots: {
        readRunSnapshot: () => ok(makeSnapshot('code.implement@1')),
      },
      currentSteps: createCurrentStepRegistry(pack),
      traces,
      mutationRecovery,
      agentRunner: { provider: 'codex' as const, run },
      commands: { run: vi.fn() },
    };
    const runtime = {
      attempt: 1,
      cancellationSignal: new AbortController().signal,
      heartbeat: () => {},
    };

    const first = await executeRegisteredTaskStep(input, dependencies, runtime);
    const replacement = await executeRegisteredTaskStep(input, dependencies, {
      ...runtime,
      attempt: 2,
    });

    expect(replacement).toEqual(first);
    expect(first).toMatchObject({
      status: 'blocked',
      waitKind: 'code.implement.1.blocked@1',
      artifactIds: [
        'task-step-output:tasker:task-ref:implement-feature:attempt-1:artifact',
        'task-step-mutation-intent:test',
      ],
    });
    expect(run).toHaveBeenCalledTimes(1);
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
        activityDelivery: { kind: 'single_attempt' },
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
        mutationRecovery,
        agentRunner: {
          provider: 'codex',
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
        activityDelivery: { kind: 'single_attempt' },
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
        mutationRecovery,
        agentRunner: {
          provider: 'codex',
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

  it('persists a reconciled integration result before returning it to Temporal', async () => {
    ledger = openSqliteLedger({ filename: ':memory:', clock: systemClock });
    const traces = new TemporalTaskStepTraceStore(ledger.repository, systemClock);
    const execute = vi.fn(() =>
      Promise.resolve({
        status: 'completed' as const,
        summary: 'Pull request 73 is ready for review',
        output: {
          externalId: '73',
          status: 'open',
          provider: 'bitbucket',
          repository: 'twiket/front-avia',
          sourceBranch: 'tasker/task-ref',
          targetBranch: 'master',
          url: 'https://bitbucket.example/projects/TWIKET/repos/front-avia/pull-requests/73',
        },
        artifactIds: ['external-effect:prepare-pr:receipt'],
      }),
    );
    const input = {
      taskReference: 'task-ref',
      workflowId: stubWorkspace.workflowId,
      workflowRunId: stubWorkspace.workflowRunId,
      workflowHash: stubWorkspace.workflowHash,
      nodeId: 'prepare-pr',
      stepAttempt: 1,
      uses: 'pr.prepare@1',
      activityDelivery: { kind: 'remote_reconciled' as const },
      workspace: stubWorkspace,
      planningSnapshot: {
        artifactId: 'planning-snapshot:test',
        checksum: 'd'.repeat(64),
      },
      operatorGuidance: null,
      input: {
        objective: fixture.title,
        repository: fixture.repository,
        taskId: fixture.taskId,
        draftPath: '.tasker/pull-request/draft.json',
      },
    };
    const dependencies = {
      snapshots: { readRunSnapshot: () => ok(makeSnapshot('pr.prepare@1')) },
      currentSteps: createCurrentStepRegistry(pack),
      traces,
      mutationRecovery,
      agentRunner: { provider: 'codex' as const, run: vi.fn() },
      commands: { run: vi.fn() },
      integrations: new IntegrationStepAdapterRegistry([
        { id: 'bitbucket.pull-request@1', execute },
      ]),
    };
    const runtime = {
      attempt: 1,
      cancellationSignal: new AbortController().signal,
      heartbeat: () => {},
    };

    const first = await executeRegisteredTaskStep(input, dependencies, runtime);
    const redelivered = await executeRegisteredTaskStep(input, dependencies, {
      ...runtime,
      attempt: 2,
    });

    expect(redelivered).toEqual(first);
    expect(first).toMatchObject({
      status: 'completed',
      summary: 'Pull request 73 is ready for review',
      artifactIds: [
        'task-step-output:tasker:task-ref:prepare-pr:attempt-1:artifact',
        'external-effect:prepare-pr:receipt',
      ],
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
