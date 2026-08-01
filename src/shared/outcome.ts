export type Outcome<T, E> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

export const ok = <T>(value: T): Outcome<T, never> => ({ ok: true, value });

export const err = <E>(error: E): Outcome<never, E> => ({ ok: false, error });
