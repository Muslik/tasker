import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { findTaskFixture, planTaskWorkflow } from '../../../src/planning/index.js';
import {
  SubscriptionCliWorkflowAnalyzer,
  type CommandRequest,
  type CommandResult,
  type WorkspaceCommandRunner,
} from '../../../src/providers/index.js';
import { makeEvidenceBundle } from '../../helpers/evidence.js';
import { TEST_CLAUDE_PROFILE, TEST_CODEX_PROFILE } from '../../helpers/execution-profile.js';

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

const claudeJsonl = (finalMessage: unknown): string =>
  JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: '',
    structured_output: finalMessage,
    session_id: 'claude-analyzer-1',
    usage: {
      input_tokens: 900,
      cache_creation_input_tokens: 100,
      cache_read_input_tokens: 200,
      output_tokens: 180,
    },
    total_cost_usd: 0.31,
  });

const providerMessage = (output: ReturnType<typeof validAnalyzerOutput>): string =>
  JSON.stringify({
    assemblyDecisions: output.assemblyDecisions,
    sourceJson: JSON.stringify(output.source),
    verificationPlan: output.verificationPlan,
  });

class RecordingRunner implements WorkspaceCommandRunner {
  public readonly executionEnvironment = 'docker_workspace' as const;
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

class ClaudeRecordingRunner implements WorkspaceCommandRunner {
  public readonly executionEnvironment = 'docker_workspace' as const;
  public readonly requests: CommandRequest[] = [];

  public constructor(private readonly finalMessage: unknown) {}

  public run(request: CommandRequest): Promise<CommandResult> {
    this.requests.push(request);
    if (request.args[0] === '--version') {
      return Promise.resolve({
        status: 'exited',
        exitCode: 0,
        stdout: '2.1.224 (Claude Code)\n',
        stderr: '',
        durationMs: 5,
      });
    }
    return Promise.resolve({
      status: 'exited',
      exitCode: 0,
      stdout: claudeJsonl(this.finalMessage),
      stderr: '',
      durationMs: 1100,
    });
  }
}

describe('subscription CLI workflow analyzer', () => {
  it('runs subscription CLI analysis in a read-only Docker workspace with structured output', async () => {
    const output = validAnalyzerOutput();
    const runner = new RecordingRunner(providerMessage(output));
    const analyzer = new SubscriptionCliWorkflowAnalyzer(runner, () => TEST_CODEX_PROFILE);

    const result = await analyzer.analyze({
      repositoryPath: '/tmp/repository',
      repositoryReference: fixture().repository,
      taskSnapshot: fixture(),
      plannerContext: { contracts: [] },
      evidenceBundle: makeEvidenceBundle('avia-13236-short-bug'),
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        output,
        receipt: {
          provider: 'codex_cli',
          analyzerVersion: 'workflow-analyzer@2',
          profile: 'test-codex',
          profileSha256: 'e'.repeat(64),
          cliVersion: 'codex-cli 0.120.0',
          model: 'gpt-5.6-terra',
          effort: 'medium',
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
    expect(executionRequest?.cwd).toBe('/tmp/repository');
    expect(executionRequest?.env?.CODEX_HOME).toMatch(
      /tasker-workflow-analyzer-.+\/provider-home$/u,
    );
    expect(executionRequest?.stdin).toContain('Do not claim facts that require later execution');
    expect(executionRequest?.stdin).toContain('MUST have exactly these top-level keys');
    expect(executionRequest?.stdin).toContain(
      '"root":{"kind":"sequence","id":"delivery","children"',
    );
    expect(executionRequest?.stdin).toContain('Do not omit node ids, sequence children, step with');
    expect(executionRequest?.stdin).toContain('Construct the complete graph from an empty root');
    expect(executionRequest?.stdin).toContain('NEVER return top-level keys such as schemaVersion');
    expect(executionRequest?.stdin).not.toContain('copying plannerContext.baseTemplate');
    expect(executionRequest?.stdin).toContain(
      'Do not emit context discovery, implementation planning, or plan-review nodes',
    );
    expect(runner.requests[1]?.args).toEqual(
      expect.arrayContaining([
        'exec',
        '--model',
        'gpt-5.6-terra',
        '-c',
        'service_tier="fast"',
        '-c',
        'model_reasoning_effort="medium"',
        '--ephemeral',
        '--skip-git-repo-check',
        '--dangerously-bypass-approvals-and-sandbox',
        '--json',
        '-',
      ]),
    );
    expect(executionRequest?.workspaceAccess).toBe('read_only');
    expect(runner.schema).toContain('sourceJson');
  });

  it('runs the analyzer through a selected Claude subscription profile', async () => {
    const output = validAnalyzerOutput();
    const runner = new ClaudeRecordingRunner(JSON.parse(providerMessage(output)) as unknown);
    const analyzer = new SubscriptionCliWorkflowAnalyzer(runner, () => TEST_CLAUDE_PROFILE);

    const result = await analyzer.analyze({
      repositoryPath: '/tmp/repository',
      repositoryReference: fixture().repository,
      taskSnapshot: fixture(),
      plannerContext: { contracts: [] },
      evidenceBundle: makeEvidenceBundle('avia-13236-short-bug'),
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        output,
        receipt: {
          provider: 'claude_cli',
          profile: 'test-claude',
          model: 'sonnet',
          effort: 'high',
          sessionId: 'claude-analyzer-1',
          usage: { inputTokens: 900, cachedInputTokens: 300, outputTokens: 180 },
          hypotheticalApiCostUsd: 0.31,
        },
      },
    });
    expect(runner.requests[1]?.args).toEqual(
      expect.arrayContaining(['--print', '--model', 'sonnet', '--effort', 'high', '--json-schema']),
    );
    expect(runner.requests[1]?.env?.HOME).toMatch(/tasker-workflow-analyzer-.+\/provider-home$/u);
    expect(runner.requests[1]?.env?.CODEX_HOME).toBeUndefined();
  });

  it('rejects a final message that violates the analyzer output contract', async () => {
    const runner = new RecordingRunner(JSON.stringify({ source: 'not-a-workflow' }));
    const analyzer = new SubscriptionCliWorkflowAnalyzer(runner, () => TEST_CODEX_PROFILE);

    const result = await analyzer.analyze({
      repositoryPath: '/tmp/repository',
      repositoryReference: fixture().repository,
      taskSnapshot: fixture(),
      plannerContext: { contracts: [] },
      evidenceBundle: makeEvidenceBundle('avia-13236-short-bug'),
    });

    expect(result).toMatchObject({ ok: false, error: { kind: 'invalid_analyzer_output' } });
  });
});
