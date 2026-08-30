import { describe, expect, it } from 'vitest';

import { WorkflowFreezeStore } from '../../src/server/workflow-freeze.js';
import { openSqliteLedger } from '../../src/store/index.js';
import { makeAdjustableClock } from '../../src/shared/clock.js';

const freezeInput = {
  taskReference: 'jira:AVIA-13235',
  workflowId: 'tasker:jira:AVIA-13235',
  workflowRunId: 'run-13235',
  workflowHash: 'a'.repeat(64),
  semanticHash: 'e'.repeat(64),
  compilerVersion: 'semantic-workflow-v1',
  harnessSnapshotHash: 'f'.repeat(64),
  planningAttempt: 2,
  planningArtifactId: 'plan:jira:AVIA-13235:2',
  planningSnapshot: {
    artifactId: 'planning-snapshot:jira:AVIA-13235',
    checksum: 'b'.repeat(64),
  },
  evidenceBundle: {
    artifactId: 'evidence-bundle:jira:AVIA-13235:r2:test',
    checksum: 'd'.repeat(64),
    revision: 2,
  },
  approval: { kind: 'operator_approved' as const },
} as const;

describe('workflow freeze recovery', () => {
  it('returns the original immutable receipt when Temporal redelivers the freeze', () => {
    const clock = makeAdjustableClock('2026-08-05T12:00:00.000Z');
    const ledger = openSqliteLedger({ filename: ':memory:', clock });
    try {
      const store = new WorkflowFreezeStore(ledger.repository, clock);
      const first = store.record(freezeInput);
      clock.advance(60_000);
      const redelivered = store.record(freezeInput);

      expect(first).toMatchObject({ ok: true });
      expect(redelivered).toEqual(first);
      if (!first.ok) throw new Error(`Freeze failed: ${first.error.kind}`);
      expect(first.value).toMatchObject({
        receiptId: 'workflow-freeze:tasker:jira:AVIA-13235:run-13235',
        frozenAt: '2026-08-05T12:00:00.000Z',
        workflowHash: freezeInput.workflowHash,
        semanticHash: freezeInput.semanticHash,
        compilerVersion: freezeInput.compilerVersion,
        harnessSnapshotHash: freezeInput.harnessSnapshotHash,
        planningSnapshot: freezeInput.planningSnapshot,
      });
      expect(store.read(freezeInput.workflowId, freezeInput.workflowRunId)).toEqual(first);
      expect(store.read(freezeInput.workflowId, 'another-run')).toEqual({ ok: true, value: null });
      expect(
        ledger.repository.listArtifacts({
          artifactKind: 'workflow_freeze_receipt',
          taskReference: freezeInput.taskReference,
        }),
      ).toHaveLength(1);
    } finally {
      ledger.close();
    }
  });

  it('rejects a different graph for a run that already has a freeze receipt', () => {
    const clock = makeAdjustableClock('2026-08-05T12:00:00.000Z');
    const ledger = openSqliteLedger({ filename: ':memory:', clock });
    try {
      const store = new WorkflowFreezeStore(ledger.repository, clock);
      expect(store.record(freezeInput)).toMatchObject({ ok: true });
      expect(store.record({ ...freezeInput, workflowHash: 'c'.repeat(64) })).toEqual({
        ok: false,
        error: {
          kind: 'receipt_conflict',
          receiptId: 'workflow-freeze:tasker:jira:AVIA-13235:run-13235',
        },
      });
    } finally {
      ledger.close();
    }
  });
});
