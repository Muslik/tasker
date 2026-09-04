import { describe, expect, it } from 'vitest';

import { ApiError } from '../api/http.js';
import {
  DEFAULT_ACTION_ERROR_COPY,
  resolveActionError,
  type ActionErrorMap,
} from './actionError.js';

describe('resolveActionError', () => {
  it('returns null when no error is present', () => {
    expect(resolveActionError(null)).toBeNull();
    expect(resolveActionError(undefined)).toBeNull();
  });

  it('maps known API error codes to caller-provided copy', () => {
    const known = {
      stale_run: {
        title: 'Task changed',
        message: 'Reload the task before trying this action again.',
      },
    } satisfies ActionErrorMap;

    expect(resolveActionError(new ApiError(409, 'stale_run', 'Refresh first'), { known })).toEqual({
      title: 'Task changed',
      message: 'Reload the task before trying this action again.',
      serverMessage: 'Refresh first',
      code: 'stale_run',
      status: 409,
    });
  });

  it('maps a closed run to actionable Russian copy by default', () => {
    expect(resolveActionError(new ApiError(409, 'run_not_active', 'Workflow is closed'))).toEqual({
      title: DEFAULT_ACTION_ERROR_COPY.title,
      message:
        'Прогон этой задачи уже завершён или терминирован — состояние на экране устарело. Обновите задачу.',
      serverMessage: 'Workflow is closed',
      code: 'run_not_active',
      status: 409,
    });
  });

  it('falls back to the server message when the API code is unknown', () => {
    expect(
      resolveActionError(new ApiError(400, 'invalid_request', 'taskReference is required')),
    ).toEqual({
      title: DEFAULT_ACTION_ERROR_COPY.title,
      message: 'taskReference is required',
      serverMessage: 'taskReference is required',
      code: 'invalid_request',
      status: 400,
    });
  });

  it('preserves a string thrown by an action', () => {
    expect(resolveActionError('boom')).toEqual({
      title: DEFAULT_ACTION_ERROR_COPY.title,
      message: 'boom',
      serverMessage: null,
      code: null,
      status: null,
    });
  });
});
