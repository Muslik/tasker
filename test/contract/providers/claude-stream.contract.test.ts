import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseClaudeStream } from '../../../src/providers/claude-cli-support.js';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'claude');
const fixture = (name: string): string => readFileSync(join(fixturesDir, name), 'utf8');

describe('Claude CLI stream contract', () => {
  it('parses a clean happy stream', () => {
    const result = parseClaudeStream(fixture('01-happy.txt'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.finalMessage).toEqual({
      status: 'ok',
      summary: 'All checks passed',
      count: 3,
    });
    expect(result.value.sessionId).toBe('claude-happy-1');
    expect(result.value.usage).toEqual({
      inputTokens: 120,
      cachedInputTokens: 15,
      outputTokens: 42,
      reasoningOutputTokens: 0,
    });
    expect(result.value.reportedCostUsd).toBe(0.0123);
    expect(result.value.diagnostics).toEqual([]);
  });

  it('tolerates a leading banner line and a mid-stream plain-text warning', () => {
    const result = parseClaudeStream(fixture('02-noise-banner-and-warning.txt'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.finalMessage).toEqual({
      status: 'ok',
      summary: 'Completed with warnings',
      count: 1,
    });
    expect(result.value.sessionId).toBe('claude-noise-1');
    expect(result.value.diagnostics).toEqual([
      'Claude Code v1.2.3 starting up...',
      'WARNING: rate limit approaching, retrying in 2s',
    ]);
  });

  it('fails with invalid_event_stream when the final line is truncated mid-object and no result event exists', () => {
    const result = parseClaudeStream(fixture('03-truncated-final-line.txt'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid_event_stream');
    expect(result.error.message).toContain('Claude emitted no result event');
    expect(result.error.message).toContain('Partial resu');
  });

  it('parses a stream using CRLF line endings', () => {
    const result = parseClaudeStream(fixture('04-crlf-line-endings.txt'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.finalMessage).toEqual({
      status: 'ok',
      summary: 'CRLF stream',
      count: 7,
    });
    expect(result.value.sessionId).toBe('claude-crlf-1');
    expect(result.value.diagnostics).toEqual([]);
  });

  it('tolerates a noise line carrying ANSI escape codes', () => {
    const result = parseClaudeStream(fixture('05-ansi-noise.txt'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.finalMessage).toEqual({
      status: 'ok',
      summary: 'ANSI-safe',
      count: 2,
    });
    expect(result.value.sessionId).toBe('claude-ansi-1');
    expect(result.value.diagnostics).toHaveLength(1);
    expect(result.value.diagnostics[0]).toContain('Claude CLI ready');
  });

  it('surfaces plain-text diagnostics when no result event is emitted', () => {
    const result = parseClaudeStream(fixture('06-plain-text-error.txt'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid_event_stream');
    expect(result.error.message).toContain('fatal: authentication expired');
  });

  it('counts all skipped lines while retaining only the first 20 diagnostics', () => {
    const result = parseClaudeStream(fixture('07-twenty-five-noise-lines.txt'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.skippedCount).toBe(25);
    expect(result.value.diagnostics).toHaveLength(20);
    expect(result.value.diagnostics[0]).toBe('claude noise 01');
    expect(result.value.diagnostics[19]).toBe('claude noise 20');
  });

  it('includes result prose when structured JSON output is missing', () => {
    const result = parseClaudeStream(fixture('08-unstructured-result.txt'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid_event_stream');
    expect(result.error.message).toContain('Claude result did not contain structured JSON output');
    expect(result.error.message).toContain('Authentication expired while decoding the response');
    expect(result.error.message).toContain('provider warning before result');
  });
});
