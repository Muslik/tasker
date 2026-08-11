import type { TaskFixture } from './fixtures.js';
import {
  resolvePackagePublicationPolicy,
  resolveProjectWorkflowProfile,
  type ProjectWorkflowProfile,
} from './project-policies.js';
import {
  branch,
  bounded_loop,
  defineWorkflow,
  finalize,
  sequence,
  step,
  wait,
  type WorkflowNodeSource,
  type WorkflowSource,
} from '../workflow/index.js';
import { getHarnessPack, harnessPolicyAppliesToTask } from '../harness/index.js';

interface TaskContext {
  readonly description: string;
  readonly repository: string;
  readonly taskId: string;
  readonly title: string;
}

interface PolicyTaskContext {
  readonly origin: string;
  readonly family: string;
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

const reproductionInput = (task: TaskContext, objective: string) => ({
  ...taskInput(task, objective),
  phase: 'after' as const,
});

const verificationInput = (task: TaskContext, profile: string) => ({
  profile,
  taskId: task.taskId,
});

const validationBoundary = (
  task: TaskContext,
  profile: 'build' | 'full' | 'targeted' | 'visual',
  prefix: string,
): readonly WorkflowNodeSource[] => [
  step(`${prefix}validate-${profile}`, {
    uses: `validate.${profile}@1`,
    with: verificationInput(task, profile),
  }),
  bounded_loop(`${prefix}validation-repair-loop`, {
    maxAttempts: 3,
    until: 'validation.passed@1',
    checkBefore: true,
    exhaustedWait: 'operator_guidance@1',
    body: sequence(`${prefix}validation-repair`, [
      step(`${prefix}repair-validation`, {
        uses: 'code.repair@1',
        with: taskInput(task, 'Repair the latest actionable declared-validation findings.'),
      }),
      step(`${prefix}revalidate-${profile}`, {
        uses: `validate.${profile}@1`,
        with: verificationInput(task, profile),
      }),
    ]),
  }),
];

const localReviewBoundary = (
  task: TaskContext,
  profile: 'build' | 'full' | 'targeted' | 'visual',
  prefix: string,
  repeatBugScenario: boolean,
): readonly WorkflowNodeSource[] => [
  step(`${prefix}agent-review`, {
    uses: 'review.agent@1',
    with: taskInput(task, 'Independently review the accepted plan, diff, and validation evidence.'),
  }),
  bounded_loop(`${prefix}agent-review-repair-loop`, {
    maxAttempts: 3,
    until: 'agent_review.accepted@1',
    checkBefore: true,
    exhaustedWait: 'operator_guidance@1',
    body: sequence(`${prefix}agent-review-repair`, [
      step(`${prefix}repair-agent-review`, {
        uses: 'code.repair@1',
        with: taskInput(task, 'Repair the latest actionable independent-review findings.'),
      }),
      ...validationBoundary(task, profile, `${prefix}review-`),
      ...(repeatBugScenario
        ? [
            step(`${prefix}review-validate-bug-fix`, {
              uses: 'bug.validate_fix@1',
              with: reproductionInput(
                task,
                'Repeat the investigated scenario after review repair.',
              ),
            }),
          ]
        : []),
      step(`${prefix}repeat-agent-review`, {
        uses: 'review.agent@1',
        with: taskInput(task, 'Review the repaired diff and replacement validation evidence.'),
      }),
    ]),
  }),
];

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

const preExecutionPolicySteps = (
  task: TaskContext & PolicyTaskContext,
): readonly WorkflowNodeSource[] => {
  const pack = getHarnessPack();
  const references = pack.policies
    .filter((policy) => harnessPolicyAppliesToTask(policy, task))
    .flatMap((policy) =>
      policy.obligations.flatMap((obligation) => {
        if (obligation.direction !== 'before' || obligation.trigger.kind !== 'effect') return [];
        return obligation.ordered
          .filter(
            (marker) =>
              marker.kind === 'step' &&
              pack.steps.find((candidate) => candidate.reference === marker.reference)?.policy ===
                policy.id,
          )
          .map((marker) => ({ policy, reference: marker.reference }));
      }),
    )
    .filter(
      (candidate, index, candidates) =>
        candidates.findIndex(({ reference }) => reference === candidate.reference) === index,
    );

  return references.map(({ policy, reference }) =>
    step(`policy-${policy.id}-${reference.split('@')[0]?.replaceAll('.', '-') ?? 'step'}`, {
      uses: reference,
      with: taskInput(task, policy.description),
    }),
  );
};

const beforeCodeReviewPolicySteps = (
  task: TaskContext & PolicyTaskContext,
  prefix: '' | 'review-',
): readonly WorkflowNodeSource[] => {
  const pack = getHarnessPack();
  const references = pack.policies
    .filter((policy) => harnessPolicyAppliesToTask(policy, task))
    .flatMap((policy) =>
      policy.obligations
        .filter(
          (obligation) =>
            obligation.direction === 'before' &&
            obligation.trigger.kind === 'wait' &&
            obligation.trigger.reference === 'code_review@1',
        )
        .flatMap((obligation) =>
          obligation.ordered
            .filter(
              (marker) =>
                marker.kind === 'step' &&
                pack.steps.find((candidate) => candidate.reference === marker.reference)?.policy ===
                  policy.id,
            )
            .map((marker) => ({ policy, reference: marker.reference })),
        ),
    )
    .filter(
      (candidate, index, candidates) =>
        candidates.findIndex(({ reference }) => reference === candidate.reference) === index,
    );

  return references.map(({ policy, reference }) =>
    step(
      `${prefix}policy-${policy.id}-${reference.split('@')[0]?.replaceAll('.', '-') ?? 'step'}`,
      {
        uses: reference,
        with: taskInput(task, policy.description),
      },
    ),
  );
};

const pullRequestPublication = (
  task: TaskContext,
  prefix: string,
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
];

const observeCi = (task: TaskContext, id: string): WorkflowNodeSource =>
  step(id, {
    uses: 'ci.observe@1',
    with: taskInput(
      task,
      'Observe the exact published revision and classify its terminal CI result.',
    ),
  });

const ciRecoveryBoundary = (
  task: TaskContext,
  validationProfile: 'build' | 'full' | 'targeted' | 'visual',
  repeatBugScenario: boolean,
  prefix: '' | 'review-',
): readonly WorkflowNodeSource[] => [
  observeCi(task, `${prefix}observe-ci`),
  bounded_loop(`${prefix}ci-recovery-loop`, {
    maxAttempts: 3,
    until: 'ci.passed@1',
    checkBefore: true,
    exhaustedWait: 'operator_guidance@1',
    body: branch(`${prefix}ci-change-failure`, {
      when: 'ci.change_failure@1',
      then: sequence(`${prefix}repair-ci-change-failure`, [
        step(`${prefix}repair-ci-failure`, {
          uses: 'ci.repair@1',
          with: taskInput(task, 'Repair the exact CI failure attributed to the task change.'),
        }),
        ...validationBoundary(task, validationProfile, `${prefix}ci-`),
        ...(repeatBugScenario
          ? [
              step(`${prefix}ci-validate-bug-fix`, {
                uses: 'bug.validate_fix@1',
                with: reproductionInput(task, 'Repeat the bug scenario after the CI repair.'),
              }),
            ]
          : []),
        ...localReviewBoundary(task, validationProfile, `${prefix}ci-`, repeatBugScenario),
        ...pullRequestPublication(task, `${prefix}ci-repair-`),
        observeCi(task, `${prefix}observe-repaired-ci`),
      ]),
      otherwise: branch(`${prefix}ci-flaky-failure`, {
        when: 'ci.flaky@1',
        then: sequence(`${prefix}retry-flaky-ci`, [
          wait(`${prefix}wait-for-flaky-ci-retry`, { for: 'ci_retry@1' }),
          observeCi(task, `${prefix}observe-retried-ci`),
        ]),
        otherwise: branch(`${prefix}ci-infrastructure-failure`, {
          when: 'ci.infrastructure@1',
          then: sequence(`${prefix}resume-ci-infrastructure`, [
            wait(`${prefix}wait-for-ci-infrastructure`, { for: 'ci_infrastructure@1' }),
            observeCi(task, `${prefix}observe-ci-after-infrastructure`),
          ]),
          otherwise: sequence(`${prefix}resolve-unknown-ci`, [
            wait(`${prefix}wait-for-unknown-ci-guidance`, { for: 'ci_unknown@1' }),
            observeCi(task, `${prefix}observe-ci-after-guidance`),
          ]),
        }),
      }),
    }),
  }),
];

const pullRequestReadiness = (
  task: TaskContext & PolicyTaskContext,
  validationProfile: 'build' | 'full' | 'targeted' | 'visual',
  repeatBugScenario: boolean,
): readonly WorkflowNodeSource[] => [
  ...pullRequestPublication(task, ''),
  ...ciRecoveryBoundary(task, validationProfile, repeatBugScenario, ''),
  ...beforeCodeReviewPolicySteps(task, ''),
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
      ...validationBoundary(task, validationProfile, 'human-review-'),
      ...(repeatBugScenario
        ? [
            step('human-review-validate-bug-fix', {
              uses: 'bug.validate_fix@1',
              with: reproductionInput(task, 'Repeat the bug scenario after human-review repair.'),
            }),
          ]
        : []),
      ...localReviewBoundary(task, validationProfile, 'human-review-', repeatBugScenario),
      ...pullRequestPublication(task, 'review-'),
      ...ciRecoveryBoundary(task, validationProfile, repeatBugScenario, 'review-'),
      step('acknowledge-review-threads', {
        uses: 'review.acknowledge@1',
        with: taskInput(task, 'Acknowledge the pull-request threads addressed by this revision.'),
      }),
      ...beforeCodeReviewPolicySteps(task, 'review-'),
      wait('wait-for-revised-code-review', { for: 'code_review@1' }),
    ]),
  }),
];

const shortBugfixRoot = (task: TaskContext & PolicyTaskContext): WorkflowNodeSource =>
  sequence('short-bugfix-delivery', [
    ...aiAssistancePrelude(task),
    ...preExecutionPolicySteps(task),
    ...acceptedPlanRecord(task),
    step('implement-fix', {
      uses: 'code.implement@1',
      with: taskInput(task, task.title),
    }),
    ...validationBoundary(task, 'targeted', ''),
    step('validate-bug-fix', {
      uses: 'bug.validate_fix@1',
      with: reproductionInput(task, 'Repeat the reproduction and preserve after evidence.'),
    }),
    ...localReviewBoundary(task, 'targeted', '', true),
    ...pullRequestReadiness(task, 'targeted', true),
    finalize('review-complete', { outcome: 'done' }),
  ]);

const featureWithReviewRoot = (
  task: TaskContext & {
    readonly origin: string;
    readonly family: string;
    readonly translationIntent: 'copy_change' | 'none';
  },
  options: { readonly includeVisualCheck: boolean },
): WorkflowNodeSource =>
  sequence('feature-delivery', [
    ...aiAssistancePrelude(task),
    ...preExecutionPolicySteps(task),
    ...acceptedPlanRecord(task),
    step('implement-feature', {
      uses: 'code.implement@1',
      with: taskInput(task, task.title),
    }),
    ...validationBoundary(task, 'full', ''),
    ...(options.includeVisualCheck ? validationBoundary(task, 'visual', 'visual-') : []),
    ...localReviewBoundary(task, 'full', '', false),
    ...translationNodes(task, task.repository, resolveProjectWorkflowProfile(task.repository)),
    ...pullRequestReadiness(task, 'full', false),
    finalize('review-complete', { outcome: 'done' }),
  ]);

const sharedComponentRoot = (
  task: Extract<TaskFixture, { readonly family: 'shared_component' }>,
): WorkflowNodeSource => {
  const profile = resolveProjectWorkflowProfile(task.componentRepository);
  const publication = resolvePackagePublicationPolicy(task.componentRepository, task.componentPath);
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
    ...preExecutionPolicySteps(task),
    ...acceptedPlanRecord(task),
    step('implement-component-copy', {
      uses: 'code.implement@1',
      with: taskInput(
        { ...task, repository: task.componentRepository },
        'Implement copy in the shared component repository.',
      ),
    }),
    ...translationNodes(task, task.componentRepository, profile),
    ...publicationNodes,
    ...validationBoundary(task, 'targeted', ''),
    ...localReviewBoundary(task, 'targeted', '', false),
    ...pullRequestReadiness(task, 'targeted', false),
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
