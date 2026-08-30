import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  CommandRequest,
  HostControlPlaneCommandRunner,
} from '../../../src/agents/command-runner.js';
import {
  DockerWorkspaceCommandRunner,
  DockerWorkspaceRuntimeStore,
  type DockerWorkspaceConfiguration,
  type DockerWorkspaceRuntimeReceipt,
} from '../../../src/workspace/index.js';

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
  it('rechecks the default image after Docker changes its image store', async () => {
    const path = root();
    const requests: CommandRequest[] = [];
    let inspections = 0;
    const host: HostControlPlaneCommandRunner = {
      executionEnvironment: 'host_control_plane',
      run: vi.fn((request: CommandRequest) => {
        requests.push(request);
        if (request.args[0] === 'image' && request.args[1] === 'inspect') {
          inspections += 1;
          if (inspections === 2) {
            return Promise.resolve({
              status: 'exited' as const,
              exitCode: 1,
              stdout: '',
              stderr: 'No such image',
              durationMs: 1,
            });
          }
          return Promise.resolve({
            status: 'exited' as const,
            exitCode: 0,
            stdout: inspections === 1 ? 'sha256:before\n' : 'sha256:after\n',
            stderr: '',
            durationMs: 1,
          });
        }
        return Promise.resolve({
          status: 'exited' as const,
          exitCode: 0,
          stdout: '',
          stderr: '',
          durationMs: 1,
        });
      }),
    };
    const runner = new DockerWorkspaceCommandRunner(
      configuration(path),
      host,
      new DockerWorkspaceRuntimeStore(join(path, 'runtimes')),
    );

    await expect(runner.ensureDefaultImage()).resolves.toBe('sha256:before');
    await expect(runner.ensureDefaultImage()).resolves.toBe('sha256:after');

    expect(requests.filter(({ args }) => args[0] === 'build')).toHaveLength(1);
  });

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
      stdin: 'Analyze this task.',
      timeoutMs: 10_000,
    });

    expect(result).toMatchObject({ status: 'exited', exitCode: 0 });
    const execution = requests.find(({ args }) => args[0] === 'run');
    expect(execution?.command).toBe('docker');
    expect(execution?.args).toEqual(
      expect.arrayContaining([
        '--interactive',
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
    expect(execution?.stdin).toBe('Analyze this task.');
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

  it('enforces read-only workspace access with a Docker bind mount', async () => {
    const path = root();
    const cwd = join(path, 'planning');
    mkdirSync(cwd, { recursive: true });
    const requests: CommandRequest[] = [];
    const runner = new DockerWorkspaceCommandRunner(
      configuration(path),
      successfulHost(requests),
      new DockerWorkspaceRuntimeStore(join(path, 'runtimes')),
    );

    await runner.run({
      command: 'codex',
      args: ['exec'],
      cwd,
      workspaceAccess: 'read_only',
      stdin: 'Plan without changing the repository.',
      timeoutMs: 10_000,
    });

    const execution = requests.find(({ args }) => args[0] === 'run');
    expect(execution?.args).toEqual(expect.arrayContaining(['--volume', `${cwd}:${cwd}:ro`]));
  });

  it('shares a configured app service network namespace with task commands', async () => {
    const path = root();
    const config = configuration(path);
    const workspaceId = 'a'.repeat(24);
    const cwd = join(config.workspaceStorePath, workspaceId);
    const repositoryPath = join(path, 'repository');
    mkdirSync(cwd, { recursive: true });
    mkdirSync(repositoryPath, { recursive: true });
    const store = new DockerWorkspaceRuntimeStore(config.runtimeStorePath);
    const receipt: DockerWorkspaceRuntimeReceipt = {
      schemaVersion: 2,
      workspaceId,
      workspacePath: cwd,
      repositorySourcePath: repositoryPath,
      policyHash: 'b'.repeat(64),
      policy: {
        engine: 'docker',
        image: { kind: 'prebuilt', reference: config.defaultImage },
        workspaceMountPath: '/workspace',
        commandNetworkService: 'app',
        environment: {},
        bootstrap: [],
        cacheVolumes: [],
        services: [
          {
            id: 'app',
            command: 'pnpm start',
            shell: 'bash',
            privileged: false,
            aliases: ['local.example'],
            environment: {},
          },
        ],
      },
      image: config.defaultImage,
      imageId: 'sha256:workspace-image',
      networkName: `tasker-network-${workspaceId}`,
      volumes: [],
      services: [
        {
          id: 'app',
          containerName: `tasker-service-${workspaceId}-app`,
          image: config.defaultImage,
          imageId: 'sha256:workspace-image',
        },
      ],
      environment: {},
      toolchain: { node: 'v22.18.0', pnpm: '11.1.2' },
      initializedVolumes: [],
      completedBootstrap: [],
      status: 'ready',
      preparedAt: '2026-08-24T00:00:00.000Z',
      updatedAt: '2026-08-24T00:00:00.000Z',
    };
    await store.write(receipt);
    const requests: CommandRequest[] = [];
    const runner = new DockerWorkspaceCommandRunner(config, successfulHost(requests), store);

    await runner.run({
      command: 'pnpm',
      args: ['test:ui'],
      cwd,
      workspaceAccess: 'read_only',
      stdin: '',
      timeoutMs: 10_000,
    });

    const execution = requests.find(({ args }) => args[0] === 'run');
    expect(execution?.args).toEqual(
      expect.arrayContaining(['--network', `container:tasker-service-${workspaceId}-app`]),
    );
  });
});
