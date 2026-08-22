import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { TaskStepFilesystemStore } from '../../../src/temporal/activities/task-step-filesystem.js';

describe('task step filesystem store', () => {
  it('reuses durable artifacts and clears only owned scratch on redelivery', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tasker-step-filesystem-'));
    const store = new TaskStepFilesystemStore(root);

    try {
      const first = await store.prepare('workflow:run:step:attempt-1');
      writeFileSync(join(first.artifactsPath, 'before.png'), 'evidence', 'utf8');
      writeFileSync(join(first.scratchPath, 'reproduce.ts'), 'scratch', 'utf8');

      const redelivered = await store.prepare('workflow:run:step:attempt-1');

      expect(redelivered).toEqual(first);
      expect(existsSync(join(redelivered.artifactsPath, 'before.png'))).toBe(true);
      expect(existsSync(join(redelivered.scratchPath, 'reproduce.ts'))).toBe(false);

      await store.cleanupScratch(redelivered);
      expect(existsSync(redelivered.scratchPath)).toBe(false);
      expect(existsSync(redelivered.artifactsPath)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('isolates different operation identities', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tasker-step-filesystem-'));
    const store = new TaskStepFilesystemStore(root);

    try {
      const left = await store.prepare('workflow:run:left:attempt-1');
      const right = await store.prepare('workflow:run:right:attempt-1');

      expect(left.artifactsPath).not.toBe(right.artifactsPath);
      expect(left.scratchPath).not.toBe(right.scratchPath);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
