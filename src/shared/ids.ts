declare const idBrand: unique symbol;

export type Id<Kind extends string> = string & { readonly [idBrand]: Kind };

export interface IdGenerator {
  next<Kind extends string>(kind: Kind): Id<Kind>;
}

export const idFromTrustedString = <Kind extends string>(value: string): Id<Kind> => {
  if (value.length === 0) {
    throw new Error('ID must not be empty');
  }

  return value as Id<Kind>;
};

export const makeSequenceIdGenerator = (seed = 0): IdGenerator => {
  if (!Number.isSafeInteger(seed) || seed < 0) {
    throw new Error('ID sequence seed must be a non-negative safe integer');
  }

  let sequence = seed;

  return {
    next: <Kind extends string>(kind: Kind): Id<Kind> => {
      sequence += 1;
      return idFromTrustedString(`${kind}-${sequence.toString().padStart(6, '0')}`);
    },
  };
};
