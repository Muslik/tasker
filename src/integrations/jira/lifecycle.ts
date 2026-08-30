import { z } from 'zod';

import { JsonValueSchema, type JsonValue } from '../../graph/schema.js';
import type {
  IntegrationStepAdapter,
  IntegrationStepExecutionRequest,
  IntegrationStepExecutionResult,
} from '../execution.js';
import type { ExternalEffectStore, ExternalEffectStoreError } from '../effects.js';
import { JiraIssueKeySchema, type JiraIssueKey } from './contracts.js';
import type { JiraConfiguration } from './client.js';

export const JiraLifecyclePolicyConfigurationSchema = z
  .object({
    provider: z.literal('jira'),
    admission: z
      .object({
        accountName: z.string().min(1),
        allowedIssueTypes: z.array(z.string().min(1)).min(1),
        deniedLabels: z.array(z.string().min(1)),
        statusPath: z.array(z.string().min(1)).min(1),
      })
      .strict(),
    reviewReady: z
      .object({
        statusPath: z.array(z.string().min(1)).min(1),
        commentPrefix: z.string().trim().min(1),
      })
      .strict(),
  })
  .strict();

const RawLifecycleIssueSchema = z
  .object({
    key: JiraIssueKeySchema,
    fields: z
      .object({
        issuetype: z.object({ name: z.string().min(1) }).loose(),
        status: z.object({ name: z.string().min(1) }).loose(),
        labels: z.array(z.string()).default([]),
        assignee: z
          .object({
            name: z.string().min(1),
            displayName: z.string().min(1),
          })
          .loose()
          .nullable(),
      })
      .loose(),
  })
  .loose();

const RawTransitionsSchema = z
  .object({
    transitions: z.array(
      z
        .object({
          id: z.string().min(1),
          name: z.string().min(1),
          to: z.object({ name: z.string().min(1) }).loose(),
          fields: z
            .record(
              z.string(),
              z
                .object({
                  required: z.boolean().default(false),
                  name: z.string().min(1),
                  hasDefaultValue: z.boolean().default(false),
                  operations: z.array(z.string()).default([]),
                })
                .loose(),
            )
            .default({}),
        })
        .loose(),
    ),
  })
  .loose();

const RawFieldValuesSchema = z
  .object({
    fields: z.record(z.string(), JsonValueSchema),
  })
  .loose();

const RawCommentsSchema = z
  .object({
    comments: z.array(
      z
        .object({
          id: z.string().min(1),
          body: z.string(),
        })
        .loose(),
    ),
  })
  .loose();

const RawAttachmentsSchema = z
  .object({
    fields: z
      .object({
        attachment: z.array(
          z
            .object({
              id: z.string().min(1),
              filename: z.string().min(1),
              mimeType: z.string().min(1),
              size: z.number().int().nonnegative(),
            })
            .loose(),
        ),
      })
      .loose(),
  })
  .loose();

const RawJiraErrorResponseSchema = z
  .object({
    errorMessages: z.array(z.string()).optional(),
    errors: z.record(z.string(), z.string()).optional(),
    message: z.string().optional(),
  })
  .loose();

export interface JiraLifecycleIssue {
  readonly issueKey: JiraIssueKey;
  readonly issueType: string;
  readonly status: string;
  readonly labels: readonly string[];
  readonly assignee: { readonly accountName: string; readonly displayName: string } | null;
}

export interface JiraLifecycleTransition {
  readonly id: string;
  readonly name: string;
  readonly toStatus: string;
  readonly fields: readonly JiraLifecycleTransitionField[];
}

export interface JiraLifecycleTransitionField {
  readonly id: string;
  readonly name: string;
  readonly required: boolean;
  readonly hasDefaultValue: boolean;
  readonly operations: readonly string[];
}

export type JiraLifecycleProblem =
  | {
      readonly kind: 'invalid_request';
      readonly message: string;
      readonly reasons: readonly string[];
      readonly retryable: false;
      readonly httpStatus: 400;
    }
  | {
      readonly kind: 'auth_failed';
      readonly message: string;
      readonly retryable: false;
      readonly httpStatus: 401;
    }
  | {
      readonly kind: 'access_blocked';
      readonly message: string;
      readonly retryable: true;
      readonly httpStatus: 403;
    }
  | {
      readonly kind: 'not_found';
      readonly message: string;
      readonly retryable: false;
      readonly httpStatus: 404;
    }
  | {
      readonly kind: 'invalid_response';
      readonly message: string;
      readonly retryable: false;
    }
  | {
      readonly kind: 'unavailable';
      readonly message: string;
      readonly retryable: boolean;
      readonly httpStatus?: number;
    };

export type JiraLifecycleObservation =
  | { readonly status: 'observed'; readonly issue: JiraLifecycleIssue }
  | { readonly status: 'failed'; readonly problem: JiraLifecycleProblem };

export type JiraTransitionObservation =
  | { readonly status: 'observed'; readonly transitions: readonly JiraLifecycleTransition[] }
  | { readonly status: 'failed'; readonly problem: JiraLifecycleProblem };

export type JiraFieldValueObservation =
  | { readonly status: 'observed'; readonly values: Readonly<Record<string, JsonValue>> }
  | { readonly status: 'failed'; readonly problem: JiraLifecycleProblem };

export type JiraCommentObservation =
  | {
      readonly status: 'observed';
      readonly comments: readonly { readonly id: string; readonly body: string }[];
    }
  | { readonly status: 'failed'; readonly problem: JiraLifecycleProblem };

export interface JiraAttachmentMetadata {
  readonly id: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly size: number;
}

export type JiraAttachmentObservation =
  | { readonly status: 'observed'; readonly attachments: readonly JiraAttachmentMetadata[] }
  | { readonly status: 'failed'; readonly problem: JiraLifecycleProblem };

export type JiraLifecycleMutation =
  | { readonly status: 'accepted' }
  | { readonly status: 'failed'; readonly problem: JiraLifecycleProblem };

export interface JiraLifecyclePort {
  observeIssue(issueKey: JiraIssueKey): Promise<JiraLifecycleObservation>;
  listTransitions(issueKey: JiraIssueKey): Promise<JiraTransitionObservation>;
  observeFieldValues(
    issueKey: JiraIssueKey,
    fieldIds: readonly string[],
  ): Promise<JiraFieldValueObservation>;
  listComments(issueKey: JiraIssueKey): Promise<JiraCommentObservation>;
  assign(issueKey: JiraIssueKey, accountName: string): Promise<JiraLifecycleMutation>;
  transition(issueKey: JiraIssueKey, transitionId: string): Promise<JiraLifecycleMutation>;
  comment(issueKey: JiraIssueKey, body: string): Promise<JiraLifecycleMutation>;
  updateComment(
    issueKey: JiraIssueKey,
    commentId: string,
    body: string,
  ): Promise<JiraLifecycleMutation>;
}

export type JiraTransitionPreflight =
  | { readonly status: 'ready' }
  | {
      readonly status: 'missing_fields';
      readonly fields: readonly JiraLifecycleTransitionField[];
    }
  | { readonly status: 'failed'; readonly problem: JiraLifecycleProblem };

const hasJiraFieldValue = (value: JsonValue | undefined): boolean => {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
};

export const preflightJiraTransition = async (
  jira: JiraLifecyclePort,
  issueKey: JiraIssueKey,
  transition: JiraLifecycleTransition,
): Promise<JiraTransitionPreflight> => {
  const requiredFields = transition.fields.filter(
    (field) => field.required && !field.hasDefaultValue,
  );
  if (requiredFields.length === 0) return { status: 'ready' };
  const observed = await jira.observeFieldValues(
    issueKey,
    requiredFields.map(({ id }) => id),
  );
  if (observed.status === 'failed') return observed;
  const missing = requiredFields.filter(({ id }) => !hasJiraFieldValue(observed.values[id]));
  return missing.length === 0 ? { status: 'ready' } : { status: 'missing_fields', fields: missing };
};

export interface JiraAttachmentPort {
  listAttachments(issueKey: JiraIssueKey): Promise<JiraAttachmentObservation>;
  uploadAttachment(
    issueKey: JiraIssueKey,
    attachment: {
      readonly filename: string;
      readonly mimeType: string;
      readonly content: Uint8Array;
    },
  ): Promise<JiraLifecycleMutation>;
}

type FetchImplementation = typeof fetch;

const normalizedJiraReason = (reason: string): string | null => {
  const normalized = reason.replace(/\s+/gu, ' ').trim();
  return normalized.length === 0 ? null : normalized.slice(0, 500);
};

const jiraReasonsFrom = async (response: Response): Promise<readonly string[]> => {
  try {
    const body = await response.text();
    if (body.length === 0 || body.length > 64_000) return [];
    const parsed = RawJiraErrorResponseSchema.safeParse(JSON.parse(body) as unknown);
    if (!parsed.success) return [];

    const candidates = [
      ...(parsed.data.errorMessages ?? []),
      ...Object.values(parsed.data.errors ?? {}),
      ...(parsed.data.message === undefined ? [] : [parsed.data.message]),
    ];
    return [
      ...new Set(
        candidates.map(normalizedJiraReason).filter((reason): reason is string => reason !== null),
      ),
    ].slice(0, 8);
  } catch {
    return [];
  }
};

const problemForResponse = async (response: Response): Promise<JiraLifecycleProblem> => {
  const status = response.status;
  if (status === 400) {
    const reasons = await jiraReasonsFrom(response);
    return {
      kind: 'invalid_request',
      message:
        reasons.length === 0
          ? 'Jira rejected the lifecycle mutation'
          : `Jira rejected the lifecycle mutation: ${reasons.join('; ')}`,
      reasons,
      retryable: false,
      httpStatus: status,
    };
  }
  if (status === 401) {
    return {
      kind: 'auth_failed',
      message: 'Jira rejected the configured token',
      retryable: false,
      httpStatus: status,
    };
  }
  if (status === 403) {
    return {
      kind: 'access_blocked',
      message: 'Jira returned 403. VPN or Jira access may be required',
      retryable: true,
      httpStatus: status,
    };
  }
  if (status === 404) {
    return {
      kind: 'not_found',
      message: 'Jira issue or lifecycle endpoint was not found',
      retryable: false,
      httpStatus: status,
    };
  }
  return {
    kind: 'unavailable',
    message: `Jira lifecycle request failed with HTTP ${String(status)}`,
    retryable: status >= 500,
    httpStatus: status,
  };
};

export class JiraLifecycleClient implements JiraLifecyclePort, JiraAttachmentPort {
  public constructor(
    private readonly configuration: JiraConfiguration,
    private readonly fetchImplementation: FetchImplementation = fetch,
    private readonly requestTimeoutMs = 15_000,
  ) {}

  public async observeIssue(issueKey: JiraIssueKey): Promise<JiraLifecycleObservation> {
    const response = await this.request(
      'GET',
      `/rest/api/2/issue/${encodeURIComponent(issueKey)}?fields=${encodeURIComponent(
        'issuetype,status,labels,assignee',
      )}`,
    );
    if (response.status === 'failed') return response;
    const payload = await this.json(response.response, 'Jira returned an invalid issue response');
    if (payload.status === 'failed') return payload;
    const parsed = RawLifecycleIssueSchema.safeParse(payload.value);
    if (!parsed.success) {
      return {
        status: 'failed',
        problem: {
          kind: 'invalid_response',
          message: 'Jira lifecycle issue response did not match its contract',
          retryable: false,
        },
      };
    }
    return {
      status: 'observed',
      issue: {
        issueKey: parsed.data.key,
        issueType: parsed.data.fields.issuetype.name,
        status: parsed.data.fields.status.name,
        labels: parsed.data.fields.labels,
        assignee:
          parsed.data.fields.assignee === null
            ? null
            : {
                accountName: parsed.data.fields.assignee.name,
                displayName: parsed.data.fields.assignee.displayName,
              },
      },
    };
  }

  public async listTransitions(issueKey: JiraIssueKey): Promise<JiraTransitionObservation> {
    const response = await this.request(
      'GET',
      `/rest/api/2/issue/${encodeURIComponent(issueKey)}/transitions?expand=transitions.fields`,
    );
    if (response.status === 'failed') return response;
    const payload = await this.json(
      response.response,
      'Jira returned an invalid transitions response',
    );
    if (payload.status === 'failed') return payload;
    const parsed = RawTransitionsSchema.safeParse(payload.value);
    if (!parsed.success) {
      return {
        status: 'failed',
        problem: {
          kind: 'invalid_response',
          message: 'Jira transitions response did not match its contract',
          retryable: false,
        },
      };
    }
    return {
      status: 'observed',
      transitions: parsed.data.transitions.map((transition) => ({
        id: transition.id,
        name: transition.name,
        toStatus: transition.to.name,
        fields: Object.entries(transition.fields).map(([id, field]) => ({ id, ...field })),
      })),
    };
  }

  public async observeFieldValues(
    issueKey: JiraIssueKey,
    fieldIds: readonly string[],
  ): Promise<JiraFieldValueObservation> {
    if (fieldIds.length === 0) return { status: 'observed', values: {} };
    const fields = [...new Set(fieldIds)].join(',');
    const response = await this.request(
      'GET',
      `/rest/api/2/issue/${encodeURIComponent(issueKey)}?fields=${encodeURIComponent(fields)}`,
    );
    if (response.status === 'failed') return response;
    const payload = await this.json(
      response.response,
      'Jira returned invalid transition field values',
    );
    if (payload.status === 'failed') return payload;
    const parsed = RawFieldValuesSchema.safeParse(payload.value);
    if (!parsed.success) {
      return {
        status: 'failed',
        problem: {
          kind: 'invalid_response',
          message: 'Jira transition field values did not match their contract',
          retryable: false,
        },
      };
    }
    return { status: 'observed', values: parsed.data.fields };
  }

  public async listComments(issueKey: JiraIssueKey): Promise<JiraCommentObservation> {
    const response = await this.request(
      'GET',
      `/rest/api/2/issue/${encodeURIComponent(issueKey)}/comment?maxResults=1000`,
    );
    if (response.status === 'failed') return response;
    const payload = await this.json(
      response.response,
      'Jira returned an invalid comments response',
    );
    if (payload.status === 'failed') return payload;
    const parsed = RawCommentsSchema.safeParse(payload.value);
    if (!parsed.success) {
      return {
        status: 'failed',
        problem: {
          kind: 'invalid_response',
          message: 'Jira comments response did not match its contract',
          retryable: false,
        },
      };
    }
    return { status: 'observed', comments: parsed.data.comments };
  }

  public async listAttachments(issueKey: JiraIssueKey): Promise<JiraAttachmentObservation> {
    const response = await this.request(
      'GET',
      `/rest/api/2/issue/${encodeURIComponent(issueKey)}?fields=attachment`,
    );
    if (response.status === 'failed') return response;
    const payload = await this.json(
      response.response,
      'Jira returned an invalid attachments response',
    );
    if (payload.status === 'failed') return payload;
    const parsed = RawAttachmentsSchema.safeParse(payload.value);
    if (!parsed.success) {
      return {
        status: 'failed',
        problem: {
          kind: 'invalid_response',
          message: 'Jira attachments response did not match its contract',
          retryable: false,
        },
      };
    }
    return { status: 'observed', attachments: parsed.data.fields.attachment };
  }

  public assign(issueKey: JiraIssueKey, accountName: string): Promise<JiraLifecycleMutation> {
    return this.mutate('PUT', `/rest/api/2/issue/${encodeURIComponent(issueKey)}`, {
      fields: { assignee: { name: accountName } },
    });
  }

  public transition(issueKey: JiraIssueKey, transitionId: string): Promise<JiraLifecycleMutation> {
    return this.mutate('POST', `/rest/api/2/issue/${encodeURIComponent(issueKey)}/transitions`, {
      transition: { id: transitionId },
    });
  }

  public comment(issueKey: JiraIssueKey, body: string): Promise<JiraLifecycleMutation> {
    return this.mutate('POST', `/rest/api/2/issue/${encodeURIComponent(issueKey)}/comment`, {
      body,
    });
  }

  public updateComment(
    issueKey: JiraIssueKey,
    commentId: string,
    body: string,
  ): Promise<JiraLifecycleMutation> {
    return this.mutate(
      'PUT',
      `/rest/api/2/issue/${encodeURIComponent(issueKey)}/comment/${encodeURIComponent(commentId)}`,
      { body },
    );
  }

  public async uploadAttachment(
    issueKey: JiraIssueKey,
    attachment: {
      readonly filename: string;
      readonly mimeType: string;
      readonly content: Uint8Array;
    },
  ): Promise<JiraLifecycleMutation> {
    const form = new FormData();
    form.append(
      'file',
      new Blob([Uint8Array.from(attachment.content)], { type: attachment.mimeType }),
      attachment.filename,
    );
    try {
      const response = await this.fetchImplementation(
        `${this.configuration.baseUrl}/rest/api/2/issue/${encodeURIComponent(issueKey)}/attachments`,
        {
          method: 'POST',
          headers: {
            accept: 'application/json',
            authorization: `Bearer ${this.configuration.token}`,
            'x-atlassian-token': 'no-check',
          },
          body: form,
          signal: AbortSignal.timeout(this.requestTimeoutMs),
        },
      );
      return response.ok
        ? { status: 'accepted' }
        : { status: 'failed', problem: await problemForResponse(response) };
    } catch (error) {
      return {
        status: 'failed',
        problem: {
          kind: 'unavailable',
          message: error instanceof Error ? error.message : 'Jira attachment upload failed',
          retryable: true,
        },
      };
    }
  }

  private async mutate(method: 'POST' | 'PUT', path: string, body: JsonValue) {
    const response = await this.request(method, path, body);
    return response.status === 'failed'
      ? response
      : ({ status: 'accepted' } as const satisfies JiraLifecycleMutation);
  }

  private async json(
    response: Response,
    message: string,
  ): Promise<
    | { readonly status: 'parsed'; readonly value: unknown }
    | { readonly status: 'failed'; readonly problem: JiraLifecycleProblem }
  > {
    try {
      return { status: 'parsed', value: await response.json() };
    } catch {
      return {
        status: 'failed',
        problem: { kind: 'invalid_response', message, retryable: false },
      };
    }
  }

  private async request(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    body?: JsonValue,
  ): Promise<
    | { readonly status: 'accepted'; readonly response: Response }
    | { readonly status: 'failed'; readonly problem: JiraLifecycleProblem }
  > {
    try {
      const response = await this.fetchImplementation(`${this.configuration.baseUrl}${path}`, {
        method,
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${this.configuration.token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
      return response.ok
        ? { status: 'accepted', response }
        : { status: 'failed', problem: await problemForResponse(response) };
    } catch (error) {
      return {
        status: 'failed',
        problem: {
          kind: 'unavailable',
          message: error instanceof Error ? error.message : 'Jira lifecycle request failed',
          retryable: true,
        },
      };
    }
  }
}

export const sameJiraValue = (left: string, right: string): boolean =>
  left.localeCompare(right, 'en-US', { sensitivity: 'base' }) === 0;

export const jiraLifecyclePolicyConfiguration = (request: IntegrationStepExecutionRequest) => {
  const policy = request.policies.find(({ id }) => id === 'jira-lifecycle');
  return JiraLifecyclePolicyConfigurationSchema.safeParse(policy?.configuration);
};

type BlockedIntegrationResult = Extract<
  IntegrationStepExecutionResult,
  { readonly status: 'blocked' }
>;

const journalFailure = (
  error: ExternalEffectStoreError,
  artifactIds: readonly string[],
): BlockedIntegrationResult => ({
  status: 'blocked',
  kind: 'unknown_outcome',
  summary: `Jira lifecycle journal is unavailable: ${error.kind}`,
  details: JsonValueSchema.parse(error),
  artifactIds,
});

const problemResult = (
  problem: JiraLifecycleProblem,
  artifactIds: readonly string[],
  unknownOutcome = false,
): BlockedIntegrationResult => ({
  status: 'blocked',
  kind: unknownOutcome
    ? 'unknown_outcome'
    : problem.kind === 'access_blocked' || problem.kind === 'unavailable'
      ? 'infrastructure'
      : problem.kind === 'auth_failed'
        ? 'configuration'
        : 'invalid_request',
  summary: problem.message,
  details: JsonValueSchema.parse(problem),
  retryable: problem.retryable,
  artifactIds,
});

const blocked = (
  kind: BlockedIntegrationResult['kind'],
  summary: string,
  details: JsonValue,
  artifactIds: readonly string[] = [],
): BlockedIntegrationResult => ({ status: 'blocked', kind, summary, details, artifactIds });

const missingTransitionFields = (
  issueKey: JiraIssueKey,
  transition: JiraLifecycleTransition,
  fields: readonly JiraLifecycleTransitionField[],
  artifactIds: readonly string[],
): BlockedIntegrationResult =>
  blocked(
    'invalid_request',
    `Jira requires fields before ${transition.name} can run: ${fields
      .map(({ name }) => name)
      .join(', ')}`,
    {
      issueKey,
      transitionId: transition.id,
      transitionName: transition.name,
      toStatus: transition.toStatus,
      missingFields: fields.map(({ id, name, operations }) => ({
        id,
        name,
        operations: [...operations],
      })),
    },
    artifactIds,
  );

const statusIndex = (path: readonly string[], status: string): number =>
  path.findIndex((candidate) => sameJiraValue(candidate, status));

const assignmentReceipt = (issueKey: JiraIssueKey, accountName: string): JsonValue => ({
  issueKey,
  accountName,
});

const transitionReceipt = (
  issueKey: JiraIssueKey,
  fromStatus: string,
  toStatus: string,
  transitionId: string | null,
): JsonValue => ({ issueKey, fromStatus, toStatus, transitionId });

export class JiraStartWorkAdapter implements IntegrationStepAdapter {
  public readonly id = 'jira.start-work@1';

  public constructor(
    private readonly jira: JiraLifecyclePort,
    private readonly effects: ExternalEffectStore,
  ) {}

  public async execute(
    request: IntegrationStepExecutionRequest,
  ): Promise<IntegrationStepExecutionResult> {
    const configured = jiraLifecyclePolicyConfiguration(request);
    if (!configured.success) {
      return blocked('configuration', 'Jira lifecycle policy is missing or invalid', {
        issues: configured.error.issues.map((issue) => issue.message),
      });
    }
    if (request.task.origin !== 'jira') {
      return blocked('invalid_request', 'Jira admission cannot run for a non-Jira task', {
        taskOrigin: request.task.origin,
      });
    }
    const issueKey = JiraIssueKeySchema.safeParse(request.task.taskId);
    if (!issueKey.success) {
      return blocked('invalid_request', 'Task does not carry a valid Jira issue key', {
        taskId: request.task.taskId,
      });
    }

    const observation = await this.jira.observeIssue(issueKey.data);
    if (observation.status === 'failed') return problemResult(observation.problem, []);
    const admission = configured.data.admission;
    const eligibility = this.validateEligibility(observation.issue, admission);
    if (eligibility !== null) return eligibility;

    const artifactIds: string[] = [];
    let issue = observation.issue;
    if (issue.assignee === null) {
      const assignment = await this.ensureAssignment(
        request,
        issueKey.data,
        admission.accountName,
        artifactIds,
      );
      if (assignment.status === 'blocked') return assignment;
      issue = assignment.issue;
    }

    if (request.trackerStatusUpdates === 'disabled') {
      return {
        status: 'completed',
        summary: `Jira ${issue.issueKey} admitted without changing status ${issue.status}`,
        output: {
          externalId: issue.issueKey,
          status: issue.status,
          statusUpdate: { outcome: 'disabled' },
        },
        artifactIds,
      };
    }

    const targetStatus = admission.statusPath.at(-1);
    if (targetStatus === undefined) {
      return blocked('configuration', 'Jira lifecycle status path is empty', {}, artifactIds);
    }
    while (!sameJiraValue(issue.status, targetStatus)) {
      const fromIndex = statusIndex(admission.statusPath, issue.status);
      const toStatus = admission.statusPath[fromIndex + 1];
      if (fromIndex < 0 || toStatus === undefined) {
        const reason = `Jira status ${issue.status} is outside the configured update path`;
        return {
          status: 'completed',
          summary: `Jira ${issue.issueKey} admitted without changing status ${issue.status}: ${reason}`,
          output: {
            externalId: issue.issueKey,
            status: issue.status,
            statusUpdate: { outcome: 'not_applied', reason },
          },
          artifactIds,
        };
      }
      const transitioned = await this.ensureTransition(
        request,
        issue,
        fromIndex,
        toStatus,
        admission.statusPath,
        artifactIds,
      );
      if (transitioned.status === 'blocked') {
        return {
          status: 'completed',
          summary: `Jira ${issue.issueKey} admitted without changing status ${issue.status}: ${transitioned.summary}`,
          output: {
            externalId: issue.issueKey,
            status: issue.status,
            statusUpdate: { outcome: 'not_applied', reason: transitioned.summary },
          },
          artifactIds: transitioned.artifactIds,
        };
      }
      issue = transitioned.issue;
    }

    return {
      status: 'completed',
      summary: `Jira ${issue.issueKey} admitted in ${issue.status}`,
      output: { externalId: issue.issueKey, status: issue.status },
      artifactIds,
    };
  }

  private validateEligibility(
    issue: JiraLifecycleIssue,
    admission: z.infer<typeof JiraLifecyclePolicyConfigurationSchema>['admission'],
  ): IntegrationStepExecutionResult | null {
    if (
      !admission.allowedIssueTypes.some((candidate) => sameJiraValue(candidate, issue.issueType))
    ) {
      return blocked(
        'invalid_request',
        `Jira issue type ${issue.issueType} is not agent-eligible`,
        {
          issueKey: issue.issueKey,
          issueType: issue.issueType,
        },
      );
    }
    const deniedLabel = issue.labels.find((label) =>
      admission.deniedLabels.some((candidate) => sameJiraValue(candidate, label)),
    );
    if (deniedLabel !== undefined) {
      return blocked('invalid_request', `Jira issue is excluded by label ${deniedLabel}`, {
        issueKey: issue.issueKey,
        deniedLabel,
      });
    }
    if (
      issue.assignee !== null &&
      !sameJiraValue(issue.assignee.accountName, admission.accountName)
    ) {
      return blocked('invalid_request', 'Jira issue is assigned to another person', {
        issueKey: issue.issueKey,
        assignee: issue.assignee.accountName,
      });
    }
    return null;
  }

  private async ensureAssignment(
    request: IntegrationStepExecutionRequest,
    issueKey: JiraIssueKey,
    accountName: string,
    artifactIds: string[],
  ): Promise<
    { readonly status: 'assigned'; readonly issue: JiraLifecycleIssue } | BlockedIntegrationResult
  > {
    const effectId = 'assign-owner';
    const prepared = this.effects.prepare({
      operationId: request.operationId,
      effectId,
      effectKind: 'jira.issue.assign',
      identity: { issueKey, accountName },
    });
    if (!prepared.ok) return journalFailure(prepared.error, artifactIds);
    artifactIds.push(this.effects.intentArtifactId(request.operationId, effectId));
    const receipt = this.effects.readReceipt(request.operationId, effectId);
    if (!receipt.ok) return journalFailure(receipt.error, artifactIds);

    if (receipt.value === null) {
      const mutation = await this.jira.assign(issueKey, accountName);
      if (mutation.status === 'failed') {
        if (
          mutation.problem.kind !== 'unavailable' &&
          mutation.problem.kind !== 'invalid_response'
        ) {
          return problemResult(mutation.problem, artifactIds);
        }
      }
      const reconciled = await this.jira.observeIssue(issueKey);
      if (
        reconciled.status !== 'observed' ||
        reconciled.issue.assignee === null ||
        !sameJiraValue(reconciled.issue.assignee.accountName, accountName)
      ) {
        return mutation.status === 'failed'
          ? problemResult(mutation.problem, artifactIds, true)
          : blocked(
              'unknown_outcome',
              'Jira accepted the assignment but the new owner could not be confirmed',
              { issueKey, expectedAssignee: accountName },
              artifactIds,
            );
      }
      const applied = this.effects.recordApplied({
        operationId: request.operationId,
        effectId,
        effectKind: 'jira.issue.assign',
        result: assignmentReceipt(issueKey, accountName),
      });
      if (!applied.ok) return journalFailure(applied.error, artifactIds);
    }
    artifactIds.push(this.effects.receiptArtifactId(request.operationId, effectId));
    const observed = await this.jira.observeIssue(issueKey);
    if (observed.status === 'failed') return problemResult(observed.problem, artifactIds, true);
    if (
      observed.issue.assignee === null ||
      !sameJiraValue(observed.issue.assignee.accountName, accountName)
    ) {
      return blocked(
        'remote_conflict',
        'Jira assignment does not match the admitted owner',
        { issueKey, expectedAssignee: accountName },
        artifactIds,
      );
    }
    return { status: 'assigned', issue: observed.issue };
  }

  private async ensureTransition(
    request: IntegrationStepExecutionRequest,
    issue: JiraLifecycleIssue,
    fromIndex: number,
    toStatus: string,
    statusPath: readonly string[],
    artifactIds: string[],
  ): Promise<
    | { readonly status: 'transitioned'; readonly issue: JiraLifecycleIssue }
    | BlockedIntegrationResult
  > {
    const effectId = `transition-${String(fromIndex)}-${String(fromIndex + 1)}`;
    let receipt = this.effects.readReceipt(request.operationId, effectId);
    if (!receipt.ok) return journalFailure(receipt.error, artifactIds);
    let selectedTransition: JiraLifecycleTransition | null = null;

    if (receipt.value === null) {
      const transitions = await this.jira.listTransitions(issue.issueKey);
      if (transitions.status === 'failed') return problemResult(transitions.problem, artifactIds);
      const matches = transitions.transitions.filter((candidate) =>
        sameJiraValue(candidate.toStatus, toStatus),
      );
      if (matches.length !== 1) {
        return blocked(
          'invalid_request',
          `Jira exposes ${String(matches.length)} transitions from ${issue.status} to ${toStatus}`,
          {
            issueKey: issue.issueKey,
            availableTransitions: transitions.transitions.map(({ id, name, toStatus: target }) => ({
              id,
              name,
              toStatus: target,
            })),
          },
          artifactIds,
        );
      }
      const transitionId = matches[0]?.id;
      selectedTransition = matches[0] ?? null;
      if (transitionId === undefined || selectedTransition === null) {
        return blocked('invalid_request', 'Jira transition selection failed', {}, artifactIds);
      }
      const preflight = await preflightJiraTransition(
        this.jira,
        issue.issueKey,
        selectedTransition,
      );
      if (preflight.status === 'failed') return problemResult(preflight.problem, artifactIds);
      if (preflight.status === 'missing_fields') {
        return missingTransitionFields(
          issue.issueKey,
          selectedTransition,
          preflight.fields,
          artifactIds,
        );
      }

      const prepared = this.effects.prepare({
        operationId: request.operationId,
        effectId,
        effectKind: 'jira.issue.transition',
        identity: { issueKey: issue.issueKey, fromStatus: issue.status, toStatus },
      });
      if (!prepared.ok) return journalFailure(prepared.error, artifactIds);
      artifactIds.push(this.effects.intentArtifactId(request.operationId, effectId));
      receipt = this.effects.readReceipt(request.operationId, effectId);
      if (!receipt.ok) return journalFailure(receipt.error, artifactIds);
    }

    if (receipt.value === null) {
      if (selectedTransition === null) {
        return blocked('unknown_outcome', 'Jira transition selection was lost before mutation', {
          issueKey: issue.issueKey,
          toStatus,
        });
      }
      const mutation = await this.jira.transition(issue.issueKey, selectedTransition.id);
      if (
        mutation.status === 'failed' &&
        mutation.problem.kind !== 'unavailable' &&
        mutation.problem.kind !== 'invalid_response'
      ) {
        return problemResult(mutation.problem, artifactIds);
      }
      const observed = await this.jira.observeIssue(issue.issueKey);
      const reached =
        observed.status === 'observed' &&
        statusIndex(statusPath, observed.issue.status) >= fromIndex + 1;
      if (!reached) {
        if (mutation.status === 'failed') {
          return problemResult(mutation.problem, artifactIds, true);
        }
        return blocked(
          'unknown_outcome',
          `Jira accepted the transition but ${toStatus} could not be confirmed`,
          { issueKey: issue.issueKey, transitionId: selectedTransition.id, toStatus },
          artifactIds,
        );
      }
      const applied = this.effects.recordApplied({
        operationId: request.operationId,
        effectId,
        effectKind: 'jira.issue.transition',
        result: transitionReceipt(issue.issueKey, issue.status, toStatus, selectedTransition.id),
      });
      if (!applied.ok) return journalFailure(applied.error, artifactIds);
      artifactIds.push(this.effects.receiptArtifactId(request.operationId, effectId));
      return { status: 'transitioned', issue: observed.issue };
    }

    artifactIds.push(this.effects.receiptArtifactId(request.operationId, effectId));
    const observed = await this.jira.observeIssue(issue.issueKey);
    if (observed.status === 'failed') return problemResult(observed.problem, artifactIds, true);
    if (statusIndex(statusPath, observed.issue.status) < fromIndex + 1) {
      return blocked(
        'remote_conflict',
        'Jira status no longer matches the recorded transition receipt',
        { issueKey: issue.issueKey, status: observed.issue.status, expectedAtLeast: toStatus },
        artifactIds,
      );
    }
    return { status: 'transitioned', issue: observed.issue };
  }
}
