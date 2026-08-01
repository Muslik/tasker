import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { commitSourceEvent } from '../../src/app/safe-event-commit.js';
import { openSqliteLedger, type SqliteLedger } from '../../src/ledger/index.js';

const FIXED_NOW = '2026-08-01T12:00:00.000Z';
const openLedgers: SqliteLedger[] = [];
const tempDirectories: string[] = [];

const makeLedger = (): SqliteLedger => {
  const directory = mkdtempSync(join(tmpdir(), 'tasker-safe-commit-'));
  tempDirectories.push(directory);
  const ledger = openSqliteLedger({
    filename: join(directory, 'ledger.sqlite'),
    clock: { now: () => FIXED_NOW },
  });
  openLedgers.push(ledger);
  return ledger;
};

afterEach(() => {
  for (const ledger of openLedgers.splice(0)) {
    ledger.close();
  }

  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('commitSourceEvent', () => {
  it('persists only the redacted derivative of a secret-bearing source', () => {
    const ledger = makeLedger();

    const result = commitSourceEvent(ledger.repository, {
      aggregateId: 'intake-1',
      expectedVersion: 0,
      eventId: 'event-1',
      eventType: 'intake.received@1',
      eventSchemaVersion: 1,
      source: {
        issue: 'AVIA-13236',
        authorization: 'Bearer must-never-persist',
      },
      redaction: { exactKeys: ['authorization'] },
    });
    const events = ledger.repository.listEvents('intake-1');

    expect(result.status).toBe('committed');
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toEqual({
      issue: 'AVIA-13236',
      authorization: '[REDACTED]',
    });
    expect(JSON.stringify(events)).not.toContain('must-never-persist');
  });

  it('does not create an event when the source cannot be inspected safely', () => {
    const ledger = makeLedger();

    const result = commitSourceEvent(ledger.repository, {
      aggregateId: 'intake-2',
      expectedVersion: 0,
      eventId: 'event-2',
      eventType: 'intake.received@1',
      eventSchemaVersion: 1,
      source: { receivedAt: new Date(FIXED_NOW) },
      redaction: {},
    });

    expect(result.status).toBe('blocked');
    expect(ledger.repository.listEvents('intake-2')).toEqual([]);
  });
});
