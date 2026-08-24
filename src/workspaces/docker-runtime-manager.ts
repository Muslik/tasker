import { createHash } from 'node:crypto';

import type { HostControlPlaneCommandRunner } from '../providers/command-runner.js';
import type { Clock } from '../shared/clock.js';
import { err, ok, type Outcome } from '../shared/outcome.js';
import type { WorkspaceLocator } from './contracts.js';
import type { DockerWorkspaceConfiguration } from './configuration.js';
import { dockerResourceName } from './docker-command-runner.js';
import type { DockerWorkspaceCommandRunner } from './docker-command-runner.js';
import type {
  DockerWorkspaceRuntimeError,
  DockerWorkspaceRuntimeReceipt,
} from './docker-runtime-contracts.js';
import type { DockerWorkspaceRuntimeStore } from './docker-runtime-store.js';
import type { ResolvedWorkspaceRuntimePolicy } from './runtime-policy.js';

const messageFrom = (result: Awaited<ReturnType<HostControlPlaneCommandRunner['run']>>): string => {
  if (result.status === 'spawn_failed') return result.message;
  const output = result.stderr.trim() || result.stdout.trim();
  if (result.status === 'timed_out') return output || 'Docker command timed out';
  return output || `Docker exited with ${String(result.exitCode)}`;
};

const succeeded = (
  result: Awaited<ReturnType<HostControlPlaneCommandRunner['run']>>,
): result is Extract<typeof result, { status: 'exited' }> =>
  result.status === 'exited' && result.exitCode === 0;

const CONTAINER_ONLY_DOCKER_ENV = new Set(['DOCKER_CERT_PATH', 'DOCKER_HOST', 'DOCKER_TLS_VERIFY']);

const resolveWorkspaceMount = (
  workspace: WorkspaceLocator,
  workspaceMountPath: string,
  mountPath: string,
): string => {
  if (mountPath === workspaceMountPath) return workspace.path;
  const prefix = `${workspaceMountPath.replace(/\/$/u, '')}/`;
  return mountPath.startsWith(prefix)
    ? `${workspace.path}/${mountPath.slice(prefix.length)}`
    : mountPath;
};

const bootstrapHash = (command: string): string =>
  createHash('sha256').update(command).digest('hex');

class RuntimePreparationFailure extends Error {
  public constructor(readonly detail: DockerWorkspaceRuntimeError) {
    super(detail.message);
  }
}

const fail = (detail: DockerWorkspaceRuntimeError): never => {
  throw new RuntimePreparationFailure(detail);
};

export interface DockerWorkspaceRuntimePreparer {
  prepare(
    workspace: WorkspaceLocator,
    policy: ResolvedWorkspaceRuntimePolicy,
    options?: DockerWorkspaceRuntimePreparationOptions,
  ): Promise<Outcome<DockerWorkspaceRuntimeReceipt, DockerWorkspaceRuntimeError>>;
}

export interface DockerWorkspaceRuntimePreparationOptions {
  readonly cancellationSignal?: AbortSignal;
  readonly onProgress?: (progress: { readonly phase: string; readonly detail?: string }) => void;
}

export class DockerWorkspaceRuntimeManager implements DockerWorkspaceRuntimePreparer {
  public constructor(
    private readonly configuration: DockerWorkspaceConfiguration,
    private readonly host: HostControlPlaneCommandRunner,
    private readonly commands: DockerWorkspaceCommandRunner,
    private readonly store: DockerWorkspaceRuntimeStore,
    private readonly clock: Clock,
  ) {}

  public async prepare(
    workspace: WorkspaceLocator,
    proposedPolicy: ResolvedWorkspaceRuntimePolicy,
    options: DockerWorkspaceRuntimePreparationOptions = {},
  ): Promise<Outcome<DockerWorkspaceRuntimeReceipt, DockerWorkspaceRuntimeError>> {
    try {
      options.cancellationSignal?.throwIfAborted();
      options.onProgress?.({ phase: 'resolve_runtime' });
      const existing = await this.readReceipt(workspace.workspaceId);
      if (existing !== null) this.assertIdentity(existing, workspace);
      const policy: ResolvedWorkspaceRuntimePolicy =
        existing === null
          ? proposedPolicy
          : { ...existing.policy, policyHash: existing.policyHash };

      const imageId =
        policy.image.reference === this.configuration.defaultImage
          ? await this.prepareDefaultImage(policy.image.reference)
          : await this.inspectRequiredImage(policy.image.reference);
      options.cancellationSignal?.throwIfAborted();
      options.onProgress?.({ phase: 'reconcile_network' });
      const networkName = dockerResourceName('network', workspace.workspaceId);
      await this.ensureNetwork(networkName, workspace.workspaceId);
      const volumes = policy.cacheVolumes.map((volume) => ({
        id: volume.id,
        name: dockerResourceName('volume', workspace.workspaceId, volume.id),
        mountPath: resolveWorkspaceMount(workspace, policy.workspaceMountPath, volume.mountPath),
        serviceIds: volume.serviceIds,
      }));
      for (const volume of volumes) {
        await this.ensureVolume(volume.name, workspace.workspaceId);
      }
      const services = [];
      for (const service of policy.services) {
        const image = service.image?.reference ?? policy.image.reference;
        const serviceImageId =
          image === policy.image.reference ? imageId : await this.ensureExternalImage(image);
        services.push({
          id: service.id,
          containerName: dockerResourceName('service', workspace.workspaceId, service.id),
          image,
          imageId: serviceImageId,
        });
      }

      const now = this.clock.now();
      const { policyHash, ...pinnedPolicy } = policy;
      let receipt: DockerWorkspaceRuntimeReceipt = {
        schemaVersion: 2,
        workspaceId: workspace.workspaceId,
        workspacePath: workspace.path,
        repositorySourcePath: workspace.repository.sourcePath,
        policyHash,
        policy: pinnedPolicy,
        image: policy.image.reference,
        imageId,
        networkName,
        volumes,
        services,
        environment: policy.environment,
        toolchain: existing?.toolchain ?? null,
        initializedVolumes: existing?.initializedVolumes ?? [],
        completedBootstrap: existing?.completedBootstrap ?? [],
        status: 'preparing',
        preparedAt: existing?.preparedAt ?? now,
        updatedAt: now,
      };
      await this.writeReceipt(receipt);
      receipt = await this.initializeVolumeOwnership(receipt, options);

      const versionSource = await this.commands.runInRuntime(
        {
          command: 'sh',
          args: [
            '-c',
            'test -f .nvmrc || test -f .tool-versions || test -f mise.toml || test -f .mise.toml',
          ],
          cwd: workspace.path,
          stdin: '',
          timeoutMs: 10_000,
          ...(options.cancellationSignal === undefined
            ? {}
            : { cancellationSignal: options.cancellationSignal }),
        },
        receipt,
        policy.image.reference,
      );
      if (!succeeded(versionSource)) {
        return err({
          kind: 'bootstrap_failed',
          command: 'resolve project toolchain version',
          message: 'Project has no .nvmrc, .tool-versions, mise.toml, or .mise.toml',
        });
      }

      const systemBootstrap = [
        'mise settings add idiomatic_version_file_enable_tools node',
        'mise trust --all',
        'mise install',
        'mkdir -p "$PNPM_HOME" && mise exec -- corepack enable --install-directory "$PNPM_HOME"',
        'pnpm config set store-dir /tasker/cache/pnpm-store --global',
      ];
      for (const command of [...systemBootstrap, ...policy.bootstrap]) {
        options.cancellationSignal?.throwIfAborted();
        const hash = bootstrapHash(command);
        if (receipt.completedBootstrap.includes(hash)) continue;
        options.onProgress?.({ phase: 'bootstrap', detail: command });
        const result = await this.commands.runInRuntime(
          {
            operationId: `workspace-bootstrap:${workspace.workspaceId}:${hash}`,
            command: 'bash',
            args: ['-lc', command],
            cwd: workspace.path,
            stdin: '',
            timeoutMs: 35 * 60_000,
            ...(options.cancellationSignal === undefined
              ? {}
              : { cancellationSignal: options.cancellationSignal }),
          },
          receipt,
          policy.image.reference,
        );
        if (!succeeded(result)) {
          return err({ kind: 'bootstrap_failed', command, message: messageFrom(result) });
        }
        receipt = {
          ...receipt,
          completedBootstrap: [...receipt.completedBootstrap, hash],
          updatedAt: this.clock.now(),
        };
        await this.writeReceipt(receipt);
      }

      for (const service of policy.services) {
        options.cancellationSignal?.throwIfAborted();
        options.onProgress?.({ phase: 'service', detail: service.id });
        await this.ensureService(workspace, receipt, service, options);
      }
      if (receipt.toolchain === null) {
        const toolchain = await this.commands.runInRuntime(
          {
            command: 'sh',
            args: ['-c', 'printf \'%s\\n\' "$(node --version)" "$(pnpm --version)"'],
            cwd: workspace.path,
            stdin: '',
            timeoutMs: 30_000,
            ...(options.cancellationSignal === undefined
              ? {}
              : { cancellationSignal: options.cancellationSignal }),
          },
          receipt,
          policy.image.reference,
        );
        if (!succeeded(toolchain)) {
          return err({
            kind: 'bootstrap_failed',
            command: 'read project toolchain versions',
            message: messageFrom(toolchain),
          });
        }
        const [node, pnpm] = toolchain.stdout.trim().split(/\r?\n/u);
        if (node === undefined || pnpm === undefined) {
          return err({
            kind: 'bootstrap_failed',
            command: 'read project toolchain versions',
            message: 'Project toolchain probe returned incomplete output',
          });
        }
        receipt = { ...receipt, toolchain: { node, pnpm } };
      }
      receipt = { ...receipt, status: 'ready', updatedAt: this.clock.now() };
      await this.writeReceipt(receipt);
      return ok(receipt);
    } catch (error) {
      if (options.cancellationSignal?.aborted === true) {
        throw options.cancellationSignal.reason;
      }
      if (error instanceof RuntimePreparationFailure) return err(error.detail);
      return err({
        kind: 'docker_unavailable',
        message: error instanceof Error ? error.message : 'Docker runtime preparation failed',
      });
    }
  }

  private assertIdentity(
    receipt: DockerWorkspaceRuntimeReceipt,
    workspace: WorkspaceLocator,
  ): void {
    if (
      receipt.workspacePath !== workspace.path ||
      receipt.repositorySourcePath !== workspace.repository.sourcePath
    ) {
      fail({
        kind: 'runtime_conflict',
        message: `Docker runtime ${workspace.workspaceId} conflicts with its pinned workspace`,
      });
    }
  }

  private async readReceipt(workspaceId: string): Promise<DockerWorkspaceRuntimeReceipt | null> {
    try {
      return await this.store.read(workspaceId);
    } catch (error) {
      return fail({
        kind: 'store_failed',
        message: error instanceof Error ? error.message : 'Docker runtime receipt cannot be read',
      });
    }
  }

  private async writeReceipt(receipt: DockerWorkspaceRuntimeReceipt): Promise<void> {
    try {
      await this.store.write(receipt);
    } catch (error) {
      fail({
        kind: 'store_failed',
        message:
          error instanceof Error ? error.message : 'Docker runtime receipt cannot be written',
      });
    }
  }

  private async prepareDefaultImage(image: string): Promise<string> {
    try {
      return await this.commands.ensureDefaultImage();
    } catch (error) {
      return fail({
        kind: 'image_unavailable',
        image,
        message: error instanceof Error ? error.message : `Docker image ${image} is unavailable`,
      });
    }
  }

  private async inspectRequiredImage(image: string): Promise<string> {
    const inspected = await this.commands.inspectImage(image);
    if (!inspected.ok) {
      return fail({
        kind: 'image_unavailable',
        image,
        message: `Docker image ${image} is unavailable: ${inspected.message}`,
      });
    }
    return inspected.imageId;
  }

  private async ensureExternalImage(image: string): Promise<string> {
    const inspected = await this.commands.inspectImage(image);
    if (inspected.ok) return inspected.imageId;
    const pulled = await this.docker(['pull', image], 20 * 60_000);
    if (!succeeded(pulled)) {
      return fail({
        kind: 'image_unavailable',
        image,
        message: `Docker image ${image} cannot be pulled: ${messageFrom(pulled)}`,
      });
    }
    const resolved = await this.commands.inspectImage(image);
    if (!resolved.ok) {
      return fail({
        kind: 'image_unavailable',
        image,
        message: `Pulled Docker image ${image} cannot be inspected: ${resolved.message}`,
      });
    }
    return resolved.imageId;
  }

  private async ensureNetwork(name: string, workspaceId: string): Promise<void> {
    const inspected = await this.docker(['network', 'inspect', name], 30_000);
    if (succeeded(inspected)) return;
    const created = await this.docker(
      [
        'network',
        'create',
        '--label',
        'tasker.managed=true',
        '--label',
        `tasker.workspace-id=${workspaceId}`,
        name,
      ],
      30_000,
    );
    if (!succeeded(created))
      throw new Error(`Docker network creation failed: ${messageFrom(created)}`);
  }

  private async ensureVolume(name: string, workspaceId: string): Promise<void> {
    const inspected = await this.docker(['volume', 'inspect', name], 30_000);
    if (succeeded(inspected)) return;
    const created = await this.docker(
      [
        'volume',
        'create',
        '--label',
        'tasker.managed=true',
        '--label',
        `tasker.workspace-id=${workspaceId}`,
        name,
      ],
      30_000,
    );
    if (!succeeded(created))
      throw new Error(`Docker volume creation failed: ${messageFrom(created)}`);
  }

  private async initializeVolumeOwnership(
    receipt: DockerWorkspaceRuntimeReceipt,
    options: DockerWorkspaceRuntimePreparationOptions,
  ): Promise<DockerWorkspaceRuntimeReceipt> {
    if (typeof process.getuid !== 'function') return receipt;
    let current = receipt;
    for (const volume of receipt.volumes.filter(({ serviceIds }) => serviceIds.length === 0)) {
      if (current.initializedVolumes.includes(volume.id)) continue;
      options.cancellationSignal?.throwIfAborted();
      options.onProgress?.({ phase: 'initialize_volume', detail: volume.id });
      const result = await this.commands.runInRuntime(
        {
          command: 'sh',
          args: [
            '-c',
            `mkdir -p -- "$1" && chown -R ${String(process.getuid())}:${String(process.getgid?.() ?? process.getuid())} -- "$1"`,
            'tasker-volume',
            volume.mountPath,
          ],
          cwd: receipt.workspacePath,
          stdin: '',
          timeoutMs: 120_000,
          ...(options.cancellationSignal === undefined
            ? {}
            : { cancellationSignal: options.cancellationSignal }),
        },
        receipt,
        receipt.image,
        { asRoot: true },
      );
      if (!succeeded(result)) {
        throw new Error(`Docker volume ${volume.id} initialization failed: ${messageFrom(result)}`);
      }
      current = {
        ...current,
        initializedVolumes: [...current.initializedVolumes, volume.id],
        updatedAt: this.clock.now(),
      };
      await this.writeReceipt(current);
    }
    return current;
  }

  private async ensureService(
    workspace: WorkspaceLocator,
    receipt: DockerWorkspaceRuntimeReceipt,
    service: ResolvedWorkspaceRuntimePolicy['services'][number],
    options: DockerWorkspaceRuntimePreparationOptions,
  ): Promise<void> {
    const containerName =
      receipt.services.find((candidate) => candidate.id === service.id)?.containerName ??
      dockerResourceName('service', workspace.workspaceId, service.id);
    const serviceReceipt = receipt.services.find((candidate) => candidate.id === service.id);
    if (serviceReceipt === undefined) {
      fail({
        kind: 'runtime_conflict',
        message: `Docker service ${service.id} is absent from the runtime receipt`,
      });
    }
    const serviceImage = serviceReceipt?.image ?? receipt.image;
    const running = await this.docker(
      ['inspect', '--format', '{{.State.Running}}', containerName],
      30_000,
    );
    if (!succeeded(running) || running.stdout.trim() !== 'true') {
      await this.docker(['rm', '--force', containerName], 30_000);
      const args = [
        'run',
        '--detach',
        '--init',
        '--name',
        containerName,
        '--label',
        'tasker.managed=true',
        '--label',
        `tasker.workspace-id=${workspace.workspaceId}`,
        '--network',
        receipt.networkName,
      ];
      if (service.privileged) args.push('--privileged');
      for (const alias of service.aliases) {
        args.push('--network-alias', alias, '--add-host', `${alias}:0.0.0.0`);
      }
      args.push(
        '--volume',
        `${workspace.path}:${workspace.path}`,
        '--volume',
        `${workspace.repository.sourcePath}:${workspace.repository.sourcePath}`,
      );
      for (const volume of receipt.volumes.filter(
        ({ serviceIds }) => serviceIds.length === 0 || serviceIds.includes(service.id),
      )) {
        args.push('--volume', `${volume.name}:${volume.mountPath}`);
      }
      if (!service.privileged && typeof process.getuid === 'function') {
        args.push(
          '--user',
          `${String(process.getuid())}:${String(process.getgid?.() ?? process.getuid())}`,
        );
      }
      const environment = { ...receipt.environment, ...service.environment };
      for (const name of Object.keys(environment).sort()) {
        args.push(
          '--env',
          CONTAINER_ONLY_DOCKER_ENV.has(name) ? `${name}=${environment[name] ?? ''}` : name,
        );
      }
      args.push('--workdir', workspace.path, serviceImage, service.shell, '-lc', service.command);
      const started = await this.host.run({
        command: this.configuration.executable,
        args,
        cwd: workspace.path,
        env: Object.fromEntries(
          Object.entries(environment).filter(([name]) => !CONTAINER_ONLY_DOCKER_ENV.has(name)),
        ),
        unsetEnv: [...CONTAINER_ONLY_DOCKER_ENV],
        stdin: '',
        timeoutMs: 120_000,
        ...(options.cancellationSignal === undefined
          ? {}
          : { cancellationSignal: options.cancellationSignal }),
      });
      if (!succeeded(started)) {
        fail({
          kind: 'service_failed',
          service: service.id,
          message: `Docker service ${service.id} failed to start: ${messageFrom(started)}`,
        });
      }
    }
    if (service.readyCheck === undefined) return;
    for (let attempt = 0; attempt < 180; attempt += 1) {
      options.cancellationSignal?.throwIfAborted();
      options.onProgress?.({
        phase: 'service_ready_check',
        detail: `${service.id}:${String(attempt + 1)}`,
      });
      const checked = await this.commands.runInRuntime(
        {
          command: 'bash',
          args: ['-lc', service.readyCheck],
          cwd: workspace.path,
          stdin: '',
          timeoutMs: 15_000,
          ...(options.cancellationSignal === undefined
            ? {}
            : { cancellationSignal: options.cancellationSignal }),
        },
        receipt,
        receipt.image,
      );
      if (succeeded(checked)) return;
      const serviceState = await this.docker(
        ['inspect', '--format', '{{.State.Status}} {{.State.ExitCode}}', containerName],
        30_000,
      );
      if (succeeded(serviceState) && /^(?:dead|exited)\b/u.test(serviceState.stdout.trim())) {
        const logs = await this.docker(['logs', '--tail', '100', containerName], 30_000);
        fail({
          kind: 'service_failed',
          service: service.id,
          message: `Docker service ${service.id} stopped (${serviceState.stdout.trim()}) before it became ready: ${
            succeeded(logs) ? logs.stdout : messageFrom(logs)
          }`,
        });
      }
      await new Promise<void>((resolve, reject) => {
        const finish = (): void => {
          options.cancellationSignal?.removeEventListener('abort', cancel);
          resolve();
        };
        const timeout = setTimeout(finish, 2_000);
        const cancel = (): void => {
          clearTimeout(timeout);
          reject(new Error('Docker runtime cancelled'));
        };
        options.cancellationSignal?.addEventListener('abort', cancel, { once: true });
      });
    }
    const logs = await this.docker(['logs', '--tail', '100', containerName], 30_000);
    fail({
      kind: 'service_failed',
      service: service.id,
      message: `Docker service ${service.id} did not become ready: ${succeeded(logs) ? logs.stdout : messageFrom(logs)}`,
    });
  }

  private docker(args: readonly string[], timeoutMs: number) {
    return this.host.run({
      command: this.configuration.executable,
      args,
      cwd: this.configuration.imageContextPath,
      stdin: '',
      timeoutMs,
    });
  }
}
