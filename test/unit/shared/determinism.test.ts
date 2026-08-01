import { describe, expect, it } from 'vitest';

import { makeAdjustableClock, makeSequenceIdGenerator } from '../../../src/shared/index.js';

describe('deterministic providers', () => {
  it('advances an injected clock without waiting', () => {
    const clock = makeAdjustableClock('2026-08-01T00:00:00.000Z');

    clock.advance(1_500);

    expect(clock.now()).toBe('2026-08-01T00:00:01.500Z');
  });

  it('generates stable typed identifiers from a seed', () => {
    const ids = makeSequenceIdGenerator(40);

    const generated = [ids.next('run'), ids.next('step')];

    expect(generated).toEqual(['run-000041', 'step-000042']);
  });

  it('rejects backward clock movement', () => {
    const clock = makeAdjustableClock('2026-08-01T00:00:00.000Z');

    const moveBackward = () => {
      clock.advance(-1);
    };

    expect(moveBackward).toThrow('non-negative safe integer');
  });
});
