import { Fragment } from 'react';

import { cn } from '../lib/utils.js';

type JsonTokenKind = 'text' | 'key' | 'string' | 'number' | 'boolean' | 'null' | 'punctuation';

type JsonToken = Readonly<{
  kind: JsonTokenKind;
  value: string;
}>;

const JSON_TOKEN_PATTERN =
  /"(?:\\.|[^"\\])*"(?=\s*:)|"(?:\\.|[^"\\])*"|true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|[{},:]|\\[|\\]/gu;

export const formatJsonBlock = (value: unknown): string => {
  const formatted = JSON.stringify(value, null, 2);
  return typeof formatted === 'string' ? formatted : String(value);
};

export const tokenizeJsonBlock = (source: string): readonly JsonToken[] => {
  const tokens: JsonToken[] = [];
  let cursor = 0;

  for (const match of source.matchAll(JSON_TOKEN_PATTERN)) {
    const value = match[0];
    const start = match.index;
    if (start > cursor) {
      tokens.push({ kind: 'text', value: source.slice(cursor, start) });
    }

    const kind: JsonTokenKind =
      value === 'true' || value === 'false'
        ? 'boolean'
        : value === 'null'
          ? 'null'
          : /^"/u.test(value)
            ? source
                .slice(start + value.length)
                .trimStart()
                .startsWith(':')
              ? 'key'
              : 'string'
            : value.length === 1 && '{},:[]'.includes(value)
              ? 'punctuation'
              : 'number';
    tokens.push({ kind, value });
    cursor = start + value.length;
  }

  if (cursor < source.length) tokens.push({ kind: 'text', value: source.slice(cursor) });
  return tokens;
};

const tokenClassName: Record<Exclude<JsonTokenKind, 'text'>, string> = {
  key: 'tasker-json-key',
  string: 'tasker-json-string',
  number: 'tasker-json-number',
  boolean: 'tasker-json-boolean',
  null: 'tasker-json-null',
  punctuation: 'tasker-json-punctuation',
};

export type JsonCodeBlockProps = {
  readonly value: unknown;
  readonly className?: string;
};

export function JsonCodeBlock({ value, className }: JsonCodeBlockProps) {
  const source = formatJsonBlock(value);
  const tokens = tokenizeJsonBlock(source);

  return (
    <pre className={cn('tasker-code-block tasker-json-block', className)}>
      {tokens.map((token, index) => (
        <Fragment key={`${token.kind}:${String(index)}`}>
          {token.kind === 'text' ? (
            token.value
          ) : (
            <span className={tokenClassName[token.kind]}>{token.value}</span>
          )}
        </Fragment>
      ))}
    </pre>
  );
}
