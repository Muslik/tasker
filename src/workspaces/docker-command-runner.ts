import { createHash, randomUUID } from 'node:crypto';
import { relative, resolve } from 'node:path';

import type {
  CommandMount,
  CommandRequest,
  CommandResult,
  HostControlPlaneCommandRunner,
  WorkspaceCommandRunner,
} from '../providers/command-runner.js';
import type { DockerWorkspaceConfiguration } from './configuration.js';
import type { DockerWorkspaceRuntimeReceipt } from './docker-runtime-contracts.js';
import type { DockerWorkspaceRuntimeStore } from './docker-runtime-store.js';

const failureMessage = (result: CommandResult): string => {
  if (result.status === 'spawn_failed') return result.message;
  const output = result.stderr.trim() || result.stdout.trim();
  if (result.status === 'timed_out') return output || 'Docker command timed out';
  return output || `Docker exited with ${String(result.exitCode)}`;
};

const isSuccessful = (
  result: CommandResult,
): result is Extract<CommandResult, { status: 'exited' }> =>
  result.status === 'exited' && result.exitCode === 0;

const CONTAINER_ONLY_DOCKER_ENV = new Set(['DOCKER_CERT_PATH', 'DOCKER_HOST', 'DOCKER_TLS_VERIFY']);

const volumeArgument = (source: string, target: string, readOnly = false): string =>
  `${source}:${target}${readOnly ? ':ro' : ''}`;

const workspaceIdFromPath = (workspaceStorePath: string, cwd: string): string | null => {
  const tail = relative(resolve(workspaceStorePath), resolve(cwd));
  if (tail === '' || tail === '..' || tail.startsWith('../')) return null;
  const workspaceId = tail.split('/')[0];
  return workspaceId !== undefined && /^[a-f0-9]{24}$/u.test(workspaceId) ? workspaceId : null;
};

export class DockerWorkspaceCommandRunner implements WorkspaceCommandRunner {
  public readonly executionEnvironment = 'docker_workspace' as const;
  private imagePreparation: Promise<string> | null = null;

  public constructor(
    private readonly configuration: DockerWorkspaceConfiguration,
    private readonly host: HostControlPlaneCommandRunner,
    private readonly runtimes: DockerWorkspaceRuntimeStore,
  ) {}

  public async run(request: CommandRequest): Promise<CommandResult> {
    const workspaceId = workspaceIdFromPath(this.configuration.workspaceStorePath, request.cwd);
    try {
      const runtime = workspaceId === null ? null : await this.runtimes.read(workspaceId);
      if (workspaceId !== null && runtime === null) {
        return {
          status: 'spawn_failed',
          message: `Managed workspace ${workspaceId} has no prepared Docker runtime`,
          durationMs: 0,
        };
      }

      const image = runtime?.image ?? this.configuration.defaultImage;
      const imageReady = await this.ensureImage(image);
      if (imageReady.status !== 'ready') {
        return { status: 'spawn_failed', message: imageReady.message, durationMs: 0 };
      }
      return await this.runInRuntime(request, runtime, image);
    } catch (error) {
      return {
        status: 'spawn_failed',
        message: error instanceof Error ? error.message : 'Docker runtime receipt is unreadable',
        durationMs: 0,
      };
    }
  }

  public async inspectImage(
    image: string,
  ): Promise<
    | { readonly ok: true; readonly imageId: string }
    | { readonly ok: false; readonly message: string }
  > {
    const result = await this.host.run({
      command: this.configuration.executable,
      args: ['image', 'inspect', '--format', '{{.Id}}', image],
      cwd: this.configuration.imageContextPath,
      stdin: '',
      timeoutMs: 30_000,
    });
    return isSuccessful(result)
      ? { ok: true, imageId: result.stdout.trim() }
      : { ok: false, message: failureMessage(result) };
  }

  public async ensureDefaultImage(): Promise<string> {
    if (this.imagePreparation === null) {
      this.imagePreparation = this.prepareDefaultImage();
    }
    const preparation = this.imagePreparation;
    try {
      return await preparation;
    } finally {
      if (this.imagePreparation === preparation) this.imagePreparation = null;
    }
  }

  public async runInRuntime(
    request: CommandRequest,
    runtime: DockerWorkspaceRuntimeReceipt | null,
    image: string,
    options: { readonly asRoot?: boolean } = {},
  ): Promise<CommandResult> {
    const name = `tasker-command-${randomUUID().slice(0, 12)}`;
    const environment = {
      ...(runtime?.environment ?? {
        HOME: request.env?.CODEX_HOME ?? request.cwd,
      }),
      ...request.env,
    };
    const workspaceReadOnly = request.workspaceAccess === 'read_only';
    const mounts = new Map<string, CommandMount>();
    const addMount = (mount: CommandMount): string | null => {
      const existing = mounts.get(mount.target);
      if (
        existing !== undefined &&
        (existing.source !== mount.source || existing.readOnly !== mount.readOnly)
      ) {
        return `Conflicting Docker mount target ${mount.target}`;
      }
      mounts.set(mount.target, mount);
      return null;
    };
    let mountConflict: string | null;
    if (runtime === null) {
      mountConflict = addMount({
        source: request.cwd,
        target: request.cwd,
        readOnly: workspaceReadOnly,
      });
    } else {
      mountConflict =
        addMount({
          source: runtime.workspacePath,
          target: runtime.workspacePath,
          readOnly: workspaceReadOnly,
        }) ??
        addMount({
          source: runtime.repositorySourcePath,
          target: runtime.repositorySourcePath,
          readOnly: workspaceReadOnly,
        });
    }
    for (const mount of request.mounts ?? []) {
      mountConflict ??= addMount(mount);
    }
    if (mountConflict !== null) {
      return { status: 'spawn_failed', message: mountConflict, durationMs: 0 };
    }

    const args = [
      'run',
      '--rm',
      '--init',
      '--interactive',
      '--name',
      name,
      '--label',
      'tasker.managed=true',
    ];
    if (runtime !== null) {
      args.push(
        '--label',
        `tasker.workspace-id=${runtime.workspaceId}`,
        '--network',
        runtime.networkName,
      );
      for (const volume of runtime.volumes.filter(({ serviceIds }) => serviceIds.length === 0)) {
        args.push('--volume', volumeArgument(volume.name, volume.mountPath));
      }
    }
    for (const mount of mounts.values()) {
      args.push('--volume', volumeArgument(mount.source, mount.target, mount.readOnly));
    }
    if (options.asRoot !== true && typeof process.getuid === 'function') {
      args.push(
        '--user',
        `${String(process.getuid())}:${String(process.getgid?.() ?? process.getuid())}`,
      );
    }
    args.push('--workdir', request.cwd);
    for (const name of Object.keys(environment).sort()) {
      args.push(
        '--env',
        CONTAINER_ONLY_DOCKER_ENV.has(name) ? `${name}=${environment[name] ?? ''}` : name,
      );
    }
    args.push(image, request.command, ...request.args);
    const hostEnvironment = Object.fromEntries(
      Object.entries(environment).filter(([name]) => !CONTAINER_ONLY_DOCKER_ENV.has(name)),
    );
    const unsetEnv = [...new Set([...(request.unsetEnv ?? []), ...CONTAINER_ONLY_DOCKER_ENV])];

    let result: CommandResult;
    try {
      result = await this.host.run({
        ...(request.operationId === undefined ? {} : { operationId: request.operationId }),
        command: this.configuration.executable,
        args,
        cwd: request.cwd,
        env: hostEnvironment,
        unsetEnv,
        stdin: request.stdin,
        timeoutMs: request.timeoutMs,
        ...(request.cancellationSignal === undefined
          ? {}
          : { cancellationSignal: request.cancellationSignal }),
        ...(request.onOutput === undefined ? {} : { onOutput: request.onOutput }),
      });
    } catch (error) {
      return {
        status: 'spawn_failed',
        message: error instanceof Error ? error.message : 'Docker command construction failed',
        durationMs: 0,
      };
    }
    if (request.cancellationSignal?.aborted === true || result.status === 'timed_out') {
      await this.host.run({
        command: this.configuration.executable,
        args: ['rm', '--force', name],
        cwd: request.cwd,
        stdin: '',
        timeoutMs: 30_000,
      });
    }
    return result;
  }

  private async ensureImage(
    image: string,
  ): Promise<
    { readonly status: 'ready' } | { readonly status: 'failed'; readonly message: string }
  > {
    if (image === this.configuration.defaultImage) {
      try {
        await this.ensureDefaultImage();
        return { status: 'ready' };
      } catch (error) {
        return {
          status: 'failed',
          message: error instanceof Error ? error.message : 'Default Docker image is unavailable',
        };
      }
    }
    const inspected = await this.inspectImage(image);
    return inspected.ok
      ? { status: 'ready' }
      : { status: 'failed', message: `Docker image ${image} is unavailable: ${inspected.message}` };
  }

  private async prepareDefaultImage(): Promise<string> {
    const current = await this.inspectImage(this.configuration.defaultImage);
    if (current.ok) return current.imageId;
    const built = await this.host.run({
      command: this.configuration.executable,
      args: [
        'build',
        '--tag',
        this.configuration.defaultImage,
        '--file',
        this.configuration.imageDockerfilePath,
        this.configuration.imageContextPath,
      ],
      cwd: this.configuration.imageContextPath,
      stdin: '',
      timeoutMs: 30 * 60_000,
    });
    if (!isSuccessful(built)) {
      throw new Error(`Docker workspace image build failed: ${failureMessage(built)}`);
    }
    const inspected = await this.inspectImage(this.configuration.defaultImage);
    if (!inspected.ok)
      throw new Error(`Built Docker image cannot be inspected: ${inspected.message}`);
    return inspected.imageId;
  }
}

export const dockerResourceName = (kind: string, workspaceId: string, suffix?: string): string => {
  const tail = suffix === undefined ? '' : `-${suffix}`;
  const raw = `tasker-${kind}-${workspaceId}${tail}`.toLocaleLowerCase('en-US');
  return raw.length <= 63
    ? raw
    : `${raw.slice(0, 50)}-${createHash('sha256').update(raw).digest('hex').slice(0, 12)}`;
};
