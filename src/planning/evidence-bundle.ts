import { z } from 'zod';

import { JsonValueSchema } from '../graph/schema.js';

export const EvidenceContentHashSchema = z.string().regex(/^[a-f0-9]{64}$/u);

export const EvidenceBundleReferenceSchema = z
  .object({
    artifactId: z.string().min(1),
    checksum: EvidenceContentHashSchema,
    revision: z.number().int().positive(),
  })
  .strict()
  .readonly();

export const EvidenceBodyReferenceSchema = z
  .object({
    kind: z.literal('artifact'),
    artifactId: z.string().min(1),
    checksum: EvidenceContentHashSchema,
    byteLength: z.number().int().positive(),
    mediaType: z.string().min(1),
  })
  .strict()
  .readonly();

export const EvidenceSourceSchema = z
  .object({
    kind: z.enum([
      'task_system',
      'repository',
      'harness',
      'operator',
      'external_system',
      'block_receipt',
    ]),
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
        phase: z.enum([
          'context_discovery',
          'investigation',
          'planning',
          'operator',
          'continuation',
        ]),
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
      'investigation_result',
    ]),
    title: z.string().min(1).max(300),
    provenance: EvidenceProvenanceSchema,
    content: JsonValueSchema,
  })
  .strict()
  .readonly();

export const EvidenceBundleSchema = z
  .object({
    schemaVersion: z.literal(2),
    scopeId: z.string().min(1),
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
export type EvidenceBodyReference = z.infer<typeof EvidenceBodyReferenceSchema>;
export type EvidenceSource = z.infer<typeof EvidenceSourceSchema>;
export type EvidenceEntry = z.infer<typeof EvidenceEntrySchema>;
export type EvidenceBundle = z.infer<typeof EvidenceBundleSchema>;
