import { afterEach, describe, expect, it, vi } from 'vitest';

import { blockReceiptId, BlockReceiptStore } from '../../src/blocks/index.js';
import {
  loadHarnessPack,
  resolveAgentExecutionProfile,
  resolveImplementationPlannerProfile,
  type ProcessExecutionPlan,
} from '../../src/harness/index.js';
import { IntegrationStepAdapterRegistry } from '../../src/integrations/index.js';
import { openSqliteLedger, type SqliteLedger } from '../../src/ledger/index.js';
import { RunPlanningSnapshotSchema } from '../../src/planning/run-planning-snapshot.js';
import type { CommandRunner, WorkspaceCommandRunner } from '../../src/providers/command-runner.js';
import { err, ok } from '../../src/shared/outcome.js';
import { systemClock } from '../../src/shared/clock.js';
import {
  createCurrentStepRegistry,
  createTaskExecutionActivity,
  executeRegisteredTaskStep,
  TemporalTaskStepTraceStore,
  type TaskStepAgentRunner,
} from '../../src/temporal/activities/block-execution.js';
import type {
  DockerWorkspaceRuntimePreparer,
  DockerWorkspaceRuntimeReceipt,
} from '../../src/workspaces/index.js';
import { makePlanningTaskSnapshot } from '../support/planning.js';

const workspaceCommands = (run: CommandRunner['run'] = vi.fn()): WorkspaceCommandRunner => ({
  executionEnvironment: 'docker_workspace',
  run,
});

const pack = loadHarnessPack();
const fixture = makePlanningTaskSnapshot('avia-13236-short-bug');
const translationFixture = makePlanningTaskSnapshot('avia-14001-translation-component');

const project = pack.projects.find((candidate) => candidate.repository === fixture.repository);
if (project === undefined) throw new Error('Missing harness project for fixture repository');
const WORKFLOW_HASH = 'a'.repeat(64);
const TEST_AGENT_USAGE = {
  provider: 'codex' as const,
  profile: 'test-agent',
  profileSha256: 'e'.repeat(64),
  model: 'gpt-5.6-terra',
  effort: 'medium' as const,
  serviceTier: 'fast' as const,
  sessionId: 'test-session',
  durationMs: 1_000,
  inputTokens: 100,
  cachedInputTokens: 50,
  outputTokens: 20,
  reasoningOutputTokens: 5,
  apiCost: { source: 'unrated' as const },
};

const stubWorkspace = {
  schemaVersion: 1 as const,
  workspaceId: 'b'.repeat(24),
  taskReference: 'task-ref',
  workflowId: 'tasker:task-ref',
  workflowRunId: 'run-1',
  repository: {
    reference: fixture.repository,
    sourcePath: '/tmp/source',
    baseBranch: 'master',
    baseCommit: 'c'.repeat(40),
  },
  runnerId: 'test-runner',
  path: '/tmp/worktree',
  branch: 'tasker/task-ref',
  preparedAt: '2026-08-03T00:00:00.000Z',
};

const stubWorkspaceStore = {
  read: () => ok(stubWorkspace),
};

const readyRuntime = (
  prepare: DockerWorkspaceRuntimePreparer['prepare'] = () =>
    Promise.resolve(ok({} as DockerWorkspaceRuntimeReceipt)),
): DockerWorkspaceRuntimePreparer => ({ prepare });

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
  inspectCompletion: () =>
    Promise.resolve(
      ok({
        intentArtifactId: 'task-step-mutation-intent:test',
        changed: false,
        current: {
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
    readonly resolvedProcess?: ProcessExecutionPlan;
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
  const block =
    current.block.executor.kind === 'agent'
      ? {
          ...current.block,
          executor: { ...current.block.executor, prompt: promptContent },
        }
      : current.block;
  const step = {
    reference: current.reference,
    block,
    activityDelivery: current.contract.activityDelivery,
    resolvedProcess:
      current.block.executor.kind === 'process'
        ? (options.resolvedProcess ??
          snapshotProject.processCommands[current.block.executor.executor] ??
          pack.company.processCommands[current.block.executor.executor] ?? {
            commands: [{ command: 'false', args: [] }],
            timeoutMs: 35 * 60_000,
          })
        : null,
    executionProfile:
      current.block.executor.kind === 'agent'
        ? resolveAgentExecutionProfile(
            pack.company,
            snapshotProject.executionProfileOverrides ?? null,
            current.block.executor.profile,
          )
        : null,
  };
  return RunPlanningSnapshotSchema.parse({
    schemaVersion: 10,
    kind: 'execution',
    executionStrategy: 'simple',
    semanticHash: '5'.repeat(64),
    semanticSource: {
      schemaVersion: 1,
      id: 'test-semantic-workflow',
      version: 1,
      root: {
        kind: 'sequence',
        id: 'test-work',
        children: [{ kind: 'step', id: 'test-step', uses: stepReference, with: {} }],
      },
    },
    compilerVersion: 'semantic-workflow-v1',
    taskReference: 'task-ref',
    workflowRunId: 'run-test',
    workflowHash: WORKFLOW_HASH,
    task,
    taskSnapshot: task,
    workflow: {},
    acceptedPlan: null,
    evidenceBundle: {
      artifactId: 'evidence-bundle:fixture:r1',
      checksum: '4'.repeat(64),
      revision: 1,
    },
    repository: {
      workspaceId,
      reference: repositoryReference,
      path: workspacePath,
    },
    harness: {
      company: pack.company,
      project: snapshotProject,
      implementationPlanner: {
        prompt: pack.prompts.implementationPlanner,
        skills: ['jira', 'confluence', 'loop'],
        profiles: {
          fast: resolveImplementationPlannerProfile(
            pack.company,
            snapshotProject.executionProfileOverrides ?? null,
            'fast',
          ),
          ralplan: resolveImplementationPlannerProfile(
            pack.company,
            snapshotProject.executionProfileOverrides ?? null,
            'ralplan',
          ),
        },
      },
      policies: pack.policies,
      steps: [step],
    },
    harnessHash: '6'.repeat(64),
    createdAt: '2026-08-03T00:00:00.000Z',
  });
};

describe('temporal block execution activity', () => {
  let ledger: SqliteLedger;

  afterEach(() => {
    ledger.close();
  });

  it('uses the snapshotted prompt and base step binding for an agent attempt', async () => {
    ledger = openSqliteLedger({ filename: ':memory:', clock: systemClock });
    const traces = new TemporalTaskStepTraceStore(ledger.repository, systemClock);
    const prompts: string[] = [];
    const selectedSkills: (readonly string[])[] = [];
    const stepReferences: string[] = [];
    const workspaceAccess: string[] = [];
    const agentRunner: TaskStepAgentRunner = {
      run: (request) => {
        prompts.push(request.prompt);
        selectedSkills.push(request.skills);
        stepReferences.push(request.stepReference);
        workspaceAccess.push(request.workspaceAccess);
        return Promise.resolve(
          ok({
            artifactIds: [],
            stdout: '',
            stderr: '',
            usage: TEST_AGENT_USAGE,
            finalMessage: {
              status: 'completed',
              outputJson: JSON.stringify({
                decision: 'accepted',
                summary: 'Independent review accepted',
                findings: [],
              }),
              requestJson: null,
              blockingReason: null,
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
        workflowHash: WORKFLOW_HASH,
        nodeId: 'agent-review',
        stepAttempt: 1,
        uses: 'review.change@1',
        activityDelivery: { kind: 'read_only' },
        workspace: stubWorkspace,
        planningSnapshot: {
          artifactId: 'planning-snapshot:test',
          checksum: 'd'.repeat(64),
        },
        operatorGuidance: 'VPN is enabled; retry the same verification without restarting.',
        waitResolution: null,
        input: {
          objective: 'Review the implementation',
          repository: fixture.repository,
          taskId: fixture.taskId,
        },
      },
      {
        snapshots: {
          readRunSnapshot: () => ok(makeSnapshot('review.change@1')),
        },
        currentSteps: createCurrentStepRegistry(pack),
        traces,
        mutationRecovery,
        agentRunner,
        commands: workspaceCommands(),
        workspaces: stubWorkspaceStore,
      },
      {
        attempt: 1,
        cancellationSignal: new AbortController().signal,
        heartbeat: () => {},
      },
    );

    expect(result).toMatchObject({
      status: 'completed',
      summary: 'Independent review accepted',
    });
    expect(prompts[0]).toContain('SNAPSHOT PROMPT');
    expect(prompts[0]).toContain('VPN is enabled; retry the same verification');
    expect(selectedSkills).toEqual([[]]);
    expect(stepReferences).toEqual(['review.change@1']);
    expect(workspaceAccess).toEqual(['read_only']);
  });

  it('returns the durable result without invoking the agent again after response loss', async () => {
    ledger = openSqliteLedger({ filename: ':memory:', clock: systemClock });
    const traces = new TemporalTaskStepTraceStore(ledger.repository, systemClock);
    const run = vi.fn<TaskStepAgentRunner['run']>(() =>
      Promise.resolve(
        ok({
          artifactIds: [],
          stdout: '',
          stderr: '',
          usage: TEST_AGENT_USAGE,
          finalMessage: {
            status: 'completed',
            outputJson: JSON.stringify({
              summary: 'Implementation completed',
              artifacts: [],
            }),
            requestJson: null,
            blockingReason: null,
          },
        }),
      ),
    );
    const input = {
      taskReference: 'task-ref',
      workflowId: stubWorkspace.workflowId,
      workflowRunId: stubWorkspace.workflowRunId,
      workflowHash: WORKFLOW_HASH,
      nodeId: 'implement-feature',
      stepAttempt: 1,
      uses: 'implement.change@1',
      activityDelivery: { kind: 'workspace_reconciled' as const },
      workspace: stubWorkspace,
      planningSnapshot: {
        artifactId: 'planning-snapshot:test',
        checksum: 'd'.repeat(64),
      },
      operatorGuidance: null,
      waitResolution: null,
      input: {
        objective: 'Normalize passenger names',
        repository: fixture.repository,
        taskId: fixture.taskId,
      },
    };
    const dependencies = {
      snapshots: {
        readRunSnapshot: () => ok(makeSnapshot('implement.change@1')),
      },
      currentSteps: createCurrentStepRegistry(pack),
      traces,
      mutationRecovery,
      agentRunner: { run },
      commands: workspaceCommands(),
      workspaces: stubWorkspaceStore,
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
      'task-step-output:tasker:task-ref:run-1:implement-feature:attempt-1:artifact',
      'task-step-mutation-intent:test',
    ]);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[0].workspaceAccess).toBe('read_write');
  });

  it('exposes exact output-contract issues in the durable wait reason', async () => {
    ledger = openSqliteLedger({ filename: ':memory:', clock: systemClock });
    const traces = new TemporalTaskStepTraceStore(ledger.repository, systemClock);

    const result = await executeRegisteredTaskStep(
      {
        taskReference: 'task-ref',
        workflowId: stubWorkspace.workflowId,
        workflowRunId: stubWorkspace.workflowRunId,
        workflowHash: WORKFLOW_HASH,
        nodeId: 'investigate-bug',
        stepAttempt: 1,
        uses: 'bug.investigate@1',
        activityDelivery: { kind: 'workspace_reconciled' },
        workspace: stubWorkspace,
        planningSnapshot: {
          artifactId: 'planning-snapshot:test',
          checksum: 'd'.repeat(64),
        },
        operatorGuidance: null,
        waitResolution: null,
        input: {
          objective: 'Reproduce the reported bug',
          repository: fixture.repository,
          taskId: fixture.taskId,
        },
      },
      {
        snapshots: {
          readRunSnapshot: () => ok(makeSnapshot('bug.investigate@1')),
        },
        currentSteps: createCurrentStepRegistry(pack),
        traces,
        mutationRecovery,
        agentRunner: {
          run: () =>
            Promise.resolve(
              ok({
                artifactIds: [`task-step-evidence:${'a'.repeat(64)}`],
                stdout: '',
                stderr: '',
                usage: TEST_AGENT_USAGE,
                finalMessage: {
                  status: 'completed',
                  outputJson: JSON.stringify({
                    summary: 'Bug reproduced',
                    outcome: 'reproduced',
                    observations: ['The reported layout failed in the prepared scenario.'],
                    evidence: [
                      {
                        kind: 'image',
                        path: '/tmp/worktree/.tasker/reproduction/result.png',
                        mimeType: 'image/png',
                      },
                    ],
                  }),
                  requestJson: null,
                  blockingReason: null,
                },
              }),
            ),
        },
        commands: workspaceCommands(),
        workspaces: stubWorkspaceStore,
      },
      {
        attempt: 1,
        cancellationSignal: new AbortController().signal,
        heartbeat: () => {},
      },
    );

    expect(result).toMatchObject({
      status: 'blocked',
      summary:
        'Agent execution for bug.investigate@1 returned invalid output: evidence.0.path: Expected a path relative to the Tasker artifact root',
    });
    expect(result.artifactIds).toContain(`task-step-evidence:${'a'.repeat(64)}`);
  });

  it('turns an agent-reported infrastructure problem into an actionable durable wait', async () => {
    ledger = openSqliteLedger({ filename: ':memory:', clock: systemClock });
    const traces = new TemporalTaskStepTraceStore(ledger.repository, systemClock);
    const reason = 'pnpm start cannot find Node.js in the prepared execution environment';
    const result = await executeRegisteredTaskStep(
      {
        taskReference: 'task-ref',
        workflowId: stubWorkspace.workflowId,
        workflowRunId: stubWorkspace.workflowRunId,
        workflowHash: WORKFLOW_HASH,
        nodeId: 'validate-bug-fix',
        stepAttempt: 1,
        uses: 'verify.acceptance@1',
        activityDelivery: { kind: 'read_only' },
        workspace: stubWorkspace,
        planningSnapshot: {
          artifactId: 'planning-snapshot:test',
          checksum: 'd'.repeat(64),
        },
        operatorGuidance: null,
        waitResolution: null,
        input: {
          objective: 'Repeat the investigated scenario and prove the fix',
          repository: fixture.repository,
          taskId: fixture.taskId,
        },
      },
      {
        snapshots: {
          readRunSnapshot: () => ok(makeSnapshot('verify.acceptance@1')),
        },
        currentSteps: createCurrentStepRegistry(pack),
        traces,
        mutationRecovery,
        agentRunner: {
          run: () =>
            Promise.resolve(
              ok({
                artifactIds: [],
                stdout: '',
                stderr: '',
                usage: TEST_AGENT_USAGE,
                finalMessage: {
                  status: 'blocked',
                  outputJson: JSON.stringify({ command: 'pnpm start', exitCode: 127 }),
                  requestJson: null,
                  blockingReason: reason,
                },
              }),
            ),
        },
        commands: workspaceCommands(),
        workspaces: stubWorkspaceStore,
      },
      {
        attempt: 1,
        cancellationSignal: new AbortController().signal,
        heartbeat: () => {},
      },
    );

    expect(result).toMatchObject({
      status: 'blocked',
      summary: `Agent execution for verify.acceptance@1 is blocked: ${reason}`,
      waitKind: 'verify.acceptance.1.blocked@1',
    });
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
      workflowHash: WORKFLOW_HASH,
      nodeId: 'implement-feature',
      stepAttempt: 1,
      uses: 'implement.change@1',
      activityDelivery: { kind: 'workspace_reconciled' as const },
      workspace: stubWorkspace,
      planningSnapshot: {
        artifactId: 'planning-snapshot:test',
        checksum: 'd'.repeat(64),
      },
      operatorGuidance: null,
      waitResolution: null,
      input: {
        objective: 'Normalize passenger names',
        repository: fixture.repository,
        taskId: fixture.taskId,
      },
    };
    const dependencies = {
      snapshots: {
        readRunSnapshot: () => ok(makeSnapshot('implement.change@1')),
      },
      currentSteps: createCurrentStepRegistry(pack),
      traces,
      mutationRecovery,
      agentRunner: { run },
      commands: workspaceCommands(),
      workspaces: stubWorkspaceStore,
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
      summary:
        'Agent execution for implement.change@1 is blocked: Provider stopped after reporting a controlled failure',
      waitKind: 'implement.change.1.blocked@1',
      artifactIds: [
        'task-step-output:tasker:task-ref:run-1:implement-feature:attempt-1:artifact',
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

    const componentTask = {
      ...translationFixture,
      repository: 'onetwotrip/front-components',
    };
    const componentWorkspace = {
      ...stubWorkspace,
      workspaceId: 'e'.repeat(24),
      workflowId: 'tasker:component-task',
      workflowRunId: 'run-2',
      repository: {
        ...stubWorkspace.repository,
        reference: componentTask.repository,
      },
    };

    const result = await executeRegisteredTaskStep(
      {
        taskReference: 'task-ref',
        workflowId: componentWorkspace.workflowId,
        workflowRunId: componentWorkspace.workflowRunId,
        workflowHash: WORKFLOW_HASH,
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
        waitResolution: null,
        input: {
          repository: componentTask.repository,
          taskId: translationFixture.taskId,
        },
      },
      {
        snapshots: {
          readRunSnapshot: () =>
            ok(
              makeSnapshot('translations.extract@1', {
                task: componentTask,
                repositoryReference: componentTask.repository,
                workspacePath: componentWorkspace.path,
                workspaceId: componentWorkspace.workspaceId,
                resolvedProcess: {
                  commands: [{ command: 'pnpm', args: ['translations:extract'] }],
                  timeoutMs: 35 * 60_000,
                },
              }),
            ),
        },
        currentSteps: createCurrentStepRegistry(pack),
        traces,
        mutationRecovery,
        agentRunner: {
          run: vi.fn(),
        },
        commands: workspaceCommands(commands),
        workspaces: stubWorkspaceStore,
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

    const componentTask = {
      ...translationFixture,
      repository: 'onetwotrip/front-components',
    };
    const componentWorkspace = {
      ...stubWorkspace,
      workspaceId: 'f'.repeat(24),
      workflowId: 'tasker:component-task',
      workflowRunId: 'run-3',
      repository: {
        ...stubWorkspace.repository,
        reference: componentTask.repository,
      },
    };

    const result = await executeRegisteredTaskStep(
      {
        taskReference: 'task-ref',
        workflowId: componentWorkspace.workflowId,
        workflowRunId: componentWorkspace.workflowRunId,
        workflowHash: WORKFLOW_HASH,
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
        waitResolution: null,
        input: {
          repository: componentTask.repository,
          taskId: translationFixture.taskId,
        },
      },
      {
        snapshots: {
          readRunSnapshot: () =>
            ok(
              makeSnapshot('component.dev_publish@1', {
                task: componentTask,
                repositoryReference: componentTask.repository,
                workspacePath: componentWorkspace.path,
                workspaceId: componentWorkspace.workspaceId,
              }),
            ),
        },
        currentSteps: createCurrentStepRegistry(pack),
        traces,
        mutationRecovery,
        agentRunner: {
          run: vi.fn(),
        },
        commands: workspaceCommands(commands),
        workspaces: stubWorkspaceStore,
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
      workflowHash: WORKFLOW_HASH,
      nodeId: 'prepare-pr',
      stepAttempt: 1,
      uses: 'deliver.pull-request@1',
      activityDelivery: { kind: 'remote_reconciled' as const },
      workspace: stubWorkspace,
      planningSnapshot: {
        artifactId: 'planning-snapshot:test',
        checksum: 'd'.repeat(64),
      },
      operatorGuidance: null,
      waitResolution: null,
      input: {
        objective: fixture.title,
        repository: fixture.repository,
        taskId: fixture.taskId,
      },
    };
    const dependencies = {
      snapshots: { readRunSnapshot: () => ok(makeSnapshot('deliver.pull-request@1')) },
      currentSteps: createCurrentStepRegistry(pack),
      traces,
      mutationRecovery,
      agentRunner: { run: vi.fn() },
      commands: workspaceCommands(),
      workspaces: stubWorkspaceStore,
      integrations: new IntegrationStepAdapterRegistry([
        { id: 'delivery.pull-request@1', execute },
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
        'task-step-output:tasker:task-ref:run-1:prepare-pr:attempt-1:artifact',
        'external-effect:prepare-pr:receipt',
      ],
    });

    const nextRun = await executeRegisteredTaskStep(
      {
        ...input,
        workflowRunId: 'run-2',
        workspace: { ...stubWorkspace, workflowRunId: 'run-2' },
      },
      dependencies,
      runtime,
    );

    expect(nextRun).toMatchObject({
      status: 'completed',
      artifactIds: [
        'task-step-output:tasker:task-ref:run-2:prepare-pr:attempt-1:artifact',
        'external-effect:prepare-pr:receipt',
      ],
    });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('preserves an integration verification failure as a verification wait', async () => {
    ledger = openSqliteLedger({ filename: ':memory:', clock: systemClock });
    const traces = new TemporalTaskStepTraceStore(ledger.repository, systemClock);
    const receipts = new BlockReceiptStore(ledger.repository, systemClock);
    const activity = createTaskExecutionActivity(
      {
        snapshots: { readRunSnapshot: () => ok(makeSnapshot('deliver.pull-request@1')) },
        currentSteps: createCurrentStepRegistry(pack),
        traces,
        mutationRecovery,
        receipts,
        runtimes: readyRuntime(),
        agentRunner: { run: vi.fn() },
        commands: workspaceCommands(),
        workspaces: stubWorkspaceStore,
        integrations: new IntegrationStepAdapterRegistry([
          {
            id: 'delivery.pull-request@1',
            execute: () =>
              Promise.resolve({
                status: 'blocked',
                kind: 'verification',
                summary: 'Jenkins build failed because payment snapshots changed',
                details: { status: 'likely_caused_by_change' },
                artifactIds: [],
              }),
          },
        ]),
      },
      () => ({
        attempt: 1,
        cancellationSignal: new AbortController().signal,
        heartbeat: () => {},
      }),
    );

    const result = await activity.runExecutionBlock({
      schemaVersion: 2,
      taskReference: 'task-ref',
      workflowId: stubWorkspace.workflowId,
      workflowRunId: stubWorkspace.workflowRunId,
      workflowHash: WORKFLOW_HASH,
      nodeId: 'observe-ci',
      blockRun: 1,
      uses: 'deliver.pull-request@1',
      activityDelivery: { kind: 'remote_reconciled' },
      contextReferences: [
        { kind: 'workspace', reference: stubWorkspace.workspaceId },
        {
          kind: 'planning_snapshot',
          reference: 'planning-snapshot:test',
          hash: 'd'.repeat(64),
        },
      ],
      operatorGuidance: null,
      waitResolution: null,
      input: {
        objective: 'Observe CI',
        repository: fixture.repository,
        taskId: fixture.taskId,
      },
    });

    expect(result).toMatchObject({
      status: 'needs_input',
      waitKind: 'deliver.pull-request@1.verification@1',
    });
    expect(
      receipts.read(
        blockReceiptId({
          workflowId: stubWorkspace.workflowId,
          workflowRunId: stubWorkspace.workflowRunId,
          nodeId: 'observe-ci',
          blockRun: 1,
        }),
      ),
    ).toMatchObject({ ok: true, value: { claim: { category: 'verification' } } });
  });

  it('restores the exact semantic integration wait from its durable receipt', async () => {
    ledger = openSqliteLedger({ filename: ':memory:', clock: systemClock });
    const traces = new TemporalTaskStepTraceStore(ledger.repository, systemClock);
    const receipts = new BlockReceiptStore(ledger.repository, systemClock);
    const execute = vi.fn(() =>
      Promise.resolve({
        status: 'waiting' as const,
        waitKind: 'code_review@1',
        summary: 'Pull request passed CI and is waiting for human review',
        details: { phase: 'human_review' },
        artifactIds: ['pull-request:42'],
      }),
    );
    const activity = createTaskExecutionActivity(
      {
        snapshots: { readRunSnapshot: () => ok(makeSnapshot('deliver.pull-request@1')) },
        currentSteps: createCurrentStepRegistry(pack),
        traces,
        mutationRecovery,
        receipts,
        runtimes: readyRuntime(),
        agentRunner: { run: vi.fn() },
        commands: workspaceCommands(),
        workspaces: stubWorkspaceStore,
        integrations: new IntegrationStepAdapterRegistry([
          { id: 'delivery.pull-request@1', execute },
        ]),
      },
      () => ({
        attempt: 1,
        cancellationSignal: new AbortController().signal,
        heartbeat: () => {},
      }),
    );
    const input = {
      schemaVersion: 2 as const,
      taskReference: 'task-ref',
      workflowId: stubWorkspace.workflowId,
      workflowRunId: stubWorkspace.workflowRunId,
      workflowHash: WORKFLOW_HASH,
      nodeId: 'deliver-change',
      blockRun: 1,
      uses: 'deliver.pull-request@1',
      activityDelivery: { kind: 'remote_reconciled' as const },
      contextReferences: [
        { kind: 'workspace' as const, reference: stubWorkspace.workspaceId },
        {
          kind: 'planning_snapshot' as const,
          reference: 'planning-snapshot:test',
          hash: 'd'.repeat(64),
        },
      ],
      operatorGuidance: null,
      waitResolution: null,
      input: {
        objective: 'Deliver the reviewed change',
        repository: fixture.repository,
        taskId: fixture.taskId,
      },
    };

    const first = await activity.runExecutionBlock(input);
    const redelivered = await activity.runExecutionBlock(input);

    expect(first).toMatchObject({ status: 'needs_input', waitKind: 'code_review@1' });
    expect(redelivered).toEqual(first);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('advances the execution graph only after an accepted BlockReceipt', async () => {
    ledger = openSqliteLedger({ filename: ':memory:', clock: systemClock });
    const traces = new TemporalTaskStepTraceStore(ledger.repository, systemClock);
    const receipts = new BlockReceiptStore(ledger.repository, systemClock);
    const calls: string[] = [];
    const prepareRuntime = vi.fn<DockerWorkspaceRuntimePreparer['prepare']>(() => {
      calls.push('runtime');
      return Promise.resolve(ok({} as DockerWorkspaceRuntimeReceipt));
    });
    const run = vi.fn<TaskStepAgentRunner['run']>(() => {
      calls.push('agent');
      return Promise.resolve(
        ok({
          artifactIds: [],
          stdout: '',
          stderr: '',
          usage: TEST_AGENT_USAGE,
          finalMessage: {
            status: 'completed',
            outputJson: JSON.stringify({ summary: 'Test operations plan ready', artifacts: [] }),
            requestJson: null,
            blockingReason: null,
          },
        }),
      );
    });
    const activity = createTaskExecutionActivity(
      {
        snapshots: { readRunSnapshot: () => ok(makeSnapshot('fill-test-ops-plan@1')) },
        currentSteps: createCurrentStepRegistry(pack),
        traces,
        mutationRecovery,
        receipts,
        runtimes: readyRuntime(prepareRuntime),
        agentRunner: { run },
        commands: workspaceCommands(),
        workspaces: stubWorkspaceStore,
      },
      () => ({
        attempt: 1,
        cancellationSignal: new AbortController().signal,
        heartbeat: () => {},
      }),
    );
    const input = {
      schemaVersion: 2 as const,
      taskReference: 'task-ref',
      workflowId: stubWorkspace.workflowId,
      workflowRunId: stubWorkspace.workflowRunId,
      workflowHash: WORKFLOW_HASH,
      nodeId: 'test-operations-plan',
      blockRun: 1,
      uses: 'fill-test-ops-plan@1',
      activityDelivery: { kind: 'read_only' as const },
      contextReferences: [
        { kind: 'workspace', reference: stubWorkspace.workspaceId },
        {
          kind: 'planning_snapshot',
          reference: 'planning-snapshot:test',
          hash: 'd'.repeat(64),
        },
      ],
      operatorGuidance: null,
      waitResolution: null,
      input: {
        objective: 'Prepare the test plan',
        repository: fixture.repository,
        taskId: fixture.taskId,
      },
    };

    const first = await activity.runExecutionBlock(input);
    const redelivered = await activity.runExecutionBlock(input);

    expect(first).toMatchObject({
      status: 'completed',
      receiptReference: 'block-receipt:tasker:task-ref:run-1:test-operations-plan:run-1',
    });
    expect(redelivered).toEqual(first);
    expect(run).toHaveBeenCalledTimes(1);
    expect(prepareRuntime).toHaveBeenCalledTimes(1);
    const runtimeCall = prepareRuntime.mock.calls[0];
    expect(runtimeCall?.[0]).toEqual(stubWorkspace);
    expect(runtimeCall?.[1].engine).toBe('docker');
    expect(runtimeCall?.[1].policyHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(runtimeCall?.[2]?.cancellationSignal).toBeInstanceOf(AbortSignal);
    expect(runtimeCall?.[2]?.onProgress).toBeTypeOf('function');
    expect(calls).toEqual(['runtime', 'agent']);
    expect(
      receipts.read(
        blockReceiptId({
          workflowId: stubWorkspace.workflowId,
          workflowRunId: stubWorkspace.workflowRunId,
          nodeId: 'test-operations-plan',
          blockRun: 1,
        }),
      ),
    ).toMatchObject({
      ok: true,
      value: {
        usageReference:
          'task-step-output:tasker:task-ref:run-1:test-operations-plan:attempt-1:artifact',
        usage: TEST_AGENT_USAGE,
      },
    });
  });

  it('opens a recoverable infrastructure wait and retries the same block after runtime repair', async () => {
    ledger = openSqliteLedger({ filename: ':memory:', clock: systemClock });
    const traces = new TemporalTaskStepTraceStore(ledger.repository, systemClock);
    const receipts = new BlockReceiptStore(ledger.repository, systemClock);
    const prepareRuntime = vi
      .fn<DockerWorkspaceRuntimePreparer['prepare']>()
      .mockResolvedValueOnce(
        err({
          kind: 'service_failed',
          service: 'front-avia-app',
          message: 'service exited with code 143',
        }),
      )
      .mockResolvedValue(ok({} as DockerWorkspaceRuntimeReceipt));
    const run = vi.fn<TaskStepAgentRunner['run']>(() =>
      Promise.resolve(
        ok({
          artifactIds: [],
          stdout: '',
          stderr: '',
          usage: TEST_AGENT_USAGE,
          finalMessage: {
            status: 'completed',
            outputJson: JSON.stringify({ summary: 'Test operations plan ready', artifacts: [] }),
            requestJson: null,
            blockingReason: null,
          },
        }),
      ),
    );
    const activity = createTaskExecutionActivity(
      {
        snapshots: { readRunSnapshot: () => ok(makeSnapshot('fill-test-ops-plan@1')) },
        currentSteps: createCurrentStepRegistry(pack),
        traces,
        mutationRecovery,
        receipts,
        runtimes: readyRuntime(prepareRuntime),
        agentRunner: { run },
        commands: workspaceCommands(),
        workspaces: stubWorkspaceStore,
      },
      () => ({
        attempt: 1,
        cancellationSignal: new AbortController().signal,
        heartbeat: () => {},
      }),
    );
    const input = {
      schemaVersion: 2 as const,
      taskReference: 'task-ref',
      workflowId: stubWorkspace.workflowId,
      workflowRunId: stubWorkspace.workflowRunId,
      workflowHash: WORKFLOW_HASH,
      nodeId: 'test-operations-plan',
      blockRun: 1,
      uses: 'fill-test-ops-plan@1',
      activityDelivery: { kind: 'read_only' as const },
      contextReferences: [
        { kind: 'workspace', reference: stubWorkspace.workspaceId },
        {
          kind: 'planning_snapshot',
          reference: 'planning-snapshot:test',
          hash: 'd'.repeat(64),
        },
      ],
      operatorGuidance: null,
      waitResolution: null,
      input: {
        objective: 'Prepare the test plan',
        repository: fixture.repository,
        taskId: fixture.taskId,
      },
    };

    const blocked = await activity.runExecutionBlock(input);
    const resumed = await activity.runExecutionBlock({ ...input, blockRun: 2 });

    expect(blocked).toEqual({
      status: 'needs_input',
      summary:
        'Docker runtime for fill-test-ops-plan@1 could not be restored: service_failed: service exited with code 143. Fix the runtime prerequisite and resume this step; completed workflow nodes and workspace changes are preserved.',
      waitKind: 'workspace.runtime-recovery@1',
    });
    expect(resumed).toMatchObject({ status: 'completed' });
    expect(prepareRuntime).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('preserves the actual harness-registration blocker when no candidate output was produced', async () => {
    ledger = openSqliteLedger({ filename: ':memory:', clock: systemClock });
    const traces = new TemporalTaskStepTraceStore(ledger.repository, systemClock);
    const activity = createTaskExecutionActivity(
      {
        snapshots: { readRunSnapshot: () => ok(makeSnapshot('fill-test-ops-plan@1')) },
        currentSteps: new Map(),
        traces,
        mutationRecovery,
        receipts: new BlockReceiptStore(ledger.repository, systemClock),
        runtimes: readyRuntime(),
        agentRunner: { run: vi.fn() },
        commands: workspaceCommands(),
        workspaces: stubWorkspaceStore,
      },
      () => ({
        attempt: 1,
        cancellationSignal: new AbortController().signal,
        heartbeat: () => {},
      }),
    );

    const result = await activity.runExecutionBlock({
      schemaVersion: 2,
      taskReference: 'task-ref',
      workflowId: stubWorkspace.workflowId,
      workflowRunId: stubWorkspace.workflowRunId,
      workflowHash: WORKFLOW_HASH,
      nodeId: 'test-operations-plan',
      blockRun: 1,
      uses: 'fill-test-ops-plan@1',
      activityDelivery: { kind: 'read_only' },
      contextReferences: [
        { kind: 'workspace', reference: stubWorkspace.workspaceId },
        {
          kind: 'planning_snapshot',
          reference: 'planning-snapshot:test',
          hash: 'd'.repeat(64),
        },
      ],
      operatorGuidance: null,
      waitResolution: null,
      input: {
        objective: 'Prepare the test plan',
        repository: fixture.repository,
        taskId: fixture.taskId,
      },
    });

    expect(result).toEqual({
      status: 'needs_input',
      summary:
        'Current harness registration for fill-test-ops-plan@1 no longer matches the snapshotted execution boundary',
      waitKind: 'fill-test-ops-plan.1.blocked@1',
    });
  });

  it('derives independent-review predicates from validated output and restores them from the receipt', async () => {
    ledger = openSqliteLedger({ filename: ':memory:', clock: systemClock });
    const traces = new TemporalTaskStepTraceStore(ledger.repository, systemClock);
    const receipts = new BlockReceiptStore(ledger.repository, systemClock);
    const run = vi.fn<TaskStepAgentRunner['run']>(() =>
      Promise.resolve(
        ok({
          artifactIds: [],
          stdout: '',
          stderr: '',
          usage: TEST_AGENT_USAGE,
          finalMessage: {
            status: 'completed',
            outputJson: JSON.stringify({
              decision: 'changes_requested',
              summary: 'Repair the fallback before publication',
              findings: [
                {
                  title: 'Fallback removed',
                  description: 'The changed branch no longer preserves the existing fallback.',
                  severity: 'blocking',
                  files: ['src/example.ts'],
                },
              ],
            }),
            requestJson: null,
            blockingReason: null,
          },
        }),
      ),
    );
    const activity = createTaskExecutionActivity(
      {
        snapshots: { readRunSnapshot: () => ok(makeSnapshot('review.change@1')) },
        currentSteps: createCurrentStepRegistry(pack),
        traces,
        mutationRecovery,
        receipts,
        runtimes: readyRuntime(),
        agentRunner: { run },
        commands: workspaceCommands(),
        workspaces: stubWorkspaceStore,
      },
      () => ({
        attempt: 1,
        cancellationSignal: new AbortController().signal,
        heartbeat: () => {},
      }),
    );
    const input = {
      schemaVersion: 2 as const,
      taskReference: 'task-ref',
      workflowId: stubWorkspace.workflowId,
      workflowRunId: stubWorkspace.workflowRunId,
      workflowHash: WORKFLOW_HASH,
      nodeId: 'agent-review',
      blockRun: 1,
      uses: 'review.change@1',
      activityDelivery: { kind: 'read_only' as const },
      contextReferences: [
        { kind: 'workspace', reference: stubWorkspace.workspaceId },
        {
          kind: 'planning_snapshot',
          reference: 'planning-snapshot:test',
          hash: 'd'.repeat(64),
        },
      ],
      operatorGuidance: null,
      waitResolution: null,
      input: {
        objective: 'Review the implementation',
        repository: fixture.repository,
        taskId: fixture.taskId,
      },
    };

    const first = await activity.runExecutionBlock(input);
    const redelivered = await activity.runExecutionBlock(input);

    expect(first).toMatchObject({
      status: 'completed',
      predicateFacts: {
        'agent_review.accepted@1': false,
        'agent_review.changes_requested@1': true,
      },
    });
    expect(redelivered).toEqual(first);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('opens a durable wait when an agent claims completion without proving a mutation', async () => {
    ledger = openSqliteLedger({ filename: ':memory:', clock: systemClock });
    const traces = new TemporalTaskStepTraceStore(ledger.repository, systemClock);
    const receipts = new BlockReceiptStore(ledger.repository, systemClock);
    const activity = createTaskExecutionActivity(
      {
        snapshots: { readRunSnapshot: () => ok(makeSnapshot('implement.change@1')) },
        currentSteps: createCurrentStepRegistry(pack),
        traces,
        mutationRecovery,
        receipts,
        runtimes: readyRuntime(),
        agentRunner: {
          run: () =>
            Promise.resolve(
              ok({
                artifactIds: [],
                stdout: '',
                stderr: '',
                usage: TEST_AGENT_USAGE,
                finalMessage: {
                  status: 'completed',
                  outputJson: JSON.stringify({
                    summary: 'Implementation claimed complete',
                    artifacts: [],
                  }),
                  requestJson: null,
                  blockingReason: null,
                },
              }),
            ),
        },
        commands: workspaceCommands(),
        workspaces: stubWorkspaceStore,
      },
      () => ({
        attempt: 1,
        cancellationSignal: new AbortController().signal,
        heartbeat: () => {},
      }),
    );

    const result = await activity.runExecutionBlock({
      schemaVersion: 2,
      taskReference: 'task-ref',
      workflowId: stubWorkspace.workflowId,
      workflowRunId: stubWorkspace.workflowRunId,
      workflowHash: WORKFLOW_HASH,
      nodeId: 'implement-feature',
      blockRun: 1,
      uses: 'implement.change@1',
      activityDelivery: { kind: 'workspace_reconciled' },
      contextReferences: [
        { kind: 'workspace', reference: stubWorkspace.workspaceId },
        {
          kind: 'planning_snapshot',
          reference: 'planning-snapshot:test',
          hash: 'd'.repeat(64),
        },
      ],
      operatorGuidance: null,
      waitResolution: null,
      input: {
        objective: 'Implement the change',
        repository: fixture.repository,
        taskId: fixture.taskId,
      },
    });

    expect(result).toMatchObject({
      status: 'needs_input',
      waitKind: 'implement.change@1.completion-evidence-required@1',
    });
    expect(result.summary).toContain('No workspace mutation was proven');
    const receipt = receipts.read(
      blockReceiptId({
        workflowId: stubWorkspace.workflowId,
        workflowRunId: stubWorkspace.workflowRunId,
        nodeId: 'implement-feature',
        blockRun: 1,
      }),
    );
    expect(receipt).toMatchObject({ ok: true, value: { predicateFacts: {} } });
  });
});
