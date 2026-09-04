import { describe, expect, it } from 'vitest';

import { ExternalEffectStore } from '../../../src/integrations/effects.js';
import { openSqliteLedger } from '../../../src/store/index.js';
import { makeAdjustableClock } from '../../../src/shared/clock.js';

describe('external effect store', () => {
  it('reuses an identical intent and rejects a changed identity', () => {
    const ledger = openSqliteLedger({
      filename: ':memory:',
      clock: makeAdjustableClock('2026-08-04T00:00:00.000Z'),
    });
    try {
      const store = new ExternalEffectStore(
        ledger.repository,
        makeAdjustableClock('2026-08-04T00:00:00.000Z'),
      );

      const first = store.prepare({
        operationId: 'workflow:push:attempt-1',
        effectId: 'push-branch',
        effectKind: 'git.push',
        identity: { branch: 'tasker/AVIA-1', commit: 'a'.repeat(40) },
      });
      const repeated = store.prepare({
        operationId: 'workflow:push:attempt-1',
        effectId: 'push-branch',
        effectKind: 'git.push',
        identity: { branch: 'tasker/AVIA-1', commit: 'a'.repeat(40) },
      });
      const changed = store.prepare({
        operationId: 'workflow:push:attempt-1',
        effectId: 'push-branch',
        effectKind: 'git.push',
        identity: { branch: 'tasker/AVIA-1', commit: 'b'.repeat(40) },
      });

      expect(repeated).toEqual(first);
      expect(changed).toEqual({
        ok: false,
        error: {
          kind: 'intent_mismatch',
          artifactId: 'external-effect:workflow:push:attempt-1:push-branch:intent',
        },
      });
    } finally {
      ledger.close();
    }
  });

  it('persists one applied receipt after its intent', () => {
    const clock = makeAdjustableClock('2026-08-04T00:00:00.000Z');
    const ledger = openSqliteLedger({ filename: ':memory:', clock });
    try {
      const store = new ExternalEffectStore(ledger.repository, clock);
      store.prepare({
        operationId: 'workflow:pr:attempt-1',
        effectId: 'create-pull-request',
        effectKind: 'bitbucket.pull-request.create',
        identity: { sourceRef: 'refs/heads/tasker/AVIA-1', targetRef: 'refs/heads/main' },
      });

      const recorded = store.recordApplied({
        operationId: 'workflow:pr:attempt-1',
        effectId: 'create-pull-request',
        effectKind: 'bitbucket.pull-request.create',
        result: { pullRequestId: 42 },
      });

      expect(recorded).toMatchObject({
        ok: true,
        value: { status: 'applied', result: { pullRequestId: 42 } },
      });
      expect(
        ledger.repository.readArtifact(
          'external-effect:workflow:pr:attempt-1:create-pull-request:receipt',
        )?.parentArtifactId,
      ).toBe('external-effect:workflow:pr:attempt-1:create-pull-request:intent');
    } finally {
      ledger.close();
    }
  });
});
