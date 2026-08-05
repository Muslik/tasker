import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ContextDiscoveryService,
  EvidenceBundleStore,
} from '../../src/control-plane/evidence-bundle.js';
import { openSqliteLedger } from '../../src/ledger/index.js';
import {
  EvidenceBodyReferenceSchema,
  EvidenceEntrySchema,
} from '../../src/planning/evidence-bundle.js';
import { makeAdjustableClock } from '../../src/shared/clock.js';

const entry = (suffix: string, capturedAt: string) =>
  EvidenceEntrySchema.parse({
    evidenceId: `evidence:${suffix.repeat(64)}`,
    evidenceType: 'external_document',
    title: `Evidence ${suffix}`,
    provenance: {
      source: { kind: 'external_system', locator: `external:${suffix}` },
      capturedAt,
      observedVersion: `version-${suffix}`,
      contentSha256: suffix.repeat(64),
      mediaType: 'text/plain',
      introducedBy: { phase: 'context_discovery', operationId: null },
    },
    content: `content-${suffix}`,
  });

describe('evidence bundle recovery', () => {
  it('deduplicates an observed state and appends new immutable revisions', () => {
    const directory = mkdtempSync(join(tmpdir(), 'tasker-evidence-store-'));
    const databasePath = join(directory, 'ledger.sqlite');
    const clock = makeAdjustableClock('2026-08-05T08:00:00.000Z');
    const firstLedger = openSqliteLedger({ filename: databasePath, clock });
    try {
      const store = new EvidenceBundleStore(firstLedger.repository, clock);
      const first = store.record('jira:AVIA-13235', '1'.repeat(64), [entry('a', clock.now())]);
      if (!first.ok) throw new Error(`First revision failed: ${first.error.kind}`);

      clock.advance(60_000);
      const duplicate = store.record('jira:AVIA-13235', '1'.repeat(64), [entry('a', clock.now())]);
      if (!duplicate.ok) throw new Error(`Duplicate revision failed: ${duplicate.error.kind}`);
      expect(duplicate.value.reference).toEqual(first.value.reference);
      expect(firstLedger.repository.listEvents('evidence-bundle:jira:AVIA-13235')).toHaveLength(1);

      const second = store.record('jira:AVIA-13235', '2'.repeat(64), [
        entry('a', clock.now()),
        entry('b', clock.now()),
      ]);
      if (!second.ok) throw new Error(`Second revision failed: ${second.error.kind}`);
      expect(second.value.bundle).toMatchObject({
        revision: 2,
        parent: first.value.reference,
      });
      expect(second.value.bundle.entries.map(({ evidenceId }) => evidenceId)).toEqual([
        `evidence:${'a'.repeat(64)}`,
        `evidence:${'b'.repeat(64)}`,
      ]);
      expect(second.value.bundle.entries[0]?.provenance.capturedAt).toBe(
        '2026-08-05T08:00:00.000Z',
      );
      firstLedger.close();

      const restartedLedger = openSqliteLedger({ filename: databasePath, clock });
      try {
        const restored = new EvidenceBundleStore(restartedLedger.repository, clock).readLatest(
          'jira:AVIA-13235',
        );
        expect(restored).toEqual(second);
      } finally {
        restartedLedger.close();
      }
    } finally {
      if (firstLedger.database.open) firstLedger.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('records bounded repository evidence once and appends a changed document version', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'tasker-context-discovery-'));
    const repositoryPath = join(directory, 'repository');
    const databasePath = join(directory, 'ledger.sqlite');
    const clock = makeAdjustableClock('2026-08-05T09:00:00.000Z');
    const ledger = openSqliteLedger({ filename: databasePath, clock });
    try {
      mkdirSync(repositoryPath, { recursive: true });
      writeFileSync(join(repositoryPath, 'README.md'), '# First policy\n', 'utf8');
      writeFileSync(join(repositoryPath, 'package.json'), '{"scripts":{"build":"vite build"}}\n');
      const discovery = new ContextDiscoveryService(
        new EvidenceBundleStore(ledger.repository, clock),
        clock,
      );
      const input = {
        taskReference: 'jira:AVIA-13235',
        taskSnapshot: { issue: { updatedAt: '2026-08-04T18:00:00.000Z' } },
        plannerContext: { harness: { companyVersion: '1' } },
        repositoryReference: 'onetwotrip/front-avia',
        repositoryPath,
      } as const;

      const first = await discovery.discover(input);
      if (!first.ok) throw new Error(`Discovery failed: ${first.error.kind}`);
      expect(first.value.bundle.entries.map(({ evidenceType }) => evidenceType)).toEqual(
        expect.arrayContaining([
          'task_snapshot',
          'harness_context',
          'repository_inventory',
          'repository_document',
        ]),
      );
      expect(
        first.value.bundle.entries.every(
          ({ provenance }) =>
            provenance.source.locator.length > 0 && provenance.contentSha256.length === 64,
        ),
      ).toBe(true);

      clock.advance(60_000);
      const unchanged = await discovery.discover(input);
      if (!unchanged.ok) throw new Error(`Repeated discovery failed: ${unchanged.error.kind}`);
      expect(unchanged.value.reference).toEqual(first.value.reference);

      writeFileSync(join(repositoryPath, 'README.md'), '# Second policy\n', 'utf8');
      clock.advance(60_000);
      const changed = await discovery.discover(input);
      if (!changed.ok) throw new Error(`Changed discovery failed: ${changed.error.kind}`);
      expect(changed.value.bundle.revision).toBe(2);
      expect(
        changed.value.bundle.entries.filter(
          ({ provenance }) => provenance.source.locator === 'onetwotrip/front-avia#README.md',
        ),
      ).toHaveLength(2);
    } finally {
      ledger.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects evidence without provenance at the schema boundary', () => {
    expect(() =>
      EvidenceEntrySchema.parse({
        evidenceId: `evidence:${'a'.repeat(64)}`,
        evidenceType: 'external_document',
        title: 'Untraceable evidence',
        content: 'body',
      }),
    ).toThrow();
  });

  it('stores large planning evidence as a content-addressed body and materializes it for the planner', () => {
    const directory = mkdtempSync(join(tmpdir(), 'tasker-large-planning-evidence-'));
    const clock = makeAdjustableClock('2026-08-05T10:00:00.000Z');
    const ledger = openSqliteLedger({ filename: join(directory, 'ledger.sqlite'), clock });
    try {
      const store = new EvidenceBundleStore(ledger.repository, clock);
      const content = { pageId: '42', body: 'external evidence '.repeat(8_000) };
      const capture = {
        request: {
          requestId: 'architecture-page',
          skill: 'confluence',
          locator: '42',
          purpose: 'Confirm the project delivery policy.',
        },
        observation: {
          skill: 'confluence',
          locator: '42',
          title: 'Delivery policy',
          observedVersion: '7:2026-08-05T09:00:00.000Z',
          mediaType: 'application/json',
          content,
        },
      } as const;

      const recorded = store.appendPlanningEvidence('jira:AVIA-13235', 'planning:evidence:1', [
        capture,
      ]);
      if (!recorded.ok) throw new Error(`Evidence append failed: ${recorded.error.kind}`);
      const storedContent = EvidenceBodyReferenceSchema.parse(
        recorded.value.bundle.entries[0]?.content,
      );
      expect(storedContent.byteLength).toBeGreaterThan(64 * 1024);
      expect(ledger.repository.readArtifact(storedContent.artifactId)).toMatchObject({
        artifactKind: 'evidence_body',
        payload: content,
      });

      const materialized = store.readMaterialized(recorded.value.reference);
      expect(materialized).toMatchObject({
        ok: true,
        value: { bundle: { entries: [{ content }] } },
      });

      const duplicate = store.appendPlanningEvidence('jira:AVIA-13235', 'planning:evidence:1', [
        capture,
      ]);
      expect(duplicate).toEqual(recorded);
    } finally {
      ledger.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
