export const runnerModuleBoundary = {
  name: 'runner',
  status: 'reserved',
  activatesAt: 'M2',
} as const;
export * from './contracts.js';
export * from './stub-runner.js';
