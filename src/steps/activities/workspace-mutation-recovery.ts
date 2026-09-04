import { z } from 'zod';

import type { LedgerRepository } from '../../store/repository.js';
import type { Clock } from '../../shared/clock.js';
import { err, ok, type Outcome } from '../../shared/outcome.js';
import {
  WorkspaceMutationStateSchema,
  type WorkspaceMutationInspectionFailure,
  type WorkspaceMutationInspector,
} from '../../workspace/mutation-state.js';
import { JsonValueSchema } from '../../graph/schema.js';

const MutationIntentSchema = z
  .object({
    schemaVersion: z.literal(1),
    operationId: z.string().min(1),
    workspaceId: z.string().min(1),
    workspacePath: z.string().min(1),
    stepReference: z.string().min(1),
    baseline: WorkspaceMutationStateSchema,
    createdAt: z.iso.datetime(),
  })
  .strict();

export const TaskStepRecoveryContextSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('single_attempt') }).strict(),
  z
    .object({
      kind: z.literal('initial_delivery'),
      intentArtifactId: z.string().min(1),
      baseline: WorkspaceMutationStateSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('recovery_delivery'),
      intentArtifactId: z.string().min(1),
      baseline: WorkspaceMutationStateSchema,
      current: WorkspaceMutationStateSchema,
      changedSinceInitialDelivery: z.boolean(),
    })
    .strict(),
]);

export type TaskStepRecoveryContext = z.infer<typeof TaskStepRecoveryContextSchema>;
export type WorkspaceMutationRecoveryContext = Exclude<
  TaskStepRecoveryContext,
  { readonly kind: 'single_attempt' }
>;

export type WorkspaceMutationRecoveryFailure =
  | WorkspaceMutationInspectionFailure
  | { readonly kind: 'mutation_intent_corrupt'; readonly artifactId: string }
  | { readonly kind: 'mutation_intent_conflict'; readonly artifactId: string }
  | { readonly kind: 'ledger_conflict' };

export interface WorkspaceMutationCompletion {
  readonly intentArtifactId: string;
  readonly changed: boolean;
  readonly current: z.infer<typeof WorkspaceMutationStateSchema>;
}

const asJson = (value: unknown) => JsonValueSchema.parse(value);

export class WorkspaceMutationRecoveryStore {
  public constructor(
    private readonly ledger: LedgerRepository,
    private readonly clock: Clock,
    private readonly inspector: WorkspaceMutationInspector,
  ) {}

  public async prepare(input: {
    readonly operationId: string;
    readonly workspaceId: string;
    readonly workspacePath: string;
    readonly stepReference: string;
  }): Promise<Outcome<WorkspaceMutationRecoveryContext, WorkspaceMutationRecoveryFailure>> {
    const current = await this.inspector.inspect(input.workspacePath);
    if (!current.ok) return current;
    const artifactId = `task-step-mutation-intent:${input.operationId}`;
    const existing = this.ledger.readArtifact(artifactId);
    if (existing !== null) return this.recoveryContext(artifactId, input, current.value);

    const createdAt = this.clock.now();
    const intent = MutationIntentSchema.parse({
      schemaVersion: 1,
      ...input,
      baseline: current.value,
      createdAt,
    });
    const committed = this.ledger.insertArtifact({
      artifactId,
      artifactKind: 'task_step_mutation_intent',
      storageUri: `ledger://artifacts/${artifactId}`,
      payload: asJson(intent),
      metadata: asJson({
        operationId: input.operationId,
        workspaceId: input.workspaceId,
        stepReference: input.stepReference,
      }),
      createdAt,
    });
    if (committed) {
      return ok({
        kind: 'initial_delivery',
        intentArtifactId: artifactId,
        baseline: current.value,
      });
    }
    if (this.ledger.readArtifact(artifactId) === null) return err({ kind: 'ledger_conflict' });
    return this.recoveryContext(artifactId, input, current.value);
  }

  public async inspectCompletion(input: {
    readonly operationId: string;
    readonly workspaceId: string;
    readonly workspacePath: string;
    readonly stepReference: string;
  }): Promise<Outcome<WorkspaceMutationCompletion, WorkspaceMutationRecoveryFailure>> {
    const prepared = await this.prepare(input);
    if (!prepared.ok) return prepared;
    return prepared.value.kind === 'recovery_delivery'
      ? ok({
          intentArtifactId: prepared.value.intentArtifactId,
          changed: prepared.value.changedSinceInitialDelivery,
          current: prepared.value.current,
        })
      : ok({
          intentArtifactId: prepared.value.intentArtifactId,
          changed: false,
          current: prepared.value.baseline,
        });
  }

  private recoveryContext(
    artifactId: string,
    input: {
      readonly operationId: string;
      readonly workspaceId: string;
      readonly workspacePath: string;
      readonly stepReference: string;
    },
    current: z.infer<typeof WorkspaceMutationStateSchema>,
  ): Outcome<WorkspaceMutationRecoveryContext, WorkspaceMutationRecoveryFailure> {
    const artifact = this.ledger.readArtifact(artifactId);
    const parsed = MutationIntentSchema.safeParse(artifact?.payload);
    if (!parsed.success) return err({ kind: 'mutation_intent_corrupt', artifactId });
    if (
      parsed.data.operationId !== input.operationId ||
      parsed.data.workspaceId !== input.workspaceId ||
      parsed.data.workspacePath !== input.workspacePath ||
      parsed.data.stepReference !== input.stepReference
    ) {
      return err({ kind: 'mutation_intent_conflict', artifactId });
    }
    return ok({
      kind: 'recovery_delivery',
      intentArtifactId: artifactId,
      baseline: parsed.data.baseline,
      current,
      changedSinceInitialDelivery: parsed.data.baseline.fingerprint !== current.fingerprint,
    });
  }
}
