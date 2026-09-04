import { z } from 'zod';
import { describe, expect, it } from 'vitest';

import {
  compileWorkflow,
  createPredicateRegistry,
  createStepTypeRegistry,
  createWaitRegistry,
} from './index.js';

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

const source = (root: unknown) => ({ id: 'workflow', version: 1, root });
const reportFor = (input: { contracts: ReturnType<typeof contracts>; source: unknown }) => {
  const result = compileWorkflow(input);
  return result.ok ? result.value.validatorReport : result.error;
};

describe('workflow compiler', () => {
  it('compiles semantic node kinds into canonical immutable IR', () => {
    const result = compileWorkflow({
      contracts: contracts(),
      source: source({
        kind: 'sequence',
        id: 'delivery',
        children: [
          {
            kind: 'step',
            id: 'investigate',
            uses: 'agent.investigate@1',
            with: { zeta: 1, alpha: ['b', 'a'] },
          },
          {
            kind: 'bounded_loop',
            id: 'repair',
            maxAttempts: 3,
            until: 'ci.is_acceptable@1',
            body: {
              kind: 'sequence',
              id: 'repair-cycle',
              children: [{ kind: 'step', id: 'run-ci', uses: 'agent.investigate@1', with: {} }],
            },
          },
          { kind: 'finalize', id: 'done', outcome: 'accepted' },
        ],
      }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.hash).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.value.canonicalJson.indexOf('"alpha"')).toBeLessThan(
      result.value.canonicalJson.indexOf('"zeta"'),
    );
    expect(result.value.canonicalJson).not.toContain('checkBefore');
    expect(Object.isFrozen(result.value.graph)).toBe(true);
    expect(result.value.validatorReport.issues).toEqual([]);
  });

  it('rejects unknown references and invalid loop bounds', () => {
    const report = reportFor({
      contracts: contracts(),
      source: source({
        kind: 'sequence',
        id: 'delivery',
        children: [
          {
            kind: 'bounded_loop',
            id: 'repair',
            maxAttempts: 0,
            until: 'predicate.missing@1',
            body: { kind: 'step', id: 'step', uses: 'step.missing@1', with: {} },
          },
          { kind: 'finalize', id: 'done', outcome: 'failed' },
        ],
      }),
    });

    expect(report.issues.map((issue) => issue.code)).toEqual([
      'unknown_reference',
      'invalid_loop_bounds',
      'unknown_reference',
    ]);
  });

  it('rejects missing terminal paths and duplicate node ids', () => {
    const missingTerminal = reportFor({
      contracts: contracts(),
      source: source({ kind: 'step', id: 'step', uses: 'agent.investigate@1', with: {} }),
    });
    expect(missingTerminal.issues).toContainEqual(
      expect.objectContaining({ code: 'missing_terminal_path' }),
    );

    const duplicate = reportFor({
      contracts: contracts(),
      source: source({
        kind: 'sequence',
        id: 'delivery',
        children: [
          { kind: 'step', id: 'same', uses: 'agent.investigate@1', with: {} },
          { kind: 'step', id: 'same', uses: 'agent.investigate@1', with: {} },
          { kind: 'finalize', id: 'done', outcome: 'accepted' },
        ],
      }),
    });
    expect(duplicate.issues).toContainEqual(expect.objectContaining({ code: 'duplicate_node_id' }));
  });

  it('preserves literal __proto__ payload keys during canonicalization', () => {
    const payload = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(payload, '__proto__', { value: { polluted: true }, enumerable: true });
    payload.alpha = 1;
    const result = compileWorkflow({
      contracts: contracts(),
      source: source({
        kind: 'sequence',
        id: 'delivery',
        children: [
          { kind: 'step', id: 'step', uses: 'agent.investigate@1', with: payload },
          { kind: 'finalize', id: 'done', outcome: 'accepted' },
        ],
      }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.canonicalJson).toContain('"__proto__"');
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it('rejects removed graph node kinds at the source boundary', () => {
    const report = reportFor({
      contracts: contracts(),
      source: source({ kind: 'branch', id: 'removed', when: 'ci.is_acceptable@1' }),
    });
    expect(report.issues).toContainEqual(expect.objectContaining({ code: 'invalid_source' }));
  });
});
