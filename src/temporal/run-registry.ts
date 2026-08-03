import { z } from 'zod';

import type { LedgerRepository } from '../ledger/index.js';
import { err, ok, type Outcome } from '../shared/outcome.js';
import {
  TASK_WORKFLOW_SCHEMA_VERSION,
  TaskWorkflowSettingsSchema,
  type TaskWorkflowPublicState,
} from './public-state.js';

export const TEMPORAL_RUN_PROJECTION_TYPE = 'temporal_run';

export const TemporalRunReferenceSchema = z
  .object({
    schemaVersion: z.literal(TASK_WORKFLOW_SCHEMA_VERSION),
    taskReference: z.string().min(1),
    workflowId: z.string().min(1),
    runId: z.string().min(1),
    workflowHash: z.string().min(1),
    settings: TaskWorkflowSettingsSchema,
  })
  .strict();

export type TemporalRunReference = z.infer<typeof TemporalRunReferenceSchema>;

export interface TemporalRunRegistry {
  register(
    state: TaskWorkflowPublicState,
  ): Outcome<TemporalRunReference, { readonly message: string }>;
  read(taskReference: string): TemporalRunReference | null;
}

export class LedgerTemporalRunRegistry implements TemporalRunRegistry {
  public constructor(private readonly ledger: LedgerRepository) {}

  public register(
    state: TaskWorkflowPublicState,
  ): Outcome<TemporalRunReference, { readonly message: string }> {
    const reference = TemporalRunReferenceSchema.parse({
      schemaVersion: TASK_WORKFLOW_SCHEMA_VERSION,
      taskReference: state.taskReference,
      workflowId: state.workflowId,
      runId: state.runId,
      workflowHash: state.workflowHash,
      settings: state.settings,
    });
    const committed = this.ledger.transact({
      projections: [
        {
          kind: 'upsert',
          projectionType: TEMPORAL_RUN_PROJECTION_TYPE,
          projectionId: state.taskReference,
          payload: reference,
        },
      ],
    });
    return committed.ok
      ? ok(reference)
      : err({ message: `Temporal run registry rejected ${committed.error.kind}` });
  }

  public read(taskReference: string): TemporalRunReference | null {
    const projection = this.ledger.readProjection(TEMPORAL_RUN_PROJECTION_TYPE, taskReference);
    return projection === null ? null : TemporalRunReferenceSchema.parse(projection.payload);
  }
}
