import { describe, expect, it } from 'vitest';

import {
  VerifiedPackagePublicationStore,
  verifiedPackagePublicationObservationIdFor,
} from '../../src/server/verified-package-publication.js';
import { openSqliteLedger } from '../../src/store/index.js';
import { makeAdjustableClock } from '../../src/shared/clock.js';

const baseInput = {
  declarationId: 'dependency-declaration:jira-link:118870:jira:AVIA-500',
  declarationRevision: 2,
  producerTaskReference: 'jira:AVIA-400',
  channel: 'dev' as const,
  packages: [
    {
      name: '@ott/core-button',
      version: '1.2.3-dev.5',
      registry: 'https://registry.npmjs.org',
      tarballUrl: 'https://registry.npmjs.org/@ott/core-button/-/core-button-1.2.3-dev.5.tgz',
      integrity: 'sha512-button',
    },
    {
      name: '@ott/core-theme',
      version: '1.2.3-dev.5',
      registry: 'https://registry.npmjs.org',
      tarballUrl: 'https://registry.npmjs.org/@ott/core-theme/-/core-theme-1.2.3-dev.5.tgz',
      integrity: 'sha512-theme',
    },
  ],
  sourceOperationId: 'operator:dependency-publication:attempt-1',
};

describe('VerifiedPackagePublicationStore', () => {
  it('records an append-only verified publication observation', () => {
    const clock = makeAdjustableClock('2026-08-25T10:00:00.000Z');
    const ledger = openSqliteLedger({ filename: ':memory:', clock });
    try {
      const store = new VerifiedPackagePublicationStore(ledger.repository, clock);

      const recorded = store.record(baseInput);

      expect(recorded).toMatchObject({
        ok: true,
        value: {
          schemaVersion: 1,
          observationId: verifiedPackagePublicationObservationIdFor(baseInput),
          declarationId: baseInput.declarationId,
          declarationRevision: 2,
          channel: 'dev',
        },
      });
    } finally {
      ledger.close();
    }
  });

  it('restores the same observation when the same operation sees the same packages again', () => {
    const clock = makeAdjustableClock('2026-08-25T10:00:00.000Z');
    const ledger = openSqliteLedger({ filename: ':memory:', clock });
    try {
      const store = new VerifiedPackagePublicationStore(ledger.repository, clock);
      const first = store.record(baseInput);
      if (!first.ok) throw new Error(JSON.stringify(first.error));

      clock.advance(60_000);
      const repeated = store.record({
        ...baseInput,
        packages: [...baseInput.packages].reverse(),
      });

      expect(repeated).toEqual(first);
    } finally {
      ledger.close();
    }
  });

  it('rejects a changed package observation for the same external publication identity', () => {
    const clock = makeAdjustableClock('2026-08-25T10:00:00.000Z');
    const ledger = openSqliteLedger({ filename: ':memory:', clock });
    try {
      const store = new VerifiedPackagePublicationStore(ledger.repository, clock);
      const first = store.record(baseInput);
      if (!first.ok) throw new Error(JSON.stringify(first.error));
      const firstPackage = baseInput.packages[0];
      const secondPackage = baseInput.packages[1];
      if (firstPackage === undefined || secondPackage === undefined) {
        throw new Error('Expected the publication fixture to include two packages');
      }

      const conflict = store.record({
        ...baseInput,
        packages: [
          {
            ...firstPackage,
            integrity: 'sha512-button-changed',
          },
          secondPackage,
        ],
      });

      expect(conflict).toEqual({
        ok: false,
        error: {
          kind: 'publication_conflict',
          externalIdentity: 'operation:operator:dependency-publication:attempt-1',
          observationId:
            'verified-package-publication:operation:operator:dependency-publication:attempt-1',
        },
      });
    } finally {
      ledger.close();
    }
  });

  it('records a new dev observation when the same Loop post reports a new exact version', () => {
    const clock = makeAdjustableClock('2026-08-25T10:00:00.000Z');
    const ledger = openSqliteLedger({ filename: ':memory:', clock });
    try {
      const store = new VerifiedPackagePublicationStore(ledger.repository, clock);
      const provenance = { kind: 'loop' as const, postId: 'loop-post-1' };
      const first = store.record({ ...baseInput, provenance });
      if (!first.ok) throw new Error(JSON.stringify(first.error));
      const nextPackages = baseInput.packages.map((packageObservation) => ({
        ...packageObservation,
        version: '1.2.3-dev.6',
        tarballUrl: packageObservation.tarballUrl.replace('dev.5', 'dev.6'),
      }));

      const second = store.record({
        ...baseInput,
        packages: nextPackages,
        sourceOperationId: 'operator:dependency-publication:attempt-2',
        provenance,
      });

      if (!second.ok) throw new Error(JSON.stringify(second.error));
      expect(second.value.observationId).toBe(
        'verified-package-publication:operation:operator:dependency-publication:attempt-2',
      );
      expect(second.value.provenance).toEqual(provenance);
      expect(second.value.packages.every(({ version }) => version === '1.2.3-dev.6')).toBe(true);
    } finally {
      ledger.close();
    }
  });
});
