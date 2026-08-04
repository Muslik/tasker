import { createHash } from 'node:crypto';
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { z } from 'zod';

import {
  WORKSPACE_HARNESS_BIN_DIRECTORY,
  WORKSPACE_HARNESS_SKILLS_DIRECTORY,
  WORKSPACE_HARNESS_SUPPORT_DIRECTORY,
} from '../harness/runtime-layout.js';
import type { CommandResult, CommandRunner } from '../providers/command-runner.js';
import type { Clock } from '../shared/clock.js';
import { err, ok, type Outcome } from '../shared/outcome.js';
import type { WorkspaceBootstrapAdapter, WorkspaceBootstrapError } from './bootstrap.js';
import {
  loadWorkspaceHarnessPack,
  resolveWorkspaceHarnessProfile,
  type LoadedWorkspaceHarnessPack,
  type WorkspaceHarnessProfile,
  type WorkspaceHarnessSourceFile,
} from './harness-pack.js';
import type { WorkspaceBootstrapReceipt, WorkspaceLocator } from './contracts.js';

const SELECTION_PATH = '.tasker/harness-bootstrap.json';
const EXCLUDE_BEGIN = '# >>> tasker workspace harness >>>';
const EXCLUDE_END = '# <<< tasker workspace harness <<<';

const SelectionSchema = z
  .object({
    schemaVersion: z.literal(1),
    operationId: z.string().min(1),
    workspaceId: z.string().regex(/^[a-f0-9]{24}$/u),
    profile: z.string().min(1),
    packSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    completedAt: z.iso.datetime(),
  })
  .strict();

type Selection = z.infer<typeof SelectionSchema>;

interface MaterializedFile extends WorkspaceHarnessSourceFile {
  readonly destination: string;
  readonly kind: 'skill' | 'provider' | 'support' | 'command' | 'override';
}

class BootstrapFailure extends Error {
  public constructor(
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
  }
}

const exists = async (path: string): Promise<boolean> => {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
};

const sha256File = async (path: string): Promise<string | null> => {
  try {
    return createHash('sha256')
      .update(await readFile(path))
      .digest('hex');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
};

const commandMessage = (result: CommandResult): string => {
  if (result.status === 'spawn_failed') return result.message;
  if (result.status === 'timed_out') return result.stderr.trim() || 'Git command timed out';
  return result.stderr.trim() || `Git exited with ${String(result.exitCode)}`;
};

const isGitMiss = (result: CommandResult): boolean =>
  result.status === 'exited' && result.exitCode === 1;

const tailUnder = (relativePath: string, directory: string): string | null => {
  const prefix = `${directory.replace(/\/$/u, '')}/`;
  return relativePath.startsWith(prefix) ? relativePath.slice(prefix.length) : null;
};

const skillName = (tail: string): string => tail.split('/')[0] ?? '';

const buildMaterializationPlan = (
  pack: LoadedWorkspaceHarnessPack,
  profile: WorkspaceHarnessProfile,
): readonly MaterializedFile[] => {
  const profileSkills = new Set(
    pack.files.flatMap((file) => {
      for (const directory of [profile.skills, profile.stepSkills]) {
        const tail = tailUnder(file.relativePath, directory);
        if (tail !== null && !file.relativePath.endsWith('/.gitkeep')) return [skillName(tail)];
      }
      return [];
    }),
  );
  const destinations = new Map<string, MaterializedFile>();
  const add = (
    file: WorkspaceHarnessSourceFile,
    destination: string,
    kind: MaterializedFile['kind'],
  ) => {
    if (destination.endsWith('/.gitkeep')) return;
    if (destinations.has(destination)) {
      throw new BootstrapFailure(
        `Workspace harness destination is duplicated: ${destination}`,
        false,
      );
    }
    destinations.set(destination, { ...file, destination, kind });
  };

  for (const file of pack.files) {
    const integrationTail = tailUnder(file.relativePath, pack.manifest.integrationSkills);
    if (integrationTail !== null && !profileSkills.has(skillName(integrationTail))) {
      add(file, `${WORKSPACE_HARNESS_SKILLS_DIRECTORY}/${integrationTail}`, 'skill');
    }
    const sharedTail = tailUnder(file.relativePath, pack.manifest.sharedSkills);
    if (sharedTail !== null && !profileSkills.has(skillName(sharedTail))) {
      add(file, `${WORKSPACE_HARNESS_SKILLS_DIRECTORY}/${sharedTail}`, 'skill');
    }
    const profileTail = tailUnder(file.relativePath, profile.skills);
    if (profileTail !== null) {
      add(file, `${WORKSPACE_HARNESS_SKILLS_DIRECTORY}/${profileTail}`, 'skill');
      for (const engine of pack.manifest.engines) {
        add(file, `.${engine}/skills/${profileTail}`, 'provider');
      }
    }
    const profileStepTail = tailUnder(file.relativePath, profile.stepSkills);
    if (profileStepTail !== null) {
      add(file, `${WORKSPACE_HARNESS_SKILLS_DIRECTORY}/${profileStepTail}`, 'skill');
    }
    const supportTail = tailUnder(file.relativePath, pack.manifest.supportFiles);
    if (supportTail !== null) {
      add(file, `${WORKSPACE_HARNESS_SUPPORT_DIRECTORY}/${supportTail}`, 'support');
    }
    const commandTail = tailUnder(file.relativePath, pack.manifest.commands);
    if (commandTail !== null) {
      add(file, `${WORKSPACE_HARNESS_BIN_DIRECTORY}/${commandTail}`, 'command');
    }
    const overrideTail = tailUnder(file.relativePath, profile.overrides);
    if (overrideTail !== null) add(file, overrideTail, 'override');
  }

  return [...destinations.values()].sort((left, right) =>
    left.destination.localeCompare(right.destination),
  );
};

const receiptFrom = async (
  workspace: WorkspaceLocator,
  selection: Selection,
  plan: readonly MaterializedFile[],
): Promise<WorkspaceBootstrapReceipt> => {
  const selectionHash = await sha256File(join(workspace.path, SELECTION_PATH));
  if (selectionHash === null)
    throw new BootstrapFailure('Workspace harness selection disappeared', true);
  return {
    schemaVersion: 1,
    operationId: selection.operationId,
    workspaceId: selection.workspaceId,
    adapterId: 'tasker.workspace-harness',
    adapterVersion: selection.packSha256,
    profile: selection.profile,
    files: [
      { relativePath: SELECTION_PATH, sha256: selectionHash },
      ...plan.map((file) => ({ relativePath: file.destination, sha256: file.sha256 })),
    ],
    completedAt: selection.completedAt,
  };
};

export interface HarnessProfileBootstrapConfiguration {
  readonly sourcePackPath: string;
  readonly snapshotStorePath: string;
}

export class HarnessProfileWorkspaceBootstrapAdapter implements WorkspaceBootstrapAdapter {
  public constructor(
    private readonly configuration: HarnessProfileBootstrapConfiguration,
    private readonly commands: CommandRunner,
    private readonly clock: Clock,
  ) {}

  public async inspect(
    workspace: WorkspaceLocator,
    operationId: string,
  ): Promise<
    Outcome<
      | { readonly status: 'absent' }
      | { readonly status: 'ready'; readonly receipt: WorkspaceBootstrapReceipt },
      WorkspaceBootstrapError
    >
  > {
    try {
      const selection = await this.readSelection(workspace);
      if (selection === null) return ok({ status: 'absent' });
      this.assertSelectionIdentity(selection, workspace, operationId);
      const pack = this.loadSnapshot(selection.packSha256);
      const profile = pack.manifest.profiles.find(
        (candidate) => candidate.id === selection.profile,
      );
      if (profile === undefined) {
        throw new BootstrapFailure(
          `Pinned workspace harness profile no longer exists: ${selection.profile}`,
          false,
        );
      }
      const plan = buildMaterializationPlan(pack, profile);
      for (const file of plan) {
        if ((await sha256File(join(workspace.path, file.destination))) !== file.sha256) {
          return ok({ status: 'absent' });
        }
        if (
          file.kind === 'command' &&
          ((await stat(join(workspace.path, file.destination))).mode & 0o111) === 0
        ) {
          return ok({ status: 'absent' });
        }
      }
      const tracked = await this.trackedPaths(
        workspace,
        plan.map((file) => file.destination),
      );
      if (!(await this.gitStateIsReady(workspace, plan, tracked))) {
        return ok({ status: 'absent' });
      }
      return ok({ status: 'ready', receipt: await receiptFrom(workspace, selection, plan) });
    } catch (error) {
      return err(this.adapterError('inspect', error));
    }
  }

  public async apply(
    workspace: WorkspaceLocator,
    operationId: string,
  ): Promise<
    Outcome<
      { readonly status: 'ready'; readonly receipt: WorkspaceBootstrapReceipt },
      WorkspaceBootstrapError
    >
  > {
    try {
      let selection = await this.readSelection(workspace);
      let pack: LoadedWorkspaceHarnessPack;
      let profile: WorkspaceHarnessProfile;
      if (selection === null) {
        const source = loadWorkspaceHarnessPack(this.configuration.sourcePackPath);
        const resolvedProfile = resolveWorkspaceHarnessProfile(
          source,
          workspace.repository.reference,
        );
        if (resolvedProfile === null) {
          throw new BootstrapFailure(
            `No workspace harness profile for repository ${workspace.repository.reference}`,
            false,
          );
        }
        pack = await this.snapshot(source);
        const snapshottedProfile = pack.manifest.profiles.find(
          (candidate) => candidate.id === resolvedProfile.id,
        );
        if (snapshottedProfile === undefined) {
          throw new BootstrapFailure(
            `Workspace harness snapshot lost profile ${resolvedProfile.id}`,
            false,
          );
        }
        profile = snapshottedProfile;
        selection = {
          schemaVersion: 1,
          operationId,
          workspaceId: workspace.workspaceId,
          profile: profile.id,
          packSha256: pack.contentSha256,
          completedAt: this.clock.now(),
        };
        await this.writeSelection(workspace, selection);
      } else {
        const pinnedSelection = selection;
        this.assertSelectionIdentity(pinnedSelection, workspace, operationId);
        pack = this.loadSnapshot(pinnedSelection.packSha256);
        const pinnedProfile = pack.manifest.profiles.find(
          (candidate) => candidate.id === pinnedSelection.profile,
        );
        if (pinnedProfile === undefined) {
          throw new BootstrapFailure(
            `Pinned workspace harness profile does not exist: ${pinnedSelection.profile}`,
            false,
          );
        }
        profile = pinnedProfile;
      }

      const plan = buildMaterializationPlan(pack, profile);
      const tracked = await this.trackedPaths(
        workspace,
        plan.map((file) => file.destination),
      );
      for (const file of plan) {
        await this.materialize(workspace, file, tracked.has(file.destination));
      }
      await this.writeGitExclude(workspace, plan, tracked);
      const inspected = await this.inspect(workspace, operationId);
      if (!inspected.ok) return inspected;
      if (inspected.value.status === 'absent') {
        throw new BootstrapFailure('Workspace harness remained incomplete after apply', true);
      }
      return ok(inspected.value);
    } catch (error) {
      return err(this.adapterError('apply', error));
    }
  }

  private adapterError(phase: 'inspect' | 'apply', error: unknown): WorkspaceBootstrapError {
    return {
      kind: 'adapter_failed',
      phase,
      message: error instanceof Error ? error.message : 'Workspace harness bootstrap failed',
      retryable: error instanceof BootstrapFailure ? error.retryable : true,
    };
  }

  private async readSelection(workspace: WorkspaceLocator): Promise<Selection | null> {
    try {
      return SelectionSchema.parse(
        JSON.parse(await readFile(join(workspace.path, SELECTION_PATH), 'utf8')) as unknown,
      );
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
      if (error instanceof SyntaxError || error instanceof z.ZodError) {
        throw new BootstrapFailure('Workspace harness selection is invalid', false);
      }
      throw error;
    }
  }

  private assertSelectionIdentity(
    selection: Selection,
    workspace: WorkspaceLocator,
    operationId: string,
  ): void {
    if (selection.workspaceId !== workspace.workspaceId || selection.operationId !== operationId) {
      throw new BootstrapFailure('Workspace harness selection belongs to another run', false);
    }
  }

  private async writeSelection(workspace: WorkspaceLocator, selection: Selection): Promise<void> {
    const destination = join(workspace.path, SELECTION_PATH);
    await mkdir(dirname(destination), { recursive: true });
    const temporary = `${destination}.${String(process.pid)}.tmp`;
    await writeFile(temporary, `${JSON.stringify(selection, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await rename(temporary, destination);
  }

  private loadSnapshot(expectedHash: string): LoadedWorkspaceHarnessPack {
    const pack = loadWorkspaceHarnessPack(join(this.configuration.snapshotStorePath, expectedHash));
    if (pack.contentSha256 !== expectedHash) {
      throw new BootstrapFailure(
        `Workspace harness snapshot hash mismatch: ${expectedHash}`,
        false,
      );
    }
    return pack;
  }

  private async snapshot(source: LoadedWorkspaceHarnessPack): Promise<LoadedWorkspaceHarnessPack> {
    await mkdir(this.configuration.snapshotStorePath, { recursive: true, mode: 0o700 });
    const destination = join(this.configuration.snapshotStorePath, source.contentSha256);
    if (await exists(destination)) return this.loadSnapshot(source.contentSha256);
    const temporary = await mkdtemp(join(this.configuration.snapshotStorePath, '.pending-'));
    try {
      for (const file of source.files) {
        const target = join(temporary, file.relativePath);
        await mkdir(dirname(target), { recursive: true });
        await copyFile(file.absolutePath, target);
      }
      try {
        await rename(temporary, destination);
      } catch (error) {
        if (!(
          error instanceof Error &&
          'code' in error &&
          (error.code === 'EEXIST' || error.code === 'ENOTEMPTY')
        )) {
          throw error;
        }
      }
    } finally {
      if (await exists(temporary)) await rm(temporary, { recursive: true, force: true });
    }
    return this.loadSnapshot(source.contentSha256);
  }

  private async materialize(
    workspace: WorkspaceLocator,
    file: MaterializedFile,
    tracked: boolean,
  ): Promise<void> {
    const destination = join(workspace.path, file.destination);
    const currentHash = await sha256File(destination);
    if (currentHash !== null && currentHash !== file.sha256) {
      const previouslyManaged = tracked && (await this.isSkipWorktree(workspace, file.destination));
      if (file.kind !== 'override' || !tracked || previouslyManaged) {
        throw new BootstrapFailure(
          `Refusing to overwrite workspace file ${file.destination}`,
          false,
        );
      }
    }
    if (currentHash !== file.sha256) {
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(file.absolutePath, destination);
    }
    if (file.kind === 'command') await chmod(destination, 0o700);
    if (file.kind === 'override' && tracked) {
      await this.git(workspace, ['update-index', '--skip-worktree', '--', file.destination]);
    }
  }

  private async gitStateIsReady(
    workspace: WorkspaceLocator,
    plan: readonly MaterializedFile[],
    tracked: ReadonlySet<string>,
  ): Promise<boolean> {
    const untracked: string[] = [SELECTION_PATH];
    for (const file of plan) {
      const isTracked = tracked.has(file.destination);
      if (
        file.kind === 'override' &&
        isTracked &&
        !(await this.isSkipWorktree(workspace, file.destination))
      ) {
        return false;
      }
      if (!isTracked) untracked.push(file.destination);
    }
    return this.pathsAreIgnored(workspace, untracked);
  }

  private async trackedPaths(
    workspace: WorkspaceLocator,
    relativePaths: readonly string[],
  ): Promise<ReadonlySet<string>> {
    const result = await this.gitResult(workspace, ['ls-files', '-z', '--', ...relativePaths]);
    if (result.status !== 'exited' || result.exitCode !== 0) {
      throw new BootstrapFailure(commandMessage(result), true);
    }
    return new Set(result.stdout.split('\0').filter((path) => path.length > 0));
  }

  private async pathsAreIgnored(
    workspace: WorkspaceLocator,
    relativePaths: readonly string[],
  ): Promise<boolean> {
    const result = await this.gitResult(
      workspace,
      ['check-ignore', '-z', '--stdin'],
      `${relativePaths.join('\0')}\0`,
    );
    if (isGitMiss(result)) return false;
    if (result.status !== 'exited' || result.exitCode !== 0) {
      throw new BootstrapFailure(commandMessage(result), true);
    }
    const ignored = new Set(result.stdout.split('\0').filter((path) => path.length > 0));
    return relativePaths.every((path) => ignored.has(path));
  }

  private async isSkipWorktree(
    workspace: WorkspaceLocator,
    relativePath: string,
  ): Promise<boolean> {
    const result = await this.gitResult(workspace, ['ls-files', '-v', '--', relativePath]);
    if (result.status !== 'exited' || result.exitCode !== 0) {
      throw new BootstrapFailure(commandMessage(result), true);
    }
    return result.stdout.startsWith('S ');
  }

  private async writeGitExclude(
    workspace: WorkspaceLocator,
    plan: readonly MaterializedFile[],
    tracked: ReadonlySet<string>,
  ): Promise<void> {
    const commonDirectoryResult = await this.git(workspace, ['rev-parse', '--git-common-dir']);
    const rawCommonDirectory = commonDirectoryResult.stdout.trim();
    const commonDirectory = rawCommonDirectory.startsWith('/')
      ? rawCommonDirectory
      : resolve(workspace.path, rawCommonDirectory);
    const excludePath = join(commonDirectory, 'info', 'exclude');
    await mkdir(dirname(excludePath), { recursive: true });
    const existing = (await exists(excludePath)) ? await readFile(excludePath, 'utf8') : '';
    const retained: string[] = [];
    let insideManagedBlock = false;
    for (const line of existing.split(/\r?\n/u)) {
      if (line === EXCLUDE_BEGIN) {
        insideManagedBlock = true;
        continue;
      }
      if (line === EXCLUDE_END) {
        insideManagedBlock = false;
        continue;
      }
      if (!insideManagedBlock) retained.push(line);
    }
    // Runtime coordination artifacts must never become part of the product branch. Policy
    // artifacts under `.ai/` remain trackable and are deliberately not covered by this rule.
    const patterns = new Set<string>(['/.tasker/']);
    for (const file of plan) {
      if (!tracked.has(file.destination)) patterns.add(`/${file.destination}`);
    }
    const body = [
      ...retained.join('\n').trimEnd().split('\n'),
      EXCLUDE_BEGIN,
      '# Generated by Tasker for managed worktrees. Do not edit this block.',
      ...[...patterns].sort(),
      EXCLUDE_END,
      '',
    ].join('\n');
    const temporary = `${excludePath}.${workspace.workspaceId}.tmp`;
    await writeFile(temporary, body, 'utf8');
    await rename(temporary, excludePath);
  }

  private gitResult(
    workspace: WorkspaceLocator,
    args: readonly string[],
    stdin = '',
  ): Promise<CommandResult> {
    return this.commands.run({
      operationId: `workspace:${workspace.workspaceId}:git:${args[0] ?? 'unknown'}`,
      command: 'git',
      args: ['-C', workspace.path, ...args],
      cwd: workspace.path,
      stdin,
      timeoutMs: 30_000,
    });
  }

  private async git(
    workspace: WorkspaceLocator,
    args: readonly string[],
  ): Promise<Extract<CommandResult, { status: 'exited' }>> {
    const result = await this.gitResult(workspace, args);
    if (result.status !== 'exited' || result.exitCode !== 0) {
      throw new BootstrapFailure(commandMessage(result), true);
    }
    return result;
  }
}
