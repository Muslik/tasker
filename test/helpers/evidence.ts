import { EvidenceBundleSchema, type EvidenceBundle } from '../../src/planning/evidence-bundle.js';
import { EvidenceBundleStore } from '../../src/server/evidence-bundle.js';
import type { LedgerRepository } from '../../src/store/repository.js';
import type { Clock } from '../../src/shared/clock.js';

export const makeEvidenceBundle = (
  taskReference = 'jira:AVIA-13235',
  scopeId = `test:${taskReference}`,
): EvidenceBundle =>
  EvidenceBundleSchema.parse({
    schemaVersion: 2,
    scopeId,
    taskReference,
    revision: 1,
    inputFingerprint: '1'.repeat(64),
    parent: null,
    entries: [
      {
        evidenceId: `evidence:${'2'.repeat(64)}`,
        evidenceType: 'task_snapshot',
        title: `Task snapshot for ${taskReference}`,
        provenance: {
          source: { kind: 'task_system', locator: taskReference },
          capturedAt: '2026-08-05T00:00:00.000Z',
          observedVersion: '2026-08-05T00:00:00.000Z',
          contentSha256: '3'.repeat(64),
          mediaType: 'application/json',
          introducedBy: { phase: 'context_discovery', operationId: null },
        },
        content: { taskReference },
      },
    ],
    createdAt: '2026-08-05T00:00:00.000Z',
  });

export const recordTestEvidenceBundle = (
  ledger: LedgerRepository,
  clock: Clock,
  taskReference: string,
): void => {
  const bundle = makeEvidenceBundle(taskReference);
  const recorded = new EvidenceBundleStore(ledger, clock).record(
    `test:${taskReference}`,
    taskReference,
    bundle.inputFingerprint,
    bundle.entries,
  );
  if (!recorded.ok) throw new Error(`Test evidence failed: ${recorded.error.kind}`);
};
