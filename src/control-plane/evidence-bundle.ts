import { checksumString } from '../ledger/checksum.js';
import type { LedgerRepository } from '../ledger/repository.js';
import type { JsonValue, LedgerConflict } from '../ledger/types.js';
import {
  EvidenceBundleReferenceSchema,
  EvidenceBundleSchema,
  EvidenceEntrySchema,
  collectRepositoryEvidence,
  type EvidenceBundle,
  type EvidenceBundleReference,
  type EvidenceEntry,
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
    };

const asJson = (value: unknown): JsonValue => JsonValueSchema.parse(value);
const aggregateIdFor = (taskReference: string): string => `evidence-bundle:${taskReference}`;

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
}): EvidenceEntry => {
  const contentSha256 = checksumString(
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
        introducedBy: { phase: 'context_discovery', operationId: null },
        content: input.taskSnapshot,
      }),
      evidenceEntry({
        evidenceType: 'harness_context',
        title: `Applicable harness context for ${input.repositoryReference}`,
        source: { kind: 'harness', locator: input.repositoryReference },
        capturedAt,
        observedVersion: checksumString(JSON.stringify(input.plannerContext)),
        mediaType: 'application/json',
        introducedBy: { phase: 'context_discovery', operationId: null },
        content: input.plannerContext,
      }),
      evidenceEntry({
        evidenceType: 'repository_inventory',
        title: `Bounded repository inventory for ${input.repositoryReference}`,
        source: { kind: 'repository', locator: input.repositoryReference },
        capturedAt,
        observedVersion: repository.inventorySha256,
        mediaType: 'application/json',
        introducedBy: { phase: 'context_discovery', operationId: null },
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
          introducedBy: { phase: 'context_discovery', operationId: null },
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
