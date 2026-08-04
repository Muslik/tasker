import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { openSqliteLedger, type SqliteLedger } from '../../../src/ledger/index.js';
import { nodeCommandRunner } from '../../../src/providers/index.js';
import { systemClock } from '../../../src/shared/clock.js';
import { WorkspaceMutationRecoveryStore } from '../../../src/temporal/activities/workspace-mutation-recovery.js';
import { GitWorkspaceMutationInspector } from '../../../src/workspaces/index.js';

const git = (cwd: string, args: readonly string[]): void => {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
};

describe('workspace mutation recovery', () => {
  const temporaryDirectories: string[] = [];
  let ledger: SqliteLedger | null = null;

  afterEach(() => {
    ledger?.close();
    ledger = null;
    for (const path of temporaryDirectories.splice(0)) {
      rmSync(path, { recursive: true, force: true });
    }
  });

  it('shows a replacement delivery the worktree changes left by the first delivery', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tasker-mutation-recovery-'));
    temporaryDirectories.push(root);
    mkdirSync(join(root, 'src'));
    writeFileSync(
      join(root, 'src/passenger-name.ts'),
      'export const passengerName = (value: string) => value;\n',
      'utf8',
    );
    git(root, ['init', '--quiet', '--initial-branch=main']);
    git(root, ['add', '.']);
    git(root, [
      '-c',
      'user.name=Tasker Test',
      '-c',
      'user.email=tasker@example.test',
      'commit',
      '--quiet',
      '-m',
      'fixture',
    ]);
    ledger = openSqliteLedger({ filename: ':memory:', clock: systemClock });
    const recovery = new WorkspaceMutationRecoveryStore(
      ledger.repository,
      systemClock,
      new GitWorkspaceMutationInspector(nodeCommandRunner),
    );
    const input = {
      operationId: 'workflow:implement:attempt-1',
      workspaceId: 'a'.repeat(24),
      workspacePath: root,
      stepReference: 'code.implement@1',
    };

    const initial = await recovery.prepare(input);
    writeFileSync(
      join(root, 'src/passenger-name.ts'),
      "export const passengerName = (value: string) => value.trim().replace(/\\s+/gu, ' ');\n",
      'utf8',
    );
    const replacement = await recovery.prepare(input);

    expect(initial).toMatchObject({ ok: true, value: { kind: 'initial_delivery' } });
    expect(replacement).toMatchObject({
      ok: true,
      value: {
        kind: 'recovery_delivery',
        changedSinceInitialDelivery: true,
        current: {
          changedPaths: [{ status: ' M', path: 'src/passenger-name.ts' }],
        },
      },
    });
  });
});
