import { z } from 'zod';

export const TaskStepEvidenceArtifactSchema = z
  .object({
    schemaVersion: z.literal(1),
    operationId: z.string().min(1),
    relativePath: z.string().min(1),
    contentSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    byteLength: z.number().int().nonnegative(),
    mimeType: z.string().min(1),
    recordedAt: z.iso.datetime(),
  })
  .strict();

export type TaskStepEvidenceArtifact = z.infer<typeof TaskStepEvidenceArtifactSchema>;
