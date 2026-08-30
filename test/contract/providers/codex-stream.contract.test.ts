import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseCodexStream, sha256 } from '../../../src/providers/codex-cli-support.js';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'codex');
const fixture = (name: string): string => readFileSync(join(fixturesDir, name), 'utf8');

describe('Codex CLI stream contract', () => {
  it('parses a clean happy stream', () => {
    const result = parseCodexStream(fixture('01-happy.txt'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sessionId).toBe('thread-happy-1');
    expect(result.value.finalMessage).toBe('Task complete: verified 3 checks.');
    expect(result.value.usage).toEqual({
      input_tokens: 200,
      cached_input_tokens: 50,
      output_tokens: 75,
      reasoning_output_tokens: 10,
    });
    expect(result.value.diagnostics).toEqual([]);
  });

  it('tolerates a leading banner line and a mid-stream plain-text warning', () => {
    const result = parseCodexStream(fixture('02-noise-banner-and-warning.txt'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sessionId).toBe('thread-noise-1');
    expect(result.value.finalMessage).toBe('Completed with one denied escalation.');
    expect(result.value.usage).toEqual({
      input_tokens: 150,
      cached_input_tokens: 0,
      output_tokens: 40,
    });
    expect(result.value.diagnostics).toEqual([
      'Codex CLI v0.9.0 — initializing session...',
      'WARNING: sandbox escalation requested and denied',
    ]);
  });

  it('succeeds with null usage when turn.completed is missing', () => {
    const result = parseCodexStream(fixture('03-missing-turn-completed.txt'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sessionId).toBe('thread-no-usage-1');
    expect(result.value.finalMessage).toBe('Completed without reporting usage.');
    expect(result.value.usage).toBeNull();
    expect(result.value.diagnostics).toEqual([]);
  });

  it('succeeds with a synthetic session id when thread.started is missing', () => {
    const raw = fixture('04-missing-thread-started.txt');
    const result = parseCodexStream(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sessionId).toBe(sha256(raw));
    expect(result.value.finalMessage).toBe('Completed without a thread id.');
    expect(result.value.usage).toEqual({
      input_tokens: 90,
      cached_input_tokens: 10,
      output_tokens: 25,
    });
    expect(result.value.diagnostics).toEqual([]);
  });

  it('fails with invalid_event_stream when the final line is truncated mid-object and no agent message exists', () => {
    const result = parseCodexStream(fixture('05-truncated-final-line.txt'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual({
      kind: 'invalid_event_stream',
      message: 'Codex stream did not contain an agent message',
    });
  });

  it('parses a stream using CRLF line endings', () => {
    const result = parseCodexStream(fixture('06-crlf-line-endings.txt'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sessionId).toBe('thread-crlf-1');
    expect(result.value.finalMessage).toBe('CRLF stream ok.');
    expect(result.value.usage).toEqual({
      input_tokens: 60,
      cached_input_tokens: 5,
      output_tokens: 15,
    });
    expect(result.value.diagnostics).toEqual([]);
  });

  it('tolerates a noise line carrying ANSI escape codes', () => {
    const result = parseCodexStream(fixture('07-ansi-noise.txt'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sessionId).toBe('thread-ansi-1');
    expect(result.value.finalMessage).toBe('ANSI noise ignored.');
    expect(result.value.diagnostics).toHaveLength(1);
    expect(result.value.diagnostics[0]).toContain('codex');
  });
});
