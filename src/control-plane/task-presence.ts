import { z } from 'zod';

import type { LedgerRepository } from '../ledger/repository.js';
import type { Clock } from '../shared/clock.js';
import { err, ok, type Outcome } from '../shared/outcome.js';
import { JsonValueSchema } from '../workflow/schema.js';

const TaskPresenceSchema = z
  .object({
    taskReference: z.string().min(1),
    status: z.enum(['active', 'removed']),
    revision: z.number().int().positive(),
    updatedAt: z.iso.datetime(),
  })
  .strict()
  .readonly();

export type TaskPresenceError = { readonly kind: 'ledger_conflict' };

const PROJECTION = 'task_presence';
const aggregateIdFor = (taskReference: string): string => `task-presence:${taskReference}`;

export class TaskPresenceStore {
  public constructor(
    private readonly ledger: LedgerRepository,
    private readonly clock: Clock,
  ) {}

  public isRemoved(taskReference: string): boolean {
    const projection = this.ledger.readProjection(PROJECTION, taskReference);
    return projection !== null && TaskPresenceSchema.parse(projection.payload).status === 'removed';
  }

  public remove(taskReference: string): Outcome<void, TaskPresenceError> {
    return this.record(taskReference, 'removed');
  }

  public restore(taskReference: string): Outcome<void, TaskPresenceError> {
    if (!this.isRemoved(taskReference)) return ok(undefined);
    return this.record(taskReference, 'active');
  }

  private record(
    taskReference: string,
    status: 'active' | 'removed',
  ): Outcome<void, TaskPresenceError> {
    const aggregateId = aggregateIdFor(taskReference);
    const version = (this.ledger.readAggregateHead(aggregateId)?.version ?? 0) + 1;
    const updatedAt = this.clock.now();
    const presence = TaskPresenceSchema.parse({
      taskReference,
      status,
      revision: version,
      updatedAt,
    });
    const committed = this.ledger.transact({
      aggregate: {
        aggregateId,
        expectedVersion: version - 1,
        events: [
          {
            eventId: `event:${aggregateId}:${String(version)}`,
            eventType: status === 'removed' ? 'TaskRemoved' : 'TaskRestored',
            eventSchemaVersion: 1,
            payload: JsonValueSchema.parse(presence),
            actor: 'operator',
          },
        ],
      },
      projections: [
        {
          kind: 'upsert',
          projectionType: PROJECTION,
          projectionId: taskReference,
          payload: JsonValueSchema.parse(presence),
        },
      ],
      timestamp: updatedAt,
    });
    return committed.ok ? ok(undefined) : err({ kind: 'ledger_conflict' });
  }
}
