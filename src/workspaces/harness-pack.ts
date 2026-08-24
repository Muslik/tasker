import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { z } from 'zod';

const SkillNameSchema = z.string().regex(/^[a-z0-9][a-z0-9-]*$/u);
const SourceIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]*$/u);
const VersionedReferenceSchema = z.string().regex(/^[a-z][a-z0-9_.-]*@[1-9]\d*$/u);
const RelativePathSchema = z
  .string()
  .min(1)
  .refine((value) => !isAbsolute(value) && !value.split('/').includes('..'), {
    message: 'Expected a path relative to the workspace harness pack',
  });

const ImportedDirectorySchema = z
  .object({
    id: SourceIdSchema,
    path: RelativePathSchema,
    importPath: RelativePathSchema.optional(),
  })
  .strict();

export const WorkspaceHarnessSkillScopeSchema = z.enum([
  'global_ambient',
  'project_ambient',
  'step_bound',
  'policy_bound',
]);

const SkillSourceBaseSchema = z
  .object({
    id: SourceIdSchema,
    path: RelativePathSchema,
    importPath: RelativePathSchema.optional(),
    skills: z.array(SkillNameSchema).min(1),
  })
  .strict();

const CommonSkillSourceSchema = SkillSourceBaseSchema.extend({
  scope: z.enum(['global_ambient', 'step_bound', 'policy_bound']),
}).strict();

const ProjectSkillSourceSchema = SkillSourceBaseSchema.extend({
  scope: z.enum(['project_ambient', 'step_bound']),
}).strict();

const ProjectStepBindingSchema = z
  .object({
    addSkills: z.array(SkillNameSchema).default([]),
    removeSkills: z.array(SkillNameSchema).default([]),
  })
  .strict()
  .refine(
    ({ addSkills, removeSkills }) => !addSkills.some((skill) => removeSkills.includes(skill)),
    { message: 'A project step binding cannot add and remove the same skill' },
  );

const WorkspaceHarnessProfileSchema = z
  .object({
    id: SourceIdSchema,
    repositoryAliases: z.array(z.string().min(1)).min(1),
    skillSources: z.array(ProjectSkillSourceSchema).default([]),
    stepBindings: z.record(VersionedReferenceSchema, ProjectStepBindingSchema).default({}),
    guidance: RelativePathSchema,
    overrides: ImportedDirectorySchema.optional(),
    ruleSources: z.array(ImportedDirectorySchema).default([]),
  })
  .strict();

export const WorkspaceHarnessManifestSchema = z
  .object({
    schemaVersion: z.literal(2),
    id: z.string().min(1),
    version: z.string().min(1),
    engines: z.array(z.string().regex(/^[a-z][a-z0-9-]*$/u)).min(1),
    skillSources: z.array(CommonSkillSourceSchema).min(1),
    ruleSources: z.array(ImportedDirectorySchema).default([]),
    supportFiles: RelativePathSchema,
    commands: RelativePathSchema,
    profiles: z.array(WorkspaceHarnessProfileSchema).min(1),
  })
  .strict();

export type WorkspaceHarnessManifest = z.infer<typeof WorkspaceHarnessManifestSchema>;
export type WorkspaceHarnessProfile = z.infer<typeof WorkspaceHarnessProfileSchema>;
export type WorkspaceHarnessSkillScope = z.infer<typeof WorkspaceHarnessSkillScopeSchema>;
type WorkspaceHarnessSkillSource =
  | WorkspaceHarnessManifest['skillSources'][number]
  | WorkspaceHarnessProfile['skillSources'][number];
type WorkspaceHarnessDirectorySource = z.infer<typeof ImportedDirectorySchema>;

export interface WorkspaceHarnessSourceFile {
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly sha256: string;
}

export interface LoadedWorkspaceHarnessPack {
  readonly rootPath: string;
  readonly manifest: WorkspaceHarnessManifest;
  readonly contentSha256: string;
  readonly files: readonly WorkspaceHarnessSourceFile[];
}

export interface ResolvedWorkspaceHarnessSkillCatalog {
  readonly profile: string;
  readonly scopes: Readonly<Record<string, WorkspaceHarnessSkillScope>>;
  readonly globalAmbient: readonly string[];
  readonly projectAmbient: readonly string[];
  readonly stepBindings: Readonly<
    Record<
      string,
      { readonly addSkills: readonly string[]; readonly removeSkills: readonly string[] }
    >
  >;
}

export interface WorkspaceHarnessSkillRequirements {
  readonly stepBound: readonly string[];
  readonly policyBound: readonly string[];
}

const normalizeAlias = (value: string): string =>
  value
    .trim()
    .replace(/\.git$/iu, '')
    .toLocaleLowerCase('en-US');

const insideRoot = (root: string, candidate: string): boolean => {
  const difference = relative(root, candidate);
  return difference === '' || (!difference.startsWith(`..${sep}`) && difference !== '..');
};

const resolvePackDirectory = (root: string, relativePath: string): string => {
  const candidate = resolve(root, relativePath);
  if (!insideRoot(root, candidate) || !existsSync(candidate)) {
    throw new Error(`Workspace harness directory does not exist: ${relativePath}`);
  }
  const realCandidate = realpathSync(candidate);
  if (!insideRoot(root, realCandidate) || !statSync(realCandidate).isDirectory()) {
    throw new Error(`Workspace harness path must be a directory inside the pack: ${relativePath}`);
  }
  return realCandidate;
};

const resolveImportedDirectory = (
  root: string,
  source: WorkspaceHarnessDirectorySource,
): string => {
  if (source.importPath !== undefined) {
    const imported = resolve(root, source.importPath);
    if (existsSync(imported)) {
      const realImported = realpathSync(imported);
      if (!statSync(realImported).isDirectory()) {
        throw new Error(`Workspace harness import must resolve to a directory: ${source.id}`);
      }
      return realImported;
    }
  }
  return resolvePackDirectory(root, source.path);
};

const resolveSkillSourceDirectory = (root: string, source: WorkspaceHarnessSkillSource): string =>
  resolveImportedDirectory(root, source);

const sourceFile = (relativePath: string, absolutePath: string): WorkspaceHarnessSourceFile => {
  const content = readFileSync(absolutePath);
  return {
    relativePath,
    absolutePath,
    sha256: createHash('sha256').update(content).digest('hex'),
  };
};

const listFiles = (
  physicalDirectory: string,
  logicalDirectory: string,
): WorkspaceHarnessSourceFile[] => {
  const visit = (current: string, logical: string): WorkspaceHarnessSourceFile[] =>
    readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
      if (entry.name === '.DS_Store') return [];
      const absolutePath = join(current, entry.name);
      const relativePath = `${logical}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        throw new Error(
          `Workspace harness sources cannot contain nested symlinks: ${absolutePath}`,
        );
      }
      if (entry.isDirectory()) return visit(absolutePath, relativePath);
      if (!entry.isFile()) throw new Error(`Unsupported workspace harness entry: ${absolutePath}`);
      if (entry.name.startsWith('.env') || relativePath.split('/').includes('.git')) {
        throw new Error(
          `Workspace harness packs cannot contain secrets or Git metadata: ${relativePath}`,
        );
      }
      return [sourceFile(relativePath, absolutePath)];
    });
  return visit(physicalDirectory, logicalDirectory.replace(/\/$/u, ''));
};

const declaredSkillName = (skillFile: string): string | null => {
  const content = readFileSync(skillFile, 'utf8');
  const frontmatter = /^---\r?\n(?<body>[\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(content)?.groups?.body;
  if (frontmatter === undefined || !/^description:\s*\S.*$/mu.test(frontmatter)) return null;
  return /^name:\s*(?<name>[^\s]+)\s*$/mu.exec(frontmatter)?.groups?.name ?? null;
};

const listSkillSourceFiles = (
  root: string,
  source: WorkspaceHarnessSkillSource,
): WorkspaceHarnessSourceFile[] => {
  const sourceRoot = resolveSkillSourceDirectory(root, source);
  const duplicate = source.skills.find((skill, index) => source.skills.indexOf(skill) !== index);
  if (duplicate !== undefined) {
    throw new Error(`Workspace harness source ${source.id} repeats skill ${duplicate}`);
  }
  return source.skills.flatMap((skill) => {
    const packagePath = join(sourceRoot, skill);
    if (!existsSync(packagePath) || lstatSync(packagePath).isSymbolicLink()) {
      throw new Error(`Workspace harness source ${source.id} does not provide skill ${skill}`);
    }
    if (!statSync(packagePath).isDirectory()) {
      throw new Error(`Workspace harness skill package must be a directory: ${source.id}/${skill}`);
    }
    const skillFile = join(packagePath, 'SKILL.md');
    if (!existsSync(skillFile) || declaredSkillName(skillFile) !== skill) {
      throw new Error(
        `Workspace harness skill must declare its directory name and description: ${source.id}/${skill}`,
      );
    }
    return listFiles(packagePath, `${source.path}/${skill}`);
  });
};

const validateGuidanceFiles = (
  root: string,
  relativeDirectory: string,
): WorkspaceHarnessSourceFile[] => {
  const files = listFiles(resolvePackDirectory(root, relativeDirectory), relativeDirectory);
  const prefix = `${relativeDirectory.replace(/\/$/u, '')}/`;
  for (const file of files) {
    const destination = file.relativePath.slice(prefix.length);
    const allowed =
      destination === '.gitkeep' ||
      destination === 'AGENTS.md' ||
      destination === 'CLAUDE.md' ||
      (destination.startsWith('.ai/') && destination.endsWith('.md'));
    if (!allowed) {
      throw new Error(
        `Workspace harness guidance may only target .ai/*.md, AGENTS.md, or CLAUDE.md: ${file.relativePath}`,
      );
    }
  }
  return files;
};

const validateImportedGuidanceFiles = (
  root: string,
  source: WorkspaceHarnessDirectorySource,
): WorkspaceHarnessSourceFile[] => {
  const files = listFiles(resolveImportedDirectory(root, source), source.path);
  const prefix = `${source.path.replace(/\/$/u, '')}/`;
  for (const file of files) {
    const destination = file.relativePath.slice(prefix.length);
    const allowed =
      destination === '.gitkeep' ||
      destination === 'AGENTS.md' ||
      destination === 'CLAUDE.md' ||
      (destination.startsWith('.ai/') && destination.endsWith('.md'));
    if (!allowed) {
      throw new Error(
        `Workspace harness overrides may only target .ai/*.md, AGENTS.md, or CLAUDE.md: ${file.relativePath}`,
      );
    }
  }
  return files;
};

const validateRuleFiles = (
  root: string,
  source: WorkspaceHarnessDirectorySource,
): WorkspaceHarnessSourceFile[] => {
  const files = listFiles(resolveImportedDirectory(root, source), source.path);
  for (const file of files) {
    if (!file.relativePath.endsWith('.md')) {
      throw new Error(`Workspace harness rules must be Markdown: ${file.relativePath}`);
    }
  }
  return files;
};

const dependencyScopeAllowed = (
  owner: WorkspaceHarnessSkillScope,
  dependency: WorkspaceHarnessSkillScope,
): boolean => {
  switch (owner) {
    case 'global_ambient':
      return dependency === 'global_ambient';
    case 'project_ambient':
      return dependency === 'global_ambient' || dependency === 'project_ambient';
    case 'step_bound':
      return dependency !== 'policy_bound';
    case 'policy_bound':
      return true;
  }
};

const validateSkillDependencies = (
  manifest: WorkspaceHarnessManifest,
  profile: WorkspaceHarnessProfile,
  files: ReadonlyMap<string, WorkspaceHarnessSourceFile>,
): void => {
  const catalog = resolveWorkspaceHarnessSkillCatalog(manifest, profile.id);
  for (const source of [...manifest.skillSources, ...profile.skillSources]) {
    for (const skill of source.skills) {
      const dependencyFile = files.get(`${source.path}/${skill}/dependencies.json`);
      if (dependencyFile === undefined) continue;
      const parsed = z
        .array(SkillNameSchema)
        .safeParse(JSON.parse(readFileSync(dependencyFile.absolutePath, 'utf8')));
      if (!parsed.success) {
        throw new Error(`Workspace harness skill ${skill} has invalid dependencies.json`);
      }
      for (const dependency of parsed.data) {
        const dependencyScope = catalog.scopes[dependency];
        if (dependencyScope === undefined) {
          throw new Error(
            `Workspace harness skill ${skill} depends on unavailable skill ${dependency} in ${profile.id}`,
          );
        }
        if (!dependencyScopeAllowed(source.scope, dependencyScope)) {
          throw new Error(
            `Workspace harness ${source.scope} skill ${skill} cannot depend on ${dependencyScope} skill ${dependency}`,
          );
        }
      }
    }
  }
};

const assertUniqueSourceIds = (
  sources: readonly { readonly id: string }[],
  context: string,
): void => {
  const ids = new Set<string>();
  for (const source of sources) {
    if (ids.has(source.id))
      throw new Error(`Duplicate workspace harness source ${source.id} in ${context}`);
    ids.add(source.id);
  }
};

export const resolveWorkspaceHarnessSkillCatalog = (
  manifest: WorkspaceHarnessManifest,
  profileId: string,
): ResolvedWorkspaceHarnessSkillCatalog => {
  const profile = manifest.profiles.find((candidate) => candidate.id === profileId);
  if (profile === undefined) throw new Error(`Unknown workspace harness profile ${profileId}`);
  const scopes: Record<string, WorkspaceHarnessSkillScope> = {};
  for (const source of [...manifest.skillSources, ...profile.skillSources]) {
    for (const skill of source.skills) {
      if (scopes[skill] !== undefined) {
        throw new Error(`Workspace harness profile ${profile.id} has duplicate skill ${skill}`);
      }
      scopes[skill] = source.scope;
    }
  }
  for (const [reference, binding] of Object.entries(profile.stepBindings)) {
    for (const skill of binding.addSkills) {
      if (scopes[skill] !== 'step_bound') {
        throw new Error(
          `Workspace harness binding ${profile.id}:${reference} can only add step_bound skill ${skill}`,
        );
      }
    }
    for (const skill of binding.removeSkills) {
      const scope = scopes[skill];
      if (scope === undefined || scope === 'global_ambient' || scope === 'policy_bound') {
        throw new Error(
          `Workspace harness binding ${profile.id}:${reference} cannot remove ${skill}`,
        );
      }
    }
  }
  return Object.freeze({
    profile: profile.id,
    scopes: Object.freeze(scopes),
    globalAmbient: Object.freeze(
      Object.keys(scopes).filter((skill) => scopes[skill] === 'global_ambient'),
    ),
    projectAmbient: Object.freeze(
      Object.keys(scopes).filter((skill) => scopes[skill] === 'project_ambient'),
    ),
    stepBindings: Object.freeze(profile.stepBindings),
  });
};

export const loadWorkspaceHarnessPack = (configuredPath: string): LoadedWorkspaceHarnessPack => {
  const rootPath = realpathSync(configuredPath);
  const manifestPath = join(rootPath, 'manifest.json');
  const manifestContent = readFileSync(manifestPath);
  const manifest = WorkspaceHarnessManifestSchema.parse(
    JSON.parse(manifestContent.toString('utf8')),
  );
  assertUniqueSourceIds(manifest.skillSources, 'common sources');
  assertUniqueSourceIds(manifest.ruleSources, 'common rule sources');
  const profileIds = new Set<string>();
  const aliases = new Set<string>();
  for (const profile of manifest.profiles) {
    if (profileIds.has(profile.id))
      throw new Error(`Duplicate workspace harness profile ${profile.id}`);
    profileIds.add(profile.id);
    assertUniqueSourceIds(profile.skillSources, `profile ${profile.id}`);
    assertUniqueSourceIds(profile.ruleSources, `profile ${profile.id} rule sources`);
    for (const alias of profile.repositoryAliases) {
      const normalized = normalizeAlias(alias);
      if (aliases.has(normalized)) throw new Error(`Duplicate workspace harness alias ${alias}`);
      aliases.add(normalized);
    }
    resolveWorkspaceHarnessSkillCatalog(manifest, profile.id);
  }

  const filesByPath = new Map<string, WorkspaceHarnessSourceFile>();
  const addFile = (file: WorkspaceHarnessSourceFile): void => {
    if (filesByPath.has(file.relativePath)) {
      throw new Error(`Duplicate workspace harness file ${file.relativePath}`);
    }
    filesByPath.set(file.relativePath, file);
  };
  addFile(sourceFile('manifest.json', manifestPath));
  for (const source of manifest.skillSources) {
    for (const file of listSkillSourceFiles(rootPath, source)) addFile(file);
  }
  for (const source of manifest.ruleSources) {
    for (const file of validateRuleFiles(rootPath, source)) addFile(file);
  }
  for (const profile of manifest.profiles) {
    for (const source of profile.skillSources) {
      for (const file of listSkillSourceFiles(rootPath, source)) addFile(file);
    }
    if (profile.overrides !== undefined) {
      for (const file of validateImportedGuidanceFiles(rootPath, profile.overrides)) addFile(file);
    }
    for (const source of profile.ruleSources) {
      for (const file of validateRuleFiles(rootPath, source)) addFile(file);
    }
    for (const file of validateGuidanceFiles(rootPath, profile.guidance)) addFile(file);
  }
  for (const directory of [manifest.supportFiles, manifest.commands]) {
    for (const file of listFiles(resolvePackDirectory(rootPath, directory), directory))
      addFile(file);
  }

  for (const profile of manifest.profiles) {
    validateSkillDependencies(manifest, profile, filesByPath);
  }

  const files = [...filesByPath.values()].sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  );
  const digest = createHash('sha256');
  for (const file of files) {
    digest.update(file.relativePath).update('\0').update(file.sha256).update('\n');
  }
  return Object.freeze({
    rootPath,
    manifest,
    contentSha256: digest.digest('hex'),
    files: Object.freeze(files),
  });
};

export const assertWorkspaceHarnessSkillBindings = (
  pack: LoadedWorkspaceHarnessPack,
  requirements: WorkspaceHarnessSkillRequirements,
): void => {
  const commonScopes = Object.fromEntries(
    pack.manifest.skillSources.flatMap((source) =>
      source.skills.map((skill) => [skill, source.scope] as const),
    ),
  );
  const violations = [...new Set(requirements.stepBound)].flatMap((skill) => {
    const scope = commonScopes[skill];
    return scope === 'step_bound' || scope === 'global_ambient'
      ? []
      : [`${skill} must be step_bound`];
  });
  for (const skill of new Set(requirements.policyBound)) {
    if (commonScopes[skill] !== 'policy_bound') violations.push(`${skill} must be policy_bound`);
  }
  if (violations.length > 0) {
    throw new Error(
      `Workspace harness skill bindings are invalid: ${violations.sort().join(', ')}`,
    );
  }
};

export const resolveWorkspaceHarnessProfile = (
  pack: LoadedWorkspaceHarnessPack,
  repositoryReference: string,
): WorkspaceHarnessProfile | null => {
  const normalized = normalizeAlias(repositoryReference);
  return (
    pack.manifest.profiles.find((profile) =>
      profile.repositoryAliases.some((alias) => normalizeAlias(alias) === normalized),
    ) ?? null
  );
};
