import {
  ApiErrorResponseSchema,
  OperatorActivityResponseSchema,
  OperatorStreamEventSchema,
  OperatorTaskListResponseSchema,
  FixtureListResponseSchema,
  WorkflowResponseSchema,
} from '../control-plane/m1-contracts.js';
import type {
  OperatorActivityResponse,
  OperatorStreamEvent,
  OperatorTaskListResponse,
  FixtureSummary,
  WorkflowResponse,
} from '../control-plane/m1-contracts.js';
import { JiraIssueStateSchema, type JiraIssueState } from '../integrations/jira/contracts.js';
import {
  RepositoryCatalogResponseSchema,
  type RepositoryCatalogEntry,
} from '../repositories/contracts.js';

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

export const listOperatorTasks = async (): Promise<OperatorTaskListResponse> => {
  const result = await fetchJson('/api/operator/tasks');

  if (!result.response.ok) {
    throw failureFrom(result);
  }

  const parsed = OperatorTaskListResponseSchema.safeParse(result.body);
  if (!parsed.success) {
    throw new Error('Operator task response does not match the cockpit contract');
  }

  return parsed.data;
};

export const listRepositories = async (): Promise<readonly RepositoryCatalogEntry[]> => {
  const result = await fetchJson('/api/repositories');
  if (!result.response.ok) throw failureFrom(result);
  const parsed = RepositoryCatalogResponseSchema.safeParse(result.body);
  if (!parsed.success) throw new Error('Repository catalog does not match the cockpit contract');
  return parsed.data.repositories;
};

export const loadOperatorActivity = async (
  fixtureId: string,
): Promise<OperatorActivityResponse> => {
  const result = await fetchJson(`/api/operator/tasks/${encodeURIComponent(fixtureId)}/activity`);

  if (!result.response.ok) {
    throw failureFrom(result);
  }

  const parsed = OperatorActivityResponseSchema.safeParse(result.body);
  if (!parsed.success) {
    throw new Error('Operator activity response does not match the cockpit contract');
  }

  return parsed.data;
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

export const loadJiraIssue = async (issueKey: string): Promise<JiraIssueState> => {
  const result = await fetchJson(`/api/jira/issues/${encodeURIComponent(issueKey)}`);
  if (!result.response.ok) throw failureFrom(result);
  const parsed = JiraIssueStateSchema.safeParse(result.body);
  if (!parsed.success) throw new Error('Jira issue response does not match the cockpit contract');
  return parsed.data;
};

export const syncJiraIssue = async (
  issueKey: string,
  repository?: string,
): Promise<JiraIssueState> => {
  const result = await fetchJson(`/api/jira/issues/${encodeURIComponent(issueKey)}/sync`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(repository === undefined ? {} : { repository }),
  });
  if (!result.response.ok) throw failureFrom(result);
  const parsed = JiraIssueStateSchema.safeParse(result.body);
  if (!parsed.success) throw new Error('Jira sync response does not match the cockpit contract');
  return parsed.data;
};

export const jiraAttachmentUrl = (issueKey: string, attachmentId: string): string =>
  `/api/jira/issues/${encodeURIComponent(issueKey)}/attachments/${encodeURIComponent(attachmentId)}`;

export const connectOperatorStream = (
  after: number,
  handlers: {
    readonly onEvent: (event: OperatorStreamEvent) => void;
    readonly onOpen: () => void;
    readonly onError: (message: string) => void;
  },
): EventSource => {
  const source = new EventSource(`/api/events?after=${encodeURIComponent(String(after))}`);

  source.addEventListener('ledger', (rawEvent) => {
    if (!(rawEvent instanceof MessageEvent)) {
      handlers.onError('The operator event stream emitted an unexpected payload');
      return;
    }

    try {
      const payload: unknown = JSON.parse(String(rawEvent.data));
      const parsedEvent = OperatorStreamEventSchema.safeParse(payload);
      if (!parsedEvent.success) {
        handlers.onError('The operator event stream payload did not match the contract');
        return;
      }

      handlers.onEvent(parsedEvent.data);
    } catch {
      handlers.onError('The operator event stream payload was not valid JSON');
    }
  });

  source.onopen = () => {
    handlers.onOpen();
  };

  source.onerror = () => {
    handlers.onError('The operator event stream is reconnecting');
  };

  return source;
};
