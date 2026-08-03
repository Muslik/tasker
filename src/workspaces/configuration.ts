import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';

import { defaultRepositoryStorePath } from '../repositories/catalog.js';

export interface WorkspaceConfiguration {
  readonly repositoryStorePath: string;
  readonly workspaceStorePath: string;
  readonly runnerId: string;
}

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
