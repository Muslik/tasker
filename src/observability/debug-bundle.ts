import { systemClock, type Clock } from '../shared/clock.js';
import {
  redactionStatusSchema,
  sourceRedactionSummarySchema,
  type SourceRedactionSummary,
} from './redaction.js';
import { z } from 'zod';

const isoTimestampSchema = z.iso.datetime({ offset: true });
const nonEmptyStringSchema = z.string().min(1);

export const debugBundleEventReferenceSchema = z
  .object({
    eventId: nonEmptyStringSchema,
    kind: nonEmptyStringSchema.optional(),
    recordedAt: isoTimestampSchema.optional(),
  })
  .strict();

export type DebugBundleEventReference = z.infer<typeof debugBundleEventReferenceSchema>;

export const debugBundleArtifactLineageSchema = z
  .object({
    parentArtifactId: nonEmptyStringSchema.optional(),
    sourceEventId: nonEmptyStringSchema.optional(),
  })
  .strict();

export type DebugBundleArtifactLineage = z.infer<typeof debugBundleArtifactLineageSchema>;

export const debugBundleArtifactReferenceSchema = z
  .object({
    artifactId: nonEmptyStringSchema,
    kind: nonEmptyStringSchema,
    createdAt: isoTimestampSchema.optional(),
    redactionStatus: redactionStatusSchema,
    lineage: debugBundleArtifactLineageSchema.optional(),
  })
  .strict();

export type DebugBundleArtifactReference = z.infer<typeof debugBundleArtifactReferenceSchema>;

export const debugBundleRunVersionsSchema = z
  .object({
    run: nonEmptyStringSchema,
    workflow: nonEmptyStringSchema,
    schema: nonEmptyStringSchema,
  })
  .strict();

export type DebugBundleRunVersions = z.infer<typeof debugBundleRunVersionsSchema>;

export const debugBundleManifestSchema = z
  .object({
    manifestSchemaVersion: z.literal('debug-bundle-manifest.v1'),
    manifestId: nonEmptyStringSchema,
    createdAt: isoTimestampSchema,
    run: z
      .object({
        runId: nonEmptyStringSchema,
        workflowId: nonEmptyStringSchema,
        versions: debugBundleRunVersionsSchema,
      })
      .strict(),
    events: z.array(debugBundleEventReferenceSchema),
    artifacts: z.array(debugBundleArtifactReferenceSchema),
    redaction: sourceRedactionSummarySchema,
  })
  .strict();

export type DebugBundleManifest = z.infer<typeof debugBundleManifestSchema>;

export interface DebugBundleManifestInput {
  readonly manifestId?: string;
  readonly run: {
    readonly runId: string;
    readonly workflowId: string;
    readonly versions: DebugBundleRunVersions;
  };
  readonly events?: readonly DebugBundleEventReference[];
  readonly artifacts?: readonly DebugBundleArtifactReference[];
  readonly redaction: SourceRedactionSummary;
}

export interface DebugBundleManifestBuilderDeps {
  readonly clock?: Clock;
}

const compareOptional = (left: string | undefined, right: string | undefined): number =>
  (left ?? '').localeCompare(right ?? '');

const compareEventReferences = (
  left: DebugBundleEventReference,
  right: DebugBundleEventReference,
): number =>
  compareOptional(left.recordedAt, right.recordedAt) ||
  compareOptional(left.kind, right.kind) ||
  left.eventId.localeCompare(right.eventId);

const compareArtifactReferences = (
  left: DebugBundleArtifactReference,
  right: DebugBundleArtifactReference,
): number =>
  left.kind.localeCompare(right.kind) ||
  left.artifactId.localeCompare(right.artifactId) ||
  compareOptional(left.createdAt, right.createdAt) ||
  left.redactionStatus.localeCompare(right.redactionStatus) ||
  compareOptional(left.lineage?.parentArtifactId, right.lineage?.parentArtifactId) ||
  compareOptional(left.lineage?.sourceEventId, right.lineage?.sourceEventId);

const normalizeArtifactReference = (
  artifact: DebugBundleArtifactReference,
): DebugBundleArtifactReference => ({
  artifactId: artifact.artifactId,
  kind: artifact.kind,
  redactionStatus: artifact.redactionStatus,
  ...(artifact.createdAt === undefined ? {} : { createdAt: artifact.createdAt }),
  ...(artifact.lineage === undefined
    ? {}
    : {
        lineage: {
          ...(artifact.lineage.parentArtifactId === undefined
            ? {}
            : { parentArtifactId: artifact.lineage.parentArtifactId }),
          ...(artifact.lineage.sourceEventId === undefined
            ? {}
            : { sourceEventId: artifact.lineage.sourceEventId }),
        },
      }),
});

export const buildDebugBundleManifest = (
  input: DebugBundleManifestInput,
  deps: DebugBundleManifestBuilderDeps = {},
): DebugBundleManifest => {
  const createdAt = (deps.clock ?? systemClock).now();

  // Sort references so identical content produces a byte-stable manifest regardless of collection order.
  const events = [...(input.events ?? [])]
    .map((event) => debugBundleEventReferenceSchema.parse(event))
    .sort(compareEventReferences);
  const artifacts = [...(input.artifacts ?? [])]
    .map((artifact) =>
      normalizeArtifactReference(debugBundleArtifactReferenceSchema.parse(artifact)),
    )
    .sort(compareArtifactReferences);

  return debugBundleManifestSchema.parse({
    manifestSchemaVersion: 'debug-bundle-manifest.v1',
    manifestId: input.manifestId ?? `debug-bundle:${input.run.runId}:${createdAt}`,
    createdAt,
    run: {
      runId: input.run.runId,
      workflowId: input.run.workflowId,
      versions: debugBundleRunVersionsSchema.parse(input.run.versions),
    },
    events,
    artifacts,
    redaction: sourceRedactionSummarySchema.parse(input.redaction),
  });
};
