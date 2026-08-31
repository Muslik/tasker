import { describe, expect, it, vi } from 'vitest';

import { readStoredBoolean, writeStoredBoolean } from './collapse-state.js';

describe('collapse state persistence', () => {
  it('restores and writes a collapsed state through localStorage', () => {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
    });

    writeStoredBoolean('task-queue', true);

    expect(readStoredBoolean('task-queue')).toBe(true);
    vi.unstubAllGlobals();
  });

  it('keeps the default when browser storage throws', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('storage unavailable');
      },
      setItem: () => {
        throw new Error('storage unavailable');
      },
    });

    expect(readStoredBoolean('task-queue', true)).toBe(true);
    expect(() => {
      writeStoredBoolean('task-queue', true);
    }).not.toThrow();
    vi.unstubAllGlobals();
  });
});
