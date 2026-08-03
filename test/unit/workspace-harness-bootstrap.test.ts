import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { makeAdjustableClock } from '../../src/shared/clock.js';
import { nodeCommandRunner } from '../../src/providers/command-runner.js';
import type { WorkspaceLocator } from '../../src/workspaces/contracts.js';
import { HarnessProfileWorkspaceBootstrapAdapter } from '../../src/workspaces/harness-profile-bootstrap.js';

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();

const createRepository = (): { readonly path: string; readonly baseCommit: string } => {
  const path = mkdtempSync(join(tmpdir(), 'tasker-harness-repository-'));
  git(path, 'init');
  git(path, 'config', 'user.email', 'tasker@example.test');
  git(path, 'config', 'user.name', 'Tasker Test');
  mkdirSync(join(path, '.ai'), { recursive: true });
  writeFileSync(join(path, 'AGENTS.md'), '# Repository agents\n', 'utf8');
  writeFileSync(join(path, 'CLAUDE.md'), '# Repository Claude\n', 'utf8');
  writeFileSync(join(path, '.ai', 'index.md'), '# Repository AI index\n', 'utf8');
  git(path, 'add', 'AGENTS.md', 'CLAUDE.md', '.ai/index.md');
  git(path, 'commit', '-m', 'fixture');
  return { path, baseCommit: git(path, 'rev-parse', 'HEAD') };
};

const locatorFor = (
  repository: ReturnType<typeof createRepository>,
  reference = 'onetwotrip/front-avia',
): WorkspaceLocator => ({
  schemaVersion: 1,
  workspaceId: 'a'.repeat(24),
  taskReference: 'AVIA-12329',
  workflowId: 'tasker/AVIA-12329',
  workflowRunId: 'run-1',
  workflowHash: 'b'.repeat(64),
  repository: {
    reference,
    sourcePath: repository.path,
    baseCommit: repository.baseCommit,
  },
  runnerId: 'test',
  path: repository.path,
  branch: 'tasker/avia-12329',
  preparedAt: '2026-08-04T00:00:00.000Z',
});

const operationId = (workspace: WorkspaceLocator): string =>
  `workspace:${workspace.workspaceId}:bootstrap@1`;

const createAdapter = (sourcePackPath: string, snapshotStorePath: string) =>
  new HarnessProfileWorkspaceBootstrapAdapter(
    { sourcePackPath, snapshotStorePath },
    nodeCommandRunner,
    makeAdjustableClock('2026-08-04T01:00:00.000Z'),
  );

describe('workspace harness bootstrap', () => {
  it('materializes the resolved project profile without creating repository changes', async () => {
    const repository = createRepository();
    const workspace = locatorFor(repository);
    const snapshotStore = mkdtempSync(join(tmpdir(), 'tasker-harness-snapshots-'));
    const adapter = createAdapter(resolve('harness/workspace'), snapshotStore);

    const result = await adapter.apply(workspace, operationId(workspace));

    expect(result).toMatchObject({
      ok: true,
      value: { status: 'ready', receipt: { profile: 'front-avia' } },
    });
    expect(readFileSync(join(repository.path, 'AGENTS.md'), 'utf8')).toContain(
      'Руководство для AI-агентов',
    );
    expect(
      readFileSync(join(repository.path, '.codex/skills/localization/SKILL.md'), 'utf8'),
    ).toContain('localization');
    expect(
      readFileSync(join(repository.path, '.claude/skills/ai-assistance/SKILL.md'), 'utf8'),
    ).toContain('AI assistance');
    expect(readFileSync(join(repository.path, '.codex/skills/jira/SKILL.md'), 'utf8')).toContain(
      'Jira issue reader',
    );
    const environmentFile = join(snapshotStore, 'test.env');
    writeFileSync(environmentFile, 'TASKER_TEST_VALUE=loaded\n', 'utf8');
    expect(
      execFileSync(
        join(repository.path, '.codex/bin/with-env'),
        ['sh', '-c', 'printf %s "$TASKER_TEST_VALUE"'],
        {
          encoding: 'utf8',
          env: { ...process.env, TASKER_HARNESS_ENV_FILE: environmentFile },
        },
      ),
    ).toBe('loaded');
    expect(git(repository.path, 'status', '--porcelain')).toBe('');
    expect(git(repository.path, 'ls-files', '-v', 'AGENTS.md')).toMatch(/^S /u);
  });

  it('repairs a partial workspace from its pinned pack after the source changes', async () => {
    const repository = createRepository();
    const workspace = locatorFor(repository);
    const sourcePack = mkdtempSync(join(tmpdir(), 'tasker-harness-source-'));
    cpSync(resolve('harness/workspace'), sourcePack, { recursive: true });
    const adapter = createAdapter(
      sourcePack,
      mkdtempSync(join(tmpdir(), 'tasker-harness-snapshots-')),
    );
    const applied = await adapter.apply(workspace, operationId(workspace));
    if (!applied.ok) throw new Error(JSON.stringify(applied.error));
    const original = readFileSync(join(repository.path, 'AGENTS.md'), 'utf8');
    writeFileSync(
      join(sourcePack, 'profiles/front-avia/overrides/AGENTS.md'),
      '# Changed for future runs\n',
      'utf8',
    );
    git(repository.path, 'update-index', '--no-skip-worktree', 'AGENTS.md');
    git(repository.path, 'checkout', '--', 'AGENTS.md');

    const recovered = await adapter.apply(workspace, operationId(workspace));

    expect(recovered).toMatchObject({ ok: true, value: { status: 'ready' } });
    expect(readFileSync(join(repository.path, 'AGENTS.md'), 'utf8')).toBe(original);
  });

  it('rejects a repository that has no declared project profile', async () => {
    const repository = createRepository();
    const workspace = locatorFor(repository, 'onetwotrip/unknown');
    const adapter = createAdapter(
      resolve('harness/workspace'),
      mkdtempSync(join(tmpdir(), 'tasker-harness-snapshots-')),
    );

    const result = await adapter.apply(workspace, operationId(workspace));

    expect(result).toMatchObject({
      ok: false,
      error: { kind: 'adapter_failed', phase: 'apply', retryable: false },
    });
  });
});
