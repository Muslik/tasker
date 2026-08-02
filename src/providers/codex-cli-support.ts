import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, chmod, copyFile, cp, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { z } from 'zod';

import { err, ok, type Outcome } from '../shared/outcome.js';

export const CodexTokenUsageSchema = z
  .object({
    input_tokens: z.number().int().nonnegative(),
    cached_input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
    reasoning_output_tokens: z.number().int().nonnegative().optional(),
  })
  .loose();

const ThreadStartedSchema = z
  .object({
    type: z.literal('thread.started'),
    thread_id: z.string().min(1),
  })
  .loose();

const AgentMessageCompletedSchema = z
  .object({
    type: z.literal('item.completed'),
    item: z
      .object({
        type: z.literal('agent_message'),
        text: z.string().min(1),
      })
      .loose(),
  })
  .loose();

const TurnCompletedSchema = z
  .object({
    type: z.literal('turn.completed'),
    usage: CodexTokenUsageSchema,
  })
  .loose();

export interface ParsedCodexStream {
  readonly sessionId: string;
  readonly finalMessage: string;
  readonly usage: z.infer<typeof CodexTokenUsageSchema>;
}

export const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

const sourceCodexHome = (): string => process.env.CODEX_HOME ?? join(homedir(), '.codex');

const copyIfReadable = async (source: string, target: string): Promise<void> => {
  try {
    await access(source, constants.R_OK);
  } catch {
    return;
  }
  await mkdir(dirname(target), { recursive: true });
  await cp(source, target, { recursive: true });
};

export const prepareIsolatedCodexHome = async (
  targetCodexHome: string,
  options: { readonly includePlanningSurfaces?: boolean } = {},
): Promise<void> => {
  const sourceHome = sourceCodexHome();
  await mkdir(targetCodexHome, { recursive: true });
  const sourceAuth = join(sourceHome, 'auth.json');
  try {
    await access(sourceAuth, constants.R_OK);
    const targetAuth = join(targetCodexHome, 'auth.json');
    await copyFile(sourceAuth, targetAuth);
    await chmod(targetAuth, 0o600);
  } catch {
    // The provider probe reports an actionable authentication failure later.
  }

  if (options.includePlanningSurfaces !== true) return;
  await Promise.all([
    copyIfReadable(join(sourceHome, 'skills', 'plan'), join(targetCodexHome, 'skills', 'plan')),
    copyIfReadable(
      join(sourceHome, 'skills', 'ralplan'),
      join(targetCodexHome, 'skills', 'ralplan'),
    ),
    copyIfReadable(join(sourceHome, 'agents'), join(targetCodexHome, 'agents')),
    copyIfReadable(join(sourceHome, 'prompts'), join(targetCodexHome, 'prompts')),
    copyIfReadable(join(sourceHome, 'AGENTS.md'), join(targetCodexHome, 'AGENTS.md')),
  ]);
};

export const providerFailureMessage = (stdout: string): string => {
  for (const line of stdout.split(/\r?\n/u).reverse()) {
    try {
      const event = JSON.parse(line) as unknown;
      if (
        typeof event === 'object' &&
        event !== null &&
        'message' in event &&
        typeof event.message === 'string'
      ) {
        return event.message;
      }
      if (
        typeof event === 'object' &&
        event !== null &&
        'error' in event &&
        typeof event.error === 'object' &&
        event.error !== null &&
        'message' in event.error &&
        typeof event.error.message === 'string'
      ) {
        return event.error.message;
      }
    } catch {
      // A failed provider may mix non-JSON diagnostics into stdout; continue backwards.
    }
  }

  return 'Codex CLI exited without a structured provider error';
};

export const parseCodexStream = (
  stdout: string,
): Outcome<
  ParsedCodexStream,
  { readonly kind: 'invalid_event_stream'; readonly message: string }
> => {
  let sessionId: string | null = null;
  let finalMessage: string | null = null;
  let usage: z.infer<typeof CodexTokenUsageSchema> | null = null;

  for (const line of stdout.split(/\r?\n/u).filter((entry) => entry.trim().length > 0)) {
    let event: unknown;
    try {
      event = JSON.parse(line) as unknown;
    } catch {
      return err({ kind: 'invalid_event_stream', message: 'Codex emitted non-JSON stdout' });
    }

    const thread = ThreadStartedSchema.safeParse(event);
    if (thread.success) {
      sessionId = thread.data.thread_id;
      continue;
    }

    const message = AgentMessageCompletedSchema.safeParse(event);
    if (message.success) {
      finalMessage = message.data.item.text;
      continue;
    }

    const completed = TurnCompletedSchema.safeParse(event);
    if (completed.success) usage = completed.data.usage;
  }

  if (sessionId === null || finalMessage === null || usage === null) {
    return err({
      kind: 'invalid_event_stream',
      message: 'Codex stream did not contain thread, final message, and usage evidence',
    });
  }

  return ok({ sessionId, finalMessage, usage });
};
