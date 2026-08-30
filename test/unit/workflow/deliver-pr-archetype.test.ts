import { describe, expect, it } from 'vitest';

import { getHarnessPack } from '../../../src/harness/index.js';
import { HARNESS_WORKFLOW_CONTRACTS } from '../../../src/planning/contracts.js';
import { validateWorkflowObligations } from '../../../src/planning/obligations.js';
import {
  compileSemanticWorkflow,
  DELIVER_PR_NODE_IDS,
  resolveDeliverPrScaffoldConfig,
  scaffoldDeliverPr,
  type DeliverPrSegment,
} from '../../../src/workflow/index.js';

const config = resolveDeliverPrScaffoldConfig(getHarnessPack().policies);

const task = {
  reference: 'avia-13236-short-bug',
  taskId: 'AVIA-13236',
  description: 'Fix the flight card layout and publish the pull request.',
  repository: 'onetwotrip/front-avia',
};

const dependencyDeclarations = [
  {
    declarationId: 'dep-b',
    revision: 2,
    packages: ['zod', 'vitest'],
  },
  {
    declarationId: 'dep-a',
    revision: 1,
    packages: ['react', 'clsx'],
  },
] as const;

const scaffold = (segments: readonly DeliverPrSegment[], taskSnapshot: unknown = {}) =>
  scaffoldDeliverPr(
    {
      task,
      taskSnapshot,
      objective: 'Implement the accepted plan.',
      segments,
      verification: {
        validationProfile: 'targeted',
      },
    },
    config,
  );

const compileScaffold = (segments: readonly DeliverPrSegment[], taskSnapshot: unknown = {}) => {
  const result = scaffold(segments, taskSnapshot);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(JSON.stringify(result.error));

  const compiled = compileSemanticWorkflow({
    contracts: HARNESS_WORKFLOW_CONTRACTS,
    loopExhaustedWait: 'operator_guidance@1',
    source: result.value,
  });
  expect(compiled.ok).toBe(true);
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.error));

  return { semantic: result.value, compiled: compiled.value };
};

const developmentChildrenOf = (
  source: ReturnType<typeof compileScaffold>['semantic'],
): readonly {
  readonly kind: 'step';
  readonly id: string;
  readonly uses: string;
}[] => {
  const deliveryLoop = source.root.children[0];
  if (deliveryLoop?.kind !== 'bounded_loop') throw new Error('Expected delivery loop');
  const reviewLoop = deliveryLoop.body.children[0];
  if (reviewLoop?.kind !== 'bounded_loop') throw new Error('Expected review loop');
  const developmentLoop = reviewLoop.body.children[0];
  if (developmentLoop?.kind !== 'bounded_loop') throw new Error('Expected development loop');
  return developmentLoop.body.children.filter(
    (child): child is (typeof developmentLoop.body.children)[number] & { readonly kind: 'step' } =>
      child.kind === 'step',
  );
};

describe('deliver-pr archetype scaffold', () => {
  it('keeps the public node-id scheme stable', () => {
    expect({
      root: DELIVER_PR_NODE_IDS.root,
      deliveryLoop: DELIVER_PR_NODE_IDS.deliveryLoop,
      deliveryAttempt: DELIVER_PR_NODE_IDS.deliveryAttempt,
      reviewLoop: DELIVER_PR_NODE_IDS.reviewLoop,
      reviewAttempt: DELIVER_PR_NODE_IDS.reviewAttempt,
      developmentLoop: DELIVER_PR_NODE_IDS.developmentLoop,
      developmentAttempt: DELIVER_PR_NODE_IDS.developmentAttempt,
      implement: DELIVER_PR_NODE_IDS.implement,
      runValidation: DELIVER_PR_NODE_IDS.runValidation,
      verify: DELIVER_PR_NODE_IDS.verify,
      review: DELIVER_PR_NODE_IDS.review,
      prepare: DELIVER_PR_NODE_IDS.prepare,
      deliver: DELIVER_PR_NODE_IDS.deliver,
      translationsExtract: DELIVER_PR_NODE_IDS.translationsExtract,
      translationsPull: DELIVER_PR_NODE_IDS.translationsPull,
      dependencyAwait: DELIVER_PR_NODE_IDS.dependencyAwait(1),
      dependencyConsume: DELIVER_PR_NODE_IDS.dependencyConsume(1),
    }).toEqual({
      root: 'task-work',
      deliveryLoop: 'delivery-feedback',
      deliveryAttempt: 'delivery-attempt',
      reviewLoop: 'review-feedback',
      reviewAttempt: 'review-attempt',
      developmentLoop: 'development',
      developmentAttempt: 'development-attempt',
      implement: 'implement-change',
      runValidation: 'run-validation',
      verify: 'verify-change',
      review: 'review-change',
      prepare: 'prepare-delivery',
      deliver: 'deliver-change',
      translationsExtract: 'extract-translations',
      translationsPull: 'pull-translations',
      dependencyAwait: 'await-dependency-1',
      dependencyConsume: 'consume-dependency-1',
    });
  });

  it.each([
    {
      name: 'base delivery loop',
      segments: [] satisfies readonly DeliverPrSegment[],
      taskSnapshot: {},
      expectedDevelopmentStepIds: [
        DELIVER_PR_NODE_IDS.implement,
        DELIVER_PR_NODE_IDS.runValidation,
        DELIVER_PR_NODE_IDS.verify,
      ],
    },
    {
      name: 'dependency await segment',
      segments: ['dependency_await'] satisfies readonly DeliverPrSegment[],
      taskSnapshot: { dependencyDeclarations },
      expectedDevelopmentStepIds: [
        DELIVER_PR_NODE_IDS.implement,
        DELIVER_PR_NODE_IDS.dependencyAwait(1),
        DELIVER_PR_NODE_IDS.dependencyConsume(1),
        DELIVER_PR_NODE_IDS.dependencyAwait(2),
        DELIVER_PR_NODE_IDS.dependencyConsume(2),
        DELIVER_PR_NODE_IDS.runValidation,
        DELIVER_PR_NODE_IDS.verify,
      ],
    },
    {
      name: 'translations segment',
      segments: ['translations'] satisfies readonly DeliverPrSegment[],
      taskSnapshot: {},
      expectedDevelopmentStepIds: [
        DELIVER_PR_NODE_IDS.implement,
        DELIVER_PR_NODE_IDS.translationsExtract,
        DELIVER_PR_NODE_IDS.translationsPull,
        DELIVER_PR_NODE_IDS.runValidation,
        DELIVER_PR_NODE_IDS.verify,
      ],
    },
    {
      name: 'dependency await and translations segments',
      segments: ['dependency_await', 'translations'] satisfies readonly DeliverPrSegment[],
      taskSnapshot: { dependencyDeclarations },
      expectedDevelopmentStepIds: [
        DELIVER_PR_NODE_IDS.implement,
        DELIVER_PR_NODE_IDS.dependencyAwait(1),
        DELIVER_PR_NODE_IDS.dependencyConsume(1),
        DELIVER_PR_NODE_IDS.dependencyAwait(2),
        DELIVER_PR_NODE_IDS.dependencyConsume(2),
        DELIVER_PR_NODE_IDS.translationsExtract,
        DELIVER_PR_NODE_IDS.translationsPull,
        DELIVER_PR_NODE_IDS.runValidation,
        DELIVER_PR_NODE_IDS.verify,
      ],
    },
  ])(
    'compiles a clean scaffold for %s',
    ({ taskSnapshot, expectedDevelopmentStepIds, segments }) => {
      const { semantic, compiled } = compileScaffold(segments, taskSnapshot);
      const deliveryLoop = semantic.root.children[0];

      expect(semantic.id).toBe(`deliver-pr-${task.reference}`);
      expect(semantic.root.id).toBe(DELIVER_PR_NODE_IDS.root);
      expect(deliveryLoop).toMatchObject({
        kind: 'bounded_loop',
        id: DELIVER_PR_NODE_IDS.deliveryLoop,
        maxAttempts: config.loopMaxAttempts,
        until: config.loops[0].until,
        body: {
          kind: 'sequence',
          id: DELIVER_PR_NODE_IDS.deliveryAttempt,
          children: [
            {
              kind: 'bounded_loop',
              id: DELIVER_PR_NODE_IDS.reviewLoop,
              maxAttempts: config.loopMaxAttempts,
              until: config.loops[1].until,
              body: {
                kind: 'sequence',
                id: DELIVER_PR_NODE_IDS.reviewAttempt,
                children: [
                  {
                    kind: 'bounded_loop',
                    id: DELIVER_PR_NODE_IDS.developmentLoop,
                    maxAttempts: config.loopMaxAttempts,
                    until: config.loops[2].until,
                    body: {
                      kind: 'sequence',
                      id: DELIVER_PR_NODE_IDS.developmentAttempt,
                    },
                  },
                  {
                    kind: 'step',
                    id: DELIVER_PR_NODE_IDS.review,
                  },
                ],
              },
            },
            {
              kind: 'step',
              id: DELIVER_PR_NODE_IDS.prepare,
            },
            {
              kind: 'step',
              id: DELIVER_PR_NODE_IDS.deliver,
            },
          ],
        },
      });
      expect(developmentChildrenOf(semantic).map(({ id }) => id)).toEqual(
        expectedDevelopmentStepIds,
      );
      expect(developmentChildrenOf(semantic)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: DELIVER_PR_NODE_IDS.runValidation,
            uses: 'validation.run@1',
            with: {
              profile: 'targeted',
            },
          }),
        ]),
      );
      expect(
        validateWorkflowObligations(compiled.compiled.graph, { origin: 'jira' }).issues,
      ).toEqual([]);
    },
  );

  it('keeps semantic and compiled hashes stable when segments and declarations are reordered', () => {
    const left = compileScaffold(['translations', 'dependency_await'], {
      dependencyDeclarations,
    });
    const right = compileScaffold(['dependency_await', 'translations'], {
      dependencyDeclarations: [
        {
          declarationId: 'dep-a',
          revision: 1,
          packages: ['clsx', 'react'],
        },
        {
          declarationId: 'dep-b',
          revision: 2,
          packages: ['vitest', 'zod'],
        },
      ],
    });

    expect(left.compiled.semanticHash).toBe(right.compiled.semanticHash);
    expect(left.compiled.compiled.hash).toBe(right.compiled.compiled.hash);
  });

  it.each([
    {
      name: 'duplicate segments',
      segments: ['translations', 'translations'],
      taskSnapshot: {},
      expectedIssue: 'segments: Segment selections must be unique',
    },
    {
      name: 'unknown segments',
      segments: ['runtime_observe'],
      taskSnapshot: {},
      expectedIssuePrefix: 'segments.0:',
    },
    {
      name: 'dependency selection without declarations',
      segments: ['dependency_await'],
      taskSnapshot: {},
      expectedIssue:
        'Segment dependency_await requires at least one frozen dependency declaration.',
    },
  ])(
    'returns planner-correctable slot failures for %s',
    ({ taskSnapshot, expectedIssue, expectedIssuePrefix, segments }) => {
      const result = scaffoldDeliverPr(
        {
          task,
          taskSnapshot,
          objective: 'Implement the accepted plan.',
          segments,
          verification: {
            validationProfile: 'targeted',
          },
        },
        config,
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('slot_error');
      if (expectedIssue !== undefined) {
        expect(result.error.issues).toContain(expectedIssue);
      }
      if (expectedIssuePrefix !== undefined) {
        expect(result.error.issues).toEqual(
          expect.arrayContaining([expect.stringContaining(expectedIssuePrefix)]),
        );
      }
    },
  );
});
