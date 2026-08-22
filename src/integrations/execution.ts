import type { PlanningTaskSnapshot } from '../planning/task-snapshot.js';
import type { HarnessPolicyManifest, HarnessProjectManifest } from '../harness/index.js';
import type { JsonValue } from '../workflow/schema.js';
import type { WorkspaceLocator } from '../workspaces/contracts.js';
import type { PullRequestReviewEvidence } from './bitbucket/review.js';

export interface TaskRunStepEvidence {
  readonly operationId: string;
  readonly nodeId: string;
  readonly stepReference: string;
  readonly status: 'blocked' | 'completed' | 'workflow_change_required';
  readonly summary: string | null;
  readonly artifactIds: readonly string[];
  readonly details: JsonValue;
  readonly recordedAt: string;
}

export interface TaskRunEvidence {
  readonly acceptedPlan: JsonValue | null;
  readonly completedSteps: readonly TaskRunStepEvidence[];
  readonly reviewInputs: readonly PullRequestReviewEvidence[];
}

export interface IntegrationStepRuntime {
  readonly attempt: number;
  readonly cancellationSignal: AbortSignal;
  heartbeat(details: unknown): void;
}

export interface IntegrationStepExecutionRequest {
  readonly operationId: string;
  readonly stepReference: string;
  readonly taskReference: string;
  readonly task: PlanningTaskSnapshot;
  readonly taskSnapshot: JsonValue;
  readonly stepInput: JsonValue;
  readonly workspace: WorkspaceLocator;
  readonly operatorGuidance: string | null;
  readonly waitResolution: JsonValue | null;
  readonly evidence: TaskRunEvidence;
  readonly policies: readonly HarnessPolicyManifest[];
  readonly project: HarnessProjectManifest | null;
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
        | 'verification'
        | 'unknown_outcome';
      readonly summary: string;
      readonly details: JsonValue;
      readonly artifactIds: readonly string[];
    }
  | {
      readonly status: 'waiting';
      readonly waitKind: string;
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
