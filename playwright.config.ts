import { defineConfig } from '@playwright/test';

const parsePort = (input: string | undefined, fallback: number, name: string): number => {
  const value = input === undefined ? fallback : Number(input);
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`Invalid ${name}: ${input ?? ''}`);
  }
  return value;
};

const apiPort = parsePort(process.env.TASKER_E2E_API_PORT, 4311, 'TASKER_E2E_API_PORT');
const cockpitPort = parsePort(process.env.TASKER_E2E_COCKPIT_PORT, 4310, 'TASKER_E2E_COCKPIT_PORT');

export default defineConfig({
  testDir: './test/browser',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: `http://127.0.0.1:${String(cockpitPort)}`,
    screenshot: 'only-on-failure',
    trace: 'on-first-retry',
  },
  webServer: [
    {
      command: `TASKER_E2E_API_PORT=${String(apiPort)} pnpm e2e:api`,
      url: `http://127.0.0.1:${String(apiPort)}/api/health`,
      reuseExistingServer: false,
      timeout: 30_000,
      gracefulShutdown: { signal: 'SIGTERM', timeout: 15_000 },
    },
    {
      command: `TASKER_API_ORIGIN=http://127.0.0.1:${String(apiPort)} pnpm exec vite --port ${String(cockpitPort)}`,
      url: `http://127.0.0.1:${String(cockpitPort)}`,
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
});
