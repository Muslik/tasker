import { z } from 'zod';

import type { LedgerRepository } from '../../ledger/repository.js';
import type { Clock } from '../../shared/clock.js';
import { err, ok, type Outcome } from '../../shared/outcome.js';
import {
  WorkspaceMutationStateSchema,
  type WorkspaceMutationInspectionFailure,
  type WorkspaceMutationInspector,
} from '../../workspaces/mutation-state.js';
import { JsonValueSchema } from '../../workflow/schema.js';

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

export type WorkspaceMutationRecoveryFailure =
  | WorkspaceMutationInspectionFailure
  | { readonly kind: 'mutation_intent_corrupt'; readonly artifactId: string }
  | { readonly kind: 'mutation_intent_conflict'; readonly artifactId: string }
  | { readonly kind: 'ledger_conflict' };

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
  }): Promise<Outcome<TaskStepRecoveryContext, WorkspaceMutationRecoveryFailure>> {
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
    const committed = this.ledger.transact({
      aggregate: {
        aggregateId: artifactId,
        expectedVersion: 0,
        events: [
          {
            eventId: `event:${artifactId}:1`,
            eventType: 'TaskStepMutationIntentPrepared',
            eventSchemaVersion: 1,
            payload: asJson({ artifactId }),
            actor: 'kernel',
          },
        ],
      },
      artifacts: [
        {
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
        },
      ],
      timestamp: createdAt,
    });
    if (committed.ok) {
      return ok({
        kind: 'initial_delivery',
        intentArtifactId: artifactId,
        baseline: current.value,
      });
    }
    if (this.ledger.readArtifact(artifactId) === null) return err({ kind: 'ledger_conflict' });
    return this.recoveryContext(artifactId, input, current.value);
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
  ): Outcome<TaskStepRecoveryContext, WorkspaceMutationRecoveryFailure> {
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
