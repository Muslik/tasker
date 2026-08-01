import { z } from 'zod';

export const JiraIssueKeySchema = z.string().regex(/^[A-Z][A-Z0-9_]+-[1-9][0-9]*$/u);

export const JiraPersonSchema = z
  .object({
    displayName: z.string().min(1),
  })
  .strict();

export const JiraAttachmentSchema = z
  .object({
    id: z.string().min(1),
    filename: z.string().min(1),
    mimeType: z.string().min(1),
    size: z.number().int().nonnegative(),
    createdAt: z.iso.datetime(),
    contentUrl: z.url(),
    thumbnailUrl: z.url().optional(),
  })
  .strict();

export const JiraCommentSchema = z
  .object({
    id: z.string().min(1),
    author: JiraPersonSchema,
    body: z.string(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

export const JiraIssueLinkSchema = z
  .object({
    issueKey: JiraIssueKeySchema,
    summary: z.string().min(1),
    relationship: z.string().min(1),
    status: z.string().min(1),
  })
  .strict();

export const JiraIssueSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    issueKey: JiraIssueKeySchema,
    issueId: z.string().min(1),
    browseUrl: z.url(),
    summary: z.string().min(1),
    description: z.string(),
    issueType: z.string().min(1),
    status: z.string().min(1),
    priority: z.string().min(1),
    labels: z.array(z.string().min(1)),
    assignee: JiraPersonSchema.nullable(),
    reporter: JiraPersonSchema.nullable(),
    repositoryHint: z.string().min(1).nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    syncedAt: z.iso.datetime(),
    attachments: z.array(JiraAttachmentSchema),
    comments: z.array(JiraCommentSchema),
    links: z.array(JiraIssueLinkSchema),
  })
  .strict();

export const JiraSyncProblemSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('not_configured'),
      message: z.string().min(1),
      retryable: z.literal(false),
    })
    .strict(),
  z
    .object({
      kind: z.literal('access_blocked'),
      message: z.string().min(1),
      retryable: z.literal(true),
      httpStatus: z.literal(403),
    })
    .strict(),
  z
    .object({
      kind: z.literal('auth_failed'),
      message: z.string().min(1),
      retryable: z.literal(false),
      httpStatus: z.literal(401),
    })
    .strict(),
  z
    .object({
      kind: z.literal('not_found'),
      message: z.string().min(1),
      retryable: z.literal(false),
      httpStatus: z.literal(404),
    })
    .strict(),
  z
    .object({
      kind: z.literal('unavailable'),
      message: z.string().min(1),
      retryable: z.literal(true),
      httpStatus: z.number().int().positive().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('invalid_response'),
      message: z.string().min(1),
      retryable: z.literal(false),
    })
    .strict(),
  z
    .object({
      kind: z.literal('attachment_too_large'),
      message: z.string().min(1),
      retryable: z.literal(false),
    })
    .strict(),
]);

export const JiraIssueStateSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('current'),
      issue: JiraIssueSnapshotSchema,
      lastSuccessfulSyncAt: z.iso.datetime(),
      recordedAt: z.iso.datetime(),
    })
    .strict(),
  z
    .object({
      status: z.literal('stale'),
      issue: JiraIssueSnapshotSchema,
      lastSuccessfulSyncAt: z.iso.datetime(),
      recordedAt: z.iso.datetime(),
      problem: JiraSyncProblemSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal('unavailable'),
      issueKey: JiraIssueKeySchema,
      lastSuccessfulSyncAt: z.null(),
      recordedAt: z.iso.datetime(),
      problem: JiraSyncProblemSchema,
    })
    .strict(),
]);

export type JiraIssueKey = z.infer<typeof JiraIssueKeySchema>;
export type JiraAttachment = z.infer<typeof JiraAttachmentSchema>;
export type JiraIssueSnapshot = z.infer<typeof JiraIssueSnapshotSchema>;
export type JiraSyncProblem = z.infer<typeof JiraSyncProblemSchema>;
export type JiraIssueState = z.infer<typeof JiraIssueStateSchema>;
