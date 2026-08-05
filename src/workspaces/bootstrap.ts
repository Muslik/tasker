import { err, ok, type Outcome } from '../shared/outcome.js';
import {
  WorkspaceLocatorSchema,
  type WorkspaceBootstrapReceipt,
  type WorkspaceLocator,
} from './contracts.js';
import type { WorkspaceBootstrapStore, WorkspaceStoreError } from './store.js';

type BootstrapAdapterResponse =
  | { readonly status: 'absent' }
  | { readonly status: 'ready'; readonly receipt: WorkspaceBootstrapReceipt };

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

const sameReceiptIdentity = (
  receipt: WorkspaceBootstrapReceipt,
  workspace: WorkspaceLocator,
  operationId: string,
): boolean => receipt.workspaceId === workspace.workspaceId && receipt.operationId === operationId;

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
