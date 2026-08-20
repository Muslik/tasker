import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadHarnessPack } from '../../src/harness/index.js';
import { makeAdjustableClock } from '../../src/shared/clock.js';
import { nodeCommandRunner } from '../../src/providers/command-runner.js';
import type { WorkspaceLocator } from '../../src/workspaces/contracts.js';
import {
  assertWorkspaceHarnessSkillBindings,
  loadWorkspaceHarnessPack,
} from '../../src/workspaces/harness-pack.js';
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
  it('rejects guidance that targets an arbitrary repository file', () => {
    const sourcePack = mkdtempSync(join(tmpdir(), 'tasker-harness-source-'));
    cpSync(resolve('harness/workspace'), sourcePack, { recursive: true });
    writeFileSync(
      join(sourcePack, 'profiles/front-avia/guidance/package.json'),
      '{"scripts":{}}\n',
      'utf8',
    );

    expect(() => loadWorkspaceHarnessPack(sourcePack)).toThrow(
      'Workspace harness guidance may only target .ai/*.md, AGENTS.md, or CLAUDE.md',
    );
  });

  it('provides a portable package for every registered agent-step skill', () => {
    const workflowPack = loadHarnessPack();
    const workspacePack = loadWorkspaceHarnessPack(resolve('harness/workspace'));
    const requiredSkills = [
      ...workflowPack.company.systemPrompts.implementationPlannerSkills,
      ...workflowPack.steps.flatMap((step) =>
        step.block.executor.kind === 'agent' ? [...step.block.executor.skills] : [],
      ),
    ];
    const policySkills = workflowPack.policies.flatMap((policy) =>
      policy.agentSkills.map((binding) => binding.skill),
    );

    expect(workspacePack.manifest.engines).toEqual(expect.arrayContaining(['codex', 'claude']));
    expect(() => {
      assertWorkspaceHarnessSkillBindings(workspacePack, {
        stepBound: requiredSkills,
        policyBound: policySkills,
      });
    }).not.toThrow();
  });

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
    expect(readFileSync(join(repository.path, 'AGENTS.md'), 'utf8')).toContain(
      '# Repository agents',
    );
    expect(existsSync(join(repository.path, '.codex/skills/localization/SKILL.md'))).toBe(false);
    expect(existsSync(join(repository.path, '.claude/skills/localization/SKILL.md'))).toBe(false);
    expect(
      readFileSync(join(repository.path, '.tasker/harness/skills/localization/SKILL.md'), 'utf8'),
    ).toContain('localization');
    expect(readFileSync(join(repository.path, '.tasker/harness/manifest.json'), 'utf8')).toContain(
      'global_ambient',
    );
    expect(
      readFileSync(join(repository.path, '.tasker/harness/skills/jira/SKILL.md'), 'utf8'),
    ).toContain('Jira issue reader');
    expect(
      readFileSync(
        join(repository.path, '.tasker/harness/skills/typescript-design/SKILL.md'),
        'utf8',
      ),
    ).toContain('make invalid states unrepresentable');
    expect(existsSync(join(repository.path, '.codex/skills/jira/SKILL.md'))).toBe(false);
    expect(existsSync(join(repository.path, '.claude/skills/pr-finalize/SKILL.md'))).toBe(false);
    expect(
      existsSync(join(repository.path, '.tasker/harness/skills/feature-review/SKILL.md')),
    ).toBe(true);
    expect(existsSync(join(repository.path, '.codex/skills/feature-review/SKILL.md'))).toBe(false);
    expect(existsSync(join(repository.path, '.claude/skills/feature-review/SKILL.md'))).toBe(false);
    const environmentFile = join(snapshotStore, 'test.env');
    writeFileSync(environmentFile, 'TASKER_TEST_VALUE=loaded\n', 'utf8');
    expect(
      execFileSync(
        join(repository.path, '.tasker/harness/bin/with-env'),
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

  it.each([
    {
      profile: 'front-avia',
      reference: 'onetwotrip/front-avia',
      files: ['.ai/tasker.md', 'AGENTS.md', 'CLAUDE.md'],
    },
    {
      profile: 'front-bus',
      reference: 'onetwotrip/front-bus',
      files: ['.ai/tasker.md', 'AGENTS.md', 'CLAUDE.md'],
    },
    {
      profile: 'front-railways',
      reference: 'onetwotrip/front-railways',
      files: ['.ai/tasker.md', 'AGENTS.md', 'CLAUDE.md'],
    },
    {
      profile: 'front-core-packages',
      reference: 'onetwotrip/front-core-packages',
      files: ['.ai/tasker.md', 'AGENTS.md', 'CLAUDE.md'],
    },
    {
      profile: 'front-components',
      reference: 'onetwotrip/front-components',
      files: ['.ai/tasker.md', 'AGENTS.md', 'CLAUDE.md'],
    },
  ])(
    'materializes every project guidance file for $profile',
    async ({ profile, reference, files }) => {
      const repository = createRepository();
      const workspace = locatorFor(repository, reference);
      const adapter = createAdapter(
        resolve('harness/workspace'),
        mkdtempSync(join(tmpdir(), 'tasker-harness-snapshots-')),
      );

      const result = await adapter.apply(workspace, operationId(workspace));

      expect(result).toMatchObject({
        ok: true,
        value: { status: 'ready', receipt: { profile } },
      });
      for (const file of files) {
        const actual = readFileSync(join(repository.path, file), 'utf8');
        const managed = readFileSync(
          join('harness/workspace/profiles', profile, 'guidance', file),
          'utf8',
        );
        if (file === 'AGENTS.md' || file === 'CLAUDE.md') {
          expect(actual).toContain(
            file === 'AGENTS.md' ? '# Repository agents' : '# Repository Claude',
          );
          expect(actual).toContain(managed.trim());
          expect(actual).toContain('tasker managed guidance');
        } else {
          expect(actual).toBe(managed);
        }
      }
      expect(git(repository.path, 'status', '--porcelain')).toBe('');
    },
  );

  it('keeps repository .ai guidance while applying the managed-run root rules', async () => {
    const repository = createRepository();
    const workspace = locatorFor(repository, 'onetwotrip/front-backoffice');
    const adapter = createAdapter(
      resolve('harness/workspace'),
      mkdtempSync(join(tmpdir(), 'tasker-harness-snapshots-')),
    );

    const result = await adapter.apply(workspace, operationId(workspace));

    expect(result).toMatchObject({
      ok: true,
      value: { status: 'ready', receipt: { profile: 'front-backoffice' } },
    });
    expect(readFileSync(join(repository.path, '.ai/index.md'), 'utf8')).toBe(
      '# Repository AI index\n',
    );
    expect(readFileSync(join(repository.path, 'AGENTS.md'), 'utf8')).toContain(
      'pnpm run agent:typecheck',
    );
    expect(readFileSync(join(repository.path, 'AGENTS.md'), 'utf8')).toContain(
      'Tasker уже выбрал workflow',
    );
    expect(git(repository.path, 'status', '--porcelain')).toBe('');
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
      join(sourcePack, 'profiles/front-avia/guidance/AGENTS.md'),
      '# Changed for future runs\n',
      'utf8',
    );
    git(repository.path, 'update-index', '--no-skip-worktree', 'AGENTS.md');
    git(repository.path, 'checkout', '--', 'AGENTS.md');

    const recovered = await adapter.apply(workspace, operationId(workspace));

    expect(recovered).toMatchObject({ ok: true, value: { status: 'ready' } });
    expect(readFileSync(join(repository.path, 'AGENTS.md'), 'utf8')).toBe(original);
  });

  it('pins imported skill content before materializing a managed run', async () => {
    const repository = createRepository();
    const workspace = locatorFor(repository);
    const sourcePack = mkdtempSync(join(tmpdir(), 'tasker-harness-source-'));
    cpSync(resolve('harness/workspace'), sourcePack, { recursive: true });
    rmSync(join(sourcePack, 'imports'), { recursive: true, force: true });
    const imported = mkdtempSync(join(tmpdir(), 'tasker-imported-skills-'));
    for (const skill of ['typescript-design', 'test-design']) {
      const directory = join(imported, skill);
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        join(directory, 'SKILL.md'),
        `---\nname: ${skill}\ndescription: Imported ${skill}.\n---\n\nImported v1\n`,
        'utf8',
      );
    }
    mkdirSync(join(sourcePack, 'imports'), { recursive: true });
    symlinkSync(imported, join(sourcePack, 'imports', 'global-skills'), 'dir');
    const adapter = createAdapter(
      sourcePack,
      mkdtempSync(join(tmpdir(), 'tasker-harness-snapshots-')),
    );
    const applied = await adapter.apply(workspace, operationId(workspace));
    if (!applied.ok) throw new Error(JSON.stringify(applied.error));
    writeFileSync(
      join(imported, 'typescript-design', 'SKILL.md'),
      '---\nname: typescript-design\ndescription: Imported TypeScript design.\n---\n\nImported v2\n',
      'utf8',
    );
    rmSync(join(repository.path, '.tasker', 'harness', 'skills', 'typescript-design'), {
      recursive: true,
      force: true,
    });

    const recovered = await adapter.apply(workspace, operationId(workspace));

    expect(recovered).toMatchObject({ ok: true, value: { status: 'ready' } });
    expect(
      readFileSync(
        join(repository.path, '.tasker', 'harness', 'skills', 'typescript-design', 'SKILL.md'),
        'utf8',
      ),
    ).toContain('Imported v1');
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
