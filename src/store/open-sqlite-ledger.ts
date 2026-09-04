import BetterSqlite3 from 'better-sqlite3';
import type { Database as SqliteDatabase } from 'better-sqlite3';

import type { Clock } from '../shared/clock.js';
import { systemClock } from '../shared/clock.js';

import {
  defaultMigrationsDirectory,
  loadMigrations,
  readAppliedMigrations,
  runMigrations,
} from './migrations.js';
import { LedgerRepository } from './repository.js';
import type { AppliedMigration } from './types.js';

export interface OpenSqliteLedgerOptions {
  readonly filename: string;
  readonly busyTimeoutMs?: number;
  readonly clock?: Clock;
  readonly migrationsDirectory?: string;
}

export interface SqliteLedger {
  readonly database: SqliteDatabase;
  readonly repository: LedgerRepository;
  readonly appliedMigrations: readonly AppliedMigration[];
  close(): void;
}

export const openSqliteLedger = (options: OpenSqliteLedgerOptions): SqliteLedger => {
  const busyTimeoutMs = options.busyTimeoutMs ?? 5_000;
  const database = new BetterSqlite3(options.filename, {
    timeout: busyTimeoutMs,
  });

  try {
    database.pragma('journal_mode = WAL');
    database.pragma('foreign_keys = ON');
    database.pragma(`busy_timeout = ${String(busyTimeoutMs)}`);
    database.pragma('synchronous = FULL');

    const clock = options.clock ?? systemClock;
    const migrations = loadMigrations(options.migrationsDirectory ?? defaultMigrationsDirectory);
    const appliedMigrations = runMigrations(database, migrations, clock.now());

    return {
      database,
      repository: new LedgerRepository(database, clock),
      appliedMigrations,
      close: () => {
        if (database.open) {
          database.close();
        }
      },
    };
  } catch (error) {
    if (database.open) {
      database.close();
    }

    throw error;
  }
};

export const readLedgerMigrations = (database: SqliteDatabase): readonly AppliedMigration[] =>
  readAppliedMigrations(database);
