import type { z } from 'zod';

import { ApiErrorResponseSchema } from '../../server/operator-contracts.js';

type ApiErrorResponse = z.infer<typeof ApiErrorResponseSchema>;

export class ApiError extends Error {
  public override readonly name = 'ApiError';

  public constructor(
    public readonly status: number,
    public readonly code: ApiErrorResponse['error'] | null,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

const readJsonBody = async (response: Response): Promise<unknown> => {
  const text = await response.text();
  if (text.length === 0) return null;

  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    throw new Error(`Server returned invalid JSON (HTTP ${String(response.status)})`, { cause });
  }
};

const toApiError = (response: Response, body: unknown): ApiError => {
  const parsed = ApiErrorResponseSchema.safeParse(body);
  return parsed.success
    ? new ApiError(response.status, parsed.data.error, parsed.data.message)
    : new ApiError(response.status, null, `Request failed with HTTP ${String(response.status)}`);
};

const requestJson = async (
  path: string,
  init?: RequestInit,
): Promise<{ body: unknown; response: Response }> => {
  const headers = new Headers(init?.headers);
  headers.set('accept', 'application/json');

  let response: Response;
  try {
    response = await fetch(path, { ...init, headers });
  } catch (cause) {
    throw new Error('The server could not be reached', { cause });
  }

  return {
    body: await readJsonBody(response),
    response,
  };
};

export const getJson = async <TSchema extends z.ZodType>(
  path: string,
  schema: TSchema,
): Promise<z.output<TSchema>> => {
  const { body, response } = await requestJson(path);
  if (!response.ok) throw toApiError(response, body);
  return schema.parse(body);
};

export const getOptionalJson = async <TSchema extends z.ZodType>(
  path: string,
  schema: TSchema,
  missingStatuses: readonly number[] = [404],
): Promise<z.output<TSchema> | null> => {
  const { body, response } = await requestJson(path);
  if (missingStatuses.includes(response.status)) return null;
  if (!response.ok) throw toApiError(response, body);
  return schema.parse(body);
};

export const postJson = async <TRequestSchema extends z.ZodType, TResponseSchema extends z.ZodType>(
  path: string,
  requestSchema: TRequestSchema,
  responseSchema: TResponseSchema,
  input: z.input<TRequestSchema>,
): Promise<z.output<TResponseSchema>> => {
  const { body, response } = await requestJson(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(requestSchema.parse(input)),
  });

  if (!response.ok) throw toApiError(response, body);
  return responseSchema.parse(body);
};
