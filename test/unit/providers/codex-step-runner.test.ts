import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { openSqliteLedger } from '../../../src/ledger/index.js';
import type { WorkspaceCommandRunner } from '../../../src/providers/index.js';
import { systemClock } from '../../../src/shared/clock.js';
import {
  CodexCliTaskStepAgentRunner,
  TemporalTaskStepTraceStore,
} from '../../../src/temporal/activities/block-execution.js';

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

describe('Codex task-step runner', () => {
  it('invokes Codex with only the step-scoped skill view', async () => {
    const repositoryPath = mkdtempSync(join(tmpdir(), 'tasker-codex-step-workspace-'));
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
        if (skillsRoot === undefined || codexHome === undefined) {
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
        });
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
    const runner = new CodexCliTaskStepAgentRunner(commands);

    try {
      const result = await runner.run({
        operationId: 'workflow:step:attempt-1',
        prompt: 'Return the result.',
        skills: ['jira'],
        recovery: { kind: 'single_attempt' },
        outputSchema: z.discriminatedUnion('status', [
          z
            .object({
              status: z.literal('done'),
              done: z.literal(true),
              labels: z.record(z.string(), z.string()),
            })
            .strict(),
          z.object({ status: z.literal('blocked'), reason: z.string() }).strict(),
        ]),
        cwd: repositoryPath,
        timeoutMs: 10_000,
        runtime: {
          attempt: 1,
          cancellationSignal: new AbortController().signal,
          heartbeat: () => {},
        },
        transcriptStore: traces,
      });

      expect(result).toMatchObject({
        ok: true,
        value: { finalMessage: { done: true, labels: { result: 'verified' } } },
      });
      expect(observations).toHaveLength(1);
      expect(observations[0]?.skillsRoot).toBe(join(observations[0]?.codexHome ?? '', 'skills'));
      expect(observations[0]?.jiraSkill).toContain('jira test skill');
      expect(observations[0]?.prFinalizeVisible).toBe(false);
      expect(observations[0]?.outputSchema).not.toContain('propertyNames');
      expect(observations[0]?.outputSchema).not.toContain('oneOf');
      expect(observations[0]?.outputSchema).toContain('anyOf');
      expect(observations[0]?.outputSchema).toContain('additionalProperties');
    } finally {
      ledger.close();
    }
  });
});
