import { z } from 'zod';

import type { LedgerRepository } from '../store/repository.js';
import type { Clock } from '../shared/clock.js';
import { err, ok, type Outcome } from '../shared/outcome.js';

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

const DOCUMENT_KIND = 'task_presence';

export class TaskPresenceStore {
  public constructor(
    private readonly ledger: LedgerRepository,
    private readonly clock: Clock,
  ) {}

  public isRemoved(taskReference: string): boolean {
    const document = this.ledger.readDocument(DOCUMENT_KIND, taskReference);
    return document !== null && TaskPresenceSchema.parse(document.payload).status === 'removed';
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
    const existing = this.ledger.readDocument(DOCUMENT_KIND, taskReference);
    const version = (existing?.revision ?? 0) + 1;
    const updatedAt = this.clock.now();
    const presence = TaskPresenceSchema.parse({
      taskReference,
      status,
      revision: version,
      updatedAt,
    });
    const committed = this.ledger.appendDocument(
      DOCUMENT_KIND,
      taskReference,
      version - 1,
      presence,
      updatedAt,
    );
    return committed.ok ? ok(undefined) : err({ kind: 'ledger_conflict' });
  }
}
