import {
  ApiErrorResponseSchema,
  CodeReviewSyncResponseSchema,
  ExpectedRunCommandSchema,
  PlanningClarificationSubmissionSchema,
  RestartRunCommandSchema,
  RunStartCommandSchema,
  ResumeRunCommandSchema,
  WorkflowChangeReviewCommandSchema,
  ExecutionRunViewSchema,
  OperatorActivityResponseSchema,
  OperatorExecutionAttemptSchema,
  OperatorRunLogResponseSchema,
  OperatorWorkflowProjectionSchema,
  OperatorStreamEventSchema,
  OperatorTaskListResponseSchema,
  WorkflowResponseSchema,
} from '../control-plane/operator-contracts.js';
import type {
  RunStartCommand,
  RestartRunCommand,
  ResumeRunCommand,
  WorkflowChangeReviewCommand,
  OperatorActivityResponse,
  OperatorExecutionAttempt,
  OperatorRunLogResponse,
  OperatorStreamEvent,
  OperatorTaskListResponse,
  OperatorWorkflowProjection,
  WorkflowResponse,
  ExecutionRunView,
  CodeReviewSyncResponse,
  ExpectedRunCommand,
  PlanningClarificationSubmission,
} from '../control-plane/operator-contracts.js';
import {
  PlanReviewCommandSchema,
  PlanReviewHistoryResponseSchema,
  type PlanReviewCommand,
  type PlanReviewRound,
} from '../control-plane/plan-review.js';
import {
  ImplementationPlanningRecordSchema,
  type ImplementationPlanningRecord,
} from '../control-plane/implementation-planning-contracts.js';
import {
  PlanningTranscriptViewSchema,
  type PlanningTranscriptView,
} from '../control-plane/planning-transcript.js';
import { JiraIssueStateSchema, type JiraIssueState } from '../integrations/jira/contracts.js';
import {
  RepositoryCatalogResponseSchema,
  type RepositoryCatalogEntry,
} from '../repositories/contracts.js';
import { RetrospectiveResponseSchema, type RetrospectiveResponse } from '../retrospective/index.js';

type WorkflowLookup =
  | { readonly status: 'found'; readonly response: WorkflowResponse }
  | { readonly status: 'missing' };

type ImplementationPlanLookup =
  | { readonly status: 'found'; readonly record: ImplementationPlanningRecord }
  | { readonly status: 'missing' };

type PlanningTranscriptLookup =
  | { readonly status: 'found'; readonly transcript: PlanningTranscriptView }
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
  taskReference: string,
): Promise<OperatorActivityResponse> => {
  const result = await fetchJson(
    `/api/operator/tasks/${encodeURIComponent(taskReference)}/activity`,
  );

  if (!result.response.ok) {
    throw failureFrom(result);
  }

  const parsed = OperatorActivityResponseSchema.safeParse(result.body);
  if (!parsed.success) {
    throw new Error('Operator activity response does not match the cockpit contract');
  }

  return parsed.data;
};

export const loadOperatorWorkflowProjection = async (
  taskReference: string,
): Promise<OperatorWorkflowProjection> => {
  const result = await fetchJson(
    `/api/operator/tasks/${encodeURIComponent(taskReference)}/projection`,
  );

  if (!result.response.ok) throw failureFrom(result);
  const parsed = OperatorWorkflowProjectionSchema.safeParse(result.body);
  if (!parsed.success) {
    throw new Error('Operator workflow projection does not match the cockpit contract');
  }
  return parsed.data;
};

export const loadOperatorExecutionAttempt = async (
  taskReference: string,
  nodeId: string,
  blockRun: number,
): Promise<OperatorExecutionAttempt> => {
  const result = await fetchJson(
    `/api/operator/tasks/${encodeURIComponent(taskReference)}/execution-attempts/${encodeURIComponent(nodeId)}/${encodeURIComponent(String(blockRun))}`,
  );
  if (!result.response.ok) throw failureFrom(result);
  const parsed = OperatorExecutionAttemptSchema.safeParse(result.body);
  if (!parsed.success) {
    throw new Error('Operator execution attempt does not match the cockpit contract');
  }
  return parsed.data;
};

export const loadOperatorRunLog = async (
  taskReference: string,
): Promise<OperatorRunLogResponse | null> => {
  const result = await fetchJson(
    `/api/operator/tasks/${encodeURIComponent(taskReference)}/run-log`,
  );
  if (result.response.status === 404) return null;
  if (!result.response.ok) throw failureFrom(result);
  const parsed = OperatorRunLogResponseSchema.safeParse(result.body);
  if (!parsed.success) throw new Error('Operator run log does not match the cockpit contract');
  return parsed.data;
};

export const loadRetrospective = async (taskReference: string): Promise<RetrospectiveResponse> => {
  const result = await fetchJson(
    `/api/operator/tasks/${encodeURIComponent(taskReference)}/retrospective`,
  );
  if (!result.response.ok) throw failureFrom(result);
  const parsed = RetrospectiveResponseSchema.safeParse(result.body);
  if (!parsed.success)
    throw new Error('Retrospective response does not match the cockpit contract');
  return parsed.data;
};

export const loadWorkflow = async (taskReference: string): Promise<WorkflowLookup> => {
  const result = await fetchJson(`/api/workflows/${encodeURIComponent(taskReference)}`);

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

export const loadImplementationPlan = async (
  taskReference: string,
): Promise<ImplementationPlanLookup> => {
  const result = await fetchJson(
    `/api/workflows/${encodeURIComponent(taskReference)}/implementation-plan`,
  );
  if (result.response.status === 404) return { status: 'missing' };
  if (!result.response.ok) throw failureFrom(result);
  const parsed = ImplementationPlanningRecordSchema.safeParse(result.body);
  if (!parsed.success) throw new Error('Implementation plan does not match the cockpit contract');
  return { status: 'found', record: parsed.data };
};

export const loadPlanningTranscript = async (
  taskReference: string,
): Promise<PlanningTranscriptLookup> => {
  const result = await fetchJson(
    `/api/workflows/${encodeURIComponent(taskReference)}/planning-transcript`,
  );
  if (result.response.status === 404) return { status: 'missing' };
  if (!result.response.ok) throw failureFrom(result);
  const parsed = PlanningTranscriptViewSchema.safeParse(result.body);
  if (!parsed.success) throw new Error('Planning transcript does not match the cockpit contract');
  return { status: 'found', transcript: parsed.data };
};

export const generateWorkflow = async (
  taskReference: string,
  commandInput: RunStartCommand,
): Promise<ExecutionRunView> => {
  const command = RunStartCommandSchema.parse(commandInput);
  const result = await fetchJson(`/api/workflows/${encodeURIComponent(taskReference)}/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(command),
  });

  if (!result.response.ok) {
    throw failureFrom(result);
  }

  const parsed = ExecutionRunViewSchema.safeParse(result.body);
  if (!parsed.success) {
    throw new Error('Bootstrap run does not match the cockpit contract');
  }

  return parsed.data;
};

export const loadExecutionRun = async (taskReference: string): Promise<ExecutionRunView> => {
  const result = await fetchJson(`/api/workflows/${encodeURIComponent(taskReference)}/run`);
  if (!result.response.ok) throw failureFrom(result);
  const parsed = ExecutionRunViewSchema.safeParse(result.body);
  if (!parsed.success) throw new Error('Execution run does not match the cockpit contract');
  return parsed.data;
};

export const resumeWorkflow = async (
  taskReference: string,
  commandInput: ResumeRunCommand,
): Promise<ExecutionRunView> => {
  const command = ResumeRunCommandSchema.parse(commandInput);
  const result = await fetchJson(`/api/workflows/${encodeURIComponent(taskReference)}/resume`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(command),
  });
  if (!result.response.ok) throw failureFrom(result);
  const parsed = ExecutionRunViewSchema.safeParse(result.body);
  if (!parsed.success) throw new Error('Resume response does not match the cockpit contract');
  return parsed.data;
};

export const reviewWorkflowChange = async (
  taskReference: string,
  commandInput: WorkflowChangeReviewCommand,
): Promise<ExecutionRunView> => {
  const command = WorkflowChangeReviewCommandSchema.parse(commandInput);
  const result = await fetchJson(
    `/api/workflows/${encodeURIComponent(taskReference)}/workflow-change-review`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(command),
    },
  );
  if (!result.response.ok) throw failureFrom(result);
  const parsed = ExecutionRunViewSchema.safeParse(result.body);
  if (!parsed.success) throw new Error('Workflow change review response is invalid');
  return parsed.data;
};

export const restartWorkflow = async (
  taskReference: string,
  commandInput: RestartRunCommand,
): Promise<ExecutionRunView> => {
  const command = RestartRunCommandSchema.parse(commandInput);
  const result = await fetchJson(`/api/workflows/${encodeURIComponent(taskReference)}/restart`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(command),
  });
  if (!result.response.ok) throw failureFrom(result);
  const parsed = ExecutionRunViewSchema.safeParse(result.body);
  if (!parsed.success) throw new Error('Restart response does not match the cockpit contract');
  return parsed.data;
};

export const syncCodeReview = async (
  taskReference: string,
  commandInput: ExpectedRunCommand,
): Promise<CodeReviewSyncResponse> => {
  const command = ExpectedRunCommandSchema.parse(commandInput);
  const result = await fetchJson(
    `/api/workflows/${encodeURIComponent(taskReference)}/code-review/sync`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(command),
    },
  );
  if (!result.response.ok) throw failureFrom(result);
  const parsed = CodeReviewSyncResponseSchema.safeParse(result.body);
  if (!parsed.success) throw new Error('Code review sync does not match the cockpit contract');
  return parsed.data;
};

export const completeCodeReview = async (
  taskReference: string,
  commandInput: ExpectedRunCommand,
): Promise<CodeReviewSyncResponse> => {
  const command = ExpectedRunCommandSchema.parse(commandInput);
  const result = await fetchJson(
    `/api/workflows/${encodeURIComponent(taskReference)}/code-review/complete`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(command),
    },
  );
  if (!result.response.ok) throw failureFrom(result);
  const parsed = CodeReviewSyncResponseSchema.safeParse(result.body);
  if (!parsed.success)
    throw new Error('Code review completion does not match the cockpit contract');
  return parsed.data;
};

export const reviewPlan = async (
  taskReference: string,
  commandInput: PlanReviewCommand,
): Promise<ExecutionRunView> => {
  const command = PlanReviewCommandSchema.parse(commandInput);
  const result = await fetchJson(
    `/api/workflows/${encodeURIComponent(taskReference)}/plan-review`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(command),
    },
  );
  if (!result.response.ok) throw failureFrom(result);
  const parsed = ExecutionRunViewSchema.safeParse(result.body);
  if (!parsed.success) throw new Error('Plan review response does not match the cockpit contract');
  return parsed.data;
};

export const loadPlanReviewHistory = async (
  taskReference: string,
): Promise<readonly PlanReviewRound[]> => {
  const result = await fetchJson(
    `/api/workflows/${encodeURIComponent(taskReference)}/plan-reviews`,
  );
  if (!result.response.ok) throw failureFrom(result);
  return PlanReviewHistoryResponseSchema.parse(result.body).rounds;
};

export const answerPlanningClarification = async (
  taskReference: string,
  commandInput: PlanningClarificationSubmission,
): Promise<ExecutionRunView> => {
  const command = PlanningClarificationSubmissionSchema.parse(commandInput);
  const result = await fetchJson(
    `/api/workflows/${encodeURIComponent(taskReference)}/planning-clarification`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(command),
    },
  );
  if (!result.response.ok) throw failureFrom(result);
  const parsed = ExecutionRunViewSchema.safeParse(result.body);
  if (!parsed.success) {
    throw new Error('Planning clarification response does not match the cockpit contract');
  }
  return parsed.data;
};

export const graphDownloadUrl = (taskReference: string): string =>
  `/api/workflows/${encodeURIComponent(taskReference)}/graph.json`;

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
