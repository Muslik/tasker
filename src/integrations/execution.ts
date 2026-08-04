import type { TaskFixture } from '../planning/fixtures.js';
import type { JsonValue } from '../workflow/schema.js';
import type { WorkspaceLocator } from '../workspaces/contracts.js';

export interface IntegrationStepRuntime {
  readonly attempt: number;
  readonly cancellationSignal: AbortSignal;
  heartbeat(details: unknown): void;
}

export interface IntegrationStepExecutionRequest {
  readonly operationId: string;
  readonly taskReference: string;
  readonly task: TaskFixture;
  readonly taskSnapshot: JsonValue;
  readonly stepInput: JsonValue;
  readonly workspace: WorkspaceLocator;
  readonly operatorGuidance: string | null;
  readonly runtime: IntegrationStepRuntime;
}

export type IntegrationStepExecutionResult =
  | {
      readonly status: 'completed';
      readonly summary: string;
      readonly output: JsonValue;
      readonly artifactIds: readonly string[];
    }
  | {
      readonly status: 'blocked';
      readonly kind:
        | 'configuration'
        | 'infrastructure'
        | 'invalid_request'
        | 'remote_conflict'
        | 'unknown_outcome';
      readonly summary: string;
      readonly details: JsonValue;
      readonly artifactIds: readonly string[];
    };

export interface IntegrationStepAdapter {
  readonly id: string;
  execute(request: IntegrationStepExecutionRequest): Promise<IntegrationStepExecutionResult>;
}

export class IntegrationStepAdapterRegistry {
  private readonly adapters: ReadonlyMap<string, IntegrationStepAdapter>;

  public constructor(adapters: readonly IntegrationStepAdapter[]) {
    const byId = new Map<string, IntegrationStepAdapter>();
    for (const adapter of adapters) {
      if (byId.has(adapter.id)) throw new Error(`Duplicate integration adapter ${adapter.id}`);
      byId.set(adapter.id, adapter);
    }
    this.adapters = byId;
  }

  public get(id: string): IntegrationStepAdapter | undefined {
    return this.adapters.get(id);
  }
}

export const emptyIntegrationStepAdapterRegistry = new IntegrationStepAdapterRegistry([]);
