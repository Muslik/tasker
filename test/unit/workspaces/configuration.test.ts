import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  loadDockerWorkspaceConfiguration,
  loadTaskStepFilesystemConfiguration,
} from '../../../src/workspace/configuration.js';

describe('Docker workspace configuration', () => {
  it('stores runtime receipts beside the managed worktree store', () => {
    const configuration = loadDockerWorkspaceConfiguration({
      TASKER_REPOSITORY_STORE: '/tmp/tasker-repositories',
      TASKER_WORKSPACE_STORE: '/tmp/tasker-pilot/worktrees',
    });

    expect(configuration.workspaceStorePath).toBe(resolve('/tmp/tasker-pilot/worktrees'));
    expect(configuration.runtimeStorePath).toBe(resolve('/tmp/tasker-pilot/docker-runtimes'));
  });

  it('honors an explicit runtime receipt store', () => {
    const configuration = loadDockerWorkspaceConfiguration({
      TASKER_WORKSPACE_STORE: '/tmp/tasker-pilot/worktrees',
      TASKER_DOCKER_RUNTIME_STORE: '/tmp/tasker-explicit-runtimes',
    });

    expect(configuration.runtimeStorePath).toBe(resolve('/tmp/tasker-explicit-runtimes'));
  });
});

describe('task step filesystem configuration', () => {
  it('stores scratch and artifacts beside the managed worktree store', () => {
    const configuration = loadTaskStepFilesystemConfiguration({
      TASKER_WORKSPACE_STORE: '/tmp/tasker-pilot/worktrees',
    });

    expect(configuration.rootPath).toBe(resolve('/tmp/tasker-pilot/step-data'));
  });

  it('honors an explicit task-step data store', () => {
    const configuration = loadTaskStepFilesystemConfiguration({
      TASKER_STEP_DATA_STORE: '/tmp/tasker-explicit-step-data',
    });

    expect(configuration.rootPath).toBe(resolve('/tmp/tasker-explicit-step-data'));
  });
});
