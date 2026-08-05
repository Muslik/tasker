import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  CommandRequest,
  HostControlPlaneCommandRunner,
} from '../../../src/providers/command-runner.js';
import {
  DockerWorkspaceCommandRunner,
  DockerWorkspaceRuntimeStore,
  type DockerWorkspaceConfiguration,
} from '../../../src/workspaces/index.js';

const roots: string[] = [];

const root = (): string => {
  const value = mkdtempSync(join(tmpdir(), 'tasker-docker-runner-'));
  roots.push(value);
  return value;
};

afterEach(() => {
  roots.splice(0).forEach((path) => {
    rmSync(path, { recursive: true, force: true });
  });
});

const configuration = (path: string): DockerWorkspaceConfiguration => ({
  executable: 'docker',
  defaultImage: 'tasker/workspace:test',
  imageContextPath: path,
  imageDockerfilePath: join(path, 'Dockerfile'),
  runtimeStorePath: join(path, 'runtimes'),
  workspaceStorePath: join(path, 'worktrees'),
});

const successfulHost = (requests: CommandRequest[]): HostControlPlaneCommandRunner => ({
  executionEnvironment: 'host_control_plane',
  run: vi.fn((request: CommandRequest) => {
    requests.push(request);
    return Promise.resolve({
      status: 'exited' as const,
      exitCode: 0,
      stdout:
        request.args[0] === 'image' && request.args[1] === 'inspect'
          ? 'sha256:workspace-image\n'
          : 'container output\n',
      stderr: '',
      durationMs: 1,
    });
  }),
});

describe('Docker workspace command runner', () => {
  it('runs an analyzer command in the workspace image instead of on the host', async () => {
    const path = root();
    const cwd = join(path, 'analysis');
    mkdirSync(cwd, { recursive: true });
    const requests: CommandRequest[] = [];
    const runner = new DockerWorkspaceCommandRunner(
      configuration(path),
      successfulHost(requests),
      new DockerWorkspaceRuntimeStore(join(path, 'runtimes')),
    );

    const result = await runner.run({
      command: 'codex',
      args: ['--version'],
      cwd,
      env: { CODEX_HOME: join(cwd, 'codex-home') },
      stdin: '',
      timeoutMs: 10_000,
    });

    expect(result).toMatchObject({ status: 'exited', exitCode: 0 });
    const execution = requests.find(({ args }) => args[0] === 'run');
    expect(execution?.command).toBe('docker');
    expect(execution?.args).toEqual(
      expect.arrayContaining([
        '--volume',
        `${cwd}:${cwd}`,
        '--workdir',
        cwd,
        '--env',
        'CODEX_HOME',
        'tasker/workspace:test',
        'codex',
        '--version',
      ]),
    );
    expect(execution?.args.join(' ')).not.toContain(join(cwd, 'codex-home'));
  });

  it('fails closed when a managed worktree has no runtime receipt', async () => {
    const path = root();
    const config = configuration(path);
    const cwd = join(config.workspaceStorePath, 'a'.repeat(24));
    mkdirSync(cwd, { recursive: true });
    const requests: CommandRequest[] = [];
    const runner = new DockerWorkspaceCommandRunner(
      config,
      successfulHost(requests),
      new DockerWorkspaceRuntimeStore(config.runtimeStorePath),
    );

    const result = await runner.run({
      command: 'node',
      args: ['--version'],
      cwd,
      stdin: '',
      timeoutMs: 10_000,
    });

    expect(result.status).toBe('spawn_failed');
    if (result.status !== 'spawn_failed') throw new Error('Expected a closed runtime failure');
    expect(result.message).toContain('has no prepared Docker runtime');
    expect(requests).toHaveLength(0);
  });
});
