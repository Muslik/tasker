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
  readonly harnessPackPath: string;
  readonly snapshotStorePath: string;
}

export interface DockerWorkspaceConfiguration {
  readonly executable: string;
  readonly defaultImage: string;
  readonly imageContextPath: string;
  readonly imageDockerfilePath: string;
  readonly runtimeStorePath: string;
  readonly workspaceStorePath: string;
}

export interface TaskStepFilesystemConfiguration {
  readonly rootPath: string;
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
  harnessPackPath: resolve(
    environment.TASKER_WORKSPACE_HARNESS_PATH?.trim() || defaultWorkspaceHarnessPackPath(),
  ),
  snapshotStorePath: resolve(
    environment.TASKER_HARNESS_SNAPSHOT_STORE?.trim() ||
      resolve(dirname(defaultRepositoryStorePath(environment)), 'harness-snapshots'),
  ),
});

export const loadDockerWorkspaceConfiguration = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
): DockerWorkspaceConfiguration => {
  const workspaceStorePath = defaultWorkspaceStorePath(environment);
  const runnerRoot = fileURLToPath(new URL('../../docker/runner/', import.meta.url));
  return {
    executable: environment.TASKER_DOCKER_EXECUTABLE?.trim() || 'docker',
    defaultImage: environment.TASKER_DOCKER_WORKSPACE_IMAGE?.trim() || 'tasker/workspace:local',
    imageContextPath: resolve(environment.TASKER_DOCKER_IMAGE_CONTEXT?.trim() || runnerRoot),
    imageDockerfilePath: resolve(
      environment.TASKER_DOCKER_IMAGE_DOCKERFILE?.trim() || resolve(runnerRoot, 'Dockerfile'),
    ),
    runtimeStorePath: resolve(
      environment.TASKER_DOCKER_RUNTIME_STORE?.trim() ||
        resolve(dirname(workspaceStorePath), 'docker-runtimes'),
    ),
    workspaceStorePath,
  };
};

export const loadTaskStepFilesystemConfiguration = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
): TaskStepFilesystemConfiguration => ({
  rootPath: resolve(
    environment.TASKER_STEP_DATA_STORE?.trim() ||
      resolve(dirname(defaultWorkspaceStorePath(environment)), 'step-data'),
  ),
});
