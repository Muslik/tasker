import { checksumString } from '../ledger/checksum.js';
import type { LedgerRepository } from '../ledger/repository.js';
import type { JsonValue, LedgerConflict } from '../ledger/types.js';
import {
  EvidenceBundleReferenceSchema,
  EvidenceBodyReferenceSchema,
  EvidenceBundleSchema,
  EvidenceEntrySchema,
  PlanningEvidenceCaptureSchema,
  collectRepositoryEvidence,
  type EvidenceBundle,
  type EvidenceBodyReference,
  type EvidenceBundleReference,
  type EvidenceEntry,
  type PlanningEvidenceCapture,
} from '../planning/index.js';
import type { Clock } from '../shared/clock.js';
import { err, ok, type Outcome } from '../shared/outcome.js';
import { JsonValueSchema } from '../workflow/schema.js';

export const EVIDENCE_BUNDLE_PROJECTION = 'evidence_bundle_by_task';

export interface EvidenceBundleRecord {
  readonly reference: EvidenceBundleReference;
  readonly bundle: EvidenceBundle;
}

export type EvidenceBundleStoreError =
  | { readonly kind: 'ledger_conflict'; readonly conflict: LedgerConflict }
  | { readonly kind: 'bundle_not_found'; readonly artifactId: string }
  | {
      readonly kind: 'bundle_reference_corrupt';
      readonly taskReference: string;
      readonly issues: readonly string[];
    }
  | {
      readonly kind: 'bundle_corrupt';
      readonly artifactId: string;
      readonly issues: readonly string[];
    }
  | {
      readonly kind: 'bundle_checksum_mismatch';
      readonly artifactId: string;
      readonly expectedChecksum: string;
      readonly actualChecksum: string;
    }
  | {
      readonly kind: 'bundle_revision_mismatch';
      readonly artifactId: string;
      readonly expectedRevision: number;
      readonly actualRevision: number;
    }
  | { readonly kind: 'body_not_found'; readonly artifactId: string }
  | {
      readonly kind: 'body_checksum_mismatch';
      readonly artifactId: string;
      readonly expectedChecksum: string;
      readonly actualChecksum: string;
    };

const asJson = (value: unknown): JsonValue => JsonValueSchema.parse(value);
const aggregateIdFor = (taskReference: string): string => `evidence-bundle:${taskReference}`;
const MAX_INLINE_EXTERNAL_EVIDENCE_BYTES = 64 * 1024;

export class EvidenceBundleStore {
  public constructor(
    private readonly ledger: LedgerRepository,
    private readonly clock: Clock,
  ) {}

  public readLatest(
    taskReference: string,
  ): Outcome<EvidenceBundleRecord | null, EvidenceBundleStoreError> {
    const projection = this.ledger.readProjection(EVIDENCE_BUNDLE_PROJECTION, taskReference);
    if (projection === null) return ok(null);
    const parsed = EvidenceBundleReferenceSchema.safeParse(projection.payload);
    if (!parsed.success) {
      return err({
        kind: 'bundle_reference_corrupt',
        taskReference,
        issues: parsed.error.issues.map(
          (issue) => `${issue.path.map(String).join('.')}: ${issue.message}`,
        ),
      });
    }
    return this.read(parsed.data);
  }

  public read(
    referenceInput: EvidenceBundleReference,
  ): Outcome<EvidenceBundleRecord, EvidenceBundleStoreError> {
    const reference = EvidenceBundleReferenceSchema.parse(referenceInput);
    const artifact = this.ledger.readArtifact(reference.artifactId);
    if (artifact === null) {
      return err({ kind: 'bundle_not_found', artifactId: reference.artifactId });
    }
    if (artifact.checksum !== reference.checksum) {
      return err({
        kind: 'bundle_checksum_mismatch',
        artifactId: reference.artifactId,
        expectedChecksum: reference.checksum,
        actualChecksum: artifact.checksum,
      });
    }
    const parsed = EvidenceBundleSchema.safeParse(artifact.payload);
    if (!parsed.success) {
      return err({
        kind: 'bundle_corrupt',
        artifactId: reference.artifactId,
        issues: parsed.error.issues.map(
          (issue) => `${issue.path.map(String).join('.')}: ${issue.message}`,
        ),
      });
    }
    if (parsed.data.revision !== reference.revision) {
      return err({
        kind: 'bundle_revision_mismatch',
        artifactId: reference.artifactId,
        expectedRevision: reference.revision,
        actualRevision: parsed.data.revision,
      });
    }
    return ok({ reference, bundle: parsed.data });
  }

  public readMaterialized(
    referenceInput: EvidenceBundleReference,
  ): Outcome<EvidenceBundleRecord, EvidenceBundleStoreError> {
    const stored = this.read(referenceInput);
    if (!stored.ok) return stored;
    const entries: EvidenceEntry[] = [];
    for (const entry of stored.value.bundle.entries) {
      const reference = EvidenceBodyReferenceSchema.safeParse(entry.content);
      if (!reference.success) {
        entries.push(entry);
        continue;
      }
      const artifact = this.ledger.readArtifact(reference.data.artifactId);
      if (artifact === null) {
        return err({ kind: 'body_not_found', artifactId: reference.data.artifactId });
      }
      if (artifact.checksum !== reference.data.checksum) {
        return err({
          kind: 'body_checksum_mismatch',
          artifactId: reference.data.artifactId,
          expectedChecksum: reference.data.checksum,
          actualChecksum: artifact.checksum,
        });
      }
      entries.push(EvidenceEntrySchema.parse({ ...entry, content: artifact.payload }));
    }
    return ok({
      reference: stored.value.reference,
      bundle: EvidenceBundleSchema.parse({ ...stored.value.bundle, entries }),
    });
  }

  public record(
    taskReference: string,
    inputFingerprint: string,
    entriesInput: readonly EvidenceEntry[],
  ): Outcome<EvidenceBundleRecord, EvidenceBundleStoreError> {
    const entries = entriesInput.map((entry) => EvidenceEntrySchema.parse(entry));
    let lastConflict: LedgerConflict | null = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const latest = this.readLatest(taskReference);
      if (!latest.ok) return latest;
      if (latest.value?.bundle.inputFingerprint === inputFingerprint) return ok(latest.value);

      const createdAt = this.clock.now();
      const revision = (latest.value?.bundle.revision ?? 0) + 1;
      const mergedEntries = new Map(
        (latest.value?.bundle.entries ?? []).map((entry) => [entry.evidenceId, entry] as const),
      );
      for (const entry of entries) {
        if (!mergedEntries.has(entry.evidenceId)) mergedEntries.set(entry.evidenceId, entry);
      }
      const bundle = EvidenceBundleSchema.parse({
        schemaVersion: 1,
        taskReference,
        revision,
        inputFingerprint,
        parent: latest.value?.reference ?? null,
        entries: [...mergedEntries.values()],
        createdAt,
      });
      const artifactId = `${aggregateIdFor(taskReference)}:r${String(revision)}:${inputFingerprint.slice(0, 16)}`;
      const saved = this.ledger.transact({
        aggregate: {
          aggregateId: aggregateIdFor(taskReference),
          expectedVersion: revision - 1,
          events: [
            {
              eventId: `event:${artifactId}`,
              eventType: 'EvidenceBundleRevisionRecorded',
              eventSchemaVersion: 1,
              payload: asJson({ artifactId, inputFingerprint, revision }),
              actor: 'evidence_recorder',
            },
          ],
        },
        artifacts: [
          {
            artifactId,
            artifactKind: 'evidence_bundle',
            storageUri: `ledger://artifacts/${encodeURIComponent(artifactId)}`,
            payload: asJson(bundle),
            metadata: asJson({ taskReference, revision, inputFingerprint }),
            createdAt,
            ...(latest.value === null
              ? {}
              : { parentArtifactId: latest.value.reference.artifactId }),
          },
        ],
        projections: [
          {
            kind: 'upsert',
            projectionType: EVIDENCE_BUNDLE_PROJECTION,
            projectionId: taskReference,
            payload: asJson({
              artifactId,
              checksum: checksumString(JSON.stringify(bundle)),
              revision,
            }),
          },
        ],
        timestamp: createdAt,
      });
      if (!saved.ok) {
        if (saved.error.kind === 'version_conflict') {
          lastConflict = saved.error;
          continue;
        }
        return err({ kind: 'ledger_conflict', conflict: saved.error });
      }

      const artifact = this.ledger.readArtifact(artifactId);
      if (artifact === null) return err({ kind: 'bundle_not_found', artifactId });
      return ok({
        reference: EvidenceBundleReferenceSchema.parse({
          artifactId,
          checksum: artifact.checksum,
          revision,
        }),
        bundle,
      });
    }

    if (lastConflict === null)
      throw new Error('Evidence bundle retry budget exhausted without conflict');
    return err({ kind: 'ledger_conflict', conflict: lastConflict });
  }

  public appendPlanningEvidence(
    taskReference: string,
    operationId: string,
    capturesInput: readonly PlanningEvidenceCapture[],
  ): Outcome<EvidenceBundleRecord, EvidenceBundleStoreError> {
    const capturedAt = this.clock.now();
    const entries: EvidenceEntry[] = [];
    for (const capture of capturesInput.map((value) =>
      PlanningEvidenceCaptureSchema.parse(value),
    )) {
      const serialized = JSON.stringify(capture.observation.content);
      const contentSha256 = checksumString(serialized);
      const content =
        Buffer.byteLength(serialized, 'utf8') > MAX_INLINE_EXTERNAL_EVIDENCE_BYTES
          ? this.recordEvidenceBody(
              capture.observation.content,
              capture.observation.mediaType,
              contentSha256,
            )
          : ok(capture.observation.content);
      if (!content.ok) return content;
      entries.push(
        evidenceEntry({
          evidenceType: 'external_document',
          title: capture.observation.title,
          source: {
            kind: 'external_system',
            locator: `${capture.observation.skill}:${capture.observation.locator}`,
          },
          capturedAt,
          observedVersion: capture.observation.observedVersion,
          mediaType: capture.observation.mediaType,
          introducedBy: { phase: 'planning', operationId },
          content: content.value,
          contentSha256,
        }),
      );
    }
    const latest = this.readLatest(taskReference);
    if (!latest.ok) return latest;
    const evidenceIds = new Set(latest.value?.bundle.entries.map(({ evidenceId }) => evidenceId));
    for (const entry of entries) evidenceIds.add(entry.evidenceId);
    const inputFingerprint = checksumString(JSON.stringify([...evidenceIds].sort()));
    return this.record(taskReference, inputFingerprint, entries);
  }

  private recordEvidenceBody(
    content: JsonValue,
    mediaType: string,
    contentSha256: string,
  ): Outcome<EvidenceBodyReference, EvidenceBundleStoreError> {
    const artifactId = `evidence-body:${contentSha256}`;
    const existing = this.ledger.readArtifact(artifactId);
    if (existing !== null) {
      return ok(
        EvidenceBodyReferenceSchema.parse({
          kind: 'artifact',
          artifactId,
          checksum: existing.checksum,
          byteLength: Buffer.byteLength(JSON.stringify(content), 'utf8'),
          mediaType,
        }),
      );
    }
    const createdAt = this.clock.now();
    const recorded = this.ledger.transact({
      aggregate: {
        aggregateId: artifactId,
        expectedVersion: 0,
        events: [
          {
            eventId: `event:${artifactId}`,
            eventType: 'EvidenceBodyRecorded',
            eventSchemaVersion: 1,
            payload: asJson({ artifactId, contentSha256 }),
            actor: 'evidence_recorder',
          },
        ],
      },
      artifacts: [
        {
          artifactId,
          artifactKind: 'evidence_body',
          storageUri: `ledger://artifacts/${encodeURIComponent(artifactId)}`,
          payload: content,
          metadata: asJson({ mediaType, contentSha256 }),
          createdAt,
        },
      ],
      timestamp: createdAt,
    });
    if (!recorded.ok) {
      const concurrentlyRecorded = this.ledger.readArtifact(artifactId);
      if (concurrentlyRecorded === null) {
        return err({ kind: 'ledger_conflict', conflict: recorded.error });
      }
    }
    const artifact = this.ledger.readArtifact(artifactId);
    if (artifact === null) return err({ kind: 'body_not_found', artifactId });
    return ok(
      EvidenceBodyReferenceSchema.parse({
        kind: 'artifact',
        artifactId,
        checksum: artifact.checksum,
        byteLength: Buffer.byteLength(JSON.stringify(content), 'utf8'),
        mediaType,
      }),
    );
  }
}

const evidenceEntry = (input: {
  readonly evidenceType: EvidenceEntry['evidenceType'];
  readonly title: string;
  readonly source: EvidenceEntry['provenance']['source'];
  readonly capturedAt: string;
  readonly observedVersion: string;
  readonly mediaType: string;
  readonly introducedBy: EvidenceEntry['provenance']['introducedBy'];
  readonly content: JsonValue;
  readonly contentSha256?: string;
}): EvidenceEntry => {
  const contentSha256 =
    input.contentSha256 ??
    checksumString(
      typeof input.content === 'string' ? input.content : JSON.stringify(input.content),
    );
  const identity = checksumString(
    JSON.stringify({
      evidenceType: input.evidenceType,
      source: input.source,
      observedVersion: input.observedVersion,
      contentSha256,
    }),
  );
  return EvidenceEntrySchema.parse({
    evidenceId: `evidence:${identity}`,
    evidenceType: input.evidenceType,
    title: input.title,
    provenance: {
      source: input.source,
      capturedAt: input.capturedAt,
      observedVersion: input.observedVersion,
      contentSha256,
      mediaType: input.mediaType,
      introducedBy: input.introducedBy,
    },
    content: input.content,
  });
};

const taskObservedVersion = (taskSnapshot: JsonValue, fallback: string): string => {
  if (taskSnapshot === null || Array.isArray(taskSnapshot) || typeof taskSnapshot !== 'object') {
    return fallback;
  }
  const issue = taskSnapshot.issue;
  if (issue === null || Array.isArray(issue) || typeof issue !== 'object') return fallback;
  return typeof issue.updatedAt === 'string' && issue.updatedAt.length > 0
    ? issue.updatedAt
    : fallback;
};

export class ContextDiscoveryService {
  public constructor(
    private readonly store: EvidenceBundleStore,
    private readonly clock: Clock,
  ) {}

  public async discover(input: {
    readonly taskReference: string;
    readonly operationId: string;
    readonly taskSnapshot: JsonValue;
    readonly plannerContext: JsonValue;
    readonly repositoryReference: string;
    readonly repositoryPath: string;
  }): Promise<Outcome<EvidenceBundleRecord, EvidenceBundleStoreError>> {
    const capturedAt = this.clock.now();
    const repository = await collectRepositoryEvidence(input.repositoryPath, input.taskSnapshot);
    const taskContentSha256 = checksumString(JSON.stringify(input.taskSnapshot));
    const entries = [
      evidenceEntry({
        evidenceType: 'task_snapshot',
        title: `Task snapshot for ${input.taskReference}`,
        source: { kind: 'task_system', locator: input.taskReference },
        capturedAt,
        observedVersion: taskObservedVersion(input.taskSnapshot, taskContentSha256),
        mediaType: 'application/json',
        introducedBy: { phase: 'context_discovery', operationId: input.operationId },
        content: input.taskSnapshot,
      }),
      evidenceEntry({
        evidenceType: 'harness_context',
        title: `Applicable harness context for ${input.repositoryReference}`,
        source: { kind: 'harness', locator: input.repositoryReference },
        capturedAt,
        observedVersion: checksumString(JSON.stringify(input.plannerContext)),
        mediaType: 'application/json',
        introducedBy: { phase: 'context_discovery', operationId: input.operationId },
        content: input.plannerContext,
      }),
      evidenceEntry({
        evidenceType: 'repository_inventory',
        title: `Bounded repository inventory for ${input.repositoryReference}`,
        source: { kind: 'repository', locator: input.repositoryReference },
        capturedAt,
        observedVersion: repository.inventorySha256,
        mediaType: 'application/json',
        introducedBy: { phase: 'context_discovery', operationId: input.operationId },
        content: JsonValueSchema.parse({
          repositoryReference: input.repositoryReference,
          files: repository.files,
        }),
      }),
      ...repository.documents.map((document) =>
        evidenceEntry({
          evidenceType: 'repository_document',
          title: document.path,
          source: {
            kind: 'repository',
            locator: `${input.repositoryReference}#${document.path}`,
          },
          capturedAt,
          observedVersion: document.contentSha256,
          mediaType: 'text/plain',
          introducedBy: { phase: 'context_discovery', operationId: input.operationId },
          content: document.content,
        }),
      ),
    ];
    const inputFingerprint = checksumString(
      JSON.stringify(entries.map((entry) => entry.evidenceId).sort()),
    );
    return this.store.record(input.taskReference, inputFingerprint, entries);
  }
}
