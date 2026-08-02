import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  CodexCliImplementationPlanner,
  type CommandRequest,
  type CommandResult,
  type CommandRunner,
} from '../../../src/providers/index.js';

const readyDecision = {
  status: 'ready',
  plan: {
    schemaVersion: 1,
    title: 'Repair the seat marker',
    summary: 'Ground the affected component, make the bounded repair, and verify it.',
    steps: [
      {
        id: 'repair-seat-marker',
        title: 'Repair the seat marker',
        objective: 'Keep the marker color consistent with the seat state.',
        repository: 'onetwotrip/front-avia',
        files: ['src/features/additionalServices/selectSeats'],
        verification: ['Run the targeted seat selection checks.'],
      },
    ],
    assumptions: [],
    risks: [],
    acceptanceCriteria: ['The marker uses the expected color.'],
  },
} as const;

const codexJsonl = (finalMessage: string): string =>
  [
    JSON.stringify({ type: 'thread.started', thread_id: 'thread-planner-1' }),
    JSON.stringify({
      type: 'item.completed',
      item: { id: 'item-1', type: 'agent_message', text: finalMessage },
    }),
    JSON.stringify({
      type: 'turn.completed',
      usage: {
        input_tokens: 1500,
        cached_input_tokens: 900,
        output_tokens: 300,
        reasoning_output_tokens: 50,
      },
    }),
  ].join('\n');

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
      stderr: '',
      durationMs: 1750,
    });
  }
}

const request = (strategy: 'fast' | 'ralplan') => ({
  repositoryPath: process.cwd(),
  strategy,
  context: {
    taskSnapshot: { taskId: 'AVIA-13235', summary: 'Repair seat marker color' },
    workflow: { kind: 'sequence', id: 'delivery' },
    repositoryReference: 'onetwotrip/front-avia',
    operatorGuidance: null,
  },
});

describe('Codex CLI implementation planner', () => {
  it('uses a bounded low-reasoning subscription pass for fast planning', async () => {
    const runner = new RecordingRunner(
      JSON.stringify({ decisionJson: JSON.stringify(readyDecision) }),
    );
    const planner = new CodexCliImplementationPlanner(runner);

    const result = await planner.plan(request('fast'));

    expect(result).toMatchObject({
      ok: true,
      value: {
        decision: readyDecision,
        receipt: {
          provider: 'codex_cli',
          strategy: 'fast',
          sessionId: 'thread-planner-1',
          durationMs: 1750,
          usage: { inputTokens: 1500, outputTokens: 300 },
        },
      },
    });
    expect(runner.requests[1]?.args).toEqual(
      expect.arrayContaining(['--sandbox', 'read-only', '-c', 'model_reasoning_effort="low"']),
    );
    expect(runner.requests[1]?.stdin).toContain('Use one bounded planning pass');
    expect(runner.requests[1]?.stdin).not.toContain('Invoke $ralplan');
    expect(runner.schema).toContain('decisionJson');
  });

  it('routes an explicit ralplan request through the consensus prompt with high reasoning', async () => {
    const runner = new RecordingRunner(
      JSON.stringify({ decisionJson: JSON.stringify(readyDecision) }),
    );
    const planner = new CodexCliImplementationPlanner(runner);

    const result = await planner.plan(request('ralplan'));

    expect(result).toMatchObject({ ok: true, value: { receipt: { strategy: 'ralplan' } } });
    expect(runner.requests[1]?.args).toEqual(
      expect.arrayContaining(['-c', 'model_reasoning_effort="high"']),
    );
    expect(runner.requests[1]?.stdin).toContain('Invoke $ralplan non-interactively');
    expect(runner.requests[1]?.stdin).toContain('Planner -> Architect -> Critic');
  });

  it('rejects a decision outside the typed planner contract', async () => {
    const runner = new RecordingRunner(
      JSON.stringify({ decisionJson: JSON.stringify({ status: 'ready', plan: {} }) }),
    );
    const planner = new CodexCliImplementationPlanner(runner);

    const result = await planner.plan(request('fast'));

    expect(result).toMatchObject({ ok: false, error: { kind: 'invalid_planner_output' } });
  });

  it('returns typed blocking questions without inventing an implementation plan', async () => {
    const decision = {
      status: 'needs_clarification',
      questions: [
        {
          id: 'target-browser',
          question: 'Which browser must the reproduction cover?',
          reason: 'The evidence requirement changes with this choice.',
        },
      ],
    } as const;
    const runner = new RecordingRunner(JSON.stringify({ decisionJson: JSON.stringify(decision) }));
    const planner = new CodexCliImplementationPlanner(runner);

    const result = await planner.plan(request('fast'));

    expect(result).toMatchObject({ ok: true, value: { decision } });
  });
});
