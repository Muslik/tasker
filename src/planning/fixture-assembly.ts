import type { TaskFixture } from './fixtures.js';
import {
  resolvePackagePublicationPolicy,
  resolveProjectWorkflowProfile,
  type ProjectWorkflowProfile,
} from './project-policies.js';
import {
  bounded_loop,
  defineWorkflow,
  finalize,
  gate,
  sequence,
  step,
  wait,
  type WorkflowNodeSource,
  type WorkflowSource,
} from '../workflow/index.js';
import { getHarnessPack } from '../harness/index.js';

interface TaskContext {
  readonly description: string;
  readonly repository: string;
  readonly taskId: string;
  readonly title: string;
}

const translationNodes = (
  task: TaskContext & { readonly translationIntent: 'copy_change' | 'none' },
  repository: string,
  profile: ProjectWorkflowProfile,
): readonly WorkflowNodeSource[] => {
  if (task.translationIntent === 'none' || profile.translations.kind === 'inline_json') {
    return [];
  }

  return [
    step('extract-translation-keys', {
      uses: 'translations.extract@1',
      with: {
        repository,
        taskId: task.taskId,
      },
    }),
    wait('wait-for-translator', { for: 'translation_complete@1' }),
    step('pull-translations', {
      uses: 'translations.pull@1',
      with: {
        repository,
        taskId: task.taskId,
      },
    }),
  ];
};

const taskInput = (task: TaskContext, objective: string) => ({
  objective,
  repository: task.repository,
  taskId: task.taskId,
});

const reproductionInput = (task: TaskContext, phase: 'before' | 'after', objective: string) => ({
  ...taskInput(task, objective),
  phase,
});

const verificationInput = (task: TaskContext, profile: string) => ({
  profile,
  taskId: task.taskId,
});

const planBoundary = (task: TaskContext): WorkflowNodeSource =>
  gate('review-plan', {
    reason: 'Every task produces a plan; immutable run settings decide whether a human reviews it.',
    resumeWhen: 'plan.approved@1',
    with: { taskId: task.taskId },
  });

const aiAssistanceEnabled = (): boolean =>
  getHarnessPack().policies.some((policy) => policy.id === 'ai-assistance');

const aiAssistancePrelude = (task: TaskContext): readonly WorkflowNodeSource[] =>
  aiAssistanceEnabled()
    ? [
        step('initialize-ai-assistance', {
          uses: 'ai.assistance.initialize@1',
          with: taskInput(task, 'Initialize the required AI-assistance evidence for this task.'),
        }),
      ]
    : [];

const acceptedPlanRecord = (task: TaskContext): readonly WorkflowNodeSource[] =>
  aiAssistanceEnabled()
    ? [
        step('record-accepted-plan', {
          uses: 'ai.assistance.record_plan@1',
          with: taskInput(task, 'Persist the accepted implementation plan before product changes.'),
        }),
      ]
    : [];

const pullRequestPublication = (
  task: TaskContext,
  prefix: '' | 'review-',
): readonly WorkflowNodeSource[] => [
  ...(aiAssistanceEnabled()
    ? [
        step(`${prefix}finalize-ai-assistance`, {
          uses: 'ai.assistance.finalize@1',
          with: taskInput(task, 'Harvest the actual result and verification evidence.'),
        }),
      ]
    : []),
  step(`${prefix}describe-pr`, {
    uses: 'pr.describe@1',
    with: {
      ...taskInput(task, 'Compose the provider-neutral pull-request draft.'),
      draftPath: '.tasker/pull-request/draft.json',
    },
  }),
  ...(aiAssistanceEnabled()
    ? [
        step(`${prefix}validate-ai-assistance`, {
          uses: 'ai.assistance.validate@1',
          with: {
            ...taskInput(task, 'Validate the branch artifacts and pull-request AI section.'),
            draftPath: '.tasker/pull-request/draft.json',
          },
        }),
      ]
    : []),
  step(`${prefix}prepare-pr`, {
    uses: 'pr.prepare@1',
    with: {
      ...taskInput(task, 'Prepare the implementation for code review.'),
      draftPath: '.tasker/pull-request/draft.json',
    },
  }),
  step(`${prefix}observe-ci`, {
    uses: 'ci.observe@1',
    with: taskInput(task, 'Wait for CI and classify failures before code review completes.'),
  }),
];

const pullRequestReadiness = (task: TaskContext): readonly WorkflowNodeSource[] => [
  ...pullRequestPublication(task, ''),
  wait('wait-for-code-review', { for: 'code_review@1' }),
  bounded_loop('code-review-revision-loop', {
    maxAttempts: 3,
    until: 'review.approved@1',
    checkBefore: true,
    exhaustedWait: 'operator_guidance@1',
    body: sequence('code-review-revision', [
      step('revise-from-review', {
        uses: 'review.revise@1',
        with: taskInput(task, 'Apply every actionable unresolved pull-request review thread.'),
      }),
      step('verify-review-revision', {
        uses: 'verify.targeted@1',
        with: verificationInput(task, 'review_revision'),
      }),
      ...pullRequestPublication(task, 'review-'),
      wait('wait-for-revised-code-review', { for: 'code_review@1' }),
    ]),
  }),
];

const shortBugfixRoot = (task: TaskContext): WorkflowNodeSource =>
  sequence('short-bugfix-delivery', [
    ...aiAssistancePrelude(task),
    step('analyze-task', {
      uses: 'task.analyze@1',
      with: taskInput(task, task.description),
    }),
    planBoundary(task),
    ...acceptedPlanRecord(task),
    step('reproduce-before', {
      uses: 'bug.reproduce@1',
      with: reproductionInput(
        task,
        'before',
        'Reproduce the reported behavior and preserve before evidence.',
      ),
    }),
    bounded_loop('implementation-loop', {
      maxAttempts: 3,
      until: 'attempt.succeeded@1',
      body: sequence('implementation-attempt', [
        step('implement-fix', {
          uses: 'code.implement@1',
          with: taskInput(task, task.title),
        }),
        step('verify-targeted', {
          uses: 'verify.targeted@1',
          with: verificationInput(task, 'targeted'),
        }),
      ]),
    }),
    step('reproduce-after', {
      uses: 'bug.reproduce@1',
      with: reproductionInput(
        task,
        'after',
        'Repeat the reproduction and preserve after evidence.',
      ),
    }),
    ...pullRequestReadiness(task),
    finalize('review-complete', { outcome: 'done' }),
  ]);

const featureWithReviewRoot = (
  task: TaskContext & { readonly translationIntent: 'copy_change' | 'none' },
  options: { readonly includeVisualCheck: boolean },
): WorkflowNodeSource =>
  sequence('feature-delivery', [
    ...aiAssistancePrelude(task),
    step('analyze-task', {
      uses: 'task.analyze@1',
      with: taskInput(task, task.description),
    }),
    planBoundary(task),
    ...acceptedPlanRecord(task),
    bounded_loop('implementation-loop', {
      maxAttempts: 3,
      until: 'attempt.succeeded@1',
      body: sequence('implementation-attempt', [
        step('implement-feature', {
          uses: 'code.implement@1',
          with: taskInput(task, task.title),
        }),
        step('verify-full', {
          uses: 'verify.full@1',
          with: verificationInput(task, 'full'),
        }),
        ...(options.includeVisualCheck
          ? [
              step('verify-visual', {
                uses: 'verify.visual@1',
                with: verificationInput(task, 'visual'),
              }),
            ]
          : []),
      ]),
    }),
    ...translationNodes(task, task.repository, resolveProjectWorkflowProfile(task.repository)),
    ...pullRequestReadiness(task),
    finalize('review-complete', { outcome: 'done' }),
  ]);

const sharedComponentRoot = (
  task: Extract<TaskFixture, { readonly family: 'shared_component' }>,
): WorkflowNodeSource => {
  const profile = resolveProjectWorkflowProfile(task.componentRepository);
  const publication = resolvePackagePublicationPolicy(task.componentRepository, task.componentPath);
  const verificationProfile =
    task.translationIntent === 'copy_change' && profile.translations.kind === 'external'
      ? 'translation_and_targeted'
      : 'targeted';
  const publicationNodes: readonly WorkflowNodeSource[] =
    publication.kind === 'human_final'
      ? [
          step('publish-development-package', {
            uses: 'component.dev_publish@1',
            with: {
              repository: task.componentRepository,
              taskId: task.taskId,
            },
          }),
          wait('wait-for-final-publish', { for: 'final_publish@1' }),
          step('consume-published-version', {
            uses: 'component.consume_published@1',
            with: taskInput(
              task,
              'Consume the exact package version supplied by the resolved final-publish signal.',
            ),
          }),
        ]
      : [];

  return sequence('shared-component-delivery', [
    ...aiAssistancePrelude(task),
    step('analyze-task', {
      uses: 'task.analyze@1',
      with: taskInput(task, task.description),
    }),
    planBoundary(task),
    ...acceptedPlanRecord(task),
    bounded_loop('component-implementation-loop', {
      maxAttempts: 3,
      until: 'attempt.succeeded@1',
      body: sequence('component-implementation-attempt', [
        step('implement-component-copy', {
          uses: 'code.implement@1',
          with: taskInput(
            { ...task, repository: task.componentRepository },
            'Implement copy in the shared component repository.',
          ),
        }),
      ]),
    }),
    ...translationNodes(task, task.componentRepository, profile),
    ...publicationNodes,
    step('verify-targeted', {
      uses: 'verify.targeted@1',
      with: verificationInput(task, verificationProfile),
    }),
    ...pullRequestReadiness(task),
    finalize('review-complete', { outcome: 'done' }),
  ]);
};

// This deterministic composer exists only for local fixtures and validator tests. Production
// workflow analyzers receive no skeleton and must assemble the complete graph from the catalog.
export const assembleFixtureWorkflow = (fixture: TaskFixture): WorkflowSource => {
  switch (fixture.family) {
    case 'short_bugfix':
      return defineWorkflow({
        id: `${fixture.fixtureId}-workflow`,
        version: 1,
        root: shortBugfixRoot(fixture),
      });

    case 'feature_with_review':
      return defineWorkflow({
        id: `${fixture.fixtureId}-workflow`,
        version: 1,
        root: featureWithReviewRoot(fixture, {
          includeVisualCheck: fixture.verification === 'full_with_visual',
        }),
      });

    case 'shared_component':
      return defineWorkflow({
        id: `${fixture.fixtureId}-workflow`,
        version: 1,
        root: sharedComponentRoot(fixture),
      });
  }
};
