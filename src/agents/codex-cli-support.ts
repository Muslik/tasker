import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, chmod, copyFile, cp, mkdir, writeFile } from 'node:fs/promises';
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

const TurnFailedSchema = z
  .object({
    type: z.literal('turn.failed'),
    error: z
      .object({
        message: z.string().min(1),
      })
      .loose(),
  })
  .loose();

export interface ParsedCodexStream {
  readonly sessionId: string;
  readonly finalMessage: string;
  readonly usage: z.infer<typeof CodexTokenUsageSchema> | null;
  readonly diagnostics: readonly string[];
  readonly skippedCount: number;
}

const MAX_STREAM_DIAGNOSTICS = 20;
const MAX_DIAGNOSTIC_LINE_LENGTH = 200;
const MAX_STREAM_FAILURE_CONTEXT_LENGTH = 2_000;
const MAX_PROVIDER_FAILURE_MESSAGE_LENGTH = 4_000;

const truncateDiagnosticLine = (line: string): string =>
  line.length <= MAX_DIAGNOSTIC_LINE_LENGTH
    ? line
    : `${line.slice(0, MAX_DIAGNOSTIC_LINE_LENGTH)}...`;

const truncateHead = (value: string, length: number): string =>
  value.length <= length ? value : `${value.slice(0, length - 3)}...`;

const truncateTail = (value: string, length: number): string =>
  value.length <= length ? value : `...${value.slice(-(length - 3))}`;

const withStreamDiagnostics = (
  message: string,
  diagnostics: readonly string[],
  skippedCount: number,
): string => {
  if (diagnostics.length === 0) return message;
  const samples = truncateHead(diagnostics.join('\n'), MAX_STREAM_FAILURE_CONTEXT_LENGTH);
  return `${message}\nStream diagnostics (${String(skippedCount)} non-JSON line(s)):\n${samples}`;
};

const eventIssues = (eventType: string, issues: readonly z.core.$ZodIssue[]): string =>
  `Invalid ${eventType} event: ${issues
    .map((issue) => `${issue.path.map(String).join('.') || '<root>'}: ${issue.message}`)
    .join('; ')}`;

export const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

const schemaRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const permitsNull = (value: unknown): boolean => {
  const record = schemaRecord(value);
  if (record === null) return false;
  if (record.type === 'null') return true;
  if (Array.isArray(record.type) && record.type.includes('null')) return true;
  if (Array.isArray(record.enum) && record.enum.includes(null)) return true;
  return Array.isArray(record.anyOf) && record.anyOf.some(permitsNull);
};

const nullableSchema = (value: unknown): unknown =>
  permitsNull(value) ? value : { anyOf: [value, { type: 'null' }] };

const rootObjectUnion = (value: unknown): Record<string, unknown> | null => {
  const record = schemaRecord(value);
  if (record === null) return null;
  const variants = Array.isArray(record.oneOf)
    ? record.oneOf
    : Array.isArray(record.anyOf)
      ? record.anyOf
      : null;
  if (variants === null || variants.length === 0) return null;
  const objects = variants.map(schemaRecord);
  if (
    objects.some(
      (variant) =>
        variant === null || variant.type !== 'object' || schemaRecord(variant.properties) === null,
    )
  ) {
    return null;
  }
  const objectVariants = objects as Record<string, unknown>[];
  const propertyNames = [
    ...new Set(
      objectVariants.flatMap((variant) =>
        Object.keys(schemaRecord(variant.properties) as Record<string, unknown>),
      ),
    ),
  ];
  const properties = Object.fromEntries(
    propertyNames.map((name) => {
      const schemas = objectVariants.flatMap((variant) => {
        const property = (schemaRecord(variant.properties) as Record<string, unknown>)[name];
        return property === undefined ? [] : [property];
      });
      const unique = [
        ...new Map(schemas.map((schema) => [JSON.stringify(schema), schema])).values(),
      ];
      const property =
        name === 'status' &&
        unique.every((schema) => typeof schemaRecord(schema)?.const === 'string')
          ? { type: 'string', enum: unique.map((schema) => schemaRecord(schema)?.const) }
          : unique.length === 1
            ? unique[0]
            : { anyOf: unique };
      const requiredInEveryVariant = objectVariants.every(
        (variant) => Array.isArray(variant.required) && variant.required.includes(name),
      );
      return [name, requiredInEveryVariant ? property : nullableSchema(property)];
    }),
  );
  return {
    ...Object.fromEntries(
      Object.entries(record).filter(([key]) => key !== 'oneOf' && key !== 'anyOf'),
    ),
    type: 'object',
    properties,
    required: propertyNames,
    additionalProperties: false,
  };
};

const makeCodexOutputSchemaCompatible = (value: unknown): void => {
  if (Array.isArray(value)) {
    value.forEach(makeCodexOutputSchemaCompatible);
    return;
  }
  if (typeof value !== 'object' || value === null) return;

  const record = value as Record<string, unknown>;
  // Codex structured outputs reject `propertyNames`. Zod emits it for records even
  // when the key schema is an unconstrained string, so removing it preserves the
  // runtime contract while keeping `additionalProperties` as the value schema.
  delete record.propertyNames;
  // Zod represents discriminated unions with `oneOf`, while the Codex structured
  // output boundary accepts `anyOf`. Our variants have disjoint literal
  // discriminators, so this keeps the same set of valid values.
  if (Array.isArray(record.oneOf)) {
    record.anyOf = record.oneOf;
    delete record.oneOf;
  }
  if (record.not !== undefined) {
    delete record.not;
    record.type = 'null';
  }
  Object.values(record).forEach(makeCodexOutputSchemaCompatible);
  const properties = schemaRecord(record.properties);
  if (properties === null) return;
  const required = new Set(Array.isArray(record.required) ? record.required : []);
  for (const [name, property] of Object.entries(properties)) {
    if (!required.has(name)) properties[name] = nullableSchema(property);
  }
  record.required = Object.keys(properties);
};

export const codexOutputJsonSchema = (schema: z.ZodType): unknown => {
  const generated = z.toJSONSchema(schema);
  const output = rootObjectUnion(generated) ?? generated;
  makeCodexOutputSchemaCompatible(output);
  return output;
};

const unionBranchFor = (value: unknown, schema: Record<string, unknown>): unknown => {
  const variants = Array.isArray(schema.oneOf)
    ? schema.oneOf
    : Array.isArray(schema.anyOf)
      ? schema.anyOf
      : null;
  if (variants === null) return schema;
  if (value === null) return variants.find(permitsNull) ?? schema;
  const valueRecord = schemaRecord(value);
  if (valueRecord === null) return schema;
  return (
    variants.find((variant) => {
      const properties = schemaRecord(schemaRecord(variant)?.properties);
      if (properties === null) return false;
      return Object.entries(properties).every(([name, property]) => {
        const expected = schemaRecord(property)?.const;
        return expected === undefined || valueRecord[name] === expected;
      });
    }) ?? schema
  );
};

const normalizeCodexValue = (value: unknown, schema: unknown): unknown => {
  const record = schemaRecord(unionBranchFor(value, schemaRecord(schema) ?? {}));
  if (record === null) return value;
  if (Array.isArray(value)) {
    return value.map((item) => normalizeCodexValue(item, record.items));
  }
  const valueRecord = schemaRecord(value);
  const properties = schemaRecord(record.properties);
  if (valueRecord === null || properties === null) return value;
  const required = new Set(Array.isArray(record.required) ? record.required : []);
  return Object.fromEntries(
    Object.entries(valueRecord).flatMap(([name, child]) => {
      const property = properties[name];
      if (property === undefined) return child === null ? [] : [[name, child]];
      if (child === null && !required.has(name)) return [];
      return [[name, normalizeCodexValue(child, property)]];
    }),
  );
};

export const normalizeCodexStructuredOutput = (value: unknown, schema: z.ZodType): unknown =>
  normalizeCodexValue(value, z.toJSONSchema(schema));

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
  await writeFile(
    join(targetCodexHome, 'config.toml'),
    [
      '# Generated by Tasker inside an externally isolated Docker execution.',
      'sandbox_mode = "danger-full-access"',
      '',
      '[sandbox_workspace_write]',
      'network_access = true',
      '',
    ].join('\n'),
    { encoding: 'utf8', mode: 0o600 },
  );
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

const nestedProviderFailureMessage = (message: string): string => {
  let current = message;
  for (let depth = 0; depth < 3; depth += 1) {
    try {
      const parsed = JSON.parse(current) as unknown;
      if (typeof parsed !== 'object' || parsed === null) return current;
      if (
        'error' in parsed &&
        typeof parsed.error === 'object' &&
        parsed.error !== null &&
        'message' in parsed.error &&
        typeof parsed.error.message === 'string'
      ) {
        current = parsed.error.message;
        continue;
      }
      if ('message' in parsed && typeof parsed.message === 'string') {
        current = parsed.message;
        continue;
      }
      return current;
    } catch {
      return current;
    }
  }
  return current;
};

export const providerFailureMessage = (stdout: string, stderr = ''): string => {
  const stdoutDiagnostics: string[] = [];
  for (const line of stdout.split(/\r?\n/u).reverse()) {
    try {
      const event = JSON.parse(line) as unknown;
      if (
        typeof event === 'object' &&
        event !== null &&
        'message' in event &&
        typeof event.message === 'string'
      ) {
        return nestedProviderFailureMessage(event.message);
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
        return nestedProviderFailureMessage(event.error.message);
      }
    } catch {
      if (line.trim().length > 0) stdoutDiagnostics.push(line);
    }
  }

  const diagnostic = [stderr.trim(), stdoutDiagnostics.reverse().join('\n').trim()]
    .filter((value) => value.length > 0)
    .join('\n');
  if (diagnostic.length > 0) {
    return truncateTail(diagnostic, MAX_PROVIDER_FAILURE_MESSAGE_LENGTH);
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
  let streamFailure: string | null = null;
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

    const eventType =
      typeof event === 'object' && event !== null && 'type' in event ? event.type : null;
    if (eventType === 'turn.failed') {
      const failed = TurnFailedSchema.safeParse(event);
      streamFailure = failed.success
        ? `Codex turn failed: ${nestedProviderFailureMessage(failed.data.error.message)}`
        : eventIssues('turn.failed', failed.error.issues);
      continue;
    }
    if (eventType === 'turn.completed') {
      const completed = TurnCompletedSchema.safeParse(event);
      if (!completed.success) {
        streamFailure = eventIssues('turn.completed', completed.error.issues);
        continue;
      }
      usage = completed.data.usage;
    }
  }

  if (streamFailure !== null) {
    return err({
      kind: 'invalid_event_stream',
      message: withStreamDiagnostics(streamFailure, diagnostics, skippedCount),
    });
  }

  if (finalMessage === null) {
    return err({
      kind: 'invalid_event_stream',
      message: withStreamDiagnostics(
        'Codex stream did not contain an agent message',
        diagnostics,
        skippedCount,
      ),
    });
  }

  return ok({
    sessionId: sessionId ?? sha256(stdout),
    finalMessage,
    usage,
    diagnostics,
    skippedCount,
  });
};
