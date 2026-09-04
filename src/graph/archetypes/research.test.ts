import { z } from 'zod';
import { describe, expect, it } from 'vitest';

import {
  compileSemanticWorkflow,
  createPredicateRegistry,
  createStepTypeRegistry,
  createWaitRegistry,
  RESEARCH_DOCUMENT_APPROVED_PREDICATE,
  scaffoldResearch,
  RESEARCH_NODE_IDS,
  RESEARCH_STEP_REFERENCES,
} from '../index.js';

const task = {
  reference: 'research-avia-17001',
  taskId: 'AVIA-17001',
  repository: 'onetwotrip/front-avia',
};

const product = {
  id: 'avia',
  title: 'Avia',
  jiraProjects: ['AVIA'],
  confluence: {
    spaceKey: 'AVIA',
    researchRootPageId: '42',
  },
  repositories: { primary: 'front-avia', linked: ['front-components'] },
} as const;

const compileScaffold = () => {
  const scaffold = scaffoldResearch({
    task,
    objective: 'Prepare the system analysis and publish it for review.',
    questions: ['Which current frontend and backend constraints shape the design?'],
    product,
    repositoryReference: task.repository,
    segments: [],
  });
  expect(scaffold.ok).toBe(true);
  if (!scaffold.ok) throw new Error(JSON.stringify(scaffold.error));

  const compiled = compileSemanticWorkflow({
    contracts: {
      predicates: createPredicateRegistry([
        {
          id: 'research.document_approved',
          version: '1',
          inputSchema: z.unknown(),
        },
      ]),
      stepTypes: createStepTypeRegistry(
        Object.values(RESEARCH_STEP_REFERENCES).map((reference) => ({
          id: reference.slice(0, reference.lastIndexOf('@')),
          version: reference.slice(reference.lastIndexOf('@') + 1),
          inputSchema: z.unknown(),
          outputSchema: z.unknown(),
        })),
      ),
      waits: createWaitRegistry([
        {
          id: 'operator_guidance',
          version: '1',
          stage: { id: 'attention', label: 'Needs attention' },
          resolutionSchema: z
            .object({
              decision: z.literal('resume'),
              guidance: z.string().trim().min(1),
            })
            .strict(),
        },
      ]),
    },
    loopExhaustedWait: 'operator_guidance@1',
    source: scaffold.value,
  });
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.error));
  expect(compiled.ok).toBe(true);

  return { semantic: scaffold.value, compiled: compiled.value };
};

describe('research archetype scaffold', () => {
  it('carries the operator brief verbatim into every research step input', () => {
    const brief = '  Проверь связанные компоненты и сохрани переносы\n';
    const result = scaffoldResearch({
      task,
      objective: 'Prepare the system analysis and publish it for review.',
      questions: ['Which current frontend and backend constraints shape the design?'],
      product,
      repositoryReference: task.repository,
      segments: [],
      operatorBrief: brief,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const investigate = result.value.root.children[0];
    const loop = result.value.root.children[1];
    if (investigate === undefined || investigate.kind !== 'step') {
      throw new Error('Research investigate step is missing');
    }
    if (loop === undefined || loop.kind !== 'bounded_loop') {
      throw new Error('Research loop is missing');
    }
    expect(loop.body.children.every((child) => child.kind === 'step')).toBe(true);
    expect(
      [
        investigate,
        ...loop.body.children.filter(
          (
            child,
          ): child is (typeof loop.body.children)[number] & {
            readonly kind: 'step';
          } => child.kind === 'step',
        ),
      ].map((child) =>
        child.with !== null && !Array.isArray(child.with) && typeof child.with === 'object'
          ? child.with.operatorBrief
          : null,
      ),
    ).toEqual([brief, brief, brief, brief]);
  });

  it('keeps the public node-id scheme stable', () => {
    expect(RESEARCH_NODE_IDS).toEqual({
      root: 'task-work',
      reviewLoop: 'review-feedback',
      reviewAttempt: 'review-attempt',
      investigate: 'investigate-research',
      draft: 'draft-research',
      review: 'review-research',
      documentReview: 'document-review-research',
      publish: 'publish-research',
      fileTasks: 'file-research-tasks',
    });
  });

  it('compiles a stable research scaffold', () => {
    const { semantic, compiled } = compileScaffold();

    expect(semantic).toMatchObject({
      id: `research-${task.reference}`,
      root: {
        kind: 'sequence',
        id: RESEARCH_NODE_IDS.root,
        children: [
          { kind: 'step', id: RESEARCH_NODE_IDS.investigate },
          {
            kind: 'bounded_loop',
            id: RESEARCH_NODE_IDS.reviewLoop,
            maxAttempts: 3,
            until: RESEARCH_DOCUMENT_APPROVED_PREDICATE,
            body: {
              kind: 'sequence',
              id: RESEARCH_NODE_IDS.reviewAttempt,
              children: [
                { kind: 'step', id: RESEARCH_NODE_IDS.draft },
                { kind: 'step', id: RESEARCH_NODE_IDS.review },
                { kind: 'step', id: RESEARCH_NODE_IDS.documentReview },
              ],
            },
          },
          { kind: 'step', id: RESEARCH_NODE_IDS.publish },
          { kind: 'step', id: RESEARCH_NODE_IDS.fileTasks },
        ],
      },
    });
    expect(compiled.compiled.graph.metadata.references.predicates).toEqual([
      RESEARCH_DOCUMENT_APPROVED_PREDICATE,
    ]);
    expect(compiled.compiled.graph.metadata.references.stepTypes).toEqual(
      expect.arrayContaining(Object.values(RESEARCH_STEP_REFERENCES)),
    );
    expect(compiled.compiled.graph.metadata.references.stepTypes).toHaveLength(
      Object.keys(RESEARCH_STEP_REFERENCES).length,
    );
    expect(compiled.compiled.graph.metadata.references.stepTypes).not.toEqual(
      expect.arrayContaining(['jira.start-work@1', 'jira.review-ready@1']),
    );
    expect(compiled.compiled.graph.metadata.references.waits).toEqual(['operator_guidance@1']);
  });

  it('rejects a repository that does not match the product primary repository', () => {
    const result = scaffoldResearch({
      task,
      objective: 'Prepare the system analysis and publish it for review.',
      questions: ['Which current frontend and backend constraints shape the design?'],
      product: {
        id: 'bus',
        title: 'Bus',
        jiraProjects: ['BUS'],
        confluence: {
          spaceKey: 'BUS',
          researchRootPageId: '51',
        },
        repositories: { primary: 'front-bus', linked: [] },
      },
      repositoryReference: task.repository,
      segments: [],
    });

    expect(result).toEqual({
      ok: false,
      error: {
        kind: 'slot_error',
        issues: [
          'Research product primary repository alias front-bus does not match prepared repository alias front-avia.',
        ],
      },
    });
  });
});
