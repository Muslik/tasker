import { z } from 'zod';

import type { CommandResult, CommandRunner } from '../providers/command-runner.js';
import { err, ok, type Outcome } from '../shared/outcome.js';
import type { WorkspaceBootstrapConfiguration } from './configuration.js';
import {
  WorkspaceBootstrapReceiptSchema,
  WorkspaceLocatorSchema,
  type WorkspaceBootstrapReceipt,
  type WorkspaceLocator,
} from './contracts.js';
import type { WorkspaceBootstrapStore, WorkspaceStoreError } from './store.js';

const BootstrapAdapterResponseSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('absent') }).strict(),
  z
    .object({
      status: z.literal('ready'),
      receipt: WorkspaceBootstrapReceiptSchema,
    })
    .strict(),
]);

type BootstrapAdapterResponse = z.infer<typeof BootstrapAdapterResponseSchema>;

export type WorkspaceBootstrapError =
  | { readonly kind: 'adapter_unavailable'; readonly message: string }
  | {
      readonly kind: 'adapter_failed';
      readonly phase: 'inspect' | 'apply';
      readonly message: string;
      readonly retryable: boolean;
    }
  | {
      readonly kind: 'invalid_adapter_response';
      readonly phase: 'inspect' | 'apply';
      readonly issues: readonly string[];
    }
  | { readonly kind: 'receipt_conflict'; readonly reason: string }
  | { readonly kind: 'store'; readonly error: WorkspaceStoreError };

export interface WorkspaceBootstrapAdapter {
  inspect(
    workspace: WorkspaceLocator,
    operationId: string,
  ): Promise<Outcome<BootstrapAdapterResponse, WorkspaceBootstrapError>>;
  apply(
    workspace: WorkspaceLocator,
    operationId: string,
  ): Promise<
    Outcome<
      Extract<BootstrapAdapterResponse, { readonly status: 'ready' }>,
      WorkspaceBootstrapError
    >
  >;
}

export interface WorkspaceBootstrapper {
  prepare(
    workspace: WorkspaceLocator,
  ): Promise<Outcome<WorkspaceBootstrapReceipt, WorkspaceBootstrapError>>;
}

const messageFrom = (result: CommandResult): string => {
  switch (result.status) {
    case 'spawn_failed':
      return result.message;
    case 'timed_out':
      return result.stderr.trim() || 'Workspace bootstrap timed out';
    case 'exited':
      return result.stderr.trim() || `Workspace bootstrap exited with ${String(result.exitCode)}`;
  }
};

const sameReceiptIdentity = (
  receipt: WorkspaceBootstrapReceipt,
  workspace: WorkspaceLocator,
  operationId: string,
): boolean => receipt.workspaceId === workspace.workspaceId && receipt.operationId === operationId;

export class CommandWorkspaceBootstrapAdapter implements WorkspaceBootstrapAdapter {
  public constructor(
    private readonly configuration: WorkspaceBootstrapConfiguration,
    private readonly commands: CommandRunner,
  ) {}

  public inspect(
    workspace: WorkspaceLocator,
    operationId: string,
  ): Promise<Outcome<BootstrapAdapterResponse, WorkspaceBootstrapError>> {
    return this.run('inspect', workspace, operationId);
  }

  public async apply(
    workspace: WorkspaceLocator,
    operationId: string,
  ): Promise<
    Outcome<
      Extract<BootstrapAdapterResponse, { readonly status: 'ready' }>,
      WorkspaceBootstrapError
    >
  > {
    const result = await this.run('apply', workspace, operationId);
    if (!result.ok) return result;
    if (result.value.status === 'absent') {
      return err({
        kind: 'invalid_adapter_response',
        phase: 'apply',
        issues: ['apply must return a ready receipt'],
      });
    }
    return ok(result.value);
  }

  private async run(
    phase: 'inspect' | 'apply',
    workspaceInput: WorkspaceLocator,
    operationId: string,
  ): Promise<Outcome<BootstrapAdapterResponse, WorkspaceBootstrapError>> {
    const workspace = WorkspaceLocatorSchema.parse(workspaceInput);
    if (this.configuration.command === null) {
      return err({
        kind: 'adapter_unavailable',
        message: 'TASKER_WORKSPACE_BOOTSTRAP_COMMAND is not configured',
      });
    }
    const result = await this.commands.run({
      operationId,
      command: this.configuration.command,
      args: [phase],
      cwd: workspace.path,
      env: {},
      stdin: JSON.stringify({ schemaVersion: 1, operationId, workspace }),
      timeoutMs: 5 * 60_000,
    });
    if (result.status !== 'exited' || result.exitCode !== 0) {
      return err({
        kind: 'adapter_failed',
        phase,
        message: messageFrom(result),
        retryable: result.status !== 'exited' || result.exitCode !== 2,
      });
    }
    const parsed = (() => {
      try {
        return BootstrapAdapterResponseSchema.safeParse(JSON.parse(result.stdout) as unknown);
      } catch (error) {
        return {
          success: false as const,
          error: error instanceof Error ? error : new Error('Invalid bootstrap JSON'),
        };
      }
    })();
    if (!parsed.success) {
      const issues =
        'issues' in parsed.error
          ? parsed.error.issues.map(
              (issue) => `${issue.path.map(String).join('.')}: ${issue.message}`,
            )
          : [parsed.error.message];
      return err({ kind: 'invalid_adapter_response', phase, issues });
    }
    if (
      parsed.data.status === 'ready' &&
      !sameReceiptIdentity(parsed.data.receipt, workspace, operationId)
    ) {
      return err({
        kind: 'receipt_conflict',
        reason: 'Bootstrap adapter returned a receipt for another workspace or operation',
      });
    }
    return ok(parsed.data);
  }
}

export class WorkspaceBootstrapCoordinator implements WorkspaceBootstrapper {
  public constructor(
    private readonly store: WorkspaceBootstrapStore,
    private readonly adapter: WorkspaceBootstrapAdapter,
  ) {}

  public async prepare(
    workspaceInput: WorkspaceLocator,
  ): Promise<Outcome<WorkspaceBootstrapReceipt, WorkspaceBootstrapError>> {
    const workspace = WorkspaceLocatorSchema.parse(workspaceInput);
    const operationId = `workspace:${workspace.workspaceId}:bootstrap@1`;
    const stored = this.store.read(workspace.workspaceId);
    if (!stored.ok) return err({ kind: 'store', error: stored.error });
    if (stored.value !== null) {
      return sameReceiptIdentity(stored.value, workspace, operationId)
        ? ok(stored.value)
        : err({ kind: 'receipt_conflict', reason: 'Stored bootstrap receipt identity is invalid' });
    }

    const inspected = await this.adapter.inspect(workspace, operationId);
    if (!inspected.ok) return inspected;
    const ready: Outcome<
      Extract<BootstrapAdapterResponse, { readonly status: 'ready' }>,
      WorkspaceBootstrapError
    > = inspected.value.status === 'ready'
      ? ok(inspected.value)
      : await this.adapter.apply(workspace, operationId);
    if (!ready.ok) return ready;
    if (!sameReceiptIdentity(ready.value.receipt, workspace, operationId)) {
      return err({ kind: 'receipt_conflict', reason: 'Bootstrap receipt identity is invalid' });
    }
    const saved = this.store.save(ready.value.receipt);
    if (!saved.ok) return err({ kind: 'store', error: saved.error });
    return sameReceiptIdentity(saved.value, workspace, operationId)
      ? ok(saved.value)
      : err({ kind: 'receipt_conflict', reason: 'Bootstrap receipt changed concurrently' });
  }
}
