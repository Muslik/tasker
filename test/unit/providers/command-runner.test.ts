import { describe, expect, it } from 'vitest';

import { nodeCommandRunner } from '../../../src/agents/command-runner.js';

describe('node command runner', () => {
  it('stops the provider when durable output persistence fails', async () => {
    const result = await nodeCommandRunner.run({
      operationId: 'planning:test:1',
      command: process.execPath,
      args: ['-e', 'process.stdout.write("provider output")'],
      cwd: process.cwd(),
      stdin: '',
      timeoutMs: 5_000,
      onOutput: () => {
        throw new Error('ledger unavailable');
      },
    });

    expect(result).toMatchObject({
      status: 'spawn_failed',
      message: 'Command output observer failed: ledger unavailable',
    });
  });
});
