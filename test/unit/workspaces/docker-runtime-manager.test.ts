import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  CommandRequest,
  HostControlPlaneCommandRunner,
} from '../../../src/providers/command-runner.js';
import { makeAdjustableClock } from '../../../src/shared/clock.js';
import {
  DockerWorkspaceCommandRunner,
  DockerWorkspaceRuntimeManager,
  DockerWorkspaceRuntimeStore,
  type DockerWorkspaceConfiguration,
  type ResolvedWorkspaceRuntimePolicy,
  type WorkspaceLocator,
} from '../../../src/workspaces/index.js';

const roots: string[] = [];

afterEach(() => {
  roots.splice(0).forEach((path) => {
    rmSync(path, { recursive: true, force: true });
  });
});

describe('Docker workspace runtime manager', () => {
  it('persists bootstrap progress and skips completed commands on recovery', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tasker-docker-runtime-'));
    roots.push(root);
    const workspaceId = 'a'.repeat(24);
    const workspacePath = join(root, 'worktrees', workspaceId);
    const repositoryPath = join(root, 'repositories', 'front-avia');
    mkdirSync(workspacePath, { recursive: true });
    mkdirSync(repositoryPath, { recursive: true });
    const config: DockerWorkspaceConfiguration = {
      executable: 'docker',
      defaultImage: 'tasker/workspace:test',
      imageContextPath: root,
      imageDockerfilePath: join(root, 'Dockerfile'),
      runtimeStorePath: join(root, 'runtimes'),
      workspaceStorePath: join(root, 'worktrees'),
    };
    const requests: CommandRequest[] = [];
    const existing = new Set<string>();
    let serviceRunning = false;
    let bootstrapFails = true;
    const host: HostControlPlaneCommandRunner = {
      executionEnvironment: 'host_control_plane',
      run: vi.fn((request: CommandRequest) => {
        requests.push(request);
        const [kind, operation, ...tail] = request.args;
        if (kind === 'image' && operation === 'inspect') {
          return Promise.resolve({
            status: 'exited' as const,
            exitCode: 0,
            stdout: 'sha256:workspace-image\n',
            stderr: '',
            durationMs: 1,
          });
        }
        if ((kind === 'network' || kind === 'volume') && operation === 'inspect') {
          const name = tail.at(-1) ?? '';
          const found = existing.has(`${kind}:${name}`);
          return Promise.resolve({
            status: 'exited' as const,
            exitCode: found ? 0 : 1,
            stdout: '',
            stderr: found ? '' : 'not found',
            durationMs: 1,
          });
        }
        if ((kind === 'network' || kind === 'volume') && operation === 'create') {
          existing.add(`${kind}:${tail.at(-1) ?? ''}`);
        }
        if (
          kind === 'inspect' &&
          operation === '--format' &&
          request.args.includes('{{.State.Running}}')
        ) {
          return Promise.resolve({
            status: 'exited' as const,
            exitCode: serviceRunning ? 0 : 1,
            stdout: serviceRunning ? 'true\n' : '',
            stderr: serviceRunning ? '' : 'not running',
            durationMs: 1,
          });
        }
        if (kind === 'rm' && operation === '--force') serviceRunning = false;
        if (kind === 'run' && request.args.includes('--detach')) serviceRunning = true;
        if (
          bootstrapFails &&
          kind === 'run' &&
          request.args.includes('pnpm install --frozen-lockfile')
        ) {
          bootstrapFails = false;
          return Promise.resolve({
            status: 'exited' as const,
            exitCode: 1,
            stdout: '[ERR_PNPM_FETCH_403] Private registry access is forbidden',
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
    const store = new DockerWorkspaceRuntimeStore(config.runtimeStorePath);
    const commands = new DockerWorkspaceCommandRunner(config, host, store);
    const manager = new DockerWorkspaceRuntimeManager(
      config,
      host,
      commands,
      store,
      makeAdjustableClock('2026-08-05T00:00:00.000Z'),
    );
    const workspace: WorkspaceLocator = {
      schemaVersion: 1,
      workspaceId,
      taskReference: 'AVIA-12045',
      workflowId: 'tasker:AVIA-12045',
      workflowRunId: 'run-1',
      repository: {
        reference: 'onetwotrip/front-avia',
        sourcePath: repositoryPath,
        baseBranch: 'master',
        baseCommit: 'c'.repeat(40),
      },
      runnerId: 'test',
      path: workspacePath,
      branch: 'tasker/avia-12045/run-1',
      preparedAt: '2026-08-05T00:00:00.000Z',
    };
    const policy: ResolvedWorkspaceRuntimePolicy = {
      engine: 'docker',
      image: { kind: 'prebuilt', reference: config.defaultImage },
      workspaceMountPath: '/workspace',
      environment: { HOME: '/tasker/home' },
      bootstrap: ['pnpm install --frozen-lockfile'],
      cacheVolumes: [{ id: 'node-modules', mountPath: '/workspace/node_modules' }],
      services: [
        {
          id: 'app',
          command: 'pnpm start',
          aliases: ['local.example'],
          environment: {},
        },
      ],
      policyHash: 'd'.repeat(64),
    };

    const failed = await manager.prepare(workspace, policy);
    expect(failed).toEqual({
      ok: false,
      error: {
        kind: 'bootstrap_failed',
        command: 'pnpm install --frozen-lockfile',
        message: '[ERR_PNPM_FETCH_403] Private registry access is forbidden',
      },
    });

    const first = await manager.prepare(workspace, policy);
    expect(first).toMatchObject({ ok: true, value: { status: 'ready' } });
    const bootstrapRunsAfterFirst = requests.filter(
      ({ args }) => args[0] === 'run' && args.includes('pnpm install --frozen-lockfile'),
    ).length;
    expect(bootstrapRunsAfterFirst).toBe(2);

    const interruptedReceipt = await store.read(workspaceId);
    expect(interruptedReceipt).not.toBeNull();
    if (interruptedReceipt === null) throw new Error('Expected a persisted runtime receipt');
    await store.write({
      ...interruptedReceipt,
      initializedVolumes: [],
      status: 'preparing',
    });
    serviceRunning = false;

    const recovered = await manager.prepare(workspace, policy);
    expect(recovered).toMatchObject({ ok: true, value: { status: 'ready' } });
    expect(
      requests.filter(
        ({ args }) => args[0] === 'run' && args.includes('pnpm install --frozen-lockfile'),
      ),
    ).toHaveLength(2);
    expect(
      requests.filter(({ args }) => args[0] === 'run' && args.includes('tasker-volume')),
    ).toHaveLength(2);
    expect(
      requests.filter(({ args }) => args[0] === 'run' && args.includes('--detach')),
    ).toHaveLength(2);
    const repeated = await manager.prepare(workspace, policy);
    expect(repeated).toMatchObject({ ok: true, value: { status: 'ready' } });
    expect(
      requests.filter(({ args }) => args[0] === 'run' && args.includes('tasker-volume')),
    ).toHaveLength(2);
    expect(
      requests.filter(({ args }) => args[0] === 'run' && args.includes('--detach')),
    ).toHaveLength(2);
    expect(
      requests.some(({ args }) =>
        args.includes(
          'mkdir -p "$PNPM_HOME" && mise exec -- corepack enable --install-directory "$PNPM_HOME"',
        ),
      ),
    ).toBe(true);
    expect(
      requests.find(({ args }) => args[0] === 'run' && args.includes('--detach'))?.args,
    ).toEqual(
      expect.arrayContaining([
        '--network-alias',
        'local.example',
        '--add-host',
        'local.example:0.0.0.0',
      ]),
    );
    const receipt = await store.read(workspaceId);
    expect(receipt).toMatchObject({
      workspaceId,
      policyHash: policy.policyHash,
      imageId: 'sha256:workspace-image',
      status: 'ready',
      volumes: [{ id: 'node-modules', mountPath: join(workspacePath, 'node_modules') }],
    });
  });
});
