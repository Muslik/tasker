import { z } from 'zod';
import { describe, expect, it } from 'vitest';

import {
  compileSemanticWorkflow,
  createPredicateRegistry,
  createStepTypeRegistry,
  createWaitRegistry,
  type SemanticWorkflowSource,
} from '../../../src/graph/index.js';

const contracts = () => ({
  predicates: createPredicateRegistry([
    { id: 'verification.accepted', version: '1', inputSchema: z.object({}) },
    { id: 'agent_review.accepted', version: '1', inputSchema: z.object({}) },
    { id: 'delivery.accepted', version: '1', inputSchema: z.object({}) },
  ]),
  stepTypes: createStepTypeRegistry([
    {
      id: 'implement.change',
      version: '1',
      inputSchema: z
        .object({
          objective: z.string().min(1),
          nested: z.object({ alpha: z.array(z.string()), zeta: z.number() }).strict(),
        })
        .strict(),
      outputSchema: z.object({}),
      allowedEffects: ['workspace.write'],
      requiredCapabilities: ['workspace.write'],
      resumeBoundary: 'step',
      idempotency: 'key',
      reconciliation: { strategy: 'receipt' },
    },
    {
      id: 'verify.acceptance',
      version: '1',
      inputSchema: z.object({ profile: z.string().min(1) }).strict(),
      outputSchema: z.object({}),
    },
    {
      id: 'review.change',
      version: '1',
      inputSchema: z.object({}).strict(),
      outputSchema: z.object({}),
    },
    {
      id: 'deliver.pull-request',
      version: '1',
      inputSchema: z.object({}).strict(),
      outputSchema: z.object({}),
      allowedEffects: ['git.push'],
      requiredCapabilities: ['git.push'],
      resumeBoundary: 'step',
      idempotency: 'key',
      reconciliation: { strategy: 'receipt' },
    },
  ]),
  waits: createWaitRegistry([
    {
      id: 'operator_guidance',
      version: '1',
      stage: { id: 'attention', label: 'Needs attention' },
      resolutionSchema: z.object({ guidance: z.string().min(1) }).strict(),
    },
  ]),
});

const simpleBugSource = (reordered = false): SemanticWorkflowSource => ({
  schemaVersion: 1,
  id: 'simple-bug',
  version: 1,
  root: {
    kind: 'sequence',
    id: 'delivery',
    children: [
      {
        kind: 'bounded_loop',
        id: 'delivery-feedback',
        maxAttempts: 3,
        until: 'delivery.accepted@1',
        body: {
          kind: 'sequence',
          id: 'delivery-attempt',
          children: [
            {
              kind: 'bounded_loop',
              id: 'review-feedback',
              maxAttempts: 3,
              until: 'agent_review.accepted@1',
              body: {
                kind: 'sequence',
                id: 'review-attempt',
                children: [
                  {
                    kind: 'bounded_loop',
                    id: 'development-loop',
                    maxAttempts: 3,
                    until: 'verification.accepted@1',
                    body: {
                      kind: 'sequence',
                      id: 'development-attempt',
                      children: [
                        {
                          kind: 'step',
                          id: 'implement',
                          uses: 'implement.change@1',
                          with: reordered
                            ? {
                                nested: { alpha: ['a', 'b'], zeta: 1 },
                                objective: 'Fix the reproduced defect',
                              }
                            : {
                                objective: 'Fix the reproduced defect',
                                nested: { zeta: 1, alpha: ['a', 'b'] },
                              },
                        },
                        {
                          kind: 'step',
                          id: 'verify',
                          uses: 'verify.acceptance@1',
                          with: { profile: 'targeted_visual' },
                        },
                      ],
                    },
                  },
                  { kind: 'step', id: 'review', uses: 'review.change@1', with: {} },
                ],
              },
            },
            { kind: 'step', id: 'pull-request', uses: 'deliver.pull-request@1', with: {} },
          ],
        },
      },
    ],
  },
});

describe('semantic workflow compiler', () => {
  it('keeps a simple bug operator source small and lowers mechanics into executable IR', () => {
    const result = compileSemanticWorkflow({
      contracts: contracts(),
      source: simpleBugSource(),
      loopExhaustedWait: 'operator_guidance@1',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.semanticHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.value.source.root.children).toHaveLength(1);
    expect(result.value.semanticCanonicalJson).not.toContain('operator_guidance');
    expect(result.value.semanticCanonicalJson).not.toContain('finalize');
    expect(result.value.compiled.canonicalJson).toContain('operator_guidance@1');
    expect(result.value.compiled.canonicalJson).toContain('__tasker_complete');
    expect(result.value.compiled.graph.metadata.references.stepTypes).toEqual([
      'deliver.pull-request@1',
      'implement.change@1',
      'review.change@1',
      'verify.acceptance@1',
    ]);
  });

  it('canonicalizes semantic input before hashing', () => {
    const left = compileSemanticWorkflow({
      contracts: contracts(),
      source: simpleBugSource(),
      loopExhaustedWait: 'operator_guidance@1',
    });
    const right = compileSemanticWorkflow({
      contracts: contracts(),
      source: simpleBugSource(true),
      loopExhaustedWait: 'operator_guidance@1',
    });

    expect(left.ok && right.ok && left.value.semanticHash).toBe(
      right.ok ? right.value.semanticHash : null,
    );
  });

  it.each(['branch', 'wait', 'gate', 'finalize'])('rejects low-level %s nodes', (kind) => {
    const base = simpleBugSource();
    const source = {
      ...base,
      root: { ...base.root, children: [...base.root.children, { kind }] },
    };
    const result = compileSemanticWorkflow({
      contracts: contracts(),
      source,
      loopExhaustedWait: 'operator_guidance@1',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.issues).toMatchObject([{ code: 'invalid_source' }]);
  });

  it('rejects reserved compiler node identifiers', () => {
    const base = simpleBugSource();
    const source = { ...base, root: { ...base.root, id: '__tasker_complete' } };
    const result = compileSemanticWorkflow({
      contracts: contracts(),
      source,
      loopExhaustedWait: 'operator_guidance@1',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(JSON.stringify(result.error)).toContain('reserved');
  });
});
