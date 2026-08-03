import { spawn } from 'node:child_process';

export interface CommandRequest {
  readonly operationId?: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly stdin: string;
  readonly timeoutMs: number;
  readonly cancellationSignal?: AbortSignal;
  readonly onOutput?: ((stream: 'stdout' | 'stderr', chunk: string) => void) | undefined;
}

export type CommandResult =
  | {
      readonly status: 'exited';
      readonly exitCode: number;
      readonly stdout: string;
      readonly stderr: string;
      readonly durationMs: number;
    }
  | {
      readonly status: 'spawn_failed';
      readonly message: string;
      readonly durationMs: number;
    }
  | {
      readonly status: 'timed_out';
      readonly stdout: string;
      readonly stderr: string;
      readonly durationMs: number;
    };

export interface CommandRunner {
  run(request: CommandRequest): Promise<CommandResult>;
}

const elapsedMilliseconds = (startedAt: bigint): number =>
  Number(process.hrtime.bigint() - startedAt) / 1_000_000;

export const nodeCommandRunner: CommandRunner = {
  run: (request) =>
    new Promise((resolve) => {
      const startedAt = process.hrtime.bigint();
      const child = spawn(request.command, [...request.args], {
        cwd: request.cwd,
        env: { ...process.env, ...request.env },
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      let settled = false;
      let timedOut = false;

      const cancelChild = (): void => {
        child.kill('SIGTERM');
      };

      const finish = (result: CommandResult): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        request.cancellationSignal?.removeEventListener('abort', cancelChild);
        resolve(result);
      };

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk;
        try {
          request.onOutput?.('stdout', chunk);
        } catch (error) {
          child.kill('SIGTERM');
          finish({
            status: 'spawn_failed',
            message: `Command output observer failed: ${error instanceof Error ? error.message : 'unknown error'}`,
            durationMs: elapsedMilliseconds(startedAt),
          });
        }
      });
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
        try {
          request.onOutput?.('stderr', chunk);
        } catch (error) {
          child.kill('SIGTERM');
          finish({
            status: 'spawn_failed',
            message: `Command output observer failed: ${error instanceof Error ? error.message : 'unknown error'}`,
            durationMs: elapsedMilliseconds(startedAt),
          });
        }
      });
      child.once('error', (error) => {
        finish({
          status: 'spawn_failed',
          message: error.message,
          durationMs: elapsedMilliseconds(startedAt),
        });
      });
      child.once('close', (exitCode) => {
        const durationMs = elapsedMilliseconds(startedAt);
        if (timedOut) {
          finish({ status: 'timed_out', stdout, stderr, durationMs });
          return;
        }

        finish({ status: 'exited', exitCode: exitCode ?? 1, stdout, stderr, durationMs });
      });

      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
      }, request.timeoutMs);

      request.cancellationSignal?.addEventListener('abort', cancelChild, { once: true });
      if (request.cancellationSignal?.aborted === true) cancelChild();

      child.stdin.on('error', () => {
        // The exit/close event owns the durable process result, including early EPIPE.
      });
      child.stdin.end(request.stdin);
    }),
};
