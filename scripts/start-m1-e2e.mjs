import { mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';

const databasePath = resolve('.tasker/e2e.sqlite');
mkdirSync(dirname(databasePath), { recursive: true });

for (const filename of [databasePath, `${databasePath}-shm`, `${databasePath}-wal`]) {
  rmSync(filename, { force: true });
}

process.env.TASKER_DB_PATH = databasePath;
process.env.TASKER_PORT = '4311';

const { startM1Server } = await import('../dist/control-plane/m1-server.js');
await startM1Server();
