import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';

import type { LoadedHarnessPack } from './contracts.js';
import { resolveHarnessOverlayPath } from './loader.js';

export interface MaterializedHarnessFile {
  readonly relativePath: string;
  readonly source: 'company' | 'project';
  readonly contentSha256: string;
}

export interface HarnessMaterializationReceipt {
  readonly companyId: string;
  readonly companyVersion: string;
  readonly files: readonly MaterializedHarnessFile[];
  readonly projectVersion: string | null;
  readonly repository: string;
}

interface OverlayFile extends MaterializedHarnessFile {
  readonly sourcePath: string;
}

const insideRoot = (root: string, path: string): boolean => {
  const difference = relative(root, path);
  return difference === '' || (!difference.startsWith(`..${sep}`) && difference !== '..');
};

const collectDirectory = async (
  sourceRoot: string,
  source: MaterializedHarnessFile['source'],
): Promise<readonly OverlayFile[]> => {
  const files: OverlayFile[] = [];

  const visit = async (sourceDirectory: string, prefix: string): Promise<void> => {
    const entries = await readdir(sourceDirectory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const relativePath = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      const sourcePath = join(sourceDirectory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Harness overlays cannot contain symbolic links: ${relativePath}`);
      }
      if (entry.isDirectory()) {
        await visit(sourcePath, relativePath);
        continue;
      }
      if (!entry.isFile()) continue;
      const bytes = await readFile(sourcePath);
      files.push({
        relativePath,
        source,
        contentSha256: createHash('sha256').update(bytes).digest('hex'),
        sourcePath,
      });
    }
  };

  await visit(sourceRoot, '');
  return files;
};

const assertTargetCompatible = async (targetPath: string, file: OverlayFile): Promise<boolean> => {
  try {
    const bytes = await readFile(targetPath);
    const targetHash = createHash('sha256').update(bytes).digest('hex');
    if (targetHash !== file.contentSha256) {
      throw new Error(`Harness overlay refuses to replace an existing file: ${file.relativePath}`);
    }
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
};

export const materializeHarnessOverlay = async (
  pack: LoadedHarnessPack,
  repository: string,
  worktreePath: string,
): Promise<HarnessMaterializationReceipt> => {
  const targetRoot = resolve(worktreePath);
  await mkdir(targetRoot, { recursive: true });
  const selectedFiles = new Map<string, OverlayFile>();

  if (pack.company.workOverlay !== undefined) {
    const companyFiles = await collectDirectory(
      resolveHarnessOverlayPath(pack, pack.company.workOverlay),
      'company',
    );
    companyFiles.forEach((file) => selectedFiles.set(file.relativePath, file));
  }

  const project = pack.projects.find((candidate) => candidate.repository === repository);
  if (project?.workOverlay !== undefined) {
    const projectFiles = await collectDirectory(
      resolveHarnessOverlayPath(pack, project.workOverlay),
      'project',
    );
    projectFiles.forEach((file) => selectedFiles.set(file.relativePath, file));
  }

  const files = [...selectedFiles.values()].sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  );
  const alreadyPresent = new Set<string>();
  for (const file of files) {
    const targetPath = resolve(targetRoot, file.relativePath);
    if (!insideRoot(targetRoot, targetPath)) {
      throw new Error(`Harness overlay target escapes the worktree: ${file.relativePath}`);
    }
    if (await assertTargetCompatible(targetPath, file)) {
      alreadyPresent.add(file.relativePath);
    }
  }

  for (const file of files) {
    if (alreadyPresent.has(file.relativePath)) continue;
    const targetPath = resolve(targetRoot, file.relativePath);
    await mkdir(dirname(targetPath), { recursive: true });
    await copyFile(file.sourcePath, targetPath);
  }

  return Object.freeze({
    companyId: pack.company.id,
    companyVersion: pack.company.version,
    files: Object.freeze(
      files.map(({ relativePath, source, contentSha256 }) => ({
        relativePath,
        source,
        contentSha256,
      })),
    ),
    projectVersion: project?.version ?? null,
    repository,
  });
};
