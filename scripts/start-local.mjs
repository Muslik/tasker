import { spawn, spawnSync } from 'node:child_process';
import console from 'node:console';
import { mkdirSync } from 'node:fs';
import { get } from 'node:http';
import { connect } from 'node:net';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';

const STARTUP_TIMEOUT_MS = 30_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;

const parsePort = (value, name, fallback) => {
  const port = Number(value ?? fallback);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name} must be an integer between 1 and 65535`);
  }
  return port;
};

const parseTemporalAddress = (value) => {
  const match = /^([^:]+):(\d+)$/u.exec(value);
  if (match === null) {
    throw new Error(`TASKER_TEMPORAL_ADDRESS must use host:port syntax: ${value}`);
  }
  return {
    host: match[1],
    port: parsePort(match[2], 'TASKER_TEMPORAL_ADDRESS port', '7233'),
  };
};

const sleep = (durationMs) =>
  new Promise((resolvePromise) => {
    setTimeout(resolvePromise, durationMs);
  });

const childHasExited = (child) => child.exitCode !== null || child.signalCode !== null;

const canConnect = (host, port) =>
  new Promise((resolvePromise) => {
    const socket = connect({ host, port });
    const finish = (ready) => {
      socket.destroy();
      resolvePromise(ready);
    };
    socket.setTimeout(300);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });

const waitUntil = async (label, ready, child) => {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child !== undefined && childHasExited(child)) {
      throw new Error(`${label} exited before becoming ready (code ${String(child.exitCode)})`);
    }
    if (await ready()) return;
    await sleep(200);
  }
  throw new Error(`${label} did not become ready within ${String(STARTUP_TIMEOUT_MS)}ms`);
};

const taskerHealthy = (url) =>
  new Promise((resolvePromise) => {
    const request = get(`${url}/api/health`, (response) => {
      response.setEncoding('utf8');
      let content = '';
      response.on('data', (chunk) => {
        content += chunk;
      });
      response.once('end', () => {
        try {
          const body = JSON.parse(content);
          resolvePromise(
            response.statusCode === 200 &&
              typeof body === 'object' &&
              body !== null &&
              body.status === 'ok' &&
              body.executionRuntime === 'temporal',
          );
        } catch {
          resolvePromise(false);
        }
      });
    });
    request.setTimeout(500, () => request.destroy());
    request.once('error', () => resolvePromise(false));
  });

const waitForWorkerReady = (child) =>
  new Promise((resolvePromise, rejectPromise) => {
    const timeout = setTimeout(() => {
      cleanup();
      rejectPromise(
        new Error(`Tasker worker did not become ready within ${String(STARTUP_TIMEOUT_MS)}ms`),
      );
    }, STARTUP_TIMEOUT_MS);
    const onMessage = (message) => {
      if (
        typeof message === 'object' &&
        message !== null &&
        message.type === 'tasker-worker-ready'
      ) {
        cleanup();
        resolvePromise();
      }
    };
    const onClose = (code) => {
      cleanup();
      rejectPromise(new Error(`Tasker worker exited before becoming ready (code ${String(code)})`));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.off('message', onMessage);
      child.off('close', onClose);
    };
    child.on('message', onMessage);
    child.once('close', onClose);
  });

const temporalAddressValue = process.env.TASKER_TEMPORAL_ADDRESS ?? '127.0.0.1:7233';
const temporalAddress = parseTemporalAddress(temporalAddressValue);
const temporalNamespace = process.env.TASKER_TEMPORAL_NAMESPACE ?? 'tasker-dev';
const temporalDatabasePath = process.env.TASKER_TEMPORAL_DB_PATH ?? '.tasker/temporal.sqlite';
const taskerDatabasePath = process.env.TASKER_DB_PATH ?? '.tasker/operator.sqlite';
const taskerPort = parsePort(process.env.TASKER_PORT, 'TASKER_PORT', '4311');
const taskerUrl = `http://127.0.0.1:${String(taskerPort)}`;
const temporalIsLocal =
  (temporalAddress.host === '127.0.0.1' || temporalAddress.host === 'localhost') &&
  temporalAddress.port === 7233;

mkdirSync(dirname(resolve(temporalDatabasePath)), { recursive: true });
mkdirSync(dirname(resolve(taskerDatabasePath)), { recursive: true });

const childEnvironment = {
  ...process.env,
  TASKER_DB_PATH: taskerDatabasePath,
  TASKER_PORT: String(taskerPort),
  TASKER_TEMPORAL_ADDRESS: temporalAddressValue,
  TASKER_TEMPORAL_NAMESPACE: temporalNamespace,
};
const children = [];
let shuttingDown = false;
let resolveLifetime;
const lifetime = new Promise((resolvePromise) => {
  resolveLifetime = resolvePromise;
});

const waitForExit = (child) =>
  childHasExited(child)
    ? Promise.resolve()
    : new Promise((resolvePromise) => {
        child.once('close', resolvePromise);
      });

const stopChild = async ({ child }, signal) => {
  if (childHasExited(child)) return;
  child.kill(signal);
  await Promise.race([waitForExit(child), sleep(SHUTDOWN_TIMEOUT_MS)]);
  if (!childHasExited(child)) {
    child.kill('SIGKILL');
    await waitForExit(child);
  }
};

const shutdown = async (exitCode, signal = 'SIGTERM') => {
  if (shuttingDown) return;
  shuttingDown = true;
  await Promise.all(children.toReversed().map((child) => stopChild(child, signal)));
  process.exitCode = exitCode;
  resolveLifetime?.();
};

const fail = (message) => {
  if (shuttingDown) return;
  console.error(`[tasker] ${message}`);
  void shutdown(1);
};

const startChild = (name, command, args, options = {}) => {
  const child = spawn(command, args, {
    cwd: resolve('.'),
    env: childEnvironment,
    stdio: options.ipc === true ? ['inherit', 'inherit', 'inherit', 'ipc'] : 'inherit',
  });
  children.push({ name, child });
  child.once('error', (error) => fail(`${name} could not start: ${error.message}`));
  child.once('exit', (code, signal) => {
    if (!shuttingDown) {
      fail(`${name} stopped unexpectedly (${signal ?? `code ${String(code)}`})`);
    }
  });
  return child;
};

process.once('SIGINT', () => void shutdown(0, 'SIGINT'));
process.once('SIGTERM', () => void shutdown(0));

try {
  if (await canConnect('127.0.0.1', taskerPort)) {
    throw new Error(`Tasker port ${String(taskerPort)} is already in use`);
  }

  let temporalChild;
  if (await canConnect(temporalAddress.host, temporalAddress.port)) {
    console.log(`[tasker] Reusing Temporal at ${temporalAddressValue}`);
  } else {
    if (!temporalIsLocal) {
      throw new Error(`Configured Temporal service is unavailable at ${temporalAddressValue}`);
    }
    const temporalVersion = spawnSync('temporal', ['--version'], { stdio: 'ignore' });
    if (temporalVersion.status !== 0) {
      throw new Error('Temporal CLI is not installed or is unavailable on PATH');
    }
    temporalChild = startChild('Temporal', 'temporal', [
      'server',
      'start-dev',
      '--namespace',
      temporalNamespace,
      '--db-filename',
      temporalDatabasePath,
    ]);
    await waitUntil(
      'Temporal',
      () => canConnect(temporalAddress.host, temporalAddress.port),
      temporalChild,
    );
  }

  const workerChild = startChild(
    'Tasker worker',
    process.execPath,
    ['dist/temporal/worker-main.js'],
    { ipc: true },
  );
  await waitForWorkerReady(workerChild);
  const apiChild = startChild('Tasker API', process.execPath, [
    'dist/control-plane/operator-server.js',
  ]);
  await waitUntil('Tasker API', () => taskerHealthy(taskerUrl), apiChild);

  console.log(`[tasker] Operator console: ${taskerUrl}`);
  if (temporalIsLocal) {
    console.log(`[tasker] Temporal UI: http://127.0.0.1:8233`);
  }
  console.log('[tasker] Press Ctrl-C to stop the complete local stack');
} catch (error) {
  fail(error instanceof Error ? error.message : 'Local stack startup failed');
}

await lifetime;
