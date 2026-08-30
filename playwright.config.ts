import { defineConfig } from '@playwright/test';

const parsePort = (input: string | undefined, fallback: number, name: string): number => {
  const value = input === undefined ? fallback : Number(input);
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`Invalid ${name}: ${input ?? ''}`);
  }
  return value;
};

const uiPort = parsePort(process.env.TASKER_E2E_UI_PORT, 4312, 'TASKER_E2E_UI_PORT');

export default defineConfig({
  testDir: './test/browser',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: `http://127.0.0.1:${String(uiPort)}`,
    screenshot: 'only-on-failure',
    trace: 'on-first-retry',
  },
  webServer: {
    command: `pnpm exec vite --config vite.ui.config.ts --port ${String(uiPort)}`,
    url: `http://127.0.0.1:${String(uiPort)}`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
