import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { prepareAgentSkills, workspaceHarnessEnvironment } from '../../../src/providers/index.js';

const createWorkspaceSkillCatalog = (): string => {
  const repositoryPath = mkdtempSync(join(tmpdir(), 'tasker-agent-skills-workspace-'));
  for (const skill of ['jira', 'test-design', 'pr-finalize']) {
    const directory = join(repositoryPath, '.tasker', 'harness', 'skills', skill);
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, 'SKILL.md'),
      `---\nname: ${skill}\ndescription: ${skill} test skill\n---\n`,
      'utf8',
    );
  }
  writeFileSync(
    join(repositoryPath, '.tasker', 'harness', 'skills', 'jira', 'dependencies.json'),
    '["test-design"]\n',
    'utf8',
  );
  return repositoryPath;
};

describe('provider-neutral agent skills', () => {
  it.each([
    {
      provider: 'codex' as const,
      relativeSkillsRoot: 'skills',
      expectedArguments: [] as const,
    },
    {
      provider: 'claude' as const,
      relativeSkillsRoot: '.claude/skills',
      expectedArguments: ['--add-dir'] as const,
    },
  ])('exposes only the selected packages to $provider', async (fixture) => {
    const repositoryPath = createWorkspaceSkillCatalog();
    const configurationRoot = mkdtempSync(join(tmpdir(), `tasker-${fixture.provider}-config-`));

    const result = await prepareAgentSkills({
      provider: fixture.provider,
      repositoryPath,
      configurationRoot,
      skills: ['jira'],
    });

    expect(result).toMatchObject({
      ok: true,
      value: { provider: fixture.provider },
    });
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    expect(result.value.skillsRoot).toBe(join(configurationRoot, fixture.relativeSkillsRoot));
    expect(readFileSync(join(result.value.skillsRoot, 'jira/SKILL.md'), 'utf8')).toContain(
      'jira test skill',
    );
    expect(readFileSync(join(result.value.skillsRoot, 'test-design/SKILL.md'), 'utf8')).toContain(
      'test-design test skill',
    );
    expect(existsSync(join(result.value.skillsRoot, 'pr-finalize/SKILL.md'))).toBe(false);
    expect(result.value.cliArguments.slice(0, 1)).toEqual(fixture.expectedArguments);
    if (result.value.provider === 'claude') {
      expect(result.value.cliArguments).toEqual(['--add-dir', configurationRoot]);
    }
  });

  it('rejects a logical skill that is absent from the pinned workspace harness', async () => {
    const repositoryPath = createWorkspaceSkillCatalog();

    const result = await prepareAgentSkills({
      provider: 'codex',
      repositoryPath,
      configurationRoot: mkdtempSync(join(tmpdir(), 'tasker-codex-config-')),
      skills: ['unknown-skill'],
    });

    expect(result).toEqual({
      ok: false,
      error: {
        kind: 'skill_unavailable',
        skill: 'unknown-skill',
        message: 'Pinned workspace harness does not provide skill unknown-skill',
      },
    });
  });

  it('points imported skill scripts at the selected provider view', () => {
    const environment = workspaceHarnessEnvironment('/tmp/repository', '/tmp/selected-skills', {
      TASKER_HARNESS_ENV_FILE: '/tmp/tasker.env',
    });

    expect(environment).toEqual({
      TASKER_SKILLS_ROOT: '/tmp/selected-skills',
      TASKER_HARNESS_BIN: '/tmp/repository/.tasker/harness/bin',
      TASKER_HARNESS_ENV_FILE: '/tmp/tasker.env',
    });
  });
});
