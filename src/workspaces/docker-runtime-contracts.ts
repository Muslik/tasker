import { z } from 'zod';

import { WorkspaceRuntimeSchema } from '../harness/contracts.js';

const ContentHashSchema = z.string().regex(/^[a-f0-9]{64}$/u);

export const DockerWorkspaceRuntimeReceiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    workspaceId: z.string().regex(/^[a-f0-9]{24}$/u),
    workspacePath: z.string().min(1),
    repositorySourcePath: z.string().min(1),
    policyHash: ContentHashSchema,
    policy: WorkspaceRuntimeSchema,
    image: z.string().min(1),
    imageId: z.string().min(1),
    networkName: z.string().min(1),
    volumes: z.array(
      z
        .object({
          id: z.string().min(1),
          name: z.string().min(1),
          mountPath: z.string().min(1),
        })
        .strict(),
    ),
    services: z.array(
      z
        .object({
          id: z.string().min(1),
          containerName: z.string().min(1),
        })
        .strict(),
    ),
    environment: z.record(z.string(), z.string()),
    initializedVolumes: z.array(z.string().min(1)),
    completedBootstrap: z.array(ContentHashSchema),
    status: z.enum(['preparing', 'ready']),
    preparedAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict()
  .readonly();

export type DockerWorkspaceRuntimeReceipt = z.infer<typeof DockerWorkspaceRuntimeReceiptSchema>;

export type DockerWorkspaceRuntimeError =
  | { readonly kind: 'docker_unavailable'; readonly message: string }
  | { readonly kind: 'image_unavailable'; readonly image: string; readonly message: string }
  | { readonly kind: 'runtime_conflict'; readonly message: string }
  | { readonly kind: 'bootstrap_failed'; readonly command: string; readonly message: string }
  | { readonly kind: 'service_failed'; readonly service: string; readonly message: string }
  | { readonly kind: 'store_failed'; readonly message: string };
