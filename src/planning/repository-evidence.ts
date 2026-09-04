import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { checksumString } from '../store/checksum.js';

export interface RepositoryEvidenceDocument {
  readonly path: string;
  readonly content: string;
  readonly contentSha256: string;
}

export interface RepositoryEvidence {
  readonly files: readonly string[];
  readonly inventorySha256: string;
  readonly documents: readonly RepositoryEvidenceDocument[];
}

const ignoredDirectories = new Set([
  '.git',
  '.tasker',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'target',
]);
const readableExtensions = new Set([
  '.cjs',
  '.css',
  '.html',
  '.js',
  '.json',
  '.jsx',
  '.md',
  '.mjs',
  '.scss',
  '.ts',
  '.tsx',
  '.yaml',
  '.yml',
]);
const stopWords = new Set([
  'about',
  'after',
  'before',
  'change',
  'description',
  'implementation',
  'requested',
  'should',
  'task',
  'workflow',
]);

const extensionOf = (path: string): string => {
  const basename = path.split('/').at(-1) ?? '';
  const dot = basename.lastIndexOf('.');
  return dot < 0 ? '' : basename.slice(dot).toLowerCase();
};

export const collectRepositoryEvidence = async (
  repositoryPath: string,
  taskSnapshot: unknown,
): Promise<RepositoryEvidence> => {
  const discoveredFiles: string[] = [];
  const visit = async (directory: string, prefix: string, depth: number): Promise<void> => {
    if (depth > 8 || discoveredFiles.length >= 1_200) return;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (discoveredFiles.length >= 1_200) return;
      const relativePath = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name)) {
          await visit(join(directory, entry.name), relativePath, depth + 1);
        }
      } else if (entry.isFile()) {
        discoveredFiles.push(relativePath);
      }
    }
  };
  await visit(repositoryPath, '', 0);

  const snapshotText = JSON.stringify(taskSnapshot).toLowerCase();
  const keywords = [
    ...new Set(
      snapshotText
        .split(/[^\p{L}\p{N}_-]+/gu)
        .filter((token) => token.length >= 4 && !stopWords.has(token)),
    ),
  ].slice(0, 80);
  const pathHints = [
    ...snapshotText.matchAll(
      /(?:^|[\s`'"(])(?<path>(?:apps|docs|lib|packages|src|test|tests)\/[\p{L}\p{N}_./-]+)/gu,
    ),
  ]
    .map((match) => match.groups?.path?.replace(/[.,:;)]+$/u, ''))
    .filter((path): path is string => path !== undefined);

  const ranked = discoveredFiles
    .filter((path) => readableExtensions.has(extensionOf(path)))
    .map((path) => {
      const normalized = path.toLowerCase();
      const basename = normalized.split('/').at(-1) ?? normalized;
      const policyScore =
        basename === 'agents.md' ||
        basename === 'readme.md' ||
        basename === 'workflow.md' ||
        basename === 'tasker-workflow.md' ||
        basename === 'package.json'
          ? 40
          : 0;
      const hintScore = pathHints.some(
        (hint) => normalized.startsWith(hint) || hint.startsWith(normalized),
      )
        ? 100
        : 0;
      const keywordScore = keywords.reduce(
        (score, keyword) => score + (normalized.includes(keyword) ? 3 : 0),
        0,
      );
      return { path, score: policyScore + hintScore + keywordScore };
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
    .slice(0, 28);

  const documents: RepositoryEvidenceDocument[] = [];
  let remainingBytes = 48_000;
  for (const entry of ranked) {
    if (remainingBytes <= 0) break;
    try {
      const content = await readFile(join(repositoryPath, entry.path), 'utf8');
      const bounded = content.slice(0, Math.min(remainingBytes, 6_000));
      documents.push({
        path: entry.path,
        content: bounded,
        contentSha256: checksumString(bounded),
      });
      remainingBytes -= Buffer.byteLength(bounded, 'utf8');
    } catch {
      // Concurrent repository changes must not make bounded context discovery fail the task.
    }
  }

  const files = discoveredFiles.slice(0, 600);
  return {
    files,
    inventorySha256: checksumString(JSON.stringify(files)),
    documents,
  };
};
