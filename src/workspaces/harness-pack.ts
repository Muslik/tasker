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

  const directories = [
    manifest.integrationSkills,
    manifest.sharedSkills,
    manifest.supportFiles,
    manifest.commands,
    ...manifest.profiles.flatMap((profile) => [profile.skills, profile.overrides]),
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
