import type { PlanningTranscriptView } from '../control-plane/planning-transcript.js';

export type PlanningAgentEvent =
  | {
      readonly kind: 'command';
      readonly id: string;
      readonly command: string;
      readonly output: string;
      readonly status: 'running' | 'completed' | 'failed';
      readonly exitCode: number | null;
    }
  | { readonly kind: 'message'; readonly title: string; readonly detail: string | null }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'warning'; readonly message: string };

export type PlanningAgentAttempt = {
  readonly attempt: number;
  readonly status: 'running' | 'completed' | 'failed';
  readonly sessionId: string | null;
  readonly events: readonly PlanningAgentEvent[];
  readonly usage: {
    readonly inputTokens: number;
    readonly cachedInputTokens: number;
    readonly outputTokens: number;
  } | null;
};

export type PlanningAgentLog = {
  readonly attempts: readonly PlanningAgentAttempt[];
  readonly raw: string;
};

type MutableAttempt = {
  attempt: number;
  status: PlanningAgentAttempt['status'];
  sessionId: string | null;
  events: PlanningAgentEvent[];
  commandIndexes: Map<string, number>;
  usage: PlanningAgentAttempt['usage'];
  stderr: string;
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const stringField = (value: Readonly<Record<string, unknown>>, key: string): string | null =>
  typeof value[key] === 'string' ? value[key] : null;

const numberField = (value: Readonly<Record<string, unknown>>, key: string): number | null =>
  typeof value[key] === 'number' && Number.isFinite(value[key]) ? value[key] : null;

const compactWhitespace = (value: string): string => value.replace(/\s+/gu, ' ').trim();

const messageFrom = (value: unknown, depth = 0): string | null => {
  if (depth > 5) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length === 0) return null;
    try {
      return messageFrom(JSON.parse(trimmed) as unknown, depth + 1) ?? compactWhitespace(trimmed);
    } catch {
      return compactWhitespace(trimmed);
    }
  }
  if (!isRecord(value)) return null;

  const nestedError = messageFrom(value.error, depth + 1);
  if (nestedError !== null) return nestedError;
  return messageFrom(value.message, depth + 1);
};

const addUniqueEvent = (attempt: MutableAttempt, event: PlanningAgentEvent): void => {
  const duplicate = attempt.events.some((candidate) => {
    if (candidate.kind !== event.kind) return false;
    if (candidate.kind === 'error' && event.kind === 'error') {
      return candidate.message === event.message;
    }
    if (candidate.kind === 'warning' && event.kind === 'warning') {
      return candidate.message === event.message;
    }
    return false;
  });
  if (!duplicate) attempt.events.push(event);
};

const commandStatus = (
  status: string | null,
  exitCode: number | null,
): Extract<PlanningAgentEvent, { readonly kind: 'command' }>['status'] => {
  if (exitCode !== null && exitCode !== 0) return 'failed';
  if (status === 'failed') return 'failed';
  if (status === 'completed') return 'completed';
  return 'running';
};

const recordCommand = (attempt: MutableAttempt, item: Readonly<Record<string, unknown>>): void => {
  const id = stringField(item, 'id') ?? `command-${String(attempt.events.length + 1)}`;
  const command = stringField(item, 'command') ?? 'Command';
  const output = stringField(item, 'aggregated_output') ?? '';
  const exitCode = numberField(item, 'exit_code');
  const event: PlanningAgentEvent = {
    kind: 'command',
    id,
    command,
    output,
    status: commandStatus(stringField(item, 'status'), exitCode),
    exitCode,
  };
  const index = attempt.commandIndexes.get(id);
  if (index === undefined) {
    attempt.commandIndexes.set(id, attempt.events.length);
    attempt.events.push(event);
  } else {
    attempt.events[index] = event;
  }
};

const planningMessage = (text: string): Extract<PlanningAgentEvent, { kind: 'message' }> => {
  try {
    const value: unknown = JSON.parse(text);
    if (isRecord(value) && isRecord(value.decision)) {
      return {
        kind: 'message',
        title: 'Implementation plan returned',
        detail: stringField(value.decision, 'status')?.replaceAll('_', ' ') ?? null,
      };
    }
    if (
      isRecord(value) &&
      Array.isArray(value.evidenceRequests) &&
      value.evidenceRequests.length > 0
    ) {
      return {
        kind: 'message',
        title: 'Evidence requested',
        detail: `${String(value.evidenceRequests.length)} request(s)`,
      };
    }
  } catch {
    // Human-readable agent messages are valid provider output too.
  }
  return { kind: 'message', title: 'Agent message', detail: compactWhitespace(text) };
};

const processProviderEvent = (attempt: MutableAttempt, value: unknown): void => {
  if (!isRecord(value)) return;
  const type = stringField(value, 'type');
  if (type === 'thread.started') {
    attempt.sessionId = stringField(value, 'thread_id');
    return;
  }
  if (type === 'turn.started') {
    attempt.status = 'running';
    return;
  }
  if (type === 'turn.completed') {
    attempt.status = 'completed';
    if (isRecord(value.usage)) {
      attempt.usage = {
        inputTokens: numberField(value.usage, 'input_tokens') ?? 0,
        cachedInputTokens: numberField(value.usage, 'cached_input_tokens') ?? 0,
        outputTokens: numberField(value.usage, 'output_tokens') ?? 0,
      };
    }
    return;
  }
  if (type === 'error' || type === 'turn.failed') {
    attempt.status = 'failed';
    const message = messageFrom(type === 'error' ? value.message : value.error);
    if (message !== null) addUniqueEvent(attempt, { kind: 'error', message });
    return;
  }
  if ((type === 'item.started' || type === 'item.completed') && isRecord(value.item)) {
    const itemType = stringField(value.item, 'type');
    if (itemType === 'command_execution') {
      recordCommand(attempt, value.item);
      return;
    }
    if (itemType === 'agent_message') {
      const text = stringField(value.item, 'text');
      if (text !== null) attempt.events.push(planningMessage(text));
    }
  }
};

const freezeAttempt = (attempt: MutableAttempt): PlanningAgentAttempt => {
  const stderr = compactWhitespace(attempt.stderr);
  if (stderr.length > 0) addUniqueEvent(attempt, { kind: 'warning', message: stderr });
  return {
    attempt: attempt.attempt,
    status: attempt.status,
    sessionId: attempt.sessionId,
    events: attempt.events,
    usage: attempt.usage,
  };
};

export const planningAgentLogFrom = (transcript: PlanningTranscriptView): PlanningAgentLog => {
  const attempts: MutableAttempt[] = [];
  const orderedChunks = [...transcript.chunks].sort(
    (left, right) => left.sequence - right.sequence,
  );
  let currentAttempt: MutableAttempt | null = null;
  let stdoutBuffer = '';

  const startAttempt = (): MutableAttempt => {
    const attempt: MutableAttempt = {
      attempt: attempts.length + 1,
      status: 'running',
      sessionId: null,
      events: [],
      commandIndexes: new Map<string, number>(),
      usage: null,
      stderr: '',
    };
    attempts.push(attempt);
    currentAttempt = attempt;
    return attempt;
  };

  const activeAttempt = (): MutableAttempt => currentAttempt ?? startAttempt();

  const processLine = (line: string): void => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    let value: unknown;
    try {
      value = JSON.parse(trimmed) as unknown;
    } catch {
      addUniqueEvent(activeAttempt(), {
        kind: 'warning',
        message: compactWhitespace(trimmed),
      });
      return;
    }

    if (isRecord(value) && stringField(value, 'type') === 'thread.started') startAttempt();
    processProviderEvent(activeAttempt(), value);
  };

  for (const chunk of orderedChunks) {
    if (chunk.stream === 'stderr') {
      activeAttempt().stderr += chunk.content;
      continue;
    }
    stdoutBuffer += chunk.content;
    const lines = stdoutBuffer.split(/\r?\n/gu);
    stdoutBuffer = lines.pop() ?? '';
    for (const line of lines) processLine(line);
  }
  processLine(stdoutBuffer);

  return {
    attempts: attempts.map(freezeAttempt),
    raw: orderedChunks.map((chunk) => chunk.content).join(''),
  };
};
