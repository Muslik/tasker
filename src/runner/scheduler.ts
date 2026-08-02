import { z } from 'zod';

import type { LedgerRepository } from '../ledger/repository.js';
import type { Clock } from '../shared/clock.js';
import { err, ok, type Outcome } from '../shared/outcome.js';
import type { RunProjection } from './contracts.js';
import type { DeterministicStubRunService, DriveOptions, StubRunError } from './stub-runner.js';

export const StubSchedulerConfigurationSchema = z
  .object({
    capacity: z.number().int().positive(),
    ownerId: z.string().min(1),
    leaseTimeoutMs: z.number().int().positive(),
    pollIntervalMs: z.number().int().positive(),
  })
  .strict();

export interface SchedulerTickOptions {
  readonly maxNodeTransitionsPerRun?: number;
}

export interface SchedulerSnapshot {
  readonly capacity: number;
  readonly queued: readonly string[];
  readonly executing: readonly string[];
  readonly waiting: readonly string[];
  readonly completed: readonly string[];
}

export type StubSchedulerError = { readonly kind: 'runner'; readonly error: StubRunError };

const byQueueOrder = (left: RunProjection, right: RunProjection): number =>
  left.queuedAt.localeCompare(right.queuedAt) ||
  left.taskReference.localeCompare(right.taskReference);

const snapshotFrom = (capacity: number, runs: readonly RunProjection[]): SchedulerSnapshot => ({
  capacity,
  queued: runs
    .filter((run) => run.status === 'queued')
    .sort(byQueueOrder)
    .map((run) => run.taskReference),
  executing: runs.filter((run) => run.status === 'executing').map((run) => run.taskReference),
  waiting: runs.filter((run) => run.status === 'waiting').map((run) => run.taskReference),
  completed: runs.filter((run) => run.status === 'completed').map((run) => run.taskReference),
});

export class DurableStubScheduler {
  private timer: NodeJS.Timeout | null = null;
  private readonly configuration;

  public constructor(
    private readonly runner: DeterministicStubRunService,
    private readonly ledger: LedgerRepository,
    private readonly clock: Clock,
    configuration: z.input<typeof StubSchedulerConfigurationSchema>,
  ) {
    this.configuration = StubSchedulerConfigurationSchema.parse(configuration);
  }

  public enqueue(taskReference: string): Outcome<RunProjection, StubSchedulerError> {
    const result = this.runner.enqueue(taskReference);
    return result.ok ? result : err({ kind: 'runner', error: result.error });
  }

  public tick(options: SchedulerTickOptions = {}): Outcome<SchedulerSnapshot, StubSchedulerError> {
    const driveOptions: DriveOptions = {
      ...(options.maxNodeTransitionsPerRun === undefined
        ? {}
        : { maxNodeTransitions: options.maxNodeTransitionsPerRun }),
    };
    const initial = this.runner.list();
    if (!initial.ok) return err({ kind: 'runner', error: initial.error });

    for (const run of initial.value) {
      if (run.status !== 'executing') continue;
      if (run.lease.ownerId === this.configuration.ownerId) {
        const advanced = this.runner.advanceClaimed(run, driveOptions);
        if (!advanced.ok) return err({ kind: 'runner', error: advanced.error });
        continue;
      }

      const lease = this.ledger.readLease(run.lease.leaseKey);
      if (lease === null || !this.leaseExpired(lease.renewedAt)) continue;
      const replaced = this.runner.replaceExpiredLease(
        run.taskReference,
        this.configuration.ownerId,
        driveOptions,
      );
      if (!replaced.ok) return err({ kind: 'runner', error: replaced.error });
    }

    const afterRecovery = this.runner.list();
    if (!afterRecovery.ok) return err({ kind: 'runner', error: afterRecovery.error });
    let executing = afterRecovery.value.filter((run) => run.status === 'executing').length;
    const queued = afterRecovery.value.filter((run) => run.status === 'queued').sort(byQueueOrder);

    for (const run of queued) {
      if (executing >= this.configuration.capacity) break;
      const claimed = this.runner.claim(
        run.taskReference,
        this.configuration.ownerId,
        driveOptions,
      );
      if (!claimed.ok) return err({ kind: 'runner', error: claimed.error });
      if (claimed.value.status === 'executing') executing += 1;
    }

    const final = this.runner.list();
    return final.ok
      ? ok(snapshotFrom(this.configuration.capacity, final.value))
      : err({ kind: 'runner', error: final.error });
  }

  public start(): void {
    if (this.timer !== null) return;
    void this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, this.configuration.pollIntervalMs);
    this.timer.unref();
  }

  public stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  public snapshot(): Outcome<SchedulerSnapshot, StubSchedulerError> {
    const runs = this.runner.list();
    return runs.ok
      ? ok(snapshotFrom(this.configuration.capacity, runs.value))
      : err({ kind: 'runner', error: runs.error });
  }

  private leaseExpired(renewedAt: string): boolean {
    const nowMs = Date.parse(this.clock.now());
    const renewedAtMs = Date.parse(renewedAt);
    if (!Number.isFinite(nowMs) || !Number.isFinite(renewedAtMs)) {
      return false;
    }
    return nowMs - renewedAtMs >= this.configuration.leaseTimeoutMs;
  }
}
