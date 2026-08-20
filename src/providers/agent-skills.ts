import { constants } from 'node:fs';
import { access, cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { z } from 'zod';

import {
  WORKSPACE_HARNESS_MANIFEST_PATH,
  workspaceHarnessBinPath,
  workspaceHarnessSkillsPath,
} from '../harness/runtime-layout.js';
import { err, ok, type Outcome } from '../shared/outcome.js';
import {
  resolveWorkspaceHarnessSkillCatalog,
  WorkspaceHarnessManifestSchema,
} from '../workspaces/harness-pack.js';

export const AgentProviderSchema = z.enum(['codex', 'claude']);
export type AgentProvider = z.infer<typeof AgentProviderSchema>;

const SkillNameSchema = z.string().regex(/^[a-z0-9][a-z0-9-]*$/u);
const VersionedReferenceSchema = z.string().regex(/^[a-z][a-z0-9_.-]*@[1-9]\d*$/u);
const SkillDependenciesSchema = z.array(SkillNameSchema);
const AgentSkillSelectionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('analyzer') }).strict(),
  z.object({ kind: z.literal('planner'), skills: z.array(SkillNameSchema) }).strict(),
  z
    .object({
      kind: z.literal('step'),
      reference: VersionedReferenceSchema,
      skills: z.array(SkillNameSchema),
    })
    .strict(),
]);
const PrepareAgentSkillsRequestSchema = z
  .object({
    provider: AgentProviderSchema,
    repositoryPath: z.string().min(1),
    configurationRoot: z.string().min(1),
    selection: AgentSkillSelectionSchema,
    skillOverrides: z.record(SkillNameSchema, z.string().min(1)).optional(),
  })
  .strict();

export type PreparedAgentSkills =
  | {
      readonly provider: 'codex';
      readonly skillsRoot: string;
      readonly skills: readonly string[];
      readonly cliArguments: readonly [];
    }
  | {
      readonly provider: 'claude';
      readonly skillsRoot: string;
      readonly skills: readonly string[];
      readonly cliArguments: readonly ['--add-dir', string];
    };

type PreparedAgentSkillsLayout =
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
): PreparedAgentSkillsLayout => {
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

const SelectionProfileSchema = z.object({ profile: z.string().min(1) }).loose();

const selectedSkillNames = async (
  repositoryPath: string,
  selection: z.infer<typeof AgentSkillSelectionSchema>,
): Promise<Outcome<readonly string[], PrepareAgentSkillsFailure>> => {
  try {
    const manifest = WorkspaceHarnessManifestSchema.parse(
      JSON.parse(
        await readFile(join(repositoryPath, WORKSPACE_HARNESS_MANIFEST_PATH), 'utf8'),
      ) as unknown,
    );
    const profileSelection = SelectionProfileSchema.parse(
      JSON.parse(
        await readFile(join(repositoryPath, '.tasker/harness-bootstrap.json'), 'utf8'),
      ) as unknown,
    );
    const catalog = resolveWorkspaceHarnessSkillCatalog(manifest, profileSelection.profile);
    const selected = [...catalog.globalAmbient, ...catalog.projectAmbient];
    if (selection.kind !== 'analyzer') selected.push(...selection.skills);
    if (selection.kind === 'step') {
      const binding = catalog.stepBindings[selection.reference];
      if (binding !== undefined) {
        const removed = new Set(binding.removeSkills);
        selected.splice(0, selected.length, ...selected.filter((skill) => !removed.has(skill)));
        selected.push(...binding.addSkills);
      }
    }
    const issues = [...new Set(selected)].flatMap((skill) => {
      const scope = catalog.scopes[skill];
      if (scope === undefined) return [`${skill}: skill is absent from the resolved profile`];
      if (
        selection.kind !== 'analyzer' &&
        !catalog.globalAmbient.includes(skill) &&
        !catalog.projectAmbient.includes(skill) &&
        scope !== 'step_bound' &&
        scope !== 'policy_bound'
      ) {
        return [`${skill}: ${scope} skill cannot be selected by ${selection.kind}`];
      }
      return [];
    });
    return issues.length === 0
      ? ok([...new Set(selected)])
      : err({ kind: 'invalid_skill_selection', issues });
  } catch (error) {
    return err({
      kind: 'invalid_skill_selection',
      issues: [error instanceof Error ? error.message : 'Workspace skill catalog is invalid'],
    });
  }
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
  const selected = await selectedSkillNames(request.repositoryPath, request.selection);
  if (!selected.ok) return selected;
  const layout = preparedLayout(request.provider, request.configurationRoot);
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
    if (request.skillOverrides?.[skill] !== undefined) {
      skills.push(skill);
      return ok(null);
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

  for (const skill of selected.value) {
    const resolved = await visit(skill);
    if (!resolved.ok) return resolved;
  }

  try {
    await mkdir(layout.skillsRoot, { recursive: true });
    for (const skill of skills) {
      const override = request.skillOverrides?.[skill];
      if (override === undefined) {
        await cp(join(sourceRoot, skill), join(layout.skillsRoot, skill), {
          recursive: true,
          errorOnExist: true,
          force: false,
        });
      } else {
        const target = join(layout.skillsRoot, skill);
        await mkdir(target, { recursive: true });
        await writeFile(join(target, 'SKILL.md'), override, 'utf8');
      }
    }
  } catch (error) {
    return err({
      kind: 'skill_materialization_failed',
      message: error instanceof Error ? error.message : 'Skill materialization failed',
    });
  }

  return ok({ ...layout, skills: Object.freeze(skills) });
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
