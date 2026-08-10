import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { runM1Cli } from '../../src/control-plane/m1-cli.js';

const directories: string[] = [];

const databasePath = (): string => {
  const directory = mkdtempSync(join(tmpdir(), 'tasker-m1-cli-'));
  directories.push(directory);
  return join(directory, 'ledger.sqlite');
};

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('M1 CLI fallback', () => {
  it('generates and restores the same compiled workflow graph', () => {
    const filename = databasePath();
    const generated: string[] = [];
    const restored: string[] = [];

    const generateExit = runM1Cli(['generate', 'avia-13236-short-bug', '--db', filename], (line) =>
      generated.push(line),
    );
    const showExit = runM1Cli(['show', 'avia-13236-short-bug', '--db', filename], (line) =>
      restored.push(line),
    );

    expect(generateExit).toBe(0);
    expect(showExit).toBe(0);
    expect(restored).toEqual(generated);
    expect(generated.join('\n')).toContain('"kind": "bounded_loop"');
    expect(generated.join('\n')).toContain('"id": "validation-repair-loop"');
    expect(generated.join('\n')).toContain('"uses": "validate.targeted@1"');
    expect(generated.join('\n')).toContain('"uses": "review.agent@1"');
    expect(generated.join('\n')).toContain('"for": "code_review@1"');
  });
});
