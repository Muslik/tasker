import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { findTaskFixture, planTaskWorkflow } from '../../../src/planning/index.js';
import {
  CodexCliWorkflowAnalyzer,
  type CommandRequest,
  type CommandResult,
  type CommandRunner,
} from '../../../src/providers/index.js';

const fixture = () => {
  const value = findTaskFixture('avia-13236-short-bug');
  if (value === undefined) {
    throw new Error('Expected short bug fixture');
  }
  return value;
};

const validAnalyzerOutput = () => {
  const planned = planTaskWorkflow(fixture());
  if (!planned.ok) {
    throw new Error('Expected deterministic proposal fixture to compile');
  }

  return {
    assemblyDecisions: planned.value.proposal.assemblyDecisions,
    source: planned.value.proposal.source,
    verificationPlan: planned.value.proposal.verificationPlan,
  };
};

const codexJsonl = (finalMessage: string): string =>
  [
    JSON.stringify({ type: 'thread.started', thread_id: 'thread-analyzer-1' }),
    JSON.stringify({
      type: 'item.completed',
      item: { id: 'item-1', type: 'agent_message', text: finalMessage },
    }),
    JSON.stringify({
      type: 'turn.completed',
      usage: {
        input_tokens: 1200,
        cached_input_tokens: 800,
        output_tokens: 240,
        reasoning_output_tokens: 40,
      },
    }),
  ].join('\n');

const providerMessage = (output: ReturnType<typeof validAnalyzerOutput>): string =>
  JSON.stringify({
    assemblyDecisions: output.assemblyDecisions,
    sourceJson: JSON.stringify(output.source),
    verificationPlan: output.verificationPlan,
  });

class RecordingRunner implements CommandRunner {
  public readonly requests: CommandRequest[] = [];
  public schema: string | null = null;

  public constructor(private readonly finalMessage: string) {}

  public run(request: CommandRequest): Promise<CommandResult> {
    this.requests.push(request);
    if (request.args[0] === '--version') {
      return Promise.resolve({
        status: 'exited',
        exitCode: 0,
        stdout: 'codex-cli 0.120.0\n',
        stderr: '',
        durationMs: 5,
      });
    }

    const schemaIndex = request.args.indexOf('--output-schema');
    const schemaPath = schemaIndex < 0 ? undefined : request.args[schemaIndex + 1];
    this.schema = schemaPath === undefined ? null : readFileSync(schemaPath, 'utf8');
    return Promise.resolve({
      status: 'exited',
      exitCode: 0,
      stdout: codexJsonl(this.finalMessage),
      stderr: 'read-only analysis completed',
      durationMs: 1250,
    });
  }
}

describe('Codex CLI workflow analyzer', () => {
  it('runs subscription CLI analysis in a read-only ephemeral sandbox with structured output', async () => {
    const output = validAnalyzerOutput();
    const runner = new RecordingRunner(providerMessage(output));
    const analyzer = new CodexCliWorkflowAnalyzer(runner);

    const result = await analyzer.analyze({
      repositoryPath: '/tmp/repository',
      taskSnapshot: fixture(),
      plannerContext: { contracts: [] },
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        output,
        receipt: {
          provider: 'codex_cli',
          analyzerVersion: 'codex-cli@1',
          cliVersion: 'codex-cli 0.120.0',
          model: 'gpt-5.4',
          serviceTier: 'fast',
          sessionId: 'thread-analyzer-1',
          durationMs: 1250,
          hypotheticalApiCostUsd: null,
          usage: {
            inputTokens: 1200,
            cachedInputTokens: 800,
            outputTokens: 240,
            reasoningOutputTokens: 40,
          },
        },
      },
    });
    const executionRequest = runner.requests[1];
    expect(executionRequest?.command).toBe('codex');
    expect(executionRequest?.cwd).toMatch(/tasker-codex-analyzer-.+\/workspace$/u);
    expect(executionRequest?.env?.CODEX_HOME).toMatch(/tasker-codex-analyzer-.+\/codex-home$/u);
    expect(executionRequest?.stdin).toContain('Do not claim facts that require later execution');
    expect(executionRequest?.stdin).toContain('MUST have exactly these top-level keys');
    expect(executionRequest?.stdin).toContain('such as schemaVersion, task, repository, workflow');
    expect(executionRequest?.stdin).toContain(
      'task.analyze@1 as the first root-sequence child and a',
    );
    expect(executionRequest?.stdin).toContain('plan.approved@1 gate as the second');
    expect(runner.requests[1]?.args).toEqual(
      expect.arrayContaining([
        'exec',
        '--model',
        'gpt-5.4',
        '-c',
        'service_tier="fast"',
        '-c',
        'model_reasoning_effort="low"',
        '--ephemeral',
        '--skip-git-repo-check',
        '--sandbox',
        'read-only',
        '--json',
        '-',
      ]),
    );
    expect(runner.schema).toContain('sourceJson');
  });

  it('rejects a final message that violates the analyzer output contract', async () => {
    const runner = new RecordingRunner(JSON.stringify({ source: 'not-a-workflow' }));
    const analyzer = new CodexCliWorkflowAnalyzer(runner);

    const result = await analyzer.analyze({
      repositoryPath: '/tmp/repository',
      taskSnapshot: fixture(),
      plannerContext: { contracts: [] },
    });

    expect(result).toMatchObject({ ok: false, error: { kind: 'invalid_analyzer_output' } });
  });
});
