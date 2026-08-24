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

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { openSqliteLedger } from '../../../src/ledger/index.js';
import type { CommandRequest, WorkspaceCommandRunner } from '../../../src/providers/index.js';
import { systemClock } from '../../../src/shared/clock.js';
import { TEST_CLAUDE_PROFILE, TEST_CODEX_PROFILE } from '../../helpers/execution-profile.js';
import {
  SubscriptionCliTaskStepAgentRunner,
  TemporalTaskStepTraceStore,
} from '../../../src/temporal/activities/block-execution.js';
import { TaskStepFilesystemStore } from '../../../src/temporal/activities/task-step-filesystem.js';
import { TaskStepEvidenceStore } from '../../../src/temporal/activities/task-step-evidence.js';

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
};

describe('subscription CLI task-step runner', () => {
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
        inputArtifactIds: [registeredInput.value[0]],
        operationId: 'workflow:step:attempt-1',
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
    } finally {
      ledger.close();
      rmSync(repositoryPath, { recursive: true, force: true });
      rmSync(stepDataPath, { recursive: true, force: true });
      rmSync(inputRoot, { recursive: true, force: true });
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
        inputArtifactIds: [],
        operationId: 'workflow:claude-step:attempt-1',
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
