import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test/browser',
  fullyParallel: false,
  workers: 1,
  retries: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:4310',
    screenshot: 'only-on-failure',
    trace: 'on-first-retry',
  },
  webServer: [
    {
      command: 'pnpm e2e:api',
      url: 'http://127.0.0.1:4311/api/health',
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: 'pnpm dev:cockpit',
      url: 'http://127.0.0.1:4310',
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
});
