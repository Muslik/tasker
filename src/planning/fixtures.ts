import { z } from 'zod';

import { err, ok, type Outcome } from '../shared/outcome.js';

const FixtureIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]*$/u);
const TaskIdSchema = z.string().regex(/^AVIA-[1-9][0-9]*$/u);
const RepositorySchema = z.string().regex(/^[a-z0-9._-]+\/[a-z0-9._-]+$/u);

const CommonFixtureSchema = z
  .object({
    fixtureId: FixtureIdSchema,
    taskId: TaskIdSchema,
    title: z.string().min(1),
    description: z.string().min(1),
    repository: RepositorySchema,
    translationIntent: z.enum(['none', 'copy_change']),
  })
  .strict();

const ShortBugfixFixtureSchema = CommonFixtureSchema.extend({
  family: z.literal('short_bugfix'),
  reproduction: z.literal('required'),
  verification: z.literal('targeted'),
}).strict();

const FeatureWithReviewFixtureSchema = CommonFixtureSchema.extend({
  family: z.literal('feature_with_review'),
  planReview: z.enum(['always', 'on_questions']),
  verification: z.enum(['full', 'full_with_visual']),
}).strict();

const SharedComponentFixtureSchema = CommonFixtureSchema.extend({
  family: z.literal('shared_component'),
  componentRepository: RepositorySchema,
  componentPath: z.string().min(1),
}).strict();

export const TaskFamilyFixtureSchema = z.discriminatedUnion('family', [
  ShortBugfixFixtureSchema,
  FeatureWithReviewFixtureSchema,
  SharedComponentFixtureSchema,
]);

const AcceptedFixtureSchema = z
  .object({
    expected: z.literal('accepted'),
    proposalVariant: z.literal('valid'),
  })
  .strict();

export const RejectedProposalVariantSchema = z.enum([
  'missing_terminal',
  'unbounded_loop',
  'unknown_step',
  'unmet_capability',
  'unsafe_effect',
]);

const RejectedFixtureSchema = z
  .object({
    expected: z.literal('rejected'),
    proposalVariant: RejectedProposalVariantSchema,
  })
  .strict();

export const TaskFixtureSchema = z.intersection(
  TaskFamilyFixtureSchema,
  z.discriminatedUnion('expected', [AcceptedFixtureSchema, RejectedFixtureSchema]),
);

export type TaskFamilyFixture = z.infer<typeof TaskFamilyFixtureSchema>;
export type TaskFixture = z.infer<typeof TaskFixtureSchema>;
export type RejectedProposalVariant = z.infer<typeof RejectedProposalVariantSchema>;

export const FixtureInputIssueSchema = z
  .object({
    message: z.string().min(1),
    path: z.array(z.union([z.string(), z.number()])),
  })
  .strict();

export const FixtureInputFailureSchema = z
  .object({
    code: z.literal('invalid_fixture'),
    issues: z.array(FixtureInputIssueSchema).min(1),
  })
  .strict();

export type FixtureInputFailure = z.infer<typeof FixtureInputFailureSchema>;

const fixtureInputs = [
  {
    fixtureId: 'avia-13236-short-bug',
    taskId: 'AVIA-13236',
    title: 'Restore fare card when baggage data is absent',
    description: 'Reproduce the frontend regression, implement the smallest fix, and verify it.',
    repository: 'twiket/avia-web',
    translationIntent: 'none',
    family: 'short_bugfix',
    reproduction: 'required',
    verification: 'targeted',
    expected: 'accepted',
    proposalVariant: 'valid',
  },
  {
    fixtureId: 'avia-12536-feature-review',
    taskId: 'AVIA-12536',
    title: 'Add a reviewed itinerary feature across the booking flow',
    description: 'Plan, implement, visually verify, run the full suite, and prepare code review.',
    repository: 'twiket/avia-web',
    translationIntent: 'none',
    family: 'feature_with_review',
    planReview: 'always',
    verification: 'full_with_visual',
    expected: 'accepted',
    proposalVariant: 'valid',
  },
  {
    fixtureId: 'avia-14001-translation-component',
    taskId: 'AVIA-14001',
    title: 'Add translated component copy and consume its published version',
    description: 'Change a shared component, pause for translation and final publish, then verify.',
    repository: 'twiket/avia-web',
    translationIntent: 'copy_change',
    family: 'shared_component',
    componentRepository: 'twiket/ui-kit',
    componentPath: 'packages/@ott/booking-copy',
    expected: 'accepted',
    proposalVariant: 'valid',
  },
  {
    fixtureId: 'avia-14002-inline-copy',
    taskId: 'AVIA-14002',
    title: 'Add booking copy stored directly in the application locale JSON',
    description: 'Change application-owned copy and verify it without an external translator wait.',
    repository: 'twiket/avia-web',
    translationIntent: 'copy_change',
    family: 'feature_with_review',
    planReview: 'on_questions',
    verification: 'full',
    expected: 'accepted',
    proposalVariant: 'valid',
  },
  ...(
    [
      ['unknown-step', 'unknown_step'],
      ['missing-terminal', 'missing_terminal'],
      ['unbounded-loop', 'unbounded_loop'],
      ['unmet-capability', 'unmet_capability'],
      ['unsafe-effect', 'unsafe_effect'],
    ] as const
  ).map(([suffix, proposalVariant], index) => ({
    fixtureId: `invalid-${suffix}`,
    taskId: `AVIA-${String(15001 + index)}`,
    title: `Rejected workflow fixture: ${suffix}`,
    description: 'Demonstrates a validator rejection without queueing or executing the graph.',
    repository: 'twiket/avia-web',
    translationIntent: 'none' as const,
    family: 'short_bugfix' as const,
    reproduction: 'required' as const,
    verification: 'targeted' as const,
    expected: 'rejected' as const,
    proposalVariant,
  })),
] satisfies readonly z.input<typeof TaskFixtureSchema>[];

const fixtures = Object.freeze(fixtureInputs.map((fixture) => TaskFixtureSchema.parse(fixture)));

export const listTaskFixtures = (): readonly TaskFixture[] => fixtures;

export const parseTaskFixture = (input: unknown): Outcome<TaskFixture, FixtureInputFailure> => {
  const result = TaskFixtureSchema.safeParse(input);

  if (!result.success) {
    return err({
      code: 'invalid_fixture',
      issues: result.error.issues.map((issue) => ({
        message: issue.message,
        path: issue.path.filter(
          (segment): segment is number | string =>
            typeof segment === 'number' || typeof segment === 'string',
        ),
      })),
    });
  }

  return ok(result.data);
};

export const findTaskFixture = (fixtureId: string): TaskFixture | undefined =>
  fixtures.find((fixture) => fixture.fixtureId === fixtureId);
