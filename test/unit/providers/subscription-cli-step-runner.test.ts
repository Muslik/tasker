import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { blockReceiptId } from '../../../src/steps/index.js';
import { openSqliteLedger } from '../../../src/store/index.js';
import {
  AgentInvocationArtifactSchema,
  executionAgentInvocationId,
} from '../../../src/steps/agent-invocation.js';
import type {
  CommandRequest,
  CommandResult,
  WorkspaceCommandRunner,
} from '../../../src/agents/index.js';
import { systemClock } from '../../../src/shared/clock.js';
import { TEST_CLAUDE_PROFILE, TEST_CODEX_PROFILE } from '../../helpers/execution-profile.js';
import {
  SubscriptionCliTaskStepAgentRunner,
  TemporalTaskStepTraceStore,
} from '../../../src/steps/activities/block-execution.js';
import { agentStepOutcomeSchema } from '../../../src/steps/activities/block-execution-contracts.js';
import { TaskStepFilesystemStore } from '../../../src/steps/activities/task-step-filesystem.js';
import { TaskStepEvidenceStore } from '../../../src/steps/activities/task-step-evidence.js';

const codexStream = (finalMessage: string): string =>
  [
    JSON.stringify({ type: 'thread.started', thread_id: 'thread-step-1' }),
    JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: finalMessage },
    }),
    JSON.stringify({
      type: 'turn.completed',
      usage: {
        input_tokens: 10,
        cached_input_tokens: 2,
        output_tokens: 4,
      },
    }),
  ].join('\n');

const claudeStream = (finalMessage: unknown): string =>
  JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: '',
    structured_output: finalMessage,
    session_id: 'claude-step-1',
    usage: {
      input_tokens: 10,
      cache_creation_input_tokens: 1,
      cache_read_input_tokens: 2,
      output_tokens: 4,
    },
  });

const outputSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('done'),
      done: z.literal(true),
      labels: z.record(z.string(), z.string()),
    })
    .strict(),
  z.object({ status: z.literal('blocked'), reason: z.string() }).strict(),
]);

const writeSkillCatalog = (repositoryPath: string): void => {
  mkdirSync(join(repositoryPath, '.tasker', 'harness'), { recursive: true });
  mkdirSync(join(repositoryPath, '.tasker', 'harness', 'lib'), { recursive: true });
  mkdirSync(join(repositoryPath, '.tasker', 'harness', 'skills'), { recursive: true });
  writeFileSync(
    join(repositoryPath, '.tasker', 'harness', 'lib', 'harness_env.py'),
    'def load_env(): pass\n',
    'utf8',
  );
  writeFileSync(
    join(repositoryPath, '.tasker', 'harness', 'manifest.json'),
    `${JSON.stringify({
      schemaVersion: 2,
      id: 'test-workspace',
      version: '1',
      engines: ['codex', 'claude'],
      skillSources: [
        {
          id: 'step-skills',
          path: 'shared-skills',
          scope: 'step_bound',
          skills: ['jira', 'pr-finalize'],
        },
      ],
      supportFiles: 'lib',
      commands: 'bin',
      profiles: [
        {
          id: 'front-avia',
          repositoryAliases: ['onetwotrip/front-avia'],
          guidance: 'guidance',
        },
      ],
    })}\n`,
    'utf8',
  );
  writeFileSync(
    join(repositoryPath, '.tasker', 'harness-bootstrap.json'),
    '{"profile":"front-avia"}\n',
    'utf8',
  );
  for (const skill of ['jira', 'pr-finalize']) {
    const directory = join(repositoryPath, '.tasker', 'harness', 'skills', skill);
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, 'SKILL.md'),
      `---\nname: ${skill}\ndescription: ${skill} test skill\n---\n`,
      'utf8',
    );
  }
};

const readInvocationArtifact = (
  ledger: ReturnType<typeof openSqliteLedger>,
  operationId: string,
  providerAttempt: number,
) => {
  const artifact = ledger.repository.readArtifact(
    executionAgentInvocationId(operationId, providerAttempt),
  );
  expect(artifact).not.toBeNull();
  return AgentInvocationArtifactSchema.parse(artifact?.payload);
};

describe('subscription CLI task-step runner', () => {
  it('surfaces heartbeat cancellation through the awaited command and stops its timer', async () => {
    vi.useFakeTimers();
    const repositoryPath = mkdtempSync(join(tmpdir(), 'tasker-cancelled-step-workspace-'));
    const stepDataPath = mkdtempSync(join(tmpdir(), 'tasker-cancelled-step-data-'));
    const ledger = openSqliteLedger({ filename: ':memory:', clock: systemClock });
    const cancellation = new Error('activity cancelled');
    const controller = new AbortController();
    const requests: CommandRequest[] = [];
    let resolveVersion: ((result: CommandResult) => void) | undefined;
    const version = new Promise<CommandResult>((resolve) => {
      resolveVersion = resolve;
    });
    const commands: WorkspaceCommandRunner = {
      executionEnvironment: 'docker_workspace',
      run: (request) => {
        requests.push(request);
        return version;
      },
    };
    const runner = new SubscriptionCliTaskStepAgentRunner(
      commands,
      new TaskStepFilesystemStore(stepDataPath),
      new TaskStepEvidenceStore(ledger.repository, systemClock),
    );

    try {
      const result = runner.run({
        taskReference: 'task-ref',
        inputArtifactIds: [],
        operationId: 'workflow:cancelled-step:attempt-1',
        workflowId: 'tasker:task-ref',
        workflowRunId: 'run-1',
        nodeId: 'cancelled-step',
        blockRun: 1,
        providerAttempt: 1,
        stepReference: 'implement.change@1',
        profile: TEST_CODEX_PROFILE,
        prompt: 'Return the result.',
        skills: [],
        recovery: { kind: 'single_attempt' },
        outputSchema,
        cwd: repositoryPath,
        workspaceAccess: 'read_write',
        runtime: {
          attempt: 1,
          cancellationSignal: controller.signal,
          heartbeat: () => {
            controller.signal.throwIfAborted();
          },
        },
        transcriptStore: new TemporalTaskStepTraceStore(ledger.repository, systemClock),
      });
      const rejection = expect(result).rejects.toBe(cancellation);

      expect(vi.getTimerCount()).toBe(1);
      controller.abort(cancellation);
      await vi.advanceTimersByTimeAsync(10_000);

      expect(vi.getTimerCount()).toBe(0);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.cancellationSignal).toBe(controller.signal);
      if (resolveVersion === undefined) throw new Error('Version probe did not start');
      resolveVersion({
        status: 'exited',
        exitCode: 0,
        stdout: 'codex-cli 0.120.0\n',
        stderr: '',
        durationMs: 1,
      });
      await rejection;
    } finally {
      vi.useRealTimers();
      ledger.close();
      rmSync(repositoryPath, { recursive: true, force: true });
      rmSync(stepDataPath, { recursive: true, force: true });
    }
  });

  it('invokes Codex with only the step-scoped skill view', async () => {
    const repositoryPath = mkdtempSync(join(tmpdir(), 'tasker-codex-step-workspace-'));
    const stepDataPath = mkdtempSync(join(tmpdir(), 'tasker-codex-step-data-'));
    writeSkillCatalog(repositoryPath);
    for (const skill of ['jira', 'pr-finalize']) {
      const directory = join(repositoryPath, '.tasker', 'harness', 'skills', skill);
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        join(directory, 'SKILL.md'),
        `---\nname: ${skill}\ndescription: ${skill} test skill\n---\n`,
        'utf8',
      );
    }
    const observations: {
      skillsRoot: string;
      codexHome: string;
      jiraSkill: string;
      prFinalizeVisible: boolean;
      outputSchema: string;
      args: readonly string[];
      workspaceAccess: CommandRequest['workspaceAccess'];
      scratchRoot: string;
      artifactsRoot: string;
      stdin: string;
      mounts: CommandRequest['mounts'];
    }[] = [];
    const commands: WorkspaceCommandRunner = {
      executionEnvironment: 'docker_workspace',
      run: (request) => {
        if (request.args[0] === '--version') {
          return Promise.resolve({
            status: 'exited',
            exitCode: 0,
            stdout: 'codex-cli 0.120.0\n',
            stderr: '',
            durationMs: 1,
          });
        }
        const skillsRoot = request.env?.TASKER_SKILLS_ROOT;
        const codexHome = request.env?.CODEX_HOME;
        const scratchRoot = request.env?.TASKER_SCRATCH_ROOT;
        const artifactsRoot = request.env?.TASKER_ARTIFACTS_ROOT;
        if (
          skillsRoot === undefined ||
          codexHome === undefined ||
          scratchRoot === undefined ||
          artifactsRoot === undefined
        ) {
          throw new Error('Codex step environment was not prepared');
        }
        const schemaIndex = request.args.indexOf('--output-schema');
        const schemaPath = schemaIndex < 0 ? undefined : request.args[schemaIndex + 1];
        if (schemaPath === undefined) throw new Error('Codex output schema was not provided');
        observations.push({
          skillsRoot,
          codexHome,
          jiraSkill: readFileSync(join(skillsRoot, 'jira/SKILL.md'), 'utf8'),
          prFinalizeVisible: existsSync(join(skillsRoot, 'pr-finalize/SKILL.md')),
          outputSchema: readFileSync(schemaPath, 'utf8'),
          args: request.args,
          workspaceAccess: request.workspaceAccess,
          scratchRoot,
          artifactsRoot,
          stdin: request.stdin,
          mounts: request.mounts,
        });
        writeFileSync(join(artifactsRoot, 'result.json'), '{"verified":true}\n', 'utf8');
        return Promise.resolve({
          status: 'exited',
          exitCode: 0,
          stdout: codexStream(
            JSON.stringify({ status: 'done', done: true, labels: { result: 'verified' } }),
          ),
          stderr: '',
          durationMs: 2,
        });
      },
    };
    const ledger = openSqliteLedger({ filename: ':memory:', clock: systemClock });
    const traces = new TemporalTaskStepTraceStore(ledger.repository, systemClock);
    const inputRoot = mkdtempSync(join(tmpdir(), 'tasker-step-input-'));
    writeFileSync(join(inputRoot, 'verification.json'), '{"accepted":true}\n', 'utf8');
    const evidenceStore = new TaskStepEvidenceStore(ledger.repository, systemClock);
    const registeredInput = await evidenceStore.register('workflow:verify:attempt-1', inputRoot);
    if (!registeredInput.ok || registeredInput.value[0] === undefined) {
      throw new Error('Input evidence fixture was not registered');
    }
    const runner = new SubscriptionCliTaskStepAgentRunner(
      commands,
      new TaskStepFilesystemStore(stepDataPath),
      evidenceStore,
    );

    try {
      const result = await runner.run({
        taskReference: 'task-ref',
        inputArtifactIds: [registeredInput.value[0]],
        operationId: 'workflow:step:attempt-1',
        workflowId: 'tasker:task-ref',
        workflowRunId: 'run-1',
        nodeId: 'implement-feature',
        blockRun: 1,
        providerAttempt: 1,
        stepReference: 'implement.change@1',
        profile: TEST_CODEX_PROFILE,
        prompt: 'Return the result.',
        skills: ['jira'],
        recovery: { kind: 'single_attempt' },
        outputSchema,
        cwd: repositoryPath,
        workspaceAccess: 'read_write',
        runtime: {
          attempt: 1,
          cancellationSignal: new AbortController().signal,
          heartbeat: () => {},
        },
        transcriptStore: traces,
      });

      expect(result).toMatchObject({
        ok: true,
        value: {
          finalMessage: { done: true, labels: { result: 'verified' } },
          usage: {
            provider: 'codex',
            inputTokens: 10,
            cachedInputTokens: 2,
            outputTokens: 4,
          },
          artifactIds: [expect.stringMatching(/^task-step-evidence:[a-f0-9]{64}$/u)],
        },
      });
      expect(observations).toHaveLength(1);
      expect(observations[0]?.skillsRoot).toBe(join(observations[0]?.codexHome ?? '', 'skills'));
      expect(observations[0]?.jiraSkill).toContain('jira test skill');
      expect(observations[0]?.prFinalizeVisible).toBe(false);
      expect(observations[0]?.outputSchema).not.toContain('propertyNames');
      expect(observations[0]?.outputSchema).not.toContain('oneOf');
      expect(observations[0]?.outputSchema).toContain('anyOf');
      expect(observations[0]?.outputSchema).toContain('additionalProperties');
      expect(observations[0]?.args).toContain('--dangerously-bypass-approvals-and-sandbox');
      expect(observations[0]?.workspaceAccess).toBe('read_write');
      expect(observations[0]?.scratchRoot).toMatch(
        new RegExp(
          `^${repositoryPath.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}/\\.tasker/scratch/[a-f0-9]{64}$`,
          'u',
        ),
      );
      expect(observations[0]?.artifactsRoot).toMatch(/\/artifacts\/[a-f0-9]{64}$/u);
      expect(observations[0]?.stdin).toContain('Mounted immutable input evidence:');
      expect(observations[0]?.stdin).toContain('verification.json');
      expect(observations[0]?.mounts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            source: realpathSync(join(inputRoot, 'verification.json')),
            target: realpathSync(join(inputRoot, 'verification.json')),
            readOnly: true,
          }),
          expect.objectContaining({
            target: observations[0]?.scratchRoot,
            readOnly: false,
          }),
        ]),
      );
      expect(existsSync(observations[0]?.artifactsRoot ?? '')).toBe(true);
      expect(existsSync(observations[0]?.scratchRoot ?? '')).toBe(false);
      expect(readInvocationArtifact(ledger, 'workflow:step:attempt-1', 1)).toMatchObject({
        invocationId: 'agent-invocation:workflow:step:attempt-1:provider-attempt-1',
        taskReference: 'task-ref',
        prompt: observations[0]?.stdin,
        promptBytes: Buffer.byteLength(observations[0]?.stdin ?? '', 'utf8'),
        argv: [TEST_CODEX_PROFILE.command, ...(observations[0]?.args ?? [])],
        skills: ['jira'],
        inputEvidenceArtifactIds: [registeredInput.value[0]],
        status: 'completed',
        exitStatus: { kind: 'exited', exitCode: 0 },
        usage: {
          inputTokens: 10,
          cachedInputTokens: 2,
          outputTokens: 4,
          reasoningOutputTokens: 0,
        },
        references: {
          kind: 'execution',
          workflowId: 'tasker:task-ref',
          runId: 'run-1',
          nodeId: 'implement-feature',
          blockRun: 1,
          providerAttempt: 1,
          transcriptId: 'task-step-transcript:workflow:step:attempt-1',
          outputArtifactIds: [
            'task-step-output:workflow:step:attempt-1:artifact',
            expect.stringMatching(/^task-step-evidence:[a-f0-9]{64}$/u),
          ],
          receiptArtifactId: blockReceiptId({
            workflowId: 'tasker:task-ref',
            workflowRunId: 'run-1',
            nodeId: 'implement-feature',
            blockRun: 1,
          }),
        },
      });
    } finally {
      ledger.close();
      rmSync(repositoryPath, { recursive: true, force: true });
      rmSync(stepDataPath, { recursive: true, force: true });
      rmSync(inputRoot, { recursive: true, force: true });
    }
  });

  it('records a failed invocation for a provider command that exits non-zero', async () => {
    const repositoryPath = mkdtempSync(join(tmpdir(), 'tasker-failed-step-workspace-'));
    const stepDataPath = mkdtempSync(join(tmpdir(), 'tasker-failed-step-data-'));
    writeSkillCatalog(repositoryPath);
    const ledger = openSqliteLedger({ filename: ':memory:', clock: systemClock });
    const traces = new TemporalTaskStepTraceStore(ledger.repository, systemClock);
    const commands: WorkspaceCommandRunner = {
      executionEnvironment: 'docker_workspace',
      run: (request) =>
        Promise.resolve(
          request.args[0] === '--version'
            ? {
                status: 'exited' as const,
                exitCode: 0,
                stdout: 'codex-cli 0.120.0\n',
                stderr: '',
                durationMs: 1,
              }
            : {
                status: 'exited' as const,
                exitCode: 17,
                stdout: '',
                stderr: 'controlled failure',
                durationMs: 25,
              },
        ),
    };
    const runner = new SubscriptionCliTaskStepAgentRunner(
      commands,
      new TaskStepFilesystemStore(stepDataPath),
      new TaskStepEvidenceStore(ledger.repository, systemClock),
    );

    try {
      const result = await runner.run({
        taskReference: 'task-ref',
        inputArtifactIds: [],
        operationId: 'workflow:failed-step:attempt-1',
        workflowId: 'tasker:task-ref',
        workflowRunId: 'run-1',
        nodeId: 'implement-feature',
        blockRun: 1,
        providerAttempt: 2,
        stepReference: 'implement.change@1',
        profile: TEST_CODEX_PROFILE,
        prompt: 'Return the result.',
        skills: [],
        recovery: { kind: 'single_attempt' },
        outputSchema,
        cwd: repositoryPath,
        workspaceAccess: 'read_write',
        runtime: {
          attempt: 2,
          cancellationSignal: new AbortController().signal,
          heartbeat: () => {},
        },
        transcriptStore: traces,
      });

      expect(result).toMatchObject({
        ok: false,
        error: { kind: 'provider_failed', exitCode: 17 },
      });
      expect(readInvocationArtifact(ledger, 'workflow:failed-step:attempt-1', 2)).toMatchObject({
        status: 'failed',
        durationMs: 25,
        exitStatus: { kind: 'exited', exitCode: 17 },
        references: {
          providerAttempt: 2,
          receiptArtifactId: blockReceiptId({
            workflowId: 'tasker:task-ref',
            workflowRunId: 'run-1',
            nodeId: 'implement-feature',
            blockRun: 1,
          }),
        },
      });
    } finally {
      ledger.close();
      rmSync(repositoryPath, { recursive: true, force: true });
      rmSync(stepDataPath, { recursive: true, force: true });
    }
  });

  it('records a waiting invocation when the agent reports a blocked outcome', async () => {
    const repositoryPath = mkdtempSync(join(tmpdir(), 'tasker-blocked-step-workspace-'));
    const stepDataPath = mkdtempSync(join(tmpdir(), 'tasker-blocked-step-data-'));
    writeSkillCatalog(repositoryPath);
    const ledger = openSqliteLedger({ filename: ':memory:', clock: systemClock });
    const traces = new TemporalTaskStepTraceStore(ledger.repository, systemClock);
    const commands: WorkspaceCommandRunner = {
      executionEnvironment: 'docker_workspace',
      run: (request) =>
        Promise.resolve(
          request.args[0] === '--version'
            ? {
                status: 'exited' as const,
                exitCode: 0,
                stdout: 'codex-cli 0.120.0\n',
                stderr: '',
                durationMs: 1,
              }
            : {
                status: 'exited' as const,
                exitCode: 0,
                stdout: codexStream(
                  JSON.stringify({
                    status: 'waiting',
                    waitKind: 'operator_input@1',
                    reason: 'Awaiting operator input',
                    category: 'task_ambiguity',
                    retryable: false,
                  }),
                ),
                stderr: '',
                durationMs: 30,
              },
        ),
    };
    const runner = new SubscriptionCliTaskStepAgentRunner(
      commands,
      new TaskStepFilesystemStore(stepDataPath),
      new TaskStepEvidenceStore(ledger.repository, systemClock),
    );
    const providerOutcomeSchema = agentStepOutcomeSchema(
      z.object({ summary: z.string() }).strict(),
    );

    try {
      const result = await runner.run({
        taskReference: 'task-ref',
        inputArtifactIds: [],
        operationId: 'workflow:blocked-step:attempt-1',
        workflowId: 'tasker:task-ref',
        workflowRunId: 'run-1',
        nodeId: 'implement-feature',
        blockRun: 1,
        providerAttempt: 1,
        stepReference: 'implement.change@1',
        profile: TEST_CODEX_PROFILE,
        prompt: 'Return the result.',
        skills: [],
        recovery: { kind: 'single_attempt' },
        outputSchema: providerOutcomeSchema,
        cwd: repositoryPath,
        workspaceAccess: 'read_write',
        runtime: {
          attempt: 1,
          cancellationSignal: new AbortController().signal,
          heartbeat: () => {},
        },
        transcriptStore: traces,
      });

      expect(result).toMatchObject({ ok: true });
      expect(readInvocationArtifact(ledger, 'workflow:blocked-step:attempt-1', 1)).toMatchObject({
        status: 'waiting',
        durationMs: 30,
        exitStatus: { kind: 'exited', exitCode: 0 },
      });
    } finally {
      ledger.close();
      rmSync(repositoryPath, { recursive: true, force: true });
      rmSync(stepDataPath, { recursive: true, force: true });
    }
  });

  it('records a failed invocation before rethrowing a provider exception', async () => {
    const repositoryPath = mkdtempSync(join(tmpdir(), 'tasker-thrown-step-workspace-'));
    const stepDataPath = mkdtempSync(join(tmpdir(), 'tasker-thrown-step-data-'));
    writeSkillCatalog(repositoryPath);
    const ledger = openSqliteLedger({ filename: ':memory:', clock: systemClock });
    const traces = new TemporalTaskStepTraceStore(ledger.repository, systemClock);
    const commands: WorkspaceCommandRunner = {
      executionEnvironment: 'docker_workspace',
      run: (request) => {
        if (request.args[0] === '--version') {
          return Promise.resolve({
            status: 'exited',
            exitCode: 0,
            stdout: 'codex-cli 0.120.0\n',
            stderr: '',
            durationMs: 1,
          });
        }
        throw new Error('provider command threw');
      },
    };
    const runner = new SubscriptionCliTaskStepAgentRunner(
      commands,
      new TaskStepFilesystemStore(stepDataPath),
      new TaskStepEvidenceStore(ledger.repository, systemClock),
    );

    try {
      await expect(
        runner.run({
          taskReference: 'task-ref',
          inputArtifactIds: [],
          operationId: 'workflow:thrown-step:attempt-1',
          workflowId: 'tasker:task-ref',
          workflowRunId: 'run-1',
          nodeId: 'implement-feature',
          blockRun: 1,
          providerAttempt: 1,
          stepReference: 'implement.change@1',
          profile: TEST_CODEX_PROFILE,
          prompt: 'Return the result.',
          skills: [],
          recovery: { kind: 'single_attempt' },
          outputSchema,
          cwd: repositoryPath,
          workspaceAccess: 'read_write',
          runtime: {
            attempt: 1,
            cancellationSignal: new AbortController().signal,
            heartbeat: () => {},
          },
          transcriptStore: traces,
        }),
      ).rejects.toThrow('provider command threw');
      const artifact = readInvocationArtifact(ledger, 'workflow:thrown-step:attempt-1', 1);
      expect(artifact).toMatchObject({
        status: 'failed',
        exitStatus: { kind: 'thrown', message: 'provider command threw' },
      });
      expect(artifact.prompt).toContain('Return the result.');
    } finally {
      ledger.close();
      rmSync(repositoryPath, { recursive: true, force: true });
      rmSync(stepDataPath, { recursive: true, force: true });
    }
  });

  it('logs observability persistence failures to the transcript without changing success', async () => {
    const repositoryPath = mkdtempSync(join(tmpdir(), 'tasker-observability-step-workspace-'));
    const stepDataPath = mkdtempSync(join(tmpdir(), 'tasker-observability-step-data-'));
    writeSkillCatalog(repositoryPath);
    const ledger = openSqliteLedger({ filename: ':memory:', clock: systemClock });
    const traces = new TemporalTaskStepTraceStore(ledger.repository, systemClock);
    const operationId = 'workflow:observability-step:attempt-1';
    const providerAttempt = 1;
    const invocationId = executionAgentInvocationId(operationId, providerAttempt);
    ledger.repository.transact({
      artifacts: [
        {
          artifactId: invocationId,
          artifactKind: 'agent_invocation',
          storageUri: `ledger://artifacts/${invocationId}`,
          payload: { invalid: true },
          metadata: {},
          createdAt: systemClock.now(),
        },
      ],
      timestamp: systemClock.now(),
    });
    const commands: WorkspaceCommandRunner = {
      executionEnvironment: 'docker_workspace',
      run: (request) =>
        Promise.resolve(
          request.args[0] === '--version'
            ? {
                status: 'exited' as const,
                exitCode: 0,
                stdout: 'codex-cli 0.120.0\n',
                stderr: '',
                durationMs: 1,
              }
            : {
                status: 'exited' as const,
                exitCode: 0,
                stdout: codexStream(
                  JSON.stringify({ status: 'done', done: true, labels: { result: 'verified' } }),
                ),
                stderr: '',
                durationMs: 2,
              },
        ),
    };
    const runner = new SubscriptionCliTaskStepAgentRunner(
      commands,
      new TaskStepFilesystemStore(stepDataPath),
      new TaskStepEvidenceStore(ledger.repository, systemClock),
    );

    try {
      const result = await runner.run({
        taskReference: 'task-ref',
        inputArtifactIds: [],
        operationId,
        workflowId: 'tasker:task-ref',
        workflowRunId: 'run-1',
        nodeId: 'implement-feature',
        blockRun: 1,
        providerAttempt,
        stepReference: 'implement.change@1',
        profile: TEST_CODEX_PROFILE,
        prompt: 'Return the result.',
        skills: [],
        recovery: { kind: 'single_attempt' },
        outputSchema,
        cwd: repositoryPath,
        workspaceAccess: 'read_write',
        runtime: {
          attempt: 1,
          cancellationSignal: new AbortController().signal,
          heartbeat: () => {},
        },
        transcriptStore: traces,
      });

      expect(result).toMatchObject({ ok: true });
      const transcript = traces.read(operationId);
      expect(
        transcript.ok ? transcript.value.chunks.map(({ content }) => content).join('') : '',
      ).toContain('[tasker observability] agent invocation finish persistence failed');
    } finally {
      ledger.close();
      rmSync(repositoryPath, { recursive: true, force: true });
      rmSync(stepDataPath, { recursive: true, force: true });
    }
  });

  it('runs the same step contract through a selected Claude subscription profile', async () => {
    const repositoryPath = mkdtempSync(join(tmpdir(), 'tasker-claude-step-workspace-'));
    const stepDataPath = mkdtempSync(join(tmpdir(), 'tasker-claude-step-data-'));
    writeSkillCatalog(repositoryPath);
    const requests: CommandRequest[] = [];
    const commands: WorkspaceCommandRunner = {
      executionEnvironment: 'docker_workspace',
      run: (request) => {
        requests.push(request);
        if (request.args[0] === '--version') {
          return Promise.resolve({
            status: 'exited',
            exitCode: 0,
            stdout: '2.1.224 (Claude Code)\n',
            stderr: '',
            durationMs: 1,
          });
        }
        return Promise.resolve({
          status: 'exited',
          exitCode: 0,
          stdout: claudeStream({ status: 'done', done: true, labels: { result: 'verified' } }),
          stderr: '',
          durationMs: 2,
        });
      },
    };
    const ledger = openSqliteLedger({ filename: ':memory:', clock: systemClock });
    const traces = new TemporalTaskStepTraceStore(ledger.repository, systemClock);
    const runner = new SubscriptionCliTaskStepAgentRunner(
      commands,
      new TaskStepFilesystemStore(stepDataPath),
      new TaskStepEvidenceStore(ledger.repository, systemClock),
    );

    try {
      const result = await runner.run({
        taskReference: 'task-ref',
        inputArtifactIds: [],
        operationId: 'workflow:claude-step:attempt-1',
        workflowId: 'tasker:task-ref',
        workflowRunId: 'run-1',
        nodeId: 'implement-feature',
        blockRun: 1,
        providerAttempt: 1,
        stepReference: 'implement.change@1',
        profile: TEST_CLAUDE_PROFILE,
        prompt: 'Return the result.',
        skills: [],
        recovery: { kind: 'single_attempt' },
        outputSchema,
        cwd: repositoryPath,
        workspaceAccess: 'read_only',
        runtime: {
          attempt: 1,
          cancellationSignal: new AbortController().signal,
          heartbeat: () => {},
        },
        transcriptStore: traces,
      });

      expect(result).toMatchObject({
        ok: true,
        value: {
          finalMessage: { done: true, labels: { result: 'verified' } },
          usage: {
            provider: 'claude',
            inputTokens: 10,
            cachedInputTokens: 3,
            outputTokens: 4,
          },
          artifactIds: [],
        },
      });
      expect(requests[1]?.args).toEqual(
        expect.arrayContaining([
          '--print',
          '--model',
          'sonnet',
          '--effort',
          'high',
          '--output-format',
          'stream-json',
          '--json-schema',
        ]),
      );
      expect(requests[1]?.env?.HOME).toMatch(/provider-home$/u);
      expect(requests[1]?.env?.CODEX_HOME).toBeUndefined();
      expect(requests[1]?.workspaceAccess).toBe('read_only');
    } finally {
      ledger.close();
      rmSync(repositoryPath, { recursive: true, force: true });
      rmSync(stepDataPath, { recursive: true, force: true });
    }
  });
});
