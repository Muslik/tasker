export type AgentActivityCommand = Readonly<{
  kind: 'command';
  id: string;
  command: string;
  input: string;
  output: string;
  status: 'running' | 'completed' | 'failed';
  exitCode: number | null;
}>;

export type AgentActivityEvent =
  | AgentActivityCommand
  | Readonly<{ kind: 'message'; title: 'Agent message'; detail: string }>
  | Readonly<{ kind: 'error'; message: string }>
  | Readonly<{ kind: 'warning'; message: string }>;

export type AgentActivityAttempt = Readonly<{
  attempt: number;
  status: 'running' | 'completed' | 'failed';
  events: readonly AgentActivityEvent[];
}>;

export type AgentActivityFeed = Readonly<{
  attempts: readonly AgentActivityAttempt[];
  raw: string;
}>;

export type AgentActivityTranscriptChunk = Readonly<{
  content: string;
  providerAttempt: number;
  stream: 'stdout' | 'stderr';
  sequence?: number;
}>;

type JsonRecord = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const stringField = (value: JsonRecord, key: string): string | null =>
  typeof value[key] === 'string' ? value[key] : null;

const numberField = (value: JsonRecord, key: string): number | null =>
  typeof value[key] === 'number' && Number.isFinite(value[key]) ? value[key] : null;

const compactWhitespace = (value: string): string => value.replace(/\s+/gu, ' ').trim();

const meaningfulText = (value: string): string | null => {
  const text = compactWhitespace(value);
  return text.length === 0 ? null : text;
};

const displayMessage = (value: string): string | null => {
  const text = meaningfulText(value);
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (isRecord(parsed)) {
      for (const key of ['summary', 'detail', 'message', 'reason', 'status']) {
        const candidate = parsed[key];
        if (typeof candidate === 'string' && candidate.trim().length > 0) {
          return compactWhitespace(candidate);
        }
      }
    }
  } catch {
    return text;
  }
  return text;
};

const jsonInput = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (value === undefined) return '';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return typeof value === 'number' || typeof value === 'boolean' ? String(value) : '';
  }
};

const commandStatus = (
  status: string | null,
  exitCode: number | null,
): AgentActivityCommand['status'] => {
  if (exitCode !== null && exitCode !== 0) return 'failed';
  if (status === 'failed' || status === 'error') return 'failed';
  if (status === 'completed' || status === 'success') return 'completed';
  return 'running';
};

type MutableAttempt = {
  attempt: number;
  status: AgentActivityAttempt['status'];
  events: AgentActivityEvent[];
  commandIndexes: Map<string, number>;
};

const updateCommand = (
  attempt: MutableAttempt,
  item: JsonRecord,
  defaults: { readonly id?: string; readonly command?: string; readonly input?: unknown } = {},
): void => {
  const id =
    stringField(item, 'id') ?? defaults.id ?? `command-${String(attempt.events.length + 1)}`;
  const command =
    stringField(item, 'command') ??
    stringField(item, 'description') ??
    defaults.command ??
    'Command';
  const input = jsonInput(item.input ?? defaults.input ?? item.command);
  const output =
    stringField(item, 'aggregated_output') ??
    stringField(item, 'output') ??
    stringField(item, 'content') ??
    '';
  const exitCode = numberField(item, 'exit_code') ?? numberField(item, 'exitCode');
  const event: AgentActivityCommand = {
    kind: 'command',
    id,
    command,
    input,
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

const updateClaudeToolResult = (attempt: MutableAttempt, value: JsonRecord): void => {
  const toolUseId = stringField(value, 'tool_use_id');
  if (toolUseId === null) return;
  const index = attempt.commandIndexes.get(toolUseId);
  if (index === undefined) return;
  const current = attempt.events[index];
  if (current?.kind !== 'command') return;
  const content = jsonInput(value.content);
  const isError = value.is_error === true;
  attempt.events[index] = {
    ...current,
    output: content,
    status: isError ? 'failed' : 'completed',
    exitCode: isError ? 1 : 0,
  };
};

const processClaudeContent = (attempt: MutableAttempt, content: unknown): void => {
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (!isRecord(block)) continue;
    const type = stringField(block, 'type');
    if (type === 'text') {
      const text = stringField(block, 'text');
      const message = text === null ? null : displayMessage(text);
      if (message !== null)
        attempt.events.push({ kind: 'message', title: 'Agent message', detail: message });
      continue;
    }
    if (type === 'tool_use') {
      const input = block.input;
      const inputRecord = isRecord(input) ? input : {};
      updateCommand(attempt, {
        id: stringField(block, 'id') ?? `claude-command-${String(attempt.events.length + 1)}`,
        command:
          stringField(inputRecord, 'command') ??
          stringField(inputRecord, 'cmd') ??
          stringField(block, 'name') ??
          'Tool call',
        input,
        status: 'running',
      });
    }
  }
};

const processEvent = (attempt: MutableAttempt, value: unknown): void => {
  if (!isRecord(value)) return;
  const type = stringField(value, 'type');
  if (type === 'turn.started' || type === 'message_start') {
    attempt.status = 'running';
    return;
  }
  if (type === 'turn.completed' || type === 'result') {
    attempt.status = value.is_error === true ? 'failed' : 'completed';
    return;
  }
  if (type === 'error' || type === 'turn.failed') {
    attempt.status = 'failed';
    const error = value.error;
    const message = isRecord(error) ? stringField(error, 'message') : stringField(value, 'message');
    if (message !== null)
      attempt.events.push({ kind: 'error', message: compactWhitespace(message) });
    return;
  }
  if (type === 'item.started' || type === 'item.completed') {
    const item = value.item;
    if (!isRecord(item)) return;
    const itemType = stringField(item, 'type');
    if (itemType === 'command_execution') {
      updateCommand(attempt, item);
      return;
    }
    if (itemType === 'agent_message') {
      const text = stringField(item, 'text');
      const message = text === null ? null : displayMessage(text);
      if (message !== null)
        attempt.events.push({ kind: 'message', title: 'Agent message', detail: message });
    }
    return;
  }
  if (type === 'assistant' || type === 'message') {
    const message = value.message;
    if (isRecord(message)) processClaudeContent(attempt, message.content);
    else processClaudeContent(attempt, value.content);
    return;
  }
  if (type === 'user') {
    const message = value.message;
    if (isRecord(message) && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (isRecord(block) && stringField(block, 'type') === 'tool_result') {
          updateClaudeToolResult(attempt, block);
        }
      }
    }
    if (isRecord(value.tool_result)) updateClaudeToolResult(attempt, value.tool_result);
    if (Array.isArray(value.content)) {
      for (const block of value.content) {
        if (isRecord(block) && stringField(block, 'type') === 'tool_result') {
          updateClaudeToolResult(attempt, block);
        }
      }
    }
    return;
  }
  if (type === 'tool_result') updateClaudeToolResult(attempt, value);
};

export const parseAgentActivityFeed = (raw: string, attemptNumber = 1): AgentActivityFeed => {
  const attempt: MutableAttempt = {
    attempt: attemptNumber,
    status: 'running',
    events: [],
    commandIndexes: new Map(),
  };
  for (const line of raw.split(/\r?\n/gu)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      processEvent(attempt, JSON.parse(trimmed) as unknown);
    } catch {
      attempt.events.push({ kind: 'warning', message: compactWhitespace(trimmed) });
    }
  }
  return { attempts: [{ ...attempt, events: [...attempt.events] }], raw };
};

export const parseAgentActivityFeedFromChunks = (
  chunks: readonly AgentActivityTranscriptChunk[],
): AgentActivityFeed => {
  const attempts = new Map<number, { stdout: string; stderr: string }>();
  const ordered = [...chunks].sort((left, right) => (left.sequence ?? 0) - (right.sequence ?? 0));
  for (const chunk of ordered) {
    const current = attempts.get(chunk.providerAttempt) ?? { stdout: '', stderr: '' };
    current[chunk.stream] += chunk.content;
    attempts.set(chunk.providerAttempt, current);
  }
  const parsedAttempts = [...attempts.entries()].map(([attempt, content]) => {
    const parsed = parseAgentActivityFeed(content.stdout, attempt);
    const stderr = meaningfulText(content.stderr);
    if (stderr === null) return parsed.attempts[0];
    const current = parsed.attempts[0];
    if (current === undefined) return undefined;
    return {
      ...current,
      events: [...current.events, { kind: 'warning' as const, message: stderr }],
    };
  });
  return {
    attempts: parsedAttempts.filter(
      (attempt): attempt is AgentActivityAttempt => attempt !== undefined,
    ),
    raw: ordered.map((chunk) => chunk.content).join(''),
  };
};
