import { defineConfig } from '@playwright/test';

const parsePort = (input: string | undefined, fallback: number, name: string): number => {
  const value = input === undefined ? fallback : Number(input);
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`Invalid ${name}: ${input ?? ''}`);
  }
  return value;
};

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
  webServer: {
    command: `pnpm exec vite --port ${String(cockpitPort)}`,
    url: `http://127.0.0.1:${String(cockpitPort)}`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
