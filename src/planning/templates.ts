import { z } from 'zod';

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

export const WorkflowTemplateIdSchema = z.enum(['feature_with_review', 'short_bugfix']);
export type WorkflowTemplateId = z.infer<typeof WorkflowTemplateIdSchema>;

const templateTask = {
  description: 'Task-specific objective is supplied by the analyzer.',
  repository: 'template/repository',
  taskId: 'TASK-TEMPLATE',
  title: 'Task-specific title',
  translationIntent: 'none',
} as const;

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
        command: profile.translations.extractCommand,
        repository,
        taskId: task.taskId,
      },
    }),
    wait('wait-for-translator', {
      for: 'translation_complete@1',
    }),
    step('pull-translations', {
      uses: 'translations.pull@1',
      with: {
        command: profile.translations.pullCommand,
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

const verificationInput = (task: TaskContext, profile: string) => ({
  profile,
  taskId: task.taskId,
});

const shortBugfixRoot = (task: TaskContext): WorkflowNodeSource =>
  sequence('short-bugfix-delivery', [
    step('analyze-task', {
      uses: 'task.analyze@1',
      with: taskInput(task, task.description),
    }),
    step('reproduce-bug', {
      uses: 'bug.reproduce@1',
      with: taskInput(task, 'Reproduce the reported behavior and preserve evidence.'),
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
    step('prepare-pr', {
      uses: 'pr.prepare@1',
      with: taskInput(task, 'Prepare the implementation for code review.'),
    }),
    wait('wait-for-code-review', {
      for: 'code_review@1',
    }),
    finalize('waiting-for-review', { outcome: 'waiting_for_review' }),
  ]);

const featureWithReviewRoot = (
  task: TaskContext & { readonly translationIntent: 'copy_change' | 'none' },
  options: { readonly includePlanGate: boolean; readonly includeVisualCheck: boolean },
): WorkflowNodeSource =>
  sequence('feature-delivery', [
    step('analyze-task', {
      uses: 'task.analyze@1',
      with: taskInput(task, task.description),
    }),
    ...(options.includePlanGate
      ? [
          gate('review-plan', {
            reason: 'This task requests a human-reviewable implementation plan.',
            resumeWhen: 'plan.approved@1',
            with: { taskId: task.taskId },
          }),
        ]
      : []),
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
    step('prepare-pr', {
      uses: 'pr.prepare@1',
      with: taskInput(task, 'Prepare the feature for code review.'),
    }),
    wait('wait-for-code-review', {
      for: 'code_review@1',
    }),
    finalize('waiting-for-review', { outcome: 'waiting_for_review' }),
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
              command: publication.developmentPublishCommand,
              repository: task.componentRepository,
              taskId: task.taskId,
            },
          }),
          wait('wait-for-final-publish', {
            for: 'final_publish@1',
          }),
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
    step('analyze-task', {
      uses: 'task.analyze@1',
      with: taskInput(task, task.description),
    }),
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
    step('prepare-pr', {
      uses: 'pr.prepare@1',
      with: taskInput(task, 'Prepare the consuming application for code review.'),
    }),
    wait('wait-for-code-review', {
      for: 'code_review@1',
    }),
    finalize('waiting-for-review', { outcome: 'waiting_for_review' }),
  ]);
};

export const selectWorkflowTemplate = (fixture: TaskFixture): WorkflowTemplateId =>
  fixture.family === 'short_bugfix' ? 'short_bugfix' : 'feature_with_review';

export const getBaseWorkflowTemplate = (templateId: WorkflowTemplateId): WorkflowSource => {
  switch (templateId) {
    case 'short_bugfix':
      return defineWorkflow({
        id: 'template-short-bugfix',
        version: 1,
        root: shortBugfixRoot(templateTask),
      });

    case 'feature_with_review':
      return defineWorkflow({
        id: 'template-feature-with-review',
        version: 1,
        root: featureWithReviewRoot(templateTask, {
          includePlanGate: true,
          includeVisualCheck: false,
        }),
      });
  }
};

export const materializeTaskWorkflow = (fixture: TaskFixture): WorkflowSource => {
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
          includePlanGate: fixture.planReview === 'always',
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
