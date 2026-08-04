import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { z } from 'zod';

const RelativePathSchema = z
  .string()
  .min(1)
  .refine((value) => !isAbsolute(value) && !value.split('/').includes('..'), {
    message: 'Expected a path relative to the workspace harness pack',
  });

const WorkspaceHarnessProfileSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/u),
    repositoryAliases: z.array(z.string().min(1)).min(1),
    skills: RelativePathSchema,
    stepSkills: RelativePathSchema,
    overrides: RelativePathSchema,
  })
  .strict();

export const WorkspaceHarnessManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().min(1),
    version: z.string().min(1),
    engines: z.array(z.string().regex(/^[a-z][a-z0-9-]*$/u)).min(1),
    integrationSkills: RelativePathSchema,
    sharedSkills: RelativePathSchema,
    supportFiles: RelativePathSchema,
    commands: RelativePathSchema,
    profiles: z.array(WorkspaceHarnessProfileSchema).min(1),
  })
  .strict();

export type WorkspaceHarnessManifest = z.infer<typeof WorkspaceHarnessManifestSchema>;
export type WorkspaceHarnessProfile = z.infer<typeof WorkspaceHarnessProfileSchema>;

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

const normalizeAlias = (value: string): string =>
  value
    .trim()
    .replace(/\.git$/iu, '')
    .toLocaleLowerCase('en-US');

const insideRoot = (root: string, candidate: string): boolean => {
  const difference = relative(root, candidate);
  return difference === '' || (!difference.startsWith(`..${sep}`) && difference !== '..');
};

const resolveDirectory = (root: string, relativePath: string): string => {
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

const listFiles = (root: string, relativeDirectory: string): WorkspaceHarnessSourceFile[] => {
  const directory = resolveDirectory(root, relativeDirectory);
  const visit = (current: string): WorkspaceHarnessSourceFile[] =>
    readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
      if (entry.name === '.DS_Store') return [];
      const absolutePath = join(current, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Workspace harness packs cannot contain symlinks: ${absolutePath}`);
      }
      if (entry.isDirectory()) return visit(absolutePath);
      if (!entry.isFile()) {
        throw new Error(`Unsupported workspace harness entry: ${absolutePath}`);
      }
      const relativePath = relative(root, absolutePath).split(sep).join('/');
      if (entry.name.startsWith('.env') || relativePath.split('/').includes('.git')) {
        throw new Error(
          `Workspace harness packs cannot contain secrets or Git metadata: ${relativePath}`,
        );
      }
      const content = readFileSync(absolutePath);
      return [
        {
          relativePath,
          absolutePath,
          sha256: createHash('sha256').update(content).digest('hex'),
        },
      ];
    });
  return visit(directory);
};

const validateSkillPackages = (root: string, relativeDirectory: string): ReadonlySet<string> => {
  const directory = resolveDirectory(root, relativeDirectory);
  const names = new Set<string>();
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === '.DS_Store' || entry.name === '.gitkeep') continue;
    if (!entry.isDirectory()) {
      throw new Error(
        `Workspace harness skill entry must be a directory: ${relativeDirectory}/${entry.name}`,
      );
    }
    const skillFile = join(directory, entry.name, 'SKILL.md');
    if (!existsSync(skillFile) || !statSync(skillFile).isFile()) {
      throw new Error(
        `Workspace harness skill has no SKILL.md: ${relativeDirectory}/${entry.name}`,
      );
    }
    const content = readFileSync(skillFile, 'utf8');
    const frontmatter = /^---\r?\n(?<body>[\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(content)?.groups
      ?.body;
    const declaredName =
      frontmatter === undefined
        ? null
        : /^name:\s*(?<name>[^\s]+)\s*$/mu.exec(frontmatter)?.groups?.name;
    const hasDescription = frontmatter !== undefined && /^description:\s*\S.*$/mu.test(frontmatter);
    if (declaredName !== entry.name) {
      throw new Error(
        `Workspace harness skill name must match its directory: ${relativeDirectory}/${entry.name}`,
      );
    }
    if (!hasDescription) {
      throw new Error(
        `Workspace harness skill has no portable description: ${relativeDirectory}/${entry.name}`,
      );
    }
    names.add(entry.name);
  }
  return names;
};

export const loadWorkspaceHarnessPack = (configuredPath: string): LoadedWorkspaceHarnessPack => {
  const rootPath = realpathSync(configuredPath);
  const manifestPath = join(rootPath, 'manifest.json');
  const manifestContent = readFileSync(manifestPath);
  const manifest = WorkspaceHarnessManifestSchema.parse(
    JSON.parse(manifestContent.toString('utf8')),
  );
  const profileIds = new Set<string>();
  const aliases = new Set<string>();
  for (const profile of manifest.profiles) {
    if (profileIds.has(profile.id))
      throw new Error(`Duplicate workspace harness profile ${profile.id}`);
    profileIds.add(profile.id);
    for (const alias of profile.repositoryAliases) {
      const normalized = normalizeAlias(alias);
      if (aliases.has(normalized)) throw new Error(`Duplicate workspace harness alias ${alias}`);
      aliases.add(normalized);
    }
  }

  const integrationSkills = validateSkillPackages(rootPath, manifest.integrationSkills);
  const sharedSkills = validateSkillPackages(rootPath, manifest.sharedSkills);
  for (const skill of integrationSkills) {
    if (sharedSkills.has(skill)) {
      throw new Error(`Duplicate common workspace harness skill ${skill}`);
    }
  }
  for (const profile of manifest.profiles) {
    validateSkillPackages(rootPath, profile.skills);
    validateSkillPackages(rootPath, profile.stepSkills);
  }

  const directories = [
    manifest.integrationSkills,
    manifest.sharedSkills,
    manifest.supportFiles,
    manifest.commands,
    ...manifest.profiles.flatMap((profile) => [
      profile.skills,
      profile.stepSkills,
      profile.overrides,
    ]),
  ];
  const filesByPath = new Map<string, WorkspaceHarnessSourceFile>();
  filesByPath.set('manifest.json', {
    relativePath: 'manifest.json',
    absolutePath: manifestPath,
    sha256: createHash('sha256').update(manifestContent).digest('hex'),
  });
  for (const directory of directories) {
    for (const file of listFiles(rootPath, directory)) filesByPath.set(file.relativePath, file);
  }
  const files = [...filesByPath.values()].sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  );
  const digest = createHash('sha256');
  for (const file of files)
    digest.update(file.relativePath).update('\0').update(file.sha256).update('\n');

  return Object.freeze({
    rootPath,
    manifest,
    contentSha256: digest.digest('hex'),
    files: Object.freeze(files),
  });
};

export const workspaceHarnessCommonSkillNames = (
  pack: LoadedWorkspaceHarnessPack,
): ReadonlySet<string> => {
  const roots = [pack.manifest.integrationSkills, pack.manifest.sharedSkills];
  return new Set(
    pack.files.flatMap((file) => {
      for (const root of roots) {
        const prefix = `${root.replace(/\/$/u, '')}/`;
        if (!file.relativePath.startsWith(prefix)) continue;
        const name = file.relativePath.slice(prefix.length).split('/')[0];
        if (name !== undefined && name.length > 0 && name !== '.gitkeep') return [name];
      }
      return [];
    }),
  );
};

export const assertWorkspaceHarnessProvidesSkills = (
  pack: LoadedWorkspaceHarnessPack,
  requiredSkills: readonly string[],
): void => {
  const available = workspaceHarnessCommonSkillNames(pack);
  const missing = [...new Set(requiredSkills)].filter((skill) => !available.has(skill));
  if (missing.length > 0) {
    throw new Error(`Workspace harness does not provide step skills: ${missing.sort().join(', ')}`);
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
