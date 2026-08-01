import fc from 'fast-check';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';

import {
  bounded_loop,
  compileWorkflow,
  createPredicateRegistry,
  createStepTypeRegistry,
  createWaitRegistry,
  defineWorkflow,
  finalize,
  sequence,
  step,
  validateWorkflow,
} from '../../../src/workflow/index.js';
import type { JsonValue } from '../../../src/workflow/index.js';

const contracts = () => ({
  predicates: createPredicateRegistry([
    {
      id: 'ci.is_acceptable',
      version: '1',
      inputSchema: z.object({}),
    },
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
  if (Array.isArray(value)) {
    return value.map((item) => reverseKeys(item));
  }

  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([key, nestedValue]) => [key, reverseKeys(nestedValue)]),
    );
  }

  return value;
};

describe('workflow compiler properties', () => {
  it('produces the same hash for semantically identical payloads with different key order', () => {
    fc.assert(
      fc.property(
        fc.dictionary(fc.string({ minLength: 1, maxLength: 5 }), fc.jsonValue()),
        (payload) => {
          const source = defineWorkflow({
            id: 'deterministic-hash',
            version: 1,
            root: sequence('delivery', [
              step('investigate', {
                uses: 'agent.investigate@1',
                with: payload as JsonValue,
              }),
              finalize('done', {
                outcome: 'waiting_for_review',
              }),
            ]),
          });

          const reordered = defineWorkflow({
            id: 'deterministic-hash',
            version: 1,
            root: sequence('delivery', [
              step('investigate', {
                uses: 'agent.investigate@1',
                with: reverseKeys(payload) as JsonValue,
              }),
              finalize('done', {
                outcome: 'waiting_for_review',
              }),
            ]),
          });

          const left = compileWorkflow({
            contracts: contracts(),
            source,
          });
          const right = compileWorkflow({
            contracts: contracts(),
            source: reordered,
          });

          expect(left.ok).toBe(true);
          expect(right.ok).toBe(true);

          if (!left.ok || !right.ok) {
            return;
          }

          expect(left.value.hash).toBe(right.value.hash);
          expect(left.value.canonicalJson).toBe(right.value.canonicalJson);
        },
      ),
    );
  });

  it('always rejects non-positive loop bounds', () => {
    fc.assert(
      fc.property(fc.integer({ max: 0 }), (maxAttempts) => {
        const report = validateWorkflow({
          contracts: contracts(),
          source: defineWorkflow({
            id: 'loop-bounds',
            version: 1,
            root: sequence('delivery', [
              bounded_loop('repair', {
                maxAttempts,
                until: 'ci.is_acceptable@1',
                body: sequence('body', [
                  step('investigate', {
                    uses: 'agent.investigate@1',
                    with: {},
                  }),
                ]),
              }),
              finalize('done', {
                outcome: 'waiting_for_review',
              }),
            ]),
          }),
        });

        expect(report.issues).toContainEqual(
          expect.objectContaining({
            code: 'invalid_loop_bounds',
          }),
        );
      }),
    );
  });
});
