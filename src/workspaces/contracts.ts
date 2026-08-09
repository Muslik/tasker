import { z } from 'zod';

const ContentHashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const GitObjectIdSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u);

export const PrepareWorkspaceRequestSchema = z
  .object({
    taskReference: z.string().min(1),
    workflowId: z.string().min(1),
    workflowRunId: z.string().min(1),
    repositoryReference: z.string().min(1),
    repositoryPath: z.string().min(1),
  })
  .strict()
  .readonly();

export const WorkspaceLocatorSchema = z
  .object({
    schemaVersion: z.literal(1),
    workspaceId: z.string().regex(/^[a-f0-9]{24}$/u),
    taskReference: z.string().min(1),
    workflowId: z.string().min(1),
    workflowRunId: z.string().min(1),
    repository: z
      .object({
        reference: z.string().min(1),
        sourcePath: z.string().min(1),
        baseCommit: GitObjectIdSchema,
      })
      .strict(),
    runnerId: z.string().min(1),
    path: z.string().min(1),
    branch: z.string().min(1),
    preparedAt: z.iso.datetime(),
  })
  .strict()
  .readonly();

export const WorkspaceBootstrapReceiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    operationId: z.string().min(1),
    workspaceId: z.string().regex(/^[a-f0-9]{24}$/u),
    adapterId: z.string().min(1),
    adapterVersion: z.string().min(1),
    profile: z.string().min(1),
    files: z.array(
      z
        .object({
          relativePath: z
            .string()
            .min(1)
            .refine((value) => !value.startsWith('/') && !value.split('/').includes('..')),
          sha256: ContentHashSchema,
        })
        .strict(),
    ),
    completedAt: z.iso.datetime(),
  })
  .strict()
  .readonly();

export type PrepareWorkspaceRequest = z.infer<typeof PrepareWorkspaceRequestSchema>;
export type WorkspaceLocator = z.infer<typeof WorkspaceLocatorSchema>;
export type WorkspaceBootstrapReceipt = z.infer<typeof WorkspaceBootstrapReceiptSchema>;
