import { describe, expect, it, vi } from 'vitest';

import { TaskPresenceStore } from '../../../src/server/task-presence.js';
import { TaskRemovalService } from '../../../src/server/task-removal.js';
import { openSqliteLedger } from '../../../src/store/index.js';
import { makeAdjustableClock } from '../../../src/shared/clock.js';
import { ok } from '../../../src/shared/outcome.js';

describe('task removal', () => {
  it('terminates work and disposes every managed workspace before hiding the task', async () => {
    const clock = makeAdjustableClock('2026-08-26T00:00:00.000Z');
    const ledger = openSqliteLedger({ filename: ':memory:', clock });
    const presence = new TaskPresenceStore(ledger.repository, clock);
    const terminate = vi.fn(() => Promise.resolve(ok(undefined)));
    const dockerDispose = vi.fn((workspaceId: string) => {
      void workspaceId;
      return Promise.resolve(ok(undefined));
    });
    const workspaceDispose = vi.fn((workspaceId: string) => {
      void workspaceId;
      return Promise.resolve(ok(undefined));
    });
    const service = new TaskRemovalService(
      { terminate },
      {
        listByTaskReference: () =>
          ok([{ workspaceId: 'a'.repeat(24) }, { workspaceId: 'b'.repeat(24) }] as never),
      },
      { dispose: dockerDispose },
      { dispose: workspaceDispose },
      presence,
    );

    const result = await service.remove('jira:FC-2244');

    expect(result).toEqual({ ok: true, value: undefined });
    expect(terminate).toHaveBeenCalledWith('jira:FC-2244');
    expect(dockerDispose.mock.calls.map(([workspaceId]) => workspaceId)).toEqual([
      'a'.repeat(24),
      'b'.repeat(24),
    ]);
    expect(workspaceDispose.mock.calls.map(([workspaceId]) => workspaceId)).toEqual([
      'a'.repeat(24),
      'b'.repeat(24),
    ]);
    expect(presence.isRemoved('jira:FC-2244')).toBe(true);
    ledger.close();
  });
});
