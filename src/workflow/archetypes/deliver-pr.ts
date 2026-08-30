import { z } from 'zod';

import { err, ok, type Outcome } from '../../shared/outcome.js';
import type { JsonValue } from '../schema.js';
import type {
  SemanticNodeSource,
  SemanticStepSource,
  SemanticWorkflowSource,
} from '../semantic-schema.js';

export const DeliverPrArchetypeSchema = z.literal('deliver-pr');

export const DELIVER_PR_SEGMENTS = ['dependency_await', 'translations'] as const;
export const DeliverPrSegmentSchema = z.enum(DELIVER_PR_SEGMENTS);
export type DeliverPrSegment = z.infer<typeof DeliverPrSegmentSchema>;

export const VALIDATION_RUN_STEP_REFERENCE = 'validation.run@1';

export const DeliverPrSegmentsSchema = z
  .array(DeliverPrSegmentSchema)
  .max(DELIVER_PR_SEGMENTS.length)
  .superRefine((segments, context) => {
    if (new Set(segments).size !== segments.length) {
      context.addIssue({ code: 'custom', message: 'Segment selections must be unique' });
    }
  });

export const DELIVER_PR_NODE_IDS = Object.freeze({
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
  dependencyAwait: (ordinal: number) => `await-dependency-${String(ordinal)}`,
  dependencyConsume: (ordinal: number) => `consume-dependency-${String(ordinal)}`,
});

const VersionedReferenceSchema = z.string().regex(/^[a-z][a-z0-9_.-]*@[1-9]\d*$/u);

const StepMarkerSchema = z
  .object({ kind: z.literal('step'), reference: VersionedReferenceSchema })
  .loose();

const PathSequenceObligationSchema = z
  .object({
    id: z.string().min(1),
    kind: z.literal('path_sequence'),
    direction: z.literal('after'),
    trigger: StepMarkerSchema,
    ordered: z.array(StepMarkerSchema).min(1),
  })
  .loose();

const FeedbackLoopsObligationSchema = z
  .object({
    id: z.string().min(1),
    kind: z.literal('feedback_loops'),
    trigger: StepMarkerSchema,
    loops: z
      .array(
        z
          .object({
            until: VersionedReferenceSchema,
            requiredSteps: z.array(VersionedReferenceSchema).min(1),
            forbiddenSteps: z.array(VersionedReferenceSchema).default([]),
          })
          .strict(),
      )
      .length(3),
  })
  .loose();

const DeliverPrPolicyConfigurationSchema = z
  .object({
    deliverPr: z
      .object({
        loopMaxAttempts: z.number().int().positive(),
        optionalSegments: z
          .object({
            dependency_await: z.tuple([
              z.literal('dependency.await_packages@1'),
              z.literal('dependency.consume_exact@1'),
            ]),
            translations: z.tuple([
              z.literal('translations.extract@1'),
              z.literal('translations.pull@1'),
            ]),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();

const QualityBoundariesPolicySchema = z
  .object({
    id: z.literal('quality-boundaries'),
    configuration: DeliverPrPolicyConfigurationSchema,
    obligations: z.array(z.unknown()),
  })
  .loose();

export interface DeliverPrScaffoldConfig {
  readonly loopMaxAttempts: number;
  readonly loops: readonly [
    { readonly until: string },
    { readonly until: string },
    { readonly until: string },
  ];
  readonly requiredStages: readonly [string, string, string, string, string];
  readonly optionalSegments: Readonly<Record<DeliverPrSegment, readonly [string, string]>>;
}

const expectedRequiredStages = [
  'implement.change@1',
  'verify.acceptance@1',
  'review.change@1',
  'prepare.delivery@1',
  'deliver.pull-request@1',
] as const;

const sameValues = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

export const resolveDeliverPrScaffoldConfig = (policiesInput: unknown): DeliverPrScaffoldConfig => {
  const policies = z.array(z.unknown()).parse(policiesInput);
  const candidate = policies.find(
    (policy) =>
      policy !== null &&
      typeof policy === 'object' &&
      'id' in policy &&
      policy.id === 'quality-boundaries',
  );
  const policy = QualityBoundariesPolicySchema.parse(candidate);
  const path = policy.obligations
    .map((obligation) => PathSequenceObligationSchema.safeParse(obligation))
    .find((result) => result.success && result.data.id === 'local-ready-before-delivery');
  const feedback = policy.obligations
    .map((obligation) => FeedbackLoopsObligationSchema.safeParse(obligation))
    .find((result) => result.success && result.data.id === 'delivery-feedback-is-frozen');
  if (path === undefined || !path.success || feedback === undefined || !feedback.success) {
    throw new Error('quality-boundaries does not define the deliver-pr scaffold obligations');
  }

  const requiredStages = [
    path.data.trigger.reference,
    ...path.data.ordered.map(({ reference }) => reference),
  ];
  if (!sameValues(requiredStages, expectedRequiredStages)) {
    throw new Error('quality-boundaries defines an unsupported deliver-pr stage sequence');
  }
  const expectedLoopStages = [
    expectedRequiredStages,
    expectedRequiredStages.slice(0, 3),
    expectedRequiredStages.slice(0, 2),
  ];
  if (
    feedback.data.trigger.reference !== expectedRequiredStages[4] ||
    feedback.data.loops.some(
      (loop, index) => !sameValues(loop.requiredSteps, expectedLoopStages[index] ?? []),
    )
  ) {
    throw new Error('quality-boundaries defines unsupported deliver-pr feedback membership');
  }
  const loops = feedback.data.loops.map(({ until }) => ({ until }));
  const [delivery, review, development] = loops;
  if (delivery === undefined || review === undefined || development === undefined) {
    throw new Error('quality-boundaries does not define three deliver-pr feedback loops');
  }

  return {
    loopMaxAttempts: policy.configuration.deliverPr.loopMaxAttempts,
    loops: [delivery, review, development],
    requiredStages: expectedRequiredStages,
    optionalSegments: policy.configuration.deliverPr.optionalSegments,
  };
};

const DeliverPrTaskSchema = z
  .object({
    reference: z.string().min(1),
    taskId: z.string().min(1),
    repository: z.string().min(1),
  })
  .loose();

const DeliverPrDependencyDeclarationSchema = z
  .object({
    declarationId: z.string().min(1),
    revision: z.number().int().positive(),
    packages: z.array(z.string().min(1)).min(1),
  })
  .loose();

const DeliverPrTaskSnapshotSchema = z
  .object({
    dependencyDeclarations: z.array(DeliverPrDependencyDeclarationSchema).optional(),
  })
  .loose();

export const VALIDATION_PROFILES = ['targeted', 'full', 'build'] as const;
export const ValidationProfileSchema = z.enum(VALIDATION_PROFILES);
export type ValidationProfile = z.infer<typeof ValidationProfileSchema>;

const DeliverPrScaffoldInputSchema = z
  .object({
    task: DeliverPrTaskSchema,
    taskSnapshot: z.unknown(),
    objective: z.string().min(1),
    segments: DeliverPrSegmentsSchema,
    verification: z
      .object({
        validationProfile: ValidationProfileSchema,
      })
      .strict(),
  })
  .strict();

export interface DeliverPrScaffoldFailure {
  readonly kind: 'slot_error';
  readonly issues: readonly string[];
}

const slotFailure = (issues: readonly string[]): Outcome<never, DeliverPrScaffoldFailure> =>
  err({ kind: 'slot_error', issues });

const step = (
  id: string,
  uses: string,
  withInput: Readonly<Record<string, JsonValue>>,
): SemanticStepSource => ({
  kind: 'step' as const,
  id,
  uses,
  with: withInput,
});

const dependencySteps = (
  taskInput: { readonly objective: string; readonly repository: string; readonly taskId: string },
  declarations: readonly z.infer<typeof DeliverPrDependencyDeclarationSchema>[],
  references: readonly [string, string],
): readonly SemanticNodeSource[] =>
  declarations.flatMap((declaration, index) => {
    const ordinal = index + 1;
    const packages = [...declaration.packages].sort((left, right) => left.localeCompare(right));
    return [
      step(DELIVER_PR_NODE_IDS.dependencyAwait(ordinal), references[0], {
        ...taskInput,
        declarationId: declaration.declarationId,
        declarationRevision: declaration.revision,
        channel: 'final',
        packages,
      }),
      step(DELIVER_PR_NODE_IDS.dependencyConsume(ordinal), references[1], {
        ...taskInput,
        declarationId: declaration.declarationId,
        declarationRevision: declaration.revision,
        channel: 'final',
      }),
    ];
  });

export const scaffoldDeliverPr = (
  inputValue: unknown,
  config: DeliverPrScaffoldConfig,
): Outcome<SemanticWorkflowSource, DeliverPrScaffoldFailure> => {
  const input = DeliverPrScaffoldInputSchema.safeParse(inputValue);
  if (!input.success) {
    return slotFailure(
      input.error.issues.map((issue) => `${issue.path.map(String).join('.')}: ${issue.message}`),
    );
  }

  const selected = new Set(input.data.segments);
  const snapshot = DeliverPrTaskSnapshotSchema.safeParse(input.data.taskSnapshot);
  if (!snapshot.success && selected.has('dependency_await')) {
    throw new Error('Frozen dependency declarations do not match the deliver-pr scaffold contract');
  }
  const declarations = snapshot.success ? (snapshot.data.dependencyDeclarations ?? []) : [];
  if (selected.has('dependency_await') && declarations.length === 0) {
    return slotFailure([
      'Segment dependency_await requires at least one frozen dependency declaration.',
    ]);
  }

  const task = input.data.task;
  const taskInput = {
    objective: input.data.objective,
    repository: task.repository,
    taskId: task.taskId,
  };
  const validationInput = {
    profile: input.data.verification.validationProfile,
  } as const;
  const [implementReference, verifyReference, reviewReference, prepareReference, deliverReference] =
    config.requiredStages;
  const optional: SemanticNodeSource[] = [];
  for (const segment of DELIVER_PR_SEGMENTS) {
    if (!selected.has(segment)) continue;
    if (segment === 'dependency_await') {
      optional.push(
        ...dependencySteps(
          taskInput,
          [...declarations].sort((left, right) =>
            left.declarationId.localeCompare(right.declarationId),
          ),
          config.optionalSegments.dependency_await,
        ),
      );
    } else {
      const [extractReference, pullReference] = config.optionalSegments.translations;
      const processInput = { repository: task.repository, taskId: task.taskId };
      optional.push(
        step(DELIVER_PR_NODE_IDS.translationsExtract, extractReference, processInput),
        step(DELIVER_PR_NODE_IDS.translationsPull, pullReference, processInput),
      );
    }
  }

  const [deliveryLoop, reviewLoop, developmentLoop] = config.loops;
  return ok({
    schemaVersion: 1,
    id: `deliver-pr-${task.reference}`,
    version: 1,
    root: {
      kind: 'sequence',
      id: DELIVER_PR_NODE_IDS.root,
      children: [
        {
          kind: 'bounded_loop',
          id: DELIVER_PR_NODE_IDS.deliveryLoop,
          maxAttempts: config.loopMaxAttempts,
          until: deliveryLoop.until,
          body: {
            kind: 'sequence',
            id: DELIVER_PR_NODE_IDS.deliveryAttempt,
            children: [
              {
                kind: 'bounded_loop',
                id: DELIVER_PR_NODE_IDS.reviewLoop,
                maxAttempts: config.loopMaxAttempts,
                until: reviewLoop.until,
                body: {
                  kind: 'sequence',
                  id: DELIVER_PR_NODE_IDS.reviewAttempt,
                  children: [
                    {
                      kind: 'bounded_loop',
                      id: DELIVER_PR_NODE_IDS.developmentLoop,
                      maxAttempts: config.loopMaxAttempts,
                      until: developmentLoop.until,
                      body: {
                        kind: 'sequence',
                        id: DELIVER_PR_NODE_IDS.developmentAttempt,
                        children: [
                          step(DELIVER_PR_NODE_IDS.implement, implementReference, taskInput),
                          ...optional,
                          step(
                            DELIVER_PR_NODE_IDS.runValidation,
                            VALIDATION_RUN_STEP_REFERENCE,
                            validationInput,
                          ),
                          step(DELIVER_PR_NODE_IDS.verify, verifyReference, taskInput),
                        ],
                      },
                    },
                    step(DELIVER_PR_NODE_IDS.review, reviewReference, taskInput),
                  ],
                },
              },
              step(DELIVER_PR_NODE_IDS.prepare, prepareReference, taskInput),
              step(DELIVER_PR_NODE_IDS.deliver, deliverReference, taskInput),
            ],
          },
        },
      ],
    },
  });
};
