import { createHash } from 'node:crypto';
import { lstat, readFile, readlink } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';

import { z } from 'zod';

import type { CommandRunner } from '../providers/command-runner.js';
import { err, ok, type Outcome } from '../shared/outcome.js';

const WorkspaceChangedPathSchema = z
  .object({
    status: z.string().length(2),
    path: z.string().min(1),
  })
  .strict();

export const WorkspaceMutationStateSchema = z
  .object({
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
    trackedDiffSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    changedPaths: z.array(WorkspaceChangedPathSchema),
    changedPathsTruncated: z.boolean(),
  })
  .strict()
  .readonly();

export type WorkspaceMutationState = z.infer<typeof WorkspaceMutationStateSchema>;

export type WorkspaceMutationInspectionFailure =
  | {
      readonly kind: 'git_status_failed' | 'git_diff_failed';
      readonly message: string;
    }
  | { readonly kind: 'unsafe_changed_path'; readonly path: string }
  | { readonly kind: 'changed_path_unreadable'; readonly path: string; readonly message: string };

export interface WorkspaceMutationInspector {
  inspect(
    workspacePath: string,
  ): Promise<Outcome<WorkspaceMutationState, WorkspaceMutationInspectionFailure>>;
}

const commandFailureMessage = (result: Awaited<ReturnType<CommandRunner['run']>>): string => {
  if (result.status === 'spawn_failed') return result.message;
  if (result.status === 'timed_out') return result.stderr.trim() || 'Git command timed out';
  return result.stderr.trim() || `Git exited with ${String(result.exitCode)}`;
};

const inside = (root: string, candidate: string): boolean => {
  const difference = relative(root, candidate);
  return difference === '' || (!difference.startsWith(`..${sep}`) && difference !== '..');
};

const changedPathsFrom = (
  porcelain: string,
): readonly { readonly status: string; readonly path: string }[] => {
  const records = porcelain.split('\0').filter((record) => record.length > 0);
  const paths: { status: string; path: string }[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record === undefined || record.length < 4 || record[2] !== ' ') continue;
    const status = record.slice(0, 2);
    paths.push({ status, path: record.slice(3) });
    if (status.includes('R') || status.includes('C')) index += 1;
  }
  return paths;
};

const untrackedContentHash = async (
  workspacePath: string,
  path: string,
): Promise<Outcome<string, WorkspaceMutationInspectionFailure>> => {
  const candidate = resolve(workspacePath, path);
  if (!inside(resolve(workspacePath), candidate)) {
    return err({ kind: 'unsafe_changed_path', path });
  }
  try {
    const metadata = await lstat(candidate);
    const content = metadata.isSymbolicLink()
      ? Buffer.from(await readlink(candidate), 'utf8')
      : metadata.isFile()
        ? await readFile(candidate)
        : Buffer.from('', 'utf8');
    return ok(createHash('sha256').update(content).digest('hex'));
  } catch (error) {
    return err({
      kind: 'changed_path_unreadable',
      path,
      message: error instanceof Error ? error.message : 'Changed path cannot be read',
    });
  }
};

export class GitWorkspaceMutationInspector implements WorkspaceMutationInspector {
  public constructor(private readonly commands: CommandRunner) {}

  public async inspect(
    workspacePath: string,
  ): Promise<Outcome<WorkspaceMutationState, WorkspaceMutationInspectionFailure>> {
    const status = await this.commands.run({
      command: 'git',
      args: ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
      cwd: workspacePath,
      stdin: '',
      timeoutMs: 30_000,
    });
    if (status.status !== 'exited' || status.exitCode !== 0) {
      return err({ kind: 'git_status_failed', message: commandFailureMessage(status) });
    }
    const diff = await this.commands.run({
      command: 'git',
      args: ['diff', '--binary', '--no-ext-diff', 'HEAD', '--'],
      cwd: workspacePath,
      stdin: '',
      timeoutMs: 30_000,
    });
    if (diff.status !== 'exited' || diff.exitCode !== 0) {
      return err({ kind: 'git_diff_failed', message: commandFailureMessage(diff) });
    }

    const changedPaths = changedPathsFrom(status.stdout);
    const untracked = changedPaths
      .filter((entry) => entry.status === '??')
      .sort((left, right) => left.path.localeCompare(right.path));
    const fingerprint = createHash('sha256').update(status.stdout).update('\0').update(diff.stdout);
    for (const entry of untracked) {
      const contentHash = await untrackedContentHash(workspacePath, entry.path);
      if (!contentHash.ok) return contentHash;
      fingerprint.update('\0').update(entry.path).update('\0').update(contentHash.value);
    }

    const maximumReportedPaths = 200;
    return ok(
      WorkspaceMutationStateSchema.parse({
        fingerprint: fingerprint.digest('hex'),
        trackedDiffSha256: createHash('sha256').update(diff.stdout).digest('hex'),
        changedPaths: changedPaths.slice(0, maximumReportedPaths),
        changedPathsTruncated: changedPaths.length > maximumReportedPaths,
      }),
    );
  }
}
