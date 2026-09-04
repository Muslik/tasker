import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import type { Database as SqliteDatabase } from 'better-sqlite3';

import { checksumString } from './checksum.js';
import type { AppliedMigration } from './types.js';

export interface MigrationDefinition {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
  readonly checksum: string;
}

const MIGRATION_FILENAME_PATTERN = /^(?<version>\d+)_?(?<name>.+)\.sql$/;

export const defaultMigrationsDirectory = fileURLToPath(new URL('./sql', import.meta.url));

export const bootstrapMigrationTables = (database: SqliteDatabase): void => {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
};

export const loadMigrations = (migrationsDirectory: string): readonly MigrationDefinition[] => {
  const definitions = readdirSync(migrationsDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
    .map((entry) => {
      const match = MIGRATION_FILENAME_PATTERN.exec(entry.name);
      if (match?.groups === undefined) {
        throw new Error(`Invalid migration filename: ${entry.name}`);
      }

      const version = Number(match.groups.version);
      const name = match.groups.name;
      if (!Number.isInteger(version) || version <= 0) {
        throw new Error(`Invalid migration version in ${entry.name}`);
      }
      if (name === undefined || name.length === 0) {
        throw new Error(`Invalid migration name in ${entry.name}`);
      }

      const sql = readFileSync(join(migrationsDirectory, entry.name), 'utf8');

      return {
        version,
        name,
        sql,
        checksum: checksumString(sql),
      } satisfies MigrationDefinition;
    })
    .sort((left, right) => left.version - right.version);

  for (let index = 1; index < definitions.length; index += 1) {
    if (definitions[index - 1]?.version === definitions[index]?.version) {
      throw new Error(`Duplicate migration version: ${String(definitions[index]?.version)}`);
    }
  }

  return definitions;
};

export const readAppliedMigrations = (database: SqliteDatabase): readonly AppliedMigration[] =>
  database
    .prepare<[], { version: number; name: string; checksum: string; applied_at: string }>(
      `
        SELECT version, name, checksum, applied_at
        FROM schema_migrations
        ORDER BY version ASC
      `,
    )
    .all()
    .map((row) => ({
      version: row.version,
      name: row.name,
      checksum: row.checksum,
      appliedAt: row.applied_at,
    }));

export const runMigrations = (
  database: SqliteDatabase,
  migrations: readonly MigrationDefinition[],
  appliedAt: string,
): readonly AppliedMigration[] => {
  bootstrapMigrationTables(database);

  const apply = database.transaction(() => {
    const appliedRows = readAppliedMigrations(database);
    const appliedByVersion = new Map(appliedRows.map((row) => [row.version, row]));
    const definitionsByVersion = new Map(
      migrations.map((migration) => [migration.version, migration]),
    );

    for (const applied of appliedRows) {
      const source = definitionsByVersion.get(applied.version);
      if (source === undefined) {
        throw new Error(
          `Applied migration version ${String(applied.version)} is missing from source definitions`,
        );
      }

      if (source.name !== applied.name) {
        throw new Error(
          `Applied migration name mismatch for version ${String(applied.version)}: expected ${applied.name}, received ${source.name}`,
        );
      }
    }

    for (const migration of migrations) {
      const applied = appliedByVersion.get(migration.version);
      if (applied !== undefined) {
        if (applied.checksum !== migration.checksum) {
          throw new Error(
            `Migration checksum mismatch for version ${String(migration.version)}: expected ${applied.checksum}, received ${migration.checksum}`,
          );
        }

        continue;
      }

      database.exec(migration.sql);
      database
        .prepare<[number, string, string, string]>(
          `
            INSERT INTO schema_migrations (version, name, checksum, applied_at)
            VALUES (?, ?, ?, ?)
          `,
        )
        .run(migration.version, migration.name, migration.checksum, appliedAt);
    }
  });

  apply();

  return readAppliedMigrations(database);
};
