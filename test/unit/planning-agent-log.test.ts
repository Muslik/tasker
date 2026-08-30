import { describe, expect, it } from 'vitest';

import {
  planningAgentLogFrom,
  planningAgentLogFromRaw,
} from '../../src/cockpit/planning-agent-log.js';
import type { PlanningTranscriptView } from '../../src/server/planning-transcript.js';

const chunk = (
  sequence: number,
  providerAttempt: number,
  stream: 'stdout' | 'stderr',
  content: string,
): PlanningTranscriptView['chunks'][number] => ({
  schemaVersion: 1,
  transcriptId: 'planning-transcript:test',
  operationId: 'test',
  sequence,
  providerAttempt,
  stream,
  content,
  byteLength: Buffer.byteLength(content, 'utf8'),
  recordedAt: '2026-08-05T12:00:00.000Z',
});

describe('planning agent log', () => {
  it('turns fragmented Codex JSONL into attempts and operator-relevant events', () => {
    const failedError = JSON.stringify({
      type: 'error',
      message: JSON.stringify({
        type: 'error',
        error: {
          code: 'invalid_json_schema',
          message: "Invalid response schema. Missing 'evidenceRequests'.",
        },
        status: 400,
      }),
    });
    const duplicateFailure = JSON.stringify({
      type: 'turn.failed',
      error: {
        message: JSON.stringify({
          error: { message: "Invalid response schema. Missing 'evidenceRequests'." },
        }),
      },
    });
    const completedCommand = JSON.stringify({
      type: 'item.completed',
      item: {
        id: 'command-1',
        type: 'command_execution',
        command: 'rg "Pay" src/pages',
        aggregated_output: 'src/pages/Pay.tsx',
        exit_code: 0,
        status: 'completed',
      },
    });
    const planningResult = JSON.stringify({
      type: 'item.completed',
      item: {
        id: 'message-1',
        type: 'agent_message',
        text: JSON.stringify({
          decision: { status: 'ready' },
          evidenceRequests: [],
        }),
      },
    });
    const completed = JSON.stringify({
      type: 'turn.completed',
      usage: { input_tokens: 1200, cached_input_tokens: 800, output_tokens: 240 },
    });
    const secondAttempt = [
      JSON.stringify({ type: 'thread.started', thread_id: 'thread-2' }),
      completedCommand,
      planningResult,
      completed,
    ].join('\n');
    const splitAt = Math.floor(secondAttempt.length / 2);
    const transcript: PlanningTranscriptView = {
      transcriptId: 'planning-transcript:test',
      operationId: 'test',
      chunks: [
        chunk(1, 1, 'stdout', `${failedError}\n${duplicateFailure}\n`),
        chunk(2, 1, 'stderr', 'provider retry scheduled\n'),
        // Provider retries restart at 1 after a durable planning resume. A new
        // thread, rather than this counter, is the stable attempt boundary.
        chunk(3, 1, 'stdout', secondAttempt.slice(0, splitAt)),
        chunk(4, 1, 'stdout', secondAttempt.slice(splitAt)),
      ],
      totalBytes: 1000,
      truncated: false,
    };

    const log = planningAgentLogFrom(transcript);

    expect(log.attempts).toHaveLength(2);
    expect(log.attempts[0]).toMatchObject({ attempt: 1, status: 'failed' });
    expect(log.attempts[0]?.events).toEqual([
      {
        kind: 'error',
        message: "Invalid response schema. Missing 'evidenceRequests'.",
      },
      { kind: 'warning', message: 'provider retry scheduled' },
    ]);
    expect(log.attempts[1]).toMatchObject({
      attempt: 2,
      status: 'completed',
      sessionId: 'thread-2',
      usage: { inputTokens: 1200, cachedInputTokens: 800, outputTokens: 240 },
    });
    expect(log.attempts[1]?.events).toEqual([
      {
        kind: 'command',
        id: 'command-1',
        command: 'rg "Pay" src/pages',
        output: 'src/pages/Pay.tsx',
        exitCode: 0,
        status: 'completed',
      },
      { kind: 'message', title: 'Implementation plan returned', detail: 'ready' },
    ]);
    expect(log.raw).toContain('thread.started');
  });

  it('parses a complete persisted execution stdout without an attempt click', () => {
    const raw = [
      JSON.stringify({ type: 'thread.started', thread_id: 'execution-thread' }),
      JSON.stringify({
        type: 'item.completed',
        item: {
          id: 'empty-protocol-message',
          type: 'agent_message',
          text: JSON.stringify({
            status: 'completed',
            outputJson: null,
            requestJson: null,
            blockingReason: null,
          }),
        },
      }),
      JSON.stringify({
        type: 'item.completed',
        item: {
          id: 'command-1',
          type: 'command_execution',
          command: 'pnpm run lint:stylelint',
          aggregated_output: 'Done',
          exit_code: 0,
          status: 'completed',
        },
      }),
      JSON.stringify({
        type: 'item.completed',
        item: {
          id: 'message-1',
          type: 'agent_message',
          text: JSON.stringify({
            status: 'completed',
            outputJson: JSON.stringify({ summary: 'Verification accepted' }),
            requestJson: null,
            blockingReason: null,
          }),
        },
      }),
      JSON.stringify({
        type: 'turn.completed',
        usage: { input_tokens: 100, cached_input_tokens: 80, output_tokens: 20 },
      }),
    ].join('\n');

    const log = planningAgentLogFromRaw(raw);

    expect(log.attempts).toHaveLength(1);
    expect(log.attempts[0]?.events).toEqual([
      {
        kind: 'command',
        id: 'command-1',
        command: 'pnpm run lint:stylelint',
        output: 'Done',
        exitCode: 0,
        status: 'completed',
      },
      { kind: 'message', title: 'Agent message', detail: 'Verification accepted' },
    ]);
  });

  it('hides empty planner protocol messages', () => {
    const raw = [
      JSON.stringify({ type: 'thread.started', thread_id: 'planning-thread' }),
      JSON.stringify({
        type: 'item.completed',
        item: {
          id: 'empty-plan-message',
          type: 'agent_message',
          text: JSON.stringify({ decision: null, evidenceRequests: [] }),
        },
      }),
      JSON.stringify({
        type: 'item.completed',
        item: {
          id: 'final-plan-message',
          type: 'agent_message',
          text: JSON.stringify({ decision: { status: 'ready' }, evidenceRequests: [] }),
        },
      }),
    ].join('\n');

    expect(planningAgentLogFromRaw(raw).attempts[0]?.events).toEqual([
      { kind: 'message', title: 'Implementation plan returned', detail: 'ready' },
    ]);
  });
});
