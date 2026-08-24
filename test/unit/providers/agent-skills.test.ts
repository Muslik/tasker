import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { prepareAgentSkills, workspaceHarnessEnvironment } from '../../../src/providers/index.js';

const createWorkspaceSkillCatalog = (profile = 'front-bus'): string => {
  const repositoryPath = mkdtempSync(join(tmpdir(), 'tasker-agent-skills-workspace-'));
  const supportDirectory = join(repositoryPath, '.tasker', 'harness', 'lib');
  mkdirSync(supportDirectory, { recursive: true });
  writeFileSync(join(supportDirectory, 'harness_env.py'), 'def load_env(): pass\n', 'utf8');
  for (const skill of [
    'ai-assistance',
    'feature-review',
    'jira',
    'pr-finalize',
    'test-design',
    'ui-kit',
  ]) {
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
  writeFileSync(
    join(repositoryPath, '.tasker', 'harness', 'manifest.json'),
    `${JSON.stringify(
      {
        schemaVersion: 2,
        id: 'test-workspace',
        version: '1',
        engines: ['codex', 'claude'],
        skillSources: [
          {
            id: 'global-design',
            path: 'shared-skills',
            scope: 'global_ambient',
            skills: ['test-design'],
          },
          {
            id: 'step-skills',
            path: 'shared-skills',
            scope: 'step_bound',
            skills: ['jira', 'pr-finalize'],
          },
          {
            id: 'policy-skills',
            path: 'shared-skills',
            scope: 'policy_bound',
            skills: ['ai-assistance'],
          },
        ],
        supportFiles: 'lib',
        commands: 'bin',
        profiles: [
          {
            id: 'front-avia',
            repositoryAliases: ['onetwotrip/front-avia'],
            skillSources: [
              {
                id: 'front-avia-ambient',
                path: 'profiles/front-avia/skills',
                scope: 'project_ambient',
                skills: ['ui-kit'],
              },
              {
                id: 'front-avia-steps',
                path: 'profiles/front-avia/step-skills',
                scope: 'step_bound',
                skills: ['feature-review'],
              },
            ],
            stepBindings: {
              'review.change@1': { addSkills: ['feature-review'] },
            },
            guidance: 'guidance',
          },
          {
            id: 'front-bus',
            repositoryAliases: ['onetwotrip/front-bus'],
            guidance: 'guidance',
          },
        ],
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  writeFileSync(
    join(repositoryPath, '.tasker', 'harness-bootstrap.json'),
    `${JSON.stringify({ profile })}\n`,
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
      selection: { kind: 'planner', skills: ['jira'] },
    });

    expect(result).toMatchObject({
      ok: true,
      value: { provider: fixture.provider },
    });
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    expect(result.value.skillsRoot).toBe(join(configurationRoot, fixture.relativeSkillsRoot));
    expect(result.value.skills).toEqual(['test-design', 'jira']);
    expect(readFileSync(join(result.value.skillsRoot, 'jira/SKILL.md'), 'utf8')).toContain(
      'jira test skill',
    );
    expect(readFileSync(join(result.value.skillsRoot, 'test-design/SKILL.md'), 'utf8')).toContain(
      'test-design test skill',
    );
    expect(readFileSync(join(configurationRoot, 'lib/harness_env.py'), 'utf8')).toContain(
      'def load_env()',
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
      selection: { kind: 'planner', skills: ['unknown-skill'] },
    });

    expect(result).toEqual({
      ok: false,
      error: {
        kind: 'invalid_skill_selection',
        issues: ['unknown-skill: skill is absent from the resolved profile'],
      },
    });
  });

  it.each(['codex', 'claude'] as const)(
    'combines ambient, step, policy, and front-avia binding skills for %s',
    async (provider) => {
      const repositoryPath = createWorkspaceSkillCatalog('front-avia');

      const result = await prepareAgentSkills({
        provider,
        repositoryPath,
        configurationRoot: mkdtempSync(join(tmpdir(), `tasker-${provider}-config-`)),
        selection: {
          kind: 'step',
          reference: 'review.change@1',
          skills: ['jira', 'ai-assistance'],
        },
      });

      expect(result).toMatchObject({ ok: true });
      if (!result.ok) throw new Error(JSON.stringify(result.error));
      expect(result.value.skills).toEqual([
        'test-design',
        'ui-kit',
        'jira',
        'ai-assistance',
        'feature-review',
      ]);
      expect(existsSync(join(result.value.skillsRoot, 'pr-finalize/SKILL.md'))).toBe(false);
    },
  );

  it('does not leak front-avia ambient or bound skills into front-bus', async () => {
    const repositoryPath = createWorkspaceSkillCatalog('front-bus');

    const result = await prepareAgentSkills({
      provider: 'codex',
      repositoryPath,
      configurationRoot: mkdtempSync(join(tmpdir(), 'tasker-codex-config-')),
      selection: { kind: 'step', reference: 'review.change@1', skills: ['jira'] },
    });

    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    expect(result.value.skills).toEqual(['test-design', 'jira']);
    expect(existsSync(join(result.value.skillsRoot, 'ui-kit/SKILL.md'))).toBe(false);
    expect(existsSync(join(result.value.skillsRoot, 'feature-review/SKILL.md'))).toBe(false);
  });

  it('gives analyzer calls ambient skills without step or policy capabilities', async () => {
    const repositoryPath = createWorkspaceSkillCatalog('front-avia');

    const result = await prepareAgentSkills({
      provider: 'codex',
      repositoryPath,
      configurationRoot: mkdtempSync(join(tmpdir(), 'tasker-codex-config-')),
      selection: { kind: 'analyzer' },
    });

    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    expect(result.value.skills).toEqual(['test-design', 'ui-kit']);
    expect(existsSync(join(result.value.skillsRoot, 'jira/SKILL.md'))).toBe(false);
    expect(existsSync(join(result.value.skillsRoot, 'ai-assistance/SKILL.md'))).toBe(false);
    expect(existsSync(join(result.value.skillsRoot, 'feature-review/SKILL.md'))).toBe(false);
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
