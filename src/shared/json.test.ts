import { describe, expect, it } from 'vitest';

import { canonicalJson } from './json.js';

describe('canonicalJson', () => {
  it('sorts object keys recursively while preserving array order', () => {
    expect(canonicalJson({ z: 3, a: { z: 1, a: 2 }, m: [{ z: null, a: false }] })).toBe(
      '{"a":{"a":2,"z":1},"m":[{"a":false,"z":null}],"z":3}',
    );
  });
});
