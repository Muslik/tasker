import { useMemo } from 'react';

import { ApiError } from '../api/http.js';

export type ActionErrorCopy = {
  readonly title?: string;
  readonly message: string;
};

export type ActionErrorMap = Readonly<Record<string, string | ActionErrorCopy>>;

export type ResolvedActionError = {
  readonly title: string;
  readonly message: string;
  readonly serverMessage: string | null;
  readonly code: string | null;
  readonly status: number | null;
};

export type ActionErrorOptions = {
  readonly known?: ActionErrorMap;
  readonly fallback?: ActionErrorCopy;
};

export const DEFAULT_ACTION_ERROR_COPY = {
  title: 'Action failed',
  message: 'Try again. If the problem persists, reload the task and retry.',
} as const satisfies ActionErrorCopy;

export const DEFAULT_ACTION_ERROR_MAP: ActionErrorMap = {
  run_not_found:
    'Прогон этой задачи уже завершён или терминирован — состояние на экране устарело. Обновите задачу.',
  run_not_active:
    'Прогон этой задачи уже завершён или терминирован — состояние на экране устарело. Обновите задачу.',
  'closed-run':
    'Прогон этой задачи уже завершён или терминирован — состояние на экране устарело. Обновите задачу.',
  closed_run:
    'Прогон этой задачи уже завершён или терминирован — состояние на экране устарело. Обновите задачу.',
  stale_plan_review: 'План изменился — обновите и посмотрите текущую попытку',
};

const normalizeCopy = (copy: string | ActionErrorCopy): ActionErrorCopy =>
  typeof copy === 'string' ? { message: copy } : copy;

const resolveMessage = (message: string | undefined, fallback: ActionErrorCopy): string => {
  if (message === undefined) return fallback.message;
  const trimmed = message.trim();
  return trimmed.length === 0 ? fallback.message : trimmed;
};

export const resolveActionError = (
  error: unknown,
  options: ActionErrorOptions = {},
): ResolvedActionError | null => {
  if (error === null || error === undefined) return null;

  const fallback = options.fallback ?? DEFAULT_ACTION_ERROR_COPY;
  const known = options.known ?? DEFAULT_ACTION_ERROR_MAP;
  const title = fallback.title ?? DEFAULT_ACTION_ERROR_COPY.title;

  if (error instanceof ApiError) {
    const mapped = error.code === null ? undefined : known[error.code];
    if (mapped !== undefined) {
      const copy = normalizeCopy(mapped);
      return {
        title: copy.title ?? title,
        message: resolveMessage(copy.message, fallback),
        serverMessage: error.message,
        code: error.code,
        status: error.status,
      };
    }

    const serverMessage = resolveMessage(error.message, fallback);
    return {
      title,
      message:
        error.code === null || error.code.startsWith('invalid_')
          ? serverMessage
          : `${error.code}: ${serverMessage}`,
      serverMessage,
      code: error.code,
      status: error.status,
    };
  }

  if (error instanceof Error) {
    return {
      title,
      message: resolveMessage(error.message, fallback),
      serverMessage: null,
      code: null,
      status: null,
    };
  }

  if (typeof error === 'string') {
    return {
      title,
      message: resolveMessage(error, fallback),
      serverMessage: null,
      code: null,
      status: null,
    };
  }

  return {
    title,
    message: fallback.message,
    serverMessage: null,
    code: null,
    status: null,
  };
};

export const useActionError = (
  error: unknown,
  options: ActionErrorOptions = {},
): ResolvedActionError | null => {
  const known = options.known === undefined ? DEFAULT_ACTION_ERROR_MAP : options.known;
  const { fallback } = options;
  const resolvedOptions: ActionErrorOptions = {
    known,
    ...(fallback === undefined ? {} : { fallback }),
  };
  return useMemo(() => resolveActionError(error, resolvedOptions), [error, resolvedOptions]);
};
