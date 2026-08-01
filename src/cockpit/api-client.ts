import {
  ApiErrorResponseSchema,
  FixtureListResponseSchema,
  WorkflowResponseSchema,
} from '../control-plane/m1-contracts.js';
import type { FixtureSummary, WorkflowResponse } from '../control-plane/m1-contracts.js';

type WorkflowLookup =
  | { readonly status: 'found'; readonly response: WorkflowResponse }
  | { readonly status: 'missing' };

type JsonResponse = {
  readonly body: unknown;
  readonly response: Response;
};

const readJsonResponse = async (response: Response): Promise<JsonResponse> => {
  const text = await response.text();

  if (text.length === 0) {
    return { body: null, response };
  }

  try {
    return { body: JSON.parse(text) as unknown, response };
  } catch {
    throw new Error(`Server returned invalid JSON (HTTP ${String(response.status)})`);
  }
};

const failureFrom = ({ body, response }: JsonResponse): Error => {
  const parsed = ApiErrorResponseSchema.safeParse(body);

  if (parsed.success) {
    return new Error(`${parsed.data.message} (${parsed.data.error})`);
  }

  return new Error(`Request failed with HTTP ${String(response.status)}`);
};

const fetchJson = async (input: string, init?: RequestInit): Promise<JsonResponse> => {
  try {
    const headers = new Headers(init?.headers);
    headers.set('accept', 'application/json');

    return await readJsonResponse(
      await fetch(input, {
        ...init,
        headers,
      }),
    );
  } catch (error) {
    if (error instanceof Error) {
      throw error;
    }

    throw new Error('The server could not be reached', { cause: error });
  }
};

export const listFixtures = async (): Promise<readonly FixtureSummary[]> => {
  const result = await fetchJson('/api/fixtures');

  if (!result.response.ok) {
    throw failureFrom(result);
  }

  const parsed = FixtureListResponseSchema.safeParse(result.body);
  if (!parsed.success) {
    throw new Error('Fixture response does not match the cockpit contract');
  }

  return parsed.data.fixtures;
};

export const loadWorkflow = async (fixtureId: string): Promise<WorkflowLookup> => {
  const result = await fetchJson(`/api/workflows/${encodeURIComponent(fixtureId)}`);

  if (result.response.status === 404) {
    return { status: 'missing' };
  }

  if (!result.response.ok) {
    throw failureFrom(result);
  }

  const parsed = WorkflowResponseSchema.safeParse(result.body);
  if (!parsed.success) {
    throw new Error('Workflow response does not match the cockpit contract');
  }

  return { status: 'found', response: parsed.data };
};

export const generateWorkflow = async (fixtureId: string): Promise<WorkflowResponse> => {
  const result = await fetchJson(`/api/workflows/${encodeURIComponent(fixtureId)}/generate`, {
    method: 'POST',
  });

  if (!result.response.ok) {
    throw failureFrom(result);
  }

  const parsed = WorkflowResponseSchema.safeParse(result.body);
  if (!parsed.success) {
    throw new Error('Generated workflow does not match the cockpit contract');
  }

  return parsed.data;
};

export const graphDownloadUrl = (fixtureId: string): string =>
  `/api/workflows/${encodeURIComponent(fixtureId)}/graph.json`;
