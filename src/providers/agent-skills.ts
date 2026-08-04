import { constants } from 'node:fs';
import { access, cp, mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { z } from 'zod';

import { workspaceHarnessBinPath, workspaceHarnessSkillsPath } from '../harness/runtime-layout.js';
import { err, ok, type Outcome } from '../shared/outcome.js';

export const AgentProviderSchema = z.enum(['codex', 'claude']);
export type AgentProvider = z.infer<typeof AgentProviderSchema>;

const SkillNameSchema = z.string().regex(/^[a-z0-9][a-z0-9-]*$/u);
const SkillDependenciesSchema = z.array(SkillNameSchema);
const PrepareAgentSkillsRequestSchema = z
  .object({
    provider: AgentProviderSchema,
    repositoryPath: z.string().min(1),
    configurationRoot: z.string().min(1),
    skills: z.array(SkillNameSchema),
  })
  .strict();

export type PreparedAgentSkills =
  | {
      readonly provider: 'codex';
      readonly skillsRoot: string;
      readonly cliArguments: readonly [];
    }
  | {
      readonly provider: 'claude';
      readonly skillsRoot: string;
      readonly cliArguments: readonly ['--add-dir', string];
    };

export type PrepareAgentSkillsFailure =
  | { readonly kind: 'invalid_skill_selection'; readonly issues: readonly string[] }
  | {
      readonly kind: 'invalid_skill_package';
      readonly skill: string;
      readonly message: string;
    }
  | {
      readonly kind: 'skill_unavailable';
      readonly skill: string;
      readonly message: string;
    }
  | { readonly kind: 'skill_materialization_failed'; readonly message: string };

const preparedLayout = (
  provider: AgentProvider,
  configurationRoot: string,
): PreparedAgentSkills => {
  if (provider === 'codex') {
    return {
      provider,
      skillsRoot: join(configurationRoot, 'skills'),
      cliArguments: [],
    };
  }

  return {
    provider,
    skillsRoot: join(configurationRoot, '.claude', 'skills'),
    cliArguments: ['--add-dir', configurationRoot],
  };
};

const readSkillDependencies = async (
  sourceRoot: string,
  skill: string,
): Promise<Outcome<readonly string[], PrepareAgentSkillsFailure>> => {
  try {
    const parsed = SkillDependenciesSchema.safeParse(
      JSON.parse(await readFile(join(sourceRoot, skill, 'dependencies.json'), 'utf8')) as unknown,
    );
    return parsed.success
      ? ok(parsed.data)
      : err({
          kind: 'invalid_skill_package',
          skill,
          message: `${skill}/dependencies.json must contain logical skill names`,
        });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return ok([]);
    return err({
      kind: 'invalid_skill_package',
      skill,
      message: `${skill}/dependencies.json is not valid JSON`,
    });
  }
};

export const prepareAgentSkills = async (
  requestInput: z.input<typeof PrepareAgentSkillsRequestSchema>,
): Promise<Outcome<PreparedAgentSkills, PrepareAgentSkillsFailure>> => {
  const parsed = PrepareAgentSkillsRequestSchema.safeParse(requestInput);
  if (!parsed.success) {
    return err({
      kind: 'invalid_skill_selection',
      issues: parsed.error.issues.map(
        (issue) => `${issue.path.map(String).join('.')}: ${issue.message}`,
      ),
    });
  }

  const request = parsed.data;
  const prepared = preparedLayout(request.provider, request.configurationRoot);
  const sourceRoot = workspaceHarnessSkillsPath(request.repositoryPath);
  const visited = new Set<string>();
  const skills: string[] = [];

  const visit = async (skill: string): Promise<Outcome<null, PrepareAgentSkillsFailure>> => {
    if (visited.has(skill)) return ok(null);
    visited.add(skill);
    const skillFile = join(sourceRoot, skill, 'SKILL.md');
    try {
      await access(skillFile, constants.R_OK);
    } catch {
      return err({
        kind: 'skill_unavailable',
        skill,
        message: `Pinned workspace harness does not provide skill ${skill}`,
      });
    }
    const dependencies = await readSkillDependencies(sourceRoot, skill);
    if (!dependencies.ok) return dependencies;
    for (const dependency of dependencies.value) {
      const resolved = await visit(dependency);
      if (!resolved.ok) return resolved;
    }
    skills.push(skill);
    return ok(null);
  };

  for (const skill of request.skills) {
    const resolved = await visit(skill);
    if (!resolved.ok) return resolved;
  }

  try {
    await mkdir(prepared.skillsRoot, { recursive: true });
    for (const skill of skills) {
      await cp(join(sourceRoot, skill), join(prepared.skillsRoot, skill), {
        recursive: true,
        errorOnExist: true,
        force: false,
      });
    }
  } catch (error) {
    return err({
      kind: 'skill_materialization_failed',
      message: error instanceof Error ? error.message : 'Skill materialization failed',
    });
  }

  return ok(prepared);
};

export const workspaceHarnessEnvironment = (
  repositoryPath: string,
  selectedSkillsRoot: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Readonly<Record<string, string>> => ({
  TASKER_SKILLS_ROOT: selectedSkillsRoot,
  TASKER_HARNESS_BIN: workspaceHarnessBinPath(repositoryPath),
  TASKER_HARNESS_ENV_FILE:
    environment.TASKER_HARNESS_ENV_FILE?.trim() ||
    resolve(
      environment.TASKER_HARNESS_WORK_PATH?.trim() || resolve('..', 'harness', 'work'),
      '.env',
    ),
});
