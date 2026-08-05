import { z } from 'zod';

import { JsonValueSchema } from '../workflow/schema.js';

export const EvidenceContentHashSchema = z.string().regex(/^[a-f0-9]{64}$/u);

export const EvidenceBundleReferenceSchema = z
  .object({
    artifactId: z.string().min(1),
    checksum: EvidenceContentHashSchema,
    revision: z.number().int().positive(),
  })
  .strict()
  .readonly();

export const EvidenceSourceSchema = z
  .object({
    kind: z.enum(['task_system', 'repository', 'harness', 'operator', 'external_system']),
    locator: z.string().min(1),
  })
  .strict()
  .readonly();

export const EvidenceProvenanceSchema = z
  .object({
    source: EvidenceSourceSchema,
    capturedAt: z.iso.datetime(),
    observedVersion: z.string().min(1),
    contentSha256: EvidenceContentHashSchema,
    mediaType: z.string().min(1),
    introducedBy: z
      .object({
        phase: z.enum(['context_discovery', 'planning', 'operator', 'continuation']),
        operationId: z.string().min(1).nullable(),
      })
      .strict()
      .readonly(),
  })
  .strict()
  .readonly();

export const EvidenceEntrySchema = z
  .object({
    evidenceId: z.string().regex(/^evidence:[a-f0-9]{64}$/u),
    evidenceType: z.enum([
      'task_snapshot',
      'repository_inventory',
      'repository_document',
      'harness_context',
      'operator_guidance',
      'external_document',
    ]),
    title: z.string().min(1).max(300),
    provenance: EvidenceProvenanceSchema,
    content: JsonValueSchema,
  })
  .strict()
  .readonly();

export const EvidenceBundleSchema = z
  .object({
    schemaVersion: z.literal(1),
    taskReference: z.string().min(1),
    revision: z.number().int().positive(),
    inputFingerprint: EvidenceContentHashSchema,
    parent: EvidenceBundleReferenceSchema.nullable(),
    entries: z.array(EvidenceEntrySchema).min(1),
    createdAt: z.iso.datetime(),
  })
  .strict()
  .readonly();

export type EvidenceBundleReference = z.infer<typeof EvidenceBundleReferenceSchema>;
export type EvidenceSource = z.infer<typeof EvidenceSourceSchema>;
export type EvidenceEntry = z.infer<typeof EvidenceEntrySchema>;
export type EvidenceBundle = z.infer<typeof EvidenceBundleSchema>;
