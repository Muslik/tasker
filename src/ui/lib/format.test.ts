import { describe, expect, it } from 'vitest';

import { formatDuration, formatElapsed } from './format.js';

describe('format helpers', () => {
  it('formats elapsed timestamps relative to a supplied clock', () => {
    expect(formatElapsed('2026-08-30T09:55:00.000Z', Date.parse('2026-08-30T10:00:00.000Z'))).toBe(
      '5m ago',
    );
  });

  it('formats active and completed durations', () => {
    expect(
      formatDuration(
        '2026-08-30T08:00:00.000Z',
        '2026-08-30T10:30:00.000Z',
        Date.parse('2026-08-30T11:00:00.000Z'),
      ),
    ).toBe('2h 30m');
    expect(formatDuration(null, null, Date.parse('2026-08-30T11:00:00.000Z'))).toBe('Unknown');
  });
});
