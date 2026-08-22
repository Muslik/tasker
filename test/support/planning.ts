import {
  type WorkflowAnalyzerOutput,
  type ImplementationPlanningDecision,
  createWorkflowProposalFromAnalyzerOutput,
} from '../../src/planning/index.js';
import { type ImplementationPlanner } from '../../src/providers/index.js';
import { type SemanticNodeSource, type SemanticWorkflowSource } from '../../src/workflow/index.js';
import {
  WorkflowGenerationSubjectSource,
  type PlanningTaskSnapshot,
  type WorkflowGenerationSubjectResolver,
  type WorkflowGenerationSubjectRunStore,
} from '../../src/planning/index.js';
import { ok } from '../../src/shared/outcome.js';

export type TestTaskFixtureId =
  | 'avia-13236-short-bug'
  | 'avia-12536-feature-review'
  | 'avia-14001-translation-component'
  | 'avia-14002-inline-copy'
  | 'invalid-unknown-step'
  | 'invalid-missing-terminal'
  | 'invalid-unbounded-loop'
  | 'invalid-unmet-capability';

export type TestTaskFixture = {
  readonly origin: string;
  readonly fixtureId: string;
  readonly taskId: string;
  readonly title: string;
  readonly description: string;
  readonly repository: string;
  readonly translationIntent: 'none' | 'copy_change';
  readonly family: 'short_bugfix' | 'feature_with_review' | 'shared_component';
  readonly reproduction?: 'required';
  readonly verification?: 'targeted' | 'full' | 'full_with_visual';
  readonly componentRepository?: string;
  readonly componentPath?: string;
  readonly expected: 'accepted' | 'rejected';
  readonly proposalVariant:
    'valid' | 'missing_terminal' | 'unbounded_loop' | 'unknown_step' | 'unmet_capability';
};

const baseFixtures: Record<TestTaskFixtureId, TestTaskFixture> = {
  'avia-13236-short-bug': {
    origin: 'fixture',
    fixtureId: 'avia-13236-short-bug',
    taskId: 'AVIA-13236',
    title: 'Restore fare card when baggage data is absent',
    description: 'Reproduce the frontend regression, implement the smallest fix, and verify it.',
    repository: 'onetwotrip/front-avia',
    translationIntent: 'none',
    family: 'short_bugfix',
    reproduction: 'required',
    verification: 'targeted',
    expected: 'accepted',
    proposalVariant: 'valid',
  },
  'avia-12536-feature-review': {
    origin: 'fixture',
    fixtureId: 'avia-12536-feature-review',
    taskId: 'AVIA-12536',
    title: 'Add a reviewed itinerary feature across the booking flow',
    description: 'Plan, implement, visually verify, run the full suite, and prepare code review.',
    repository: 'onetwotrip/front-avia',
    translationIntent: 'none',
    family: 'feature_with_review',
    verification: 'full_with_visual',
    expected: 'accepted',
    proposalVariant: 'valid',
  },
  'avia-14001-translation-component': {
    origin: 'fixture',
    fixtureId: 'avia-14001-translation-component',
    taskId: 'AVIA-14001',
    title: 'Add translated component copy and consume its published version',
    description: 'Change a shared component, pause for translation and final publish, then verify.',
    repository: 'onetwotrip/front-avia',
    translationIntent: 'copy_change',
    family: 'shared_component',
    componentRepository: 'twiket/ui-kit',
    componentPath: 'packages/@ott/booking-copy',
    expected: 'accepted',
    proposalVariant: 'valid',
  },
  'avia-14002-inline-copy': {
    origin: 'fixture',
    fixtureId: 'avia-14002-inline-copy',
    taskId: 'AVIA-14002',
    title: 'Add booking copy stored directly in the application locale JSON',
    description: 'Change application-owned copy and verify it without an external translator wait.',
    repository: 'onetwotrip/front-avia',
    translationIntent: 'copy_change',
    family: 'feature_with_review',
    verification: 'full',
    expected: 'accepted',
    proposalVariant: 'valid',
  },
  'invalid-unknown-step': {
    origin: 'fixture',
    fixtureId: 'invalid-unknown-step',
    taskId: 'AVIA-15001',
    title: 'Rejected workflow fixture: unknown-step',
    description: 'Demonstrates a validator rejection without queueing or executing the graph.',
    repository: 'onetwotrip/front-avia',
    translationIntent: 'none',
    family: 'short_bugfix',
    reproduction: 'required',
    verification: 'targeted',
    expected: 'rejected',
    proposalVariant: 'unknown_step',
  },
  'invalid-missing-terminal': {
    origin: 'fixture',
    fixtureId: 'invalid-missing-terminal',
    taskId: 'AVIA-15002',
    title: 'Rejected workflow fixture: missing-terminal',
    description: 'Demonstrates a validator rejection without queueing or executing the graph.',
    repository: 'onetwotrip/front-avia',
    translationIntent: 'none',
    family: 'short_bugfix',
    reproduction: 'required',
    verification: 'targeted',
    expected: 'rejected',
    proposalVariant: 'missing_terminal',
  },
  'invalid-unbounded-loop': {
    origin: 'fixture',
    fixtureId: 'invalid-unbounded-loop',
    taskId: 'AVIA-15003',
    title: 'Rejected workflow fixture: unbounded-loop',
    description: 'Demonstrates a validator rejection without queueing or executing the graph.',
    repository: 'onetwotrip/front-avia',
    translationIntent: 'none',
    family: 'short_bugfix',
    reproduction: 'required',
    verification: 'targeted',
    expected: 'rejected',
    proposalVariant: 'unbounded_loop',
  },
  'invalid-unmet-capability': {
    origin: 'fixture',
    fixtureId: 'invalid-unmet-capability',
    taskId: 'AVIA-15004',
    title: 'Rejected workflow fixture: unmet-capability',
    description: 'Demonstrates a validator rejection without queueing or executing the graph.',
    repository: 'onetwotrip/front-avia',
    translationIntent: 'none',
    family: 'short_bugfix',
    reproduction: 'required',
    verification: 'targeted',
    expected: 'rejected',
    proposalVariant: 'unmet_capability',
  },
};

export const makeTaskFixture = (
  id: TestTaskFixtureId = 'avia-13236-short-bug',
  overrides: Partial<TestTaskFixture> = {},
): TestTaskFixture => ({ ...baseFixtures[id], ...overrides });

export const makePlanningTaskSnapshot = (
  id: TestTaskFixtureId = 'avia-13236-short-bug',
  overrides: Partial<{
    readonly origin: string;
    readonly reference: string;
    readonly taskId: string;
    readonly title: string;
    readonly description: string;
    readonly repository: string;
    readonly kind: 'bug' | 'feature' | 'task' | 'other';
    readonly labels: string[];
  }> = {},
) => {
  const task = makeTaskFixture(id);
  return {
    schemaVersion: 1 as const,
    origin: task.origin,
    reference: task.fixtureId,
    taskId: task.taskId,
    title: task.title,
    description: task.description,
    repository: task.repository,
    kind: task.family === 'short_bugfix' ? ('bug' as const) : ('feature' as const),
    labels: [],
    ...overrides,
  };
};

const semanticWorkflow = (task: TestTaskFixture): SemanticWorkflowSource => {
  const taskInput = (objective: string) => ({
    objective,
    repository: task.repository,
    taskId: task.taskId,
  });
  return {
    schemaVersion: 1,
    id: `${task.fixtureId}-workflow`,
    version: 1,
    root: {
      kind: 'sequence',
      id: 'task-work',
      children: [
        {
          kind: 'bounded_loop',
          id: 'development',
          maxAttempts: 3,
          until: 'verification.accepted@1',
          body: {
            kind: 'sequence',
            id: 'development-attempt',
            children: [
              {
                kind: 'step',
                id: 'implement-change',
                uses: 'implement.change@1',
                with: taskInput(`Implement ${task.title}`),
              },
              {
                kind: 'step',
                id: 'verify-change',
                uses: 'verify.acceptance@1',
                with: taskInput(`Verify ${task.title}`),
              },
            ],
          },
        },
        {
          kind: 'step',
          id: 'review-change',
          uses: 'review.change@1',
          with: taskInput(`Review ${task.title}`),
        },
        {
          kind: 'step',
          id: 'deliver-change',
          uses: 'deliver.pull-request@1',
          with: taskInput(`Deliver ${task.title}`),
        },
      ],
    },
  };
};

export const makeAnalyzerOutput = (
  task: TestTaskFixture = makeTaskFixture(),
): WorkflowAnalyzerOutput => {
  const source = semanticWorkflow(task);

  const verificationPlan =
    task.family === 'short_bugfix'
      ? {
          checks: ['reproduction evidence', 'targeted tests for changed behavior'],
          profile: 'targeted' as const,
          rationale:
            'A localized bug fix needs proof of reproduction and focused regression coverage.',
        }
      : task.family === 'shared_component'
        ? {
            checks: ['translation resources pulled', 'targeted consumer tests'],
            profile: 'translation_and_targeted' as const,
            rationale:
              'The component project uses external translation and must verify the consuming surface.',
          }
        : task.verification === 'full_with_visual'
          ? {
              checks: ['full test suite', 'visual comparison of affected screens'],
              profile: 'full_with_visual' as const,
              rationale: 'The feature spans a booking flow and changes visible frontend behavior.',
            }
          : {
              checks: ['full test suite'],
              profile: 'full' as const,
              rationale:
                'The feature spans multiple behaviors, so targeted checks are insufficient.',
            };

  return {
    assemblyDecisions: [
      {
        id: 'explicit-test-proposal',
        title: 'Explicit test workflow candidate',
        source: 'test-support',
        reason:
          'Unit tests use an explicit workflow candidate instead of the deterministic fixture planner.',
        effect: 'Compile and validate the candidate exactly as a production analyzer output.',
      },
    ],
    source,
    verificationPlan,
  };
};

export const makeWorkflowProposal = (
  task: TestTaskFixture = makeTaskFixture(),
  analyzerVersion = 'test-analyzer@1',
) => {
  const proposal = createWorkflowProposalFromAnalyzerOutput(
    makePlanningTaskSnapshot(task.fixtureId as TestTaskFixtureId),
    analyzerVersion,
    makeAnalyzerOutput(task),
  );
  if (!proposal.ok) {
    throw new Error(`Expected valid workflow proposal for ${task.fixtureId}`);
  }
  return proposal.value;
};

const stepIdByUse = (node: SemanticNodeSource, reference: string): string | null => {
  switch (node.kind) {
    case 'step':
      return node.uses === reference ? node.id : null;
    case 'sequence':
      for (const child of node.children) {
        const found = stepIdByUse(child, reference);
        if (found !== null) return found;
      }
      return null;
    case 'bounded_loop':
      return stepIdByUse(node.body, reference);
  }
};

export const makeReadyPlanningDecision = (): ImplementationPlanningDecision => {
  const workflow = makeAnalyzerOutput();
  const verificationStepId = stepIdByUse(workflow.source.root, 'verify.acceptance@1');
  if (verificationStepId === null) throw new Error('Test workflow has no Verify block');
  return {
    status: 'ready',
    executionStrategy: 'simple',
    plan: {
      schemaVersion: 2,
      title: 'Repair the reported behavior',
      summary: 'Inspect the bounded surface, implement the repair, and verify the result.',
      steps: [
        {
          id: 'repair-behavior',
          title: 'Repair the reported behavior',
          objective: 'Make the smallest change that satisfies the task.',
          repository: 'onetwotrip/front-avia',
          files: [],
          verification: ['Run the workflow verification step.'],
        },
      ],
      assumptions: [],
      risks: [],
      acceptanceCriteria: [
        {
          id: 'reported-behavior-fixed',
          expected: 'The reported behavior satisfies the task description.',
          verification: [
            {
              kind: 'process',
              profile: 'targeted',
              scenario: 'Run the workflow verification step.',
              workflowStepIds: [verificationStepId],
            },
          ],
        },
      ],
    },
    followUps: [],
    workflow,
  };
};

export const makeTestImplementationPlanner = (): ImplementationPlanner => ({
  plan: (request) =>
    Promise.resolve(
      ok({
        decision: makeReadyPlanningDecision(),
        evidenceRequests: [],
        stderr: '',
        receipt: {
          status: 'completed',
          provider: 'codex_cli',
          plannerVersion: 'implementation-planner@3',
          profile: 'test-planner',
          profileSha256: '0'.repeat(64),
          cliVersion: 'test@1',
          model: 'test-model',
          effort: 'low',
          serviceTier: 'fast',
          strategy: request.strategy,
          sessionId: `test:${request.operationId ?? 'planning'}`,
          promptHash: '1'.repeat(64),
          durationMs: 0,
          usage: {
            inputTokens: 0,
            cachedInputTokens: 0,
            outputTokens: 0,
            reasoningOutputTokens: 0,
          },
          apiCost: { source: 'provider_reported', amountUsd: 0 },
        },
      }),
    ),
});

export const makeTestGenerationSubjectSource = (
  repositoryPath: string,
  task: PlanningTaskSnapshot = makePlanningTaskSnapshot(),
): WorkflowGenerationSubjectSource => {
  const resolver: WorkflowGenerationSubjectResolver = {
    resolve: (taskReference) =>
      ok(
        taskReference === task.reference
          ? {
              schemaVersion: 1,
              repositoryPath,
              task,
              taskSnapshot: task,
            }
          : null,
      ),
  };
  const captures = new Map<string, ReturnType<typeof resolver.resolve>>();
  const runStore: WorkflowGenerationSubjectRunStore = {
    readRunGenerationSubject: (taskReference, workflowRunId) => {
      const captured = captures.get(`${taskReference}:${workflowRunId}`);
      return captured?.ok === true ? ok(captured.value) : ok(null);
    },
    captureRunGenerationSubject: (taskReference, workflowRunId, subject) => {
      captures.set(`${taskReference}:${workflowRunId}`, ok(subject));
      return ok(subject);
    },
  };
  return new WorkflowGenerationSubjectSource([resolver], runStore);
};
