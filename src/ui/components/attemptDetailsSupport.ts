import type {
  OperatorExecutionAttempt,
  OperatorRunLogEntry,
  OperatorTaskInvocationDetail,
} from '../../server/operator-contracts.js';
import { formatOperatorDurationMs } from './operatorUiFormat.js';

type TranscriptChunk = NonNullable<OperatorExecutionAttempt['transcript']>['chunks'][number];

export type RenderedOutputLine = Readonly<{
  id: string;
  stream: 'stdout' | 'stderr';
  text: string;
  structured: boolean;
  recordedAt: string | null;
}>;

const EVENT_MESSAGE_KEYS = [
  'message',
  'text',
  'summary',
  'result',
  'item',
  'content',
  'delta',
  'data',
] as const;

const normalizeLine = (value: string): string => value.trim().replace(/\s+/gu, ' ');

const providerBanner = (value: string): boolean =>
  /^(codex(?:-cli)?\b.*|\d+\.\d+\.\d+\s+\(Claude Code\))$/u.test(value.trim());

const parseJsonLine = (line: string): Record<string, unknown> | null => {
  try {
    const value = JSON.parse(line) as unknown;
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

const nestedMessage = (value: unknown): string | null => {
  if (typeof value === 'string' && value.trim().length > 0) return normalizeLine(value);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;

  for (const key of EVENT_MESSAGE_KEYS) {
    const candidate = record[key];
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return normalizeLine(candidate);
    }
    if (typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate)) {
      const nested = nestedMessage(candidate);
      if (nested !== null) return nested;
    }
  }

  return 'error' in record ? nestedMessage(record.error) : null;
};

export const summarizeProviderEventLine = (line: string): string | null => {
  const event = parseJsonLine(line);
  if (event === null) return null;

  const type = typeof event.type === 'string' ? event.type : null;
  const message = nestedMessage(event);
  if (type === null) return message;
  return message === null ? type : `${type}: ${message}`;
};

const meaningfulText = (value: string): string | null => {
  const trimmed = normalizeLine(value);
  if (trimmed.length === 0 || providerBanner(trimmed)) return null;
  return trimmed;
};

export const buildRenderedOutputLines = (
  content: string,
  stream: 'stdout' | 'stderr',
  recordedAt: string | null,
  idPrefix: string,
): readonly RenderedOutputLine[] =>
  content
    .split(/\r?\n/gu)
    .map((line, index) => {
      const summary = summarizeProviderEventLine(line);
      const text = summary ?? meaningfulText(line);
      if (text === null) return null;
      return {
        id: `${idPrefix}:${String(index)}`,
        stream,
        text,
        structured: summary !== null,
        recordedAt,
      } satisfies RenderedOutputLine;
    })
    .filter((line): line is RenderedOutputLine => line !== null);

export const buildTranscriptLines = (
  transcript: OperatorExecutionAttempt['transcript'],
): readonly RenderedOutputLine[] => {
  if (transcript === null) return [];

  return transcript.chunks.flatMap((chunk: TranscriptChunk) =>
    buildRenderedOutputLines(
      chunk.content,
      chunk.stream,
      chunk.recordedAt,
      `chunk-${String(chunk.sequence)}`,
    ),
  );
};

export const firstMeaningfulAttemptOutput = (
  entry: OperatorRunLogEntry,
  attempt: OperatorExecutionAttempt | null | undefined,
): string => {
  if (entry.resultSummary !== null) return entry.resultSummary;

  const transcriptLine = buildTranscriptLines(attempt?.transcript ?? null)[0];
  if (transcriptLine !== undefined) return transcriptLine.text;

  const stdoutLine = buildRenderedOutputLines(
    attempt?.output?.stdout ?? '',
    'stdout',
    attempt?.output?.recordedAt ?? null,
    'stdout',
  )[0];
  if (stdoutLine !== undefined) return stdoutLine.text;

  const stderrLine = buildRenderedOutputLines(
    attempt?.output?.stderr ?? '',
    'stderr',
    attempt?.output?.recordedAt ?? null,
    'stderr',
  )[0];
  if (stderrLine !== undefined) return stderrLine.text;

  return 'No meaningful output recorded';
};

export const attemptOutcomeLabel = (
  entry: OperatorRunLogEntry,
  invocationDetail: OperatorTaskInvocationDetail | null,
): string => {
  const outcome = invocationDetail?.status ?? entry.status;
  return outcome.replaceAll('_', ' ');
};

export const attemptDurationLabel = (
  entry: OperatorRunLogEntry,
  invocationDetail: OperatorTaskInvocationDetail | null,
): string => {
  if (invocationDetail !== null) return formatOperatorDurationMs(invocationDetail.durationMs);
  if (entry.startedAt === null) return 'Unknown';

  const completedAt = entry.completedAt ?? entry.startedAt;
  return formatOperatorDurationMs(
    Math.max(0, Date.parse(completedAt) - Date.parse(entry.startedAt)),
  );
};
