import fc from 'fast-check';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';

import {
  compileWorkflow,
  createPredicateRegistry,
  createStepTypeRegistry,
  createWaitRegistry,
} from '../../../src/workflow/index.js';
import type { JsonValue } from '../../../src/workflow/index.js';

const contracts = () => ({
  predicates: createPredicateRegistry([
    { id: 'ci.is_acceptable', version: '1', inputSchema: z.object({}) },
  ]),
  stepTypes: createStepTypeRegistry([
    {
      id: 'agent.investigate',
      version: '1',
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      allowedEffects: [],
      requiredCapabilities: [],
      resumeBoundary: 'none',
      idempotency: 'none',
      waitKinds: [],
      artifactContracts: [],
    },
  ]),
  waits: createWaitRegistry([]),
});

const reverseKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([key, item]) => [key, reverseKeys(item)]),
    );
  }
  return value;
};

const workflow = (payload: JsonValue) => ({
  id: 'deterministic-hash',
  version: 1,
  root: {
    kind: 'sequence' as const,
    id: 'delivery',
    children: [
      { kind: 'step' as const, id: 'investigate', uses: 'agent.investigate@1', with: payload },
      { kind: 'finalize' as const, id: 'done', outcome: 'accepted' },
    ],
  },
});

describe('workflow compiler properties', () => {
  it('produces the same hash for payloads with different key order', () => {
    fc.assert(
      fc.property(
        fc.dictionary(fc.string({ minLength: 1, maxLength: 5 }), fc.jsonValue()),
        (payload) => {
          const left = compileWorkflow({
            contracts: contracts(),
            source: workflow(payload as JsonValue),
          });
          const right = compileWorkflow({
            contracts: contracts(),
            source: workflow(reverseKeys(payload) as JsonValue),
          });
          expect(left.ok).toBe(true);
          expect(right.ok).toBe(true);
          if (!left.ok || !right.ok) return;
          expect(left.value.hash).toBe(right.value.hash);
          expect(left.value.canonicalJson).toBe(right.value.canonicalJson);
        },
      ),
    );
  });

  it('always rejects non-positive loop bounds', () => {
    fc.assert(
      fc.property(fc.integer({ max: 0 }), (maxAttempts) => {
        const result = compileWorkflow({
          contracts: contracts(),
          source: {
            id: 'loop-bounds',
            version: 1,
            root: {
              kind: 'sequence',
              id: 'delivery',
              children: [
                {
                  kind: 'bounded_loop',
                  id: 'repair',
                  maxAttempts,
                  until: 'ci.is_acceptable@1',
                  body: {
                    kind: 'sequence',
                    id: 'body',
                    children: [{ kind: 'step', id: 'step', uses: 'agent.investigate@1', with: {} }],
                  },
                },
                { kind: 'finalize', id: 'done', outcome: 'accepted' },
              ],
            },
          },
        });
        expect(result.ok).toBe(false);
        if (!result.ok)
          expect(result.error.issues).toContainEqual(
            expect.objectContaining({ code: 'invalid_loop_bounds' }),
          );
      }),
    );
  });
});
