import { checksumString } from '../store/checksum.js';
import type { BlockReceipt } from '../steps/index.js';
import type { LedgerRepository } from '../store/repository.js';
import type { DocumentConflict, JsonValue, LedgerConflict } from '../store/types.js';
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
import { JsonValueSchema } from '../graph/schema.js';

export const EVIDENCE_BUNDLE_PROJECTION = 'evidence_bundle_reference';

export interface EvidenceBundleRecord {
  readonly reference: EvidenceBundleReference;
  readonly bundle: EvidenceBundle;
}

export type EvidenceBundleStoreError =
  | { readonly kind: 'ledger_conflict'; readonly conflict: LedgerConflict }
  | { readonly kind: 'bundle_not_found'; readonly artifactId: string }
  | {
      readonly kind: 'bundle_reference_corrupt';
      readonly scopeId: string;
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
const MAX_INLINE_EXTERNAL_EVIDENCE_BYTES = 64 * 1024;

const ledgerConflictFromDocumentConflict = (conflict: DocumentConflict): LedgerConflict => ({
  kind: 'version_conflict',
  aggregateId: `document:${conflict.documentKind}:${conflict.documentId}`,
  expectedVersion: conflict.expectedRevision,
  actualVersion: conflict.actualRevision,
});

export class EvidenceBundleStore {
  public constructor(
    private readonly ledger: LedgerRepository,
    private readonly clock: Clock,
  ) {}

  public readLatest(
    scopeId: string,
  ): Outcome<EvidenceBundleRecord | null, EvidenceBundleStoreError> {
    const document = this.ledger.readDocument(EVIDENCE_BUNDLE_PROJECTION, scopeId);
    if (document === null) return ok(null);
    const parsed = EvidenceBundleReferenceSchema.safeParse(document.payload);
    if (!parsed.success) {
      return err({
        kind: 'bundle_reference_corrupt',
        scopeId,
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
    scopeId: string,
    taskReference: string,
    inputFingerprint: string,
    entriesInput: readonly EvidenceEntry[],
  ): Outcome<EvidenceBundleRecord, EvidenceBundleStoreError> {
    const entries = entriesInput.map((entry) => EvidenceEntrySchema.parse(entry));
    let lastConflict: LedgerConflict | null = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const latest = this.readLatest(scopeId);
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
        schemaVersion: 2,
        scopeId,
        taskReference,
        revision,
        inputFingerprint,
        parent: latest.value?.reference ?? null,
        entries: [...mergedEntries.values()],
        createdAt,
      });
      const artifactId = `evidence-bundle:${scopeId}:r${String(revision)}:${inputFingerprint.slice(0, 16)}`;
      this.ledger.insertArtifact({
        artifactId,
        artifactKind: 'evidence_bundle',
        taskReference,
        storageUri: `ledger://artifacts/${encodeURIComponent(artifactId)}`,
        payload: asJson(bundle),
        metadata: asJson({ scopeId, taskReference, revision, inputFingerprint }),
        createdAt,
        ...(latest.value === null ? {} : { parentArtifactId: latest.value.reference.artifactId }),
      });

      const artifact = this.ledger.readArtifact(artifactId);
      if (artifact === null) return err({ kind: 'bundle_not_found', artifactId });

      const saved = this.ledger.appendDocument(
        EVIDENCE_BUNDLE_PROJECTION,
        scopeId,
        latest.value?.bundle.revision ?? 0,
        asJson({
          artifactId,
          checksum: artifact.checksum,
          revision,
        }),
        createdAt,
      );
      if (!saved.ok) {
        lastConflict = ledgerConflictFromDocumentConflict(saved.error);
        const concurrent = this.readLatest(scopeId);
        if (!concurrent.ok) return concurrent;
        if (concurrent.value?.bundle.inputFingerprint === inputFingerprint)
          return ok(concurrent.value);
        continue;
      }

      return ok({
        reference: EvidenceBundleReferenceSchema.parse({
          artifactId,
          checksum: artifact.checksum,
          revision,
        }),
        bundle,
      });
    }

    if (lastConflict === null) {
      throw new Error('Evidence bundle retry budget exhausted without conflict');
    }
    return err({ kind: 'ledger_conflict', conflict: lastConflict });
  }

  public appendPlanningEvidence(
    baseReference: EvidenceBundleReference,
    operationId: string,
    capturesInput: readonly PlanningEvidenceCapture[],
  ): Outcome<EvidenceBundleRecord, EvidenceBundleStoreError> {
    const base = this.read(baseReference);
    if (!base.ok) return base;
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
              base.value.bundle.taskReference,
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
    const evidenceIds = new Set(base.value.bundle.entries.map(({ evidenceId }) => evidenceId));
    for (const entry of entries) evidenceIds.add(entry.evidenceId);
    const inputFingerprint = checksumString(JSON.stringify([...evidenceIds].sort()));
    return this.record(
      base.value.bundle.scopeId,
      base.value.bundle.taskReference,
      inputFingerprint,
      entries,
    );
  }

  public appendInvestigationEvidence(
    baseReference: EvidenceBundleReference,
    operationId: string,
    receipts: readonly BlockReceipt[],
  ): Outcome<EvidenceBundleRecord, EvidenceBundleStoreError> {
    const entries = receipts.map((receipt) => {
      const content = asJson(receipt);
      const contentSha256 = checksumString(JSON.stringify(content));
      return evidenceEntry({
        evidenceType: 'investigation_result',
        title: `${receipt.blockReference}: ${receipt.claim.summary}`,
        source: { kind: 'block_receipt', locator: receipt.receiptId },
        capturedAt: receipt.completedAt,
        observedVersion: receipt.blockDefinitionHash,
        mediaType: 'application/vnd.tasker.block-receipt+json',
        introducedBy: { phase: 'investigation', operationId },
        content,
        contentSha256,
      });
    });
    const base = this.read(baseReference);
    if (!base.ok) return base;
    const evidenceIds = new Set(base.value.bundle.entries.map(({ evidenceId }) => evidenceId));
    for (const entry of entries) evidenceIds.add(entry.evidenceId);
    const inputFingerprint = checksumString(JSON.stringify([...evidenceIds].sort()));
    return this.record(
      base.value.bundle.scopeId,
      base.value.bundle.taskReference,
      inputFingerprint,
      entries,
    );
  }

  private recordEvidenceBody(
    content: JsonValue,
    mediaType: string,
    contentSha256: string,
    taskReference: string,
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
    this.ledger.insertArtifact({
      artifactId,
      artifactKind: 'evidence_body',
      taskReference,
      storageUri: `ledger://artifacts/${encodeURIComponent(artifactId)}`,
      payload: content,
      metadata: asJson({ mediaType, contentSha256 }),
      createdAt,
    });

    const artifact = this.ledger.readArtifact(artifactId);
    if (artifact === null) {
      return err({
        kind: 'ledger_conflict',
        conflict: {
          kind: 'version_conflict',
          aggregateId: `artifact:${artifactId}`,
          expectedVersion: 0,
          actualVersion: 0,
        },
      });
    }
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
    return this.store.record(input.operationId, input.taskReference, inputFingerprint, entries);
  }
}
