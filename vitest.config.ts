import { defineConfig } from 'vitest/config';

const project = (name: string, include: string[]) => ({
  test: {
    name,
    include,
  },
});

export default defineConfig({
  test: {
    projects: [
      project('unit', ['test/unit/**/*.test.ts']),
      project('property', ['test/property/**/*.test.ts']),
      project('repository', ['test/repository/**/*.test.ts']),
      project('contract', ['test/contract/**/*.test.ts']),
      project('recovery', ['test/recovery/**/*.test.ts']),
      project('operator', ['test/operator/**/*.test.ts']),
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      include: ['src/**/*.ts'],
    },
  },
});
