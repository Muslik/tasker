import { z } from 'zod';
import { describe, expect, it } from 'vitest';

import {
  branch,
  bounded_loop,
  compileWorkflow,
  createPredicateRegistry,
  createStepTypeRegistry,
  createWaitRegistry,
  defineWorkflow,
  finalize,
  gate,
  predicate,
  sequence,
  step,
  validateWorkflow,
  wait,
} from '../../../src/workflow/index.js';

const baseContracts = () => ({
  predicates: createPredicateRegistry([
    {
      id: 'change.needs_visual_verification',
      version: '1',
      inputSchema: z.object({}),
    },
    {
      id: 'ci.is_acceptable',
      version: '1',
      inputSchema: z.object({}),
    },
    {
      id: 'review.guidance_cleared',
      version: '1',
      inputSchema: z.object({}),
    },
    {
      id: 'review.approved',
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
    {
      id: 'verify.visual',
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
    {
      id: 'verify.targeted',
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
    {
      id: 'ci.run',
      version: '1',
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      allowedEffects: ['ci.dispatch'],
      requiredCapabilities: ['ci'],
      resumeBoundary: 'step',
      idempotency: 'probe',
      waitKinds: ['review_event@1'],
      artifactContracts: ['build-log'],
      reconciliation: {
        strategy: 'probe',
      },
    },
  ]),
  waits: createWaitRegistry([
    {
      id: 'review_event',
      version: '1',
      stage: { id: 'review', label: 'Review' },
      resolutionSchema: z.object({
        decision: z.literal('approved'),
        reviewId: z.string().min(1),
      }),
      resolutionMapping: {
        discriminator: 'decision',
        cases: { approved: { 'review.approved@1': true } },
      },
    },
    {
      id: 'operator_guidance',
      version: '1',
      stage: { id: 'attention', label: 'Needs attention' },
      resolutionSchema: z.object({
        decision: z.literal('resume'),
        guidance: z.string().min(1),
      }),
    },
  ]),
});

describe('workflow compiler', () => {
  it('compiles the first-wave workflow nodes into canonical immutable IR', () => {
    const workflow = defineWorkflow({
      id: 'bugfix',
      version: 1,
      root: sequence('delivery', [
        step('investigate', {
          uses: 'agent.investigate@1',
          with: {
            requireReproduction: true,
            nested: {
              zeta: 1,
              alpha: ['b', 'a'],
            },
          },
        }),
        branch('choose-verification', {
          when: predicate('change.needs_visual_verification@1'),
          then: gate('request-guidance', {
            reason: 'Visual verification is required before review.',
            resumeWhen: 'review.guidance_cleared@1',
            with: {
              team: 'qa',
            },
          }),
          otherwise: step('targeted-check', {
            uses: 'verify.targeted@1',
            with: {
              selection: 'changed-files',
            },
          }),
        }),
        bounded_loop('ci-repair', {
          maxAttempts: 3,
          until: predicate('ci.is_acceptable@1'),
          checkBefore: true,
          exhaustedWait: 'operator_guidance@1',
          body: sequence('repair-cycle', [
            step('run-ci', {
              uses: 'ci.run@1',
              with: {
                mode: 'full',
              },
            }),
          ]),
        }),
        wait('code-review', {
          for: 'review_event@1',
          resumeAt: 'waiting-for-review',
        }),
        finalize('waiting-for-review', {
          outcome: 'waiting_for_review',
        }),
      ]),
    });

    const result = compileWorkflow({
      contracts: baseContracts(),
      source: workflow,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.value.hash).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.value.graph.metadata).toEqual({
      compilerVersion: 4,
      irVersion: 'm2',
      references: {
        predicates: [
          'change.needs_visual_verification@1',
          'ci.is_acceptable@1',
          'review.approved@1',
          'review.guidance_cleared@1',
        ],
        stepTypes: ['agent.investigate@1', 'ci.run@1', 'verify.targeted@1'],
        waits: ['operator_guidance@1', 'review_event@1'],
      },
      workflowId: 'bugfix',
      workflowVersion: 1,
    });
    expect(result.value.canonicalJson).toContain('"alpha"');
    expect(result.value.canonicalJson.indexOf('"alpha"')).toBeLessThan(
      result.value.canonicalJson.indexOf('"zeta"'),
    );
    expect(Object.isFrozen(result.value.graph)).toBe(true);
    expect(Object.isFrozen(result.value.graph.root)).toBe(true);
    expect(result.value.canonicalJson).toContain('"checkBefore":true');
    expect(result.value.canonicalJson).toContain('"exhaustedWait":"operator_guidance@1"');
    expect(result.value.canonicalJson).toContain('"resolutionMapping"');
    expect(result.value.validatorReport.issues).toEqual([]);
  });

  it('allows branch-arm sequences to continue into an enclosing finalize', () => {
    const result = compileWorkflow({
      contracts: baseContracts(),
      source: defineWorkflow({
        id: 'branch-arm-sequence',
        version: 1,
        root: sequence('delivery', [
          branch('choose-verification', {
            when: 'change.needs_visual_verification@1',
            then: sequence('visual-path', [
              step('visual-check', {
                uses: 'verify.visual@1',
                with: {},
              }),
            ]),
            otherwise: step('targeted-check', {
              uses: 'verify.targeted@1',
              with: {},
            }),
          }),
          finalize('done', {
            outcome: 'waiting_for_review',
          }),
        ]),
      }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.value.validatorReport.issues).toEqual([]);
  });

  it('rejects unknown references across step, predicate, and wait contracts', () => {
    const report = validateWorkflow({
      contracts: baseContracts(),
      source: defineWorkflow({
        id: 'invalid-refs',
        version: 1,
        root: sequence('delivery', [
          branch('choose', {
            when: 'predicate.missing@1',
            then: step('then-step', {
              uses: 'agent.investigate@1',
              with: {},
            }),
            otherwise: step('otherwise-step', {
              uses: 'step.missing@1',
              with: {},
            }),
          }),
          wait('review', {
            for: 'wait.missing@1',
          }),
          finalize('done', {
            outcome: 'failed_terminal',
          }),
        ]),
      }),
    });

    expect(report.issues.map((issue) => issue.code)).toEqual([
      'unknown_reference',
      'unknown_reference',
      'unknown_reference',
    ]);
  });

  it('quarantines a known step ABI requested at an unsupported version', () => {
    const report = validateWorkflow({
      contracts: baseContracts(),
      source: defineWorkflow({
        id: 'unsupported-step-version',
        version: 1,
        root: sequence('delivery', [
          step('investigate', {
            uses: 'agent.investigate@2',
            with: {},
          }),
          finalize('done', { outcome: 'quarantined' }),
        ]),
      }),
    });

    const unsupportedReference = report.issues.find((issue) => issue.code === 'unknown_reference');

    expect(unsupportedReference?.details).toEqual({
      reference: 'agent.investigate@2',
      referenceKind: 'step_type',
      recovery: 'quarantine',
    });
  });

  it('rejects missing terminal paths and invalid terminal structure', () => {
    const missingTerminal = validateWorkflow({
      contracts: baseContracts(),
      source: defineWorkflow({
        id: 'missing-terminal',
        version: 1,
        root: sequence('delivery', [
          step('investigate', {
            uses: 'agent.investigate@1',
            with: {},
          }),
        ]),
      }),
    });

    expect(missingTerminal.issues).toContainEqual(
      expect.objectContaining({
        code: 'missing_terminal_path',
      }),
    );

    const rootStep = validateWorkflow({
      contracts: baseContracts(),
      source: defineWorkflow({
        id: 'root-step',
        version: 1,
        root: step('investigate', {
          uses: 'agent.investigate@1',
          with: {},
        }),
      }),
    });

    expect(rootStep.issues).toContainEqual(
      expect.objectContaining({
        code: 'missing_terminal_path',
        path: ['root'],
      }),
    );

    const rootBranch = validateWorkflow({
      contracts: baseContracts(),
      source: defineWorkflow({
        id: 'root-branch',
        version: 1,
        root: branch('choose', {
          when: 'change.needs_visual_verification@1',
          then: finalize('done', {
            outcome: 'waiting_for_review',
          }),
          otherwise: step('fallback', {
            uses: 'agent.investigate@1',
            with: {},
          }),
        }),
      }),
    });

    expect(rootBranch.issues).toContainEqual(
      expect.objectContaining({
        code: 'missing_terminal_path',
        path: ['root'],
      }),
    );

    const invalidTerminal = validateWorkflow({
      contracts: baseContracts(),
      source: defineWorkflow({
        id: 'invalid-terminal',
        version: 1,
        root: sequence('delivery', [
          finalize('done', {
            outcome: 'waiting_for_review',
          }),
          step('after-finalize', {
            uses: 'agent.investigate@1',
            with: {},
          }),
        ]),
      }),
    });

    expect(invalidTerminal.issues).toContainEqual(
      expect.objectContaining({
        code: 'invalid_terminal_structure',
      }),
    );
  });

  it('rejects effectful steps without reconciliation metadata', () => {
    const report = validateWorkflow({
      contracts: {
        ...baseContracts(),
        stepTypes: createStepTypeRegistry([
          {
            id: 'agent.write',
            version: '1',
            inputSchema: z.object({}),
            outputSchema: z.object({}),
            allowedEffects: ['bitbucket.push'],
            requiredCapabilities: ['git'],
            resumeBoundary: 'step',
            idempotency: 'none',
            waitKinds: [],
            artifactContracts: [],
          },
        ]),
      },
      source: defineWorkflow({
        id: 'effectful',
        version: 1,
        root: sequence('delivery', [
          step('push', {
            uses: 'agent.write@1',
            with: {},
          }),
          finalize('done', {
            outcome: 'waiting_for_review',
          }),
        ]),
      }),
    });

    expect(report.issues).toContainEqual(
      expect.objectContaining({
        code: 'effectful_step_without_reconciliation_metadata',
      }),
    );
  });

  it('rejects invalid loop bounds, waits without contracts, and duplicate node ids', () => {
    const report = validateWorkflow({
      contracts: {
        ...baseContracts(),
        waits: createWaitRegistry([
          {
            id: 'review_event',
            version: '1',
            stage: { id: 'review', label: 'Review' },
          },
        ]),
      },
      source: defineWorkflow({
        id: 'invalid-graph',
        version: 1,
        root: sequence('delivery', [
          bounded_loop('repair', {
            maxAttempts: 0,
            until: 'ci.is_acceptable@1',
            body: sequence('repair-body', [
              step('dup', {
                uses: 'agent.investigate@1',
                with: {},
              }),
            ]),
          }),
          wait('dup', {
            for: 'review_event@1',
          }),
          finalize('done', {
            outcome: 'waiting_for_review',
          }),
        ]),
      }),
    });

    expect(report.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'duplicate_node_id' }),
        expect.objectContaining({ code: 'invalid_loop_bounds' }),
        expect.objectContaining({ code: 'wait_without_resolution_contract' }),
      ]),
    );
  });

  it('rejects a wait resume cursor that does not reference a graph node', () => {
    const result = compileWorkflow({
      contracts: baseContracts(),
      source: defineWorkflow({
        id: 'orphan-resume-target',
        version: 1,
        root: sequence('delivery', [
          wait('code-review', {
            for: 'review_event@1',
            resumeAt: 'missing-review-handler',
          }),
          finalize('done', { outcome: 'waiting_for_review' }),
        ]),
      }),
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.issues).toContainEqual({
      code: 'unknown_resume_target',
      message: 'Wait "code-review" resumes at unknown node "missing-review-handler"',
      path: ['root', 'children', 0, 'resumeAt'],
      details: {
        nodeId: 'code-review',
        resumeAt: 'missing-review-handler',
      },
    });
  });

  it('rejects extra fields at the public workflow source boundary', () => {
    const report = validateWorkflow({
      contracts: baseContracts(),
      source: {
        id: 'extra-fields',
        version: 1,
        root: {
          kind: 'step',
          id: 'investigate',
          uses: 'agent.investigate@1',
          with: {},
          extra: true,
        },
      },
    });

    expect(report.issues).toContainEqual(
      expect.objectContaining({
        code: 'invalid_source',
      }),
    );
  });

  it('reports invalid step and gate payloads against registered schemas', () => {
    const report = validateWorkflow({
      contracts: {
        predicates: createPredicateRegistry([
          {
            id: 'review.guidance_cleared',
            version: '1',
            inputSchema: z.object({
              reviewer: z.string().min(1),
            }),
          },
        ]),
        stepTypes: createStepTypeRegistry([
          {
            id: 'agent.investigate',
            version: '1',
            inputSchema: z.object({
              requireReproduction: z.boolean(),
            }),
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
      },
      source: defineWorkflow({
        id: 'invalid-payloads',
        version: 1,
        root: sequence('delivery', [
          step('investigate', {
            uses: 'agent.investigate@1',
            with: {
              requireReproduction: 'yes',
            },
          }),
          gate('request-guidance', {
            reason: 'Need a reviewer before proceeding.',
            resumeWhen: 'review.guidance_cleared@1',
            with: {
              reviewer: 123,
            },
          }),
          finalize('done', {
            outcome: 'waiting_for_review',
          }),
        ]),
      }),
    });

    expect(report.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'invalid_step_input',
          path: ['root', 'children', 0, 'with'],
        }),
        expect.objectContaining({
          code: 'invalid_predicate_input',
          path: ['root', 'children', 1, 'with'],
        }),
      ]),
    );
  });

  it('normalizes an omitted gate payload to an empty persisted input', () => {
    const result = compileWorkflow({
      contracts: baseContracts(),
      source: defineWorkflow({
        id: 'empty-gate-input',
        version: 1,
        root: sequence('delivery', [
          gate('await-guidance', {
            reason: 'Wait for operator guidance.',
            resumeWhen: 'review.guidance_cleared@1',
          }),
          finalize('done', { outcome: 'waiting_for_review' }),
        ]),
      }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok || result.value.graph.root.kind !== 'sequence') {
      return;
    }

    expect(result.value.graph.root.children[0]).toEqual({
      kind: 'gate',
      id: 'await-guidance',
      reason: 'Wait for operator guidance.',
      resumeWhen: 'review.guidance_cleared@1',
      with: {},
    });
  });

  it('preserves literal __proto__ payload keys during canonicalization', () => {
    const payload = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(payload, '__proto__', {
      value: { polluted: true },
      enumerable: true,
      configurable: true,
      writable: true,
    });
    payload.alpha = 1;

    const result = compileWorkflow({
      contracts: baseContracts(),
      source: defineWorkflow({
        id: 'proto-payload',
        version: 1,
        root: sequence('delivery', [
          step('investigate', {
            uses: 'agent.investigate@1',
            with: payload as never,
          }),
          finalize('done', {
            outcome: 'waiting_for_review',
          }),
        ]),
      }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    if (result.value.graph.root.kind !== 'sequence') {
      return;
    }

    const compiledPayload = result.value.graph.root.children[0];
    expect(compiledPayload).toBeDefined();
    if (compiledPayload === undefined || compiledPayload.kind !== 'step') {
      return;
    }

    expect(Object.prototype.hasOwnProperty.call(compiledPayload.with, '__proto__')).toBe(true);
    expect(result.value.canonicalJson).toContain('"__proto__"');
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it('rejects an unbounded loop at the source schema boundary', () => {
    const report = validateWorkflow({
      contracts: baseContracts(),
      source: {
        id: 'unbounded-loop',
        version: 1,
        root: {
          kind: 'bounded_loop',
          id: 'repair',
          until: 'ci.is_acceptable@1',
          body: {
            kind: 'step',
            id: 'investigate',
            uses: 'agent.investigate@1',
            with: {},
          },
        },
      },
    });

    expect(report.issues.some((issue) => issue.code === 'invalid_source')).toBe(true);
  });
});
