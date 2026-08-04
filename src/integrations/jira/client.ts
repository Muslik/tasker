import { z } from 'zod';

import { loadHarnessEnvironmentDefaults } from '../../shared/env-file.js';
import { err, ok, type Outcome } from '../../shared/outcome.js';
import {
  JiraIssueKeySchema,
  JiraIssueSnapshotSchema,
  type JiraIssueKey,
  type JiraIssueSnapshot,
  type JiraSyncProblem,
} from './contracts.js';

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_ATTACHMENT_BYTES = 32 * 1024 * 1024;

export const JiraConfigurationSchema = z
  .object({
    baseUrl: z.url(),
    token: z.string().min(1),
  })
  .strict();

export type JiraConfiguration = z.infer<typeof JiraConfigurationSchema>;

const RawPersonSchema = z
  .object({
    displayName: z.string().min(1),
  })
  .loose();

const RawAttachmentSchema = z
  .object({
    id: z.string().min(1),
    filename: z.string().min(1),
    mimeType: z.string().min(1),
    size: z.number().int().nonnegative(),
    created: z.string().min(1),
    content: z.url(),
    thumbnail: z.url().optional(),
  })
  .loose();

const RawCommentSchema = z
  .object({
    id: z.string().min(1),
    author: RawPersonSchema,
    body: z.string(),
    created: z.string().min(1),
    updated: z.string().min(1),
  })
  .loose();

const RawLinkedIssueSchema = z
  .object({
    key: JiraIssueKeySchema,
    fields: z
      .object({
        summary: z.string().min(1),
        status: z.object({ name: z.string().min(1) }).loose(),
      })
      .loose(),
  })
  .loose();

const RawIssueLinkSchema = z
  .object({
    type: z
      .object({
        inward: z.string().min(1),
        outward: z.string().min(1),
      })
      .loose(),
    inwardIssue: RawLinkedIssueSchema.optional(),
    outwardIssue: RawLinkedIssueSchema.optional(),
  })
  .loose();

const RawJiraIssueSchema = z
  .object({
    id: z.string().min(1),
    key: JiraIssueKeySchema,
    fields: z
      .object({
        summary: z.string().min(1),
        description: z.string().nullable(),
        issuetype: z.object({ name: z.string().min(1) }).loose(),
        status: z.object({ name: z.string().min(1) }).loose(),
        priority: z.object({ name: z.string().min(1) }).loose(),
        labels: z.array(z.string()),
        assignee: RawPersonSchema.nullable(),
        reporter: RawPersonSchema.nullable(),
        created: z.string().min(1),
        updated: z.string().min(1),
        attachment: z.array(RawAttachmentSchema),
        comment: z.object({ comments: z.array(RawCommentSchema) }).loose(),
        issuelinks: z.array(RawIssueLinkSchema),
        customfield_14100: z.string().nullable().optional(),
      })
      .loose(),
  })
  .loose();

export interface JiraAttachmentContent {
  readonly bytes: Uint8Array;
  readonly contentType: string;
}

export interface JiraIssuePort {
  fetchIssue(
    issueKey: JiraIssueKey,
    syncedAt: string,
  ): Promise<Outcome<JiraIssueSnapshot, JiraSyncProblem>>;
  fetchAttachment(contentUrl: string): Promise<Outcome<JiraAttachmentContent, JiraSyncProblem>>;
}

type FetchImplementation = typeof fetch;

export const loadJiraConfiguration = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
): JiraConfiguration | null => {
  const defaults = loadHarnessEnvironmentDefaults(environment);
  const baseUrl = environment.JIRA_BASE_URL ?? defaults.JIRA_BASE_URL;
  const token = environment.JIRA_TOKEN ?? defaults.JIRA_TOKEN;
  const parsed = JiraConfigurationSchema.safeParse({ baseUrl, token });
  return parsed.success
    ? { ...parsed.data, baseUrl: parsed.data.baseUrl.replace(/\/$/u, '') }
    : null;
};

const httpProblem = (status: number): JiraSyncProblem => {
  if (status === 401) {
    return {
      kind: 'auth_failed',
      message: 'Jira rejected the configured token',
      retryable: false,
      httpStatus: 401,
    };
  }
  if (status === 403) {
    return {
      kind: 'access_blocked',
      message: 'Jira returned 403. VPN or Jira access may be required',
      retryable: true,
      httpStatus: 403,
    };
  }
  if (status === 404) {
    return {
      kind: 'not_found',
      message: 'Jira issue does not exist or is not visible to this account',
      retryable: false,
      httpStatus: 404,
    };
  }
  return {
    kind: 'unavailable',
    message: `Jira request failed with HTTP ${String(status)}`,
    retryable: true,
    httpStatus: status,
  };
};

const normalizeDate = (value: string): string => {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new Error(`Invalid Jira timestamp: ${value}`);
  }
  return new Date(milliseconds).toISOString();
};

const normalizeIssue = (
  baseUrl: string,
  raw: z.infer<typeof RawJiraIssueSchema>,
  syncedAt: string,
): JiraIssueSnapshot => {
  const fields = raw.fields;
  const links = raw.fields.issuelinks.flatMap((link) => {
    if (link.inwardIssue !== undefined) {
      return [
        {
          issueKey: link.inwardIssue.key,
          summary: link.inwardIssue.fields.summary,
          relationship: link.type.inward,
          status: link.inwardIssue.fields.status.name,
        },
      ];
    }
    if (link.outwardIssue !== undefined) {
      return [
        {
          issueKey: link.outwardIssue.key,
          summary: link.outwardIssue.fields.summary,
          relationship: link.type.outward,
          status: link.outwardIssue.fields.status.name,
        },
      ];
    }
    return [];
  });

  return JiraIssueSnapshotSchema.parse({
    schemaVersion: 1,
    issueKey: raw.key,
    issueId: raw.id,
    browseUrl: `${baseUrl}/browse/${raw.key}`,
    summary: fields.summary,
    description: fields.description ?? '',
    issueType: fields.issuetype.name,
    status: fields.status.name,
    priority: fields.priority.name,
    labels: fields.labels,
    assignee: fields.assignee === null ? null : { displayName: fields.assignee.displayName },
    reporter: fields.reporter === null ? null : { displayName: fields.reporter.displayName },
    repositoryHint: fields.customfield_14100 ?? null,
    createdAt: normalizeDate(fields.created),
    updatedAt: normalizeDate(fields.updated),
    syncedAt,
    attachments: fields.attachment.map((attachment) => ({
      id: attachment.id,
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      size: attachment.size,
      createdAt: normalizeDate(attachment.created),
      contentUrl: attachment.content,
      ...(attachment.thumbnail === undefined ? {} : { thumbnailUrl: attachment.thumbnail }),
    })),
    comments: fields.comment.comments.map((comment) => ({
      id: comment.id,
      author: { displayName: comment.author.displayName },
      body: comment.body,
      createdAt: normalizeDate(comment.created),
      updatedAt: normalizeDate(comment.updated),
    })),
    links,
  });
};

export class JiraServerClient implements JiraIssuePort {
  public constructor(
    private readonly configuration: JiraConfiguration | null,
    private readonly fetchImplementation: FetchImplementation = fetch,
    private readonly requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    private readonly maxAttachmentBytes = DEFAULT_MAX_ATTACHMENT_BYTES,
  ) {}

  public async fetchIssue(
    issueKeyInput: JiraIssueKey,
    syncedAt: string,
  ): Promise<Outcome<JiraIssueSnapshot, JiraSyncProblem>> {
    const issueKey = JiraIssueKeySchema.parse(issueKeyInput);
    const response = await this.request(
      `/rest/api/2/issue/${encodeURIComponent(issueKey)}?fields=${encodeURIComponent(
        'summary,description,issuetype,status,priority,labels,assignee,reporter,created,updated,attachment,comment,issuelinks,customfield_14100',
      )}`,
    );
    if (!response.ok) return response;

    let payload: unknown;
    try {
      payload = await response.value.json();
    } catch {
      return err({
        kind: 'invalid_response',
        message: 'Jira returned a non-JSON issue response',
        retryable: false,
      });
    }

    const parsed = RawJiraIssueSchema.safeParse(payload);
    if (!parsed.success) {
      return err({
        kind: 'invalid_response',
        message: `Jira issue response did not match the normalized contract: ${parsed.error.issues
          .slice(0, 3)
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('; ')}`,
        retryable: false,
      });
    }

    try {
      return ok(normalizeIssue(this.configuration?.baseUrl ?? '', parsed.data, syncedAt));
    } catch (error) {
      return err({
        kind: 'invalid_response',
        message: error instanceof Error ? error.message : 'Jira issue normalization failed',
        retryable: false,
      });
    }
  }

  public async fetchAttachment(
    contentUrl: string,
  ): Promise<Outcome<JiraAttachmentContent, JiraSyncProblem>> {
    const response = await this.request(contentUrl);
    if (!response.ok) return response;

    const declaredSize = Number(response.value.headers.get('content-length'));
    if (Number.isFinite(declaredSize) && declaredSize > this.maxAttachmentBytes) {
      return err({
        kind: 'attachment_too_large',
        message: `Jira attachment exceeds the ${String(this.maxAttachmentBytes)} byte proxy limit`,
        retryable: false,
      });
    }

    const bytes = new Uint8Array(await response.value.arrayBuffer());
    if (bytes.byteLength > this.maxAttachmentBytes) {
      return err({
        kind: 'attachment_too_large',
        message: `Jira attachment exceeds the ${String(this.maxAttachmentBytes)} byte proxy limit`,
        retryable: false,
      });
    }

    return ok({
      bytes,
      contentType: response.value.headers.get('content-type') ?? 'application/octet-stream',
    });
  }

  private async request(pathOrUrl: string): Promise<Outcome<Response, JiraSyncProblem>> {
    if (this.configuration === null) {
      return err({
        kind: 'not_configured',
        message: 'Jira credentials are not configured for Tasker',
        retryable: false,
      });
    }

    const url = pathOrUrl.startsWith('http')
      ? pathOrUrl
      : `${this.configuration.baseUrl}${pathOrUrl}`;
    if (!url.startsWith(`${this.configuration.baseUrl}/`)) {
      return err({
        kind: 'invalid_response',
        message: 'Jira attachment URL points outside the configured Jira origin',
        retryable: false,
      });
    }

    try {
      const response = await this.fetchImplementation(url, {
        headers: {
          accept: '*/*',
          authorization: `Bearer ${this.configuration.token}`,
        },
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
      return response.ok ? ok(response) : err(httpProblem(response.status));
    } catch (error) {
      return err({
        kind: 'unavailable',
        message: error instanceof Error ? error.message : 'Jira request failed before a response',
        retryable: true,
      });
    }
  }
}
