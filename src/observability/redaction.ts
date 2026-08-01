import { z } from 'zod';

export type JsonPrimitive = string | number | boolean | null;

export type JsonValue = JsonPrimitive | JsonValue[] | { readonly [key: string]: JsonValue };

export interface SourceRedactionConfig {
  readonly exactKeys?: readonly string[];
  readonly keyPatterns?: readonly RegExp[];
  readonly valuePatterns?: readonly RegExp[];
  readonly replacementText?: string;
}

export const redactionStatusSchema = z.enum(['clean', 'redacted', 'blocked']);

export type RedactionStatus = z.infer<typeof redactionStatusSchema>;

export const redactionReasonSchema = z.enum(['exact_key', 'key_pattern', 'value_pattern']);

export type RedactionReason = z.infer<typeof redactionReasonSchema>;

export const blockedReasonSchema = z.enum([
  'accessor_property',
  'array_hole',
  'circular_reference',
  'non_finite_number',
  'symbol_key',
  'unsupported_type',
]);

export type BlockedReason = z.infer<typeof blockedReasonSchema>;

export const redactionEntrySchema = z
  .object({
    path: z.string().min(1),
    reason: redactionReasonSchema,
  })
  .strict();

export type RedactionEntry = z.infer<typeof redactionEntrySchema>;

export const blockedEntrySchema = z
  .object({
    path: z.string().min(1),
    reason: blockedReasonSchema,
    detail: z.string().min(1),
  })
  .strict();

export type BlockedEntry = z.infer<typeof blockedEntrySchema>;

const cleanRedactionSummarySchema = z
  .object({
    status: z.literal('clean'),
    redactedCount: z.literal(0),
    blockedCount: z.literal(0),
    redactions: z.array(redactionEntrySchema).length(0),
    blocked: z.array(blockedEntrySchema).length(0),
  })
  .strict();

const redactedRedactionSummarySchema = z
  .object({
    status: z.literal('redacted'),
    redactedCount: z.number().int().positive(),
    blockedCount: z.literal(0),
    redactions: z.array(redactionEntrySchema).min(1),
    blocked: z.array(blockedEntrySchema).length(0),
  })
  .strict();

const blockedRedactionSummarySchema = z
  .object({
    status: z.literal('blocked'),
    redactedCount: z.number().int().nonnegative(),
    blockedCount: z.number().int().positive(),
    redactions: z.array(redactionEntrySchema),
    blocked: z.array(blockedEntrySchema).min(1),
  })
  .strict();

export const sourceRedactionSummarySchema = z.discriminatedUnion('status', [
  cleanRedactionSummarySchema,
  redactedRedactionSummarySchema,
  blockedRedactionSummarySchema,
]);

export type SourceRedactionSummary = z.infer<typeof sourceRedactionSummarySchema>;

export type SourceRedactionResult =
  | {
      readonly status: 'clean';
      readonly value: JsonValue;
      readonly summary: Extract<SourceRedactionSummary, { status: 'clean' }>;
    }
  | {
      readonly status: 'redacted';
      readonly value: JsonValue;
      readonly summary: Extract<SourceRedactionSummary, { status: 'redacted' }>;
    }
  | {
      readonly status: 'blocked';
      readonly summary: Extract<SourceRedactionSummary, { status: 'blocked' }>;
    };

const DEFAULT_REPLACEMENT_TEXT = '[REDACTED]';
const IDENTIFIER_KEY_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/u;

interface CompiledSourceRedactionConfig {
  readonly exactKeys: ReadonlySet<string>;
  readonly keyPatterns: readonly RegExp[];
  readonly valuePatterns: readonly RegExp[];
  readonly replacementText: string;
}

type VisitResult =
  | {
      readonly kind: 'ok';
      readonly value: JsonValue;
      readonly redactions: readonly RedactionEntry[];
    }
  | {
      readonly kind: 'blocked';
      readonly redactions: readonly RedactionEntry[];
      readonly blocked: readonly BlockedEntry[];
    };

const compileConfig = (config: SourceRedactionConfig): CompiledSourceRedactionConfig => ({
  exactKeys: new Set(config.exactKeys ?? []),
  keyPatterns: [...(config.keyPatterns ?? [])],
  valuePatterns: [...(config.valuePatterns ?? [])],
  replacementText: config.replacementText ?? DEFAULT_REPLACEMENT_TEXT,
});

const testPattern = (pattern: RegExp, value: string): boolean => {
  pattern.lastIndex = 0;
  return pattern.test(value);
};

const matchKeyReason = (
  key: string,
  config: CompiledSourceRedactionConfig,
): RedactionReason | null => {
  if (config.exactKeys.has(key)) {
    return 'exact_key';
  }

  for (const pattern of config.keyPatterns) {
    if (testPattern(pattern, key)) {
      return 'key_pattern';
    }
  }

  return null;
};

const matchesValuePattern = (value: string, config: CompiledSourceRedactionConfig): boolean => {
  for (const pattern of config.valuePatterns) {
    if (testPattern(pattern, value)) {
      return true;
    }
  }

  return false;
};

const makeBlockedEntry = (
  path: string,
  reason: BlockedReason,
  detail: string,
): Extract<VisitResult, { kind: 'blocked' }> => ({
  kind: 'blocked',
  redactions: [],
  blocked: [{ path, reason, detail }],
});

const describeUnsupportedValue = (value: unknown): string => {
  if (value === undefined) {
    return 'undefined';
  }

  const primitiveType = typeof value;
  if (primitiveType !== 'object') {
    return primitiveType;
  }

  return Object.prototype.toString.call(value);
};

const appendObjectPath = (parentPath: string, key: string): string => {
  if (IDENTIFIER_KEY_PATTERN.test(key)) {
    return `${parentPath}.${key}`;
  }

  return `${parentPath}[${JSON.stringify(key)}]`;
};

const appendArrayPath = (parentPath: string, index: number): string =>
  `${parentPath}[${String(index)}]`;

const mergeVisitResults = (
  accumulator: readonly RedactionEntry[],
  result: VisitResult,
): readonly RedactionEntry[] => [...accumulator, ...result.redactions];

const isPlainObject = (value: object): value is Record<string, unknown> => {
  const prototype = Reflect.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const getDescriptorValue = (descriptor: PropertyDescriptor): unknown =>
  (descriptor as PropertyDescriptor & { value?: unknown }).value;

const validateSecretSubtree = (
  value: unknown,
  path: string,
  config: CompiledSourceRedactionConfig,
  ancestors: WeakSet<object>,
): VisitResult => visitValue(value, path, config, ancestors, true);

const visitArray = (
  value: readonly unknown[],
  path: string,
  config: CompiledSourceRedactionConfig,
  ancestors: WeakSet<object>,
  secretMode: boolean,
): VisitResult => {
  if (ancestors.has(value)) {
    return makeBlockedEntry(path, 'circular_reference', 'Array contains a circular reference');
  }

  ancestors.add(value);

  const redactions: RedactionEntry[] = [];
  const items: JsonValue[] = [];

  for (let index = 0; index < value.length; index += 1) {
    if (!(index in value)) {
      ancestors.delete(value);
      return {
        kind: 'blocked',
        redactions,
        blocked: [
          {
            path: appendArrayPath(path, index),
            reason: 'array_hole',
            detail: 'Sparse arrays are not valid JSON-like values',
          },
        ],
      };
    }

    const childResult = visitValue(
      value[index],
      appendArrayPath(path, index),
      config,
      ancestors,
      secretMode,
    );
    if (childResult.kind === 'blocked') {
      ancestors.delete(value);
      return {
        kind: 'blocked',
        redactions: mergeVisitResults(redactions, childResult),
        blocked: childResult.blocked,
      };
    }

    redactions.push(...childResult.redactions);
    items.push(childResult.value);
  }

  ancestors.delete(value);

  return {
    kind: 'ok',
    value: items,
    redactions,
  };
};

const visitObject = (
  value: Record<string, unknown>,
  path: string,
  config: CompiledSourceRedactionConfig,
  ancestors: WeakSet<object>,
  secretMode: boolean,
): VisitResult => {
  if (ancestors.has(value)) {
    return makeBlockedEntry(path, 'circular_reference', 'Object contains a circular reference');
  }

  if (Object.getOwnPropertySymbols(value).length > 0) {
    return makeBlockedEntry(
      path,
      'symbol_key',
      'Objects with symbol keys are not valid JSON-like values',
    );
  }

  ancestors.add(value);

  const redactions: RedactionEntry[] = [];
  const output: Record<string, JsonValue> = {};

  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (descriptor.get !== undefined || descriptor.set !== undefined) {
      ancestors.delete(value);
      return makeBlockedEntry(
        appendObjectPath(path, key),
        'accessor_property',
        'Accessor properties cannot be inspected without executing code',
      );
    }

    if (descriptor.enumerable !== true) {
      continue;
    }

    const childValue = getDescriptorValue(descriptor);
    const childPath = appendObjectPath(path, key);

    if (!secretMode) {
      const keyReason = matchKeyReason(key, config);
      if (keyReason !== null) {
        const validationResult = validateSecretSubtree(childValue, childPath, config, ancestors);
        if (validationResult.kind === 'blocked') {
          ancestors.delete(value);
          return {
            kind: 'blocked',
            redactions: mergeVisitResults(redactions, validationResult),
            blocked: validationResult.blocked,
          };
        }

        Object.defineProperty(output, key, {
          configurable: true,
          enumerable: true,
          value: config.replacementText,
          writable: true,
        });
        redactions.push({ path: childPath, reason: keyReason });
        continue;
      }
    }

    const childResult = visitValue(childValue, childPath, config, ancestors, secretMode);
    if (childResult.kind === 'blocked') {
      ancestors.delete(value);
      return {
        kind: 'blocked',
        redactions: mergeVisitResults(redactions, childResult),
        blocked: childResult.blocked,
      };
    }

    redactions.push(...childResult.redactions);
    Object.defineProperty(output, key, {
      configurable: true,
      enumerable: true,
      value: childResult.value,
      writable: true,
    });
  }

  ancestors.delete(value);

  return {
    kind: 'ok',
    value: output,
    redactions,
  };
};

const visitValue = (
  value: unknown,
  path: string,
  config: CompiledSourceRedactionConfig,
  ancestors: WeakSet<object>,
  secretMode = false,
): VisitResult => {
  if (value === null) {
    return { kind: 'ok', value: null, redactions: [] };
  }

  switch (typeof value) {
    case 'string':
      if (!secretMode && matchesValuePattern(value, config)) {
        return {
          kind: 'ok',
          value: config.replacementText,
          redactions: [{ path, reason: 'value_pattern' }],
        };
      }

      return { kind: 'ok', value, redactions: [] };

    case 'number':
      if (!Number.isFinite(value)) {
        return makeBlockedEntry(path, 'non_finite_number', 'Numbers must be finite');
      }

      return { kind: 'ok', value, redactions: [] };

    case 'boolean':
      return { kind: 'ok', value, redactions: [] };

    case 'bigint':
    case 'symbol':
    case 'undefined':
    case 'function':
      return makeBlockedEntry(path, 'unsupported_type', describeUnsupportedValue(value));

    case 'object':
      if (Array.isArray(value)) {
        return visitArray(value, path, config, ancestors, secretMode);
      }

      if (!isPlainObject(value)) {
        return makeBlockedEntry(path, 'unsupported_type', describeUnsupportedValue(value));
      }

      return visitObject(value, path, config, ancestors, secretMode);
  }

  return makeBlockedEntry(path, 'unsupported_type', describeUnsupportedValue(value));
};

export const redactSourceValue = (
  value: unknown,
  config: SourceRedactionConfig = {},
): SourceRedactionResult => {
  const visitResult = visitValue(value, '$', compileConfig(config), new WeakSet<object>());

  if (visitResult.kind === 'blocked') {
    const summary = sourceRedactionSummarySchema.parse({
      status: 'blocked',
      redactedCount: visitResult.redactions.length,
      blockedCount: visitResult.blocked.length,
      redactions: visitResult.redactions,
      blocked: visitResult.blocked,
    }) as Extract<SourceRedactionSummary, { status: 'blocked' }>;

    return {
      status: 'blocked',
      summary,
    };
  }

  if (visitResult.redactions.length === 0) {
    const summary = sourceRedactionSummarySchema.parse({
      status: 'clean',
      redactedCount: 0,
      blockedCount: 0,
      redactions: [],
      blocked: [],
    }) as Extract<SourceRedactionSummary, { status: 'clean' }>;

    return {
      status: 'clean',
      value: visitResult.value,
      summary,
    };
  }

  const summary = sourceRedactionSummarySchema.parse({
    status: 'redacted',
    redactedCount: visitResult.redactions.length,
    blockedCount: 0,
    redactions: visitResult.redactions,
    blocked: [],
  }) as Extract<SourceRedactionSummary, { status: 'redacted' }>;

  return {
    status: 'redacted',
    value: visitResult.value,
    summary,
  };
};
