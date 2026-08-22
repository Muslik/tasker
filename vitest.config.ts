import { defineConfig } from 'vitest/config';
import { fileURLToPath, URL } from 'node:url';

const sourceRoot = fileURLToPath(new URL('./src', import.meta.url));

const project = (name: string, include: string[]) => ({
  resolve: { alias: { '@': sourceRoot } },
  test: {
    name,
    include,
  },
});

export default defineConfig({
  resolve: {
    alias: {
      '@': sourceRoot,
    },
  },
  test: {
    projects: [
      project('unit', ['test/unit/**/*.test.ts', 'test/unit/**/*.test.tsx']),
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
