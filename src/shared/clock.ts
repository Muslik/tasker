export interface Clock {
  now(): string;
}

export const systemClock: Clock = {
  now: () => new Date().toISOString(),
};

export interface AdjustableClock extends Clock {
  advance(milliseconds: number): void;
}

export const makeAdjustableClock = (initialTimestamp: string): AdjustableClock => {
  let currentMilliseconds = Date.parse(initialTimestamp);

  if (!Number.isFinite(currentMilliseconds)) {
    throw new Error(`Invalid initial timestamp: ${initialTimestamp}`);
  }

  return {
    now: () => new Date(currentMilliseconds).toISOString(),
    advance: (milliseconds) => {
      if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
        throw new Error('Clock advancement must be a non-negative safe integer');
      }

      currentMilliseconds += milliseconds;
    },
  };
};
