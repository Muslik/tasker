import { describe, expect, it } from 'vitest';

import { TaskPresenceStore } from '../../src/control-plane/task-presence.js';
import { openSqliteLedger } from '../../src/ledger/index.js';
import { makeAdjustableClock } from '../../src/shared/clock.js';

describe('task presence', () => {
  it('hides and restores a task through append-only presence revisions', () => {
    const clock = makeAdjustableClock('2026-08-26T00:00:00.000Z');
    const ledger = openSqliteLedger({ filename: ':memory:', clock });
    const store = new TaskPresenceStore(ledger.repository, clock);

    expect(store.isRemoved('jira:FC-2244')).toBe(false);
    expect(store.remove('jira:FC-2244')).toEqual({ ok: true, value: undefined });
    expect(store.isRemoved('jira:FC-2244')).toBe(true);
    expect(store.restore('jira:FC-2244')).toEqual({ ok: true, value: undefined });
    expect(store.isRemoved('jira:FC-2244')).toBe(false);
    expect(
      ledger.repository.listEvents('task-presence:jira:FC-2244').map(({ eventType }) => eventType),
    ).toEqual(['TaskRemoved', 'TaskRestored']);
    ledger.close();
  });
});
