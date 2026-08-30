import { constants } from 'node:fs';
import { access, cp, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { z } from 'zod';

import { err, ok, type Outcome } from '../shared/outcome.js';

const ClaudeUsageSchema = z
  .object({
    input_tokens: z.number().int().nonnegative().default(0),
    cache_creation_input_tokens: z.number().int().nonnegative().default(0),
    cache_read_input_tokens: z.number().int().nonnegative().default(0),
    output_tokens: z.number().int().nonnegative().default(0),
  })
  .loose();

const ClaudeResultEventSchema = z
  .object({
    type: z.literal('result'),
    subtype: z.string().min(1),
    is_error: z.boolean().default(false),
    result: z.string().default(''),
    structured_output: z.unknown().optional(),
    session_id: z.string().min(1),
    usage: ClaudeUsageSchema.default({
      input_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 0,
    }),
    total_cost_usd: z.number().nonnegative().optional(),
  })
  .loose();

export interface ClaudeStreamResult {
  readonly finalMessage: unknown;
  readonly sessionId: string;
  readonly usage: {
    readonly inputTokens: number;
    readonly cachedInputTokens: number;
    readonly outputTokens: number;
    readonly reasoningOutputTokens: 0;
  };
  readonly reportedCostUsd: number | null;
  readonly diagnostics: readonly string[];
  readonly skippedCount: number;
}

const MAX_STREAM_DIAGNOSTICS = 20;
const MAX_DIAGNOSTIC_LINE_LENGTH = 200;
const MAX_STREAM_FAILURE_CONTEXT_LENGTH = 2_000;

const truncateDiagnosticLine = (line: string): string =>
  line.length <= MAX_DIAGNOSTIC_LINE_LENGTH
    ? line
    : `${line.slice(0, MAX_DIAGNOSTIC_LINE_LENGTH)}...`;

const truncateFailureContext = (value: string): string =>
  value.length <= MAX_STREAM_FAILURE_CONTEXT_LENGTH
    ? value
    : `${value.slice(0, MAX_STREAM_FAILURE_CONTEXT_LENGTH - 3)}...`;

const claudeFailureMessage = (
  message: string,
  diagnostics: readonly string[],
  prose = '',
): string => {
  const context = [
    prose.trim().length === 0 ? '' : `Result prose:\n${prose.trim()}`,
    diagnostics.length === 0 ? '' : `Stream diagnostics:\n${diagnostics.join('\n')}`,
  ]
    .filter((value) => value.length > 0)
    .join('\n');
  return context.length === 0 ? message : `${message}\n${truncateFailureContext(context)}`;
};

export const prepareIsolatedClaudeHome = async (configurationRoot: string): Promise<void> => {
  const claudeRoot = join(configurationRoot, '.claude');
  await mkdir(claudeRoot, { recursive: true });
  const credentials = join(homedir(), '.claude', '.credentials.json');
  try {
    await access(credentials, constants.R_OK);
    await cp(credentials, join(claudeRoot, '.credentials.json'));
  } catch {
    return;
  }
};

export const parseClaudeStream = (
  stdout: string,
): Outcome<
  ClaudeStreamResult,
  { readonly kind: 'invalid_event_stream'; readonly message: string }
> => {
  let result: z.infer<typeof ClaudeResultEventSchema> | null = null;
  const diagnostics: string[] = [];
  let skippedCount = 0;
  for (const line of stdout.split(/\r?\n/u)) {
    if (line.trim().length === 0) continue;
    let event: unknown;
    try {
      event = JSON.parse(line) as unknown;
    } catch {
      skippedCount += 1;
      if (diagnostics.length < MAX_STREAM_DIAGNOSTICS) {
        diagnostics.push(truncateDiagnosticLine(line));
      }
      continue;
    }
    const parsed = ClaudeResultEventSchema.safeParse(event);
    if (parsed.success) result = parsed.data;
  }
  if (result === null) {
    return err({
      kind: 'invalid_event_stream',
      message: claudeFailureMessage('Claude emitted no result event', diagnostics),
    });
  }
  if (result.is_error) {
    return err({
      kind: 'invalid_event_stream',
      message: result.result.trim() || `Claude result failed with subtype ${result.subtype}`,
    });
  }

  let finalMessage = result.structured_output;
  if (finalMessage === undefined) {
    try {
      finalMessage = JSON.parse(result.result) as unknown;
    } catch {
      return err({
        kind: 'invalid_event_stream',
        message: claudeFailureMessage(
          'Claude result did not contain structured JSON output',
          diagnostics,
          result.result,
        ),
      });
    }
  }
  return ok({
    finalMessage,
    sessionId: result.session_id,
    usage: {
      inputTokens: result.usage.input_tokens,
      cachedInputTokens:
        result.usage.cache_creation_input_tokens + result.usage.cache_read_input_tokens,
      outputTokens: result.usage.output_tokens,
      reasoningOutputTokens: 0,
    },
    reportedCostUsd: result.total_cost_usd ?? null,
    diagnostics,
    skippedCount,
  });
};
