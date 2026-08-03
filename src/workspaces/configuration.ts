import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defaultRepositoryStorePath } from '../repositories/catalog.js';

export interface WorkspaceConfiguration {
  readonly repositoryStorePath: string;
  readonly workspaceStorePath: string;
  readonly runnerId: string;
}

export interface WorkspaceBootstrapConfiguration {
  readonly command: string | null;
  readonly harnessPackPath: string;
  readonly snapshotStorePath: string;
}

const defaultWorkspaceHarnessPackPath = (): string =>
  fileURLToPath(new URL('../../harness/workspace/', import.meta.url));

export const defaultWorkspaceStorePath = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform,
  homeDirectory: string = homedir(),
): string => {
  const override = environment.TASKER_WORKSPACE_STORE?.trim();
  return override
    ? resolve(override)
    : resolve(
        dirname(defaultRepositoryStorePath(environment, platform, homeDirectory)),
        'worktrees',
      );
};

export const loadWorkspaceConfiguration = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
): WorkspaceConfiguration => ({
  repositoryStorePath: defaultRepositoryStorePath(environment),
  workspaceStorePath: defaultWorkspaceStorePath(environment),
  runnerId: environment.TASKER_RUNNER_ID?.trim() || 'local',
});

export const loadWorkspaceBootstrapConfiguration = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
): WorkspaceBootstrapConfiguration => ({
  command: environment.TASKER_WORKSPACE_BOOTSTRAP_COMMAND?.trim() || null,
  harnessPackPath: resolve(
    environment.TASKER_WORKSPACE_HARNESS_PATH?.trim() || defaultWorkspaceHarnessPackPath(),
  ),
  snapshotStorePath: resolve(
    environment.TASKER_HARNESS_SNAPSHOT_STORE?.trim() ||
      resolve(dirname(defaultRepositoryStorePath(environment)), 'harness-snapshots'),
  ),
});
