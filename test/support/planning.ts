import {
  type WorkflowAnalyzerOutput,
  type ImplementationPlanningDecision,
  createWorkflowProposalFromAnalyzerOutput,
} from '../../src/planning/index.js';
import { type ImplementationPlanner } from '../../src/providers/index.js';
import {
  branch,
  bounded_loop,
  finalize,
  sequence,
  step,
  wait,
  type WorkflowSource,
} from '../../src/workflow/index.js';
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

const shortBugWorkflow = (): WorkflowSource => ({
  id: 'short-bugfix-delivery',
  version: 1,
  root: sequence('delivery', [
    step('implement-fix', {
      uses: 'code.implement@1',
      with: {
        objective: 'Implement the fix',
        repository: 'onetwotrip/front-avia',
        taskId: 'AVIA-13236',
      },
    }),
    step('validate-targeted', {
      uses: 'validate.targeted@1',
      with: { profile: 'targeted', taskId: 'AVIA-13236' },
    }),
    bounded_loop('validation-repair-loop', {
      maxAttempts: 3,
      until: 'validation.passed@1',
      checkBefore: true,
      exhaustedWait: 'operator_guidance@1',
      body: sequence('validation-repair', [
        step('repair-validation', {
          uses: 'code.repair@1',
          with: {
            objective: 'Repair validation failures',
            repository: 'onetwotrip/front-avia',
            taskId: 'AVIA-13236',
          },
        }),
        step('revalidate-targeted', {
          uses: 'validate.targeted@1',
          with: { profile: 'targeted', taskId: 'AVIA-13236' },
        }),
      ]),
    }),
    step('validate-bug-fix', {
      uses: 'bug.validate_fix@1',
      with: {
        objective: 'Repeat bug scenario after the fix',
        repository: 'onetwotrip/front-avia',
        taskId: 'AVIA-13236',
        phase: 'after',
      },
    }),
    step('agent-review', {
      uses: 'review.agent@1',
      with: {
        objective: 'Review the change',
        repository: 'onetwotrip/front-avia',
        taskId: 'AVIA-13236',
      },
    }),
    bounded_loop('agent-review-repair-loop', {
      maxAttempts: 3,
      until: 'agent_review.accepted@1',
      checkBefore: true,
      exhaustedWait: 'operator_guidance@1',
      body: sequence('agent-review-repair', [
        step('repair-agent-review', {
          uses: 'code.repair@1',
          with: {
            objective: 'Repair review findings',
            repository: 'onetwotrip/front-avia',
            taskId: 'AVIA-13236',
          },
        }),
        step('review-validate-targeted', {
          uses: 'validate.targeted@1',
          with: { profile: 'targeted', taskId: 'AVIA-13236' },
        }),
        step('repeat-agent-review', {
          uses: 'review.agent@1',
          with: {
            objective: 'Repeat the review',
            repository: 'onetwotrip/front-avia',
            taskId: 'AVIA-13236',
          },
        }),
      ]),
    }),
    step('describe-pr', {
      uses: 'pr.describe@1',
      with: {
        objective: 'Describe the PR',
        repository: 'onetwotrip/front-avia',
        taskId: 'AVIA-13236',
        draftPath: '.tasker/pull-request/draft.json',
      },
    }),
    step('prepare-pr', {
      uses: 'pr.prepare@1',
      with: {
        objective: 'Prepare the PR',
        repository: 'onetwotrip/front-avia',
        taskId: 'AVIA-13236',
        draftPath: '.tasker/pull-request/draft.json',
      },
    }),
    step('observe-ci', {
      uses: 'ci.observe@1',
      with: { objective: 'Observe CI', repository: 'onetwotrip/front-avia', taskId: 'AVIA-13236' },
    }),
    bounded_loop('ci-recovery-loop', {
      maxAttempts: 3,
      until: 'ci.passed@1',
      checkBefore: true,
      exhaustedWait: 'operator_guidance@1',
      body: branch('ci-classification', {
        when: 'ci.change_failure@1',
        then: step('repair-ci-failure', {
          uses: 'ci.repair@1',
          with: {
            objective: 'Repair the CI failure',
            repository: 'onetwotrip/front-avia',
            taskId: 'AVIA-13236',
          },
        }),
        otherwise: wait('wait-for-flaky-ci-retry', { for: 'ci_retry@1' }),
      }),
    }),
    wait('wait-for-code-review', { for: 'code_review@1' }),
    finalize('finished', { outcome: 'done' }),
  ]),
});

const featureWorkflow = (includeVisual: boolean): WorkflowSource => ({
  id: 'feature-delivery',
  version: 1,
  root: sequence('delivery', [
    step('implement-feature', {
      uses: 'code.implement@1',
      with: {
        objective: 'Implement the feature',
        repository: 'onetwotrip/front-avia',
        taskId: 'AVIA-12536',
      },
    }),
    step('validate-full', {
      uses: 'validate.full@1',
      with: { profile: 'full', taskId: 'AVIA-12536' },
    }),
    ...(includeVisual
      ? [
          step('validate-visual', {
            uses: 'validate.visual@1',
            with: { profile: 'visual', taskId: 'AVIA-12536' },
          }),
        ]
      : []),
    step('agent-review', {
      uses: 'review.agent@1',
      with: {
        objective: 'Review the feature',
        repository: 'onetwotrip/front-avia',
        taskId: 'AVIA-12536',
      },
    }),
    step('describe-pr', {
      uses: 'pr.describe@1',
      with: {
        objective: 'Describe the PR',
        repository: 'onetwotrip/front-avia',
        taskId: 'AVIA-12536',
        draftPath: '.tasker/pull-request/draft.json',
      },
    }),
    step('prepare-pr', {
      uses: 'pr.prepare@1',
      with: {
        objective: 'Prepare the PR',
        repository: 'onetwotrip/front-avia',
        taskId: 'AVIA-12536',
        draftPath: '.tasker/pull-request/draft.json',
      },
    }),
    step('observe-ci', {
      uses: 'ci.observe@1',
      with: { objective: 'Observe CI', repository: 'onetwotrip/front-avia', taskId: 'AVIA-12536' },
    }),
    wait('wait-for-code-review', { for: 'code_review@1' }),
    finalize('finished', { outcome: 'done' }),
  ]),
});

const sharedComponentWorkflow = (): WorkflowSource => ({
  id: 'shared-component-delivery',
  version: 1,
  root: sequence('delivery', [
    step('implement-component-copy', {
      uses: 'code.implement@1',
      with: {
        objective: 'Implement the shared component copy',
        repository: 'twiket/ui-kit',
        taskId: 'AVIA-14001',
      },
    }),
    step('extract-translation-keys', {
      uses: 'translations.extract@1',
      with: { repository: 'twiket/ui-kit', taskId: 'AVIA-14001' },
    }),
    wait('wait-for-translator', { for: 'translation_complete@1' }),
    step('pull-translations', {
      uses: 'translations.pull@1',
      with: { repository: 'twiket/ui-kit', taskId: 'AVIA-14001' },
    }),
    step('publish-development-package', {
      uses: 'component.dev_publish@1',
      with: { repository: 'twiket/ui-kit', taskId: 'AVIA-14001' },
    }),
    wait('wait-for-final-publish', { for: 'final_publish@1' }),
    step('consume-published-version', {
      uses: 'component.consume_published@1',
      with: {
        objective: 'Consume the published version',
        repository: 'onetwotrip/front-avia',
        taskId: 'AVIA-14001',
      },
    }),
    step('validate-targeted', {
      uses: 'validate.targeted@1',
      with: { profile: 'targeted', taskId: 'AVIA-14001' },
    }),
    step('agent-review', {
      uses: 'review.agent@1',
      with: {
        objective: 'Review the cross-repository change',
        repository: 'onetwotrip/front-avia',
        taskId: 'AVIA-14001',
      },
    }),
    step('describe-pr', {
      uses: 'pr.describe@1',
      with: {
        objective: 'Describe the PR',
        repository: 'onetwotrip/front-avia',
        taskId: 'AVIA-14001',
        draftPath: '.tasker/pull-request/draft.json',
      },
    }),
    step('prepare-pr', {
      uses: 'pr.prepare@1',
      with: {
        objective: 'Prepare the PR',
        repository: 'onetwotrip/front-avia',
        taskId: 'AVIA-14001',
        draftPath: '.tasker/pull-request/draft.json',
      },
    }),
    step('observe-ci', {
      uses: 'ci.observe@1',
      with: { objective: 'Observe CI', repository: 'onetwotrip/front-avia', taskId: 'AVIA-14001' },
    }),
    wait('wait-for-code-review', { for: 'code_review@1' }),
    finalize('finished', { outcome: 'done' }),
  ]),
});

export const makeAnalyzerOutput = (
  task: TestTaskFixture = makeTaskFixture(),
): WorkflowAnalyzerOutput => {
  const source =
    task.family === 'short_bugfix'
      ? shortBugWorkflow()
      : task.family === 'shared_component'
        ? sharedComponentWorkflow()
        : featureWorkflow(task.verification === 'full_with_visual');

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

const firstStepId = (node: WorkflowSource['root']): string => {
  switch (node.kind) {
    case 'step':
      return node.id;
    case 'sequence':
      return firstStepId(node.children[0] ?? finalize('missing', { outcome: 'missing' }));
    case 'branch':
      return firstStepId(node.then);
    case 'bounded_loop':
      return firstStepId(node.body);
    case 'wait':
    case 'gate':
    case 'finalize':
      throw new Error('Test workflow has no executable step');
  }
};

export const makeReadyPlanningDecision = (): ImplementationPlanningDecision => {
  const workflow = makeAnalyzerOutput();
  const verificationStepId = firstStepId(workflow.source.root);
  return {
    status: 'ready',
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
          hypotheticalApiCostUsd: 0,
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
