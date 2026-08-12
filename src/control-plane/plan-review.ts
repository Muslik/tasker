import { z } from 'zod';

import type { LedgerRepository } from '../ledger/repository.js';
import type { JsonValue } from '../ledger/types.js';
import type { Clock } from '../shared/clock.js';
import { err, ok, type Outcome } from '../shared/outcome.js';
import { JsonValueSchema } from '../workflow/schema.js';

export const PlanReviewAnnotationSchema = z
  .object({
    id: z.string().min(1).max(200),
    anchor: z.string().min(1).max(300),
    quote: z.string().trim().min(1).max(2_000),
    startOffset: z.number().int().nonnegative(),
    endOffset: z.number().int().positive(),
    comment: z.string().trim().min(1).max(4_000),
  })
  .strict()
  .refine((annotation) => annotation.endOffset > annotation.startOffset, {
    message: 'Annotation end must follow its start',
    path: ['endOffset'],
  });

const annotationFeedback = (
  annotation: z.infer<typeof PlanReviewAnnotationSchema>,
  index: number,
): string =>
  `Annotation ${String(index + 1)} (${annotation.anchor})\n> ${annotation.quote.replaceAll('\n', '\n> ')}\n\n${annotation.comment}`;

const combinedReviewFeedback = (command: {
  readonly guidance: string;
  readonly annotations: readonly z.infer<typeof PlanReviewAnnotationSchema>[];
}): string =>
  [
    command.guidance.length === 0 ? null : command.guidance,
    ...command.annotations.map(annotationFeedback),
  ]
    .filter((part): part is string => part !== null)
    .join('\n\n');

const PlanReviewContextSchema = z
  .object({
    reviewId: z.string().min(1).max(200),
    planArtifactId: z.string().min(1),
    planAttempt: z.number().int().positive(),
  })
  .strict();

export const ApprovePlanReviewCommandSchema = PlanReviewContextSchema.extend({
  decision: z.literal('approve'),
}).strict();

export const RequestPlanChangesCommandSchema = PlanReviewContextSchema.extend({
  decision: z.literal('request_changes'),
  guidance: z.string().trim().max(10_000),
  annotations: z.array(PlanReviewAnnotationSchema).max(50),
})
  .strict()
  .refine(
    (command) => command.guidance.length > 0 || command.annotations.length > 0,
    'Plan review requires guidance or at least one annotation',
  )
  .refine(
    (command) => combinedReviewFeedback(command).length <= 10_000,
    'Combined plan review feedback must not exceed 10000 characters',
  );

export const PlanReviewCommandSchema = z.discriminatedUnion('decision', [
  ApprovePlanReviewCommandSchema,
  RequestPlanChangesCommandSchema,
]);

const PlanReviewSubmissionSchema = z
  .object({
    schemaVersion: z.literal(2),
    planningEpisodeId: z.string().min(1),
    taskReference: z.string().min(1),
    reviewId: z.string().min(1),
    planArtifactId: z.string().min(1),
    planAttempt: z.number().int().positive(),
    decision: z.enum(['approve', 'request_changes']),
    guidance: z.string().max(10_000).nullable(),
    annotations: z.array(PlanReviewAnnotationSchema).max(50),
    submittedAt: z.iso.datetime(),
  })
  .strict();

export const PlanReviewRoundSchema = PlanReviewSubmissionSchema.extend({
  status: z.enum(['submitted', 'applied']),
  appliedAt: z.iso.datetime().nullable(),
}).strict();

export const PlanReviewHistoryResponseSchema = z
  .object({
    rounds: z.array(PlanReviewRoundSchema),
  })
  .strict();

export type PlanReviewAnnotation = z.infer<typeof PlanReviewAnnotationSchema>;
export type PlanReviewCommand = z.infer<typeof PlanReviewCommandSchema>;
export type PlanReviewRound = z.infer<typeof PlanReviewRoundSchema>;

export type PlanReviewStoreError =
  | { readonly kind: 'ledger_conflict' }
  | { readonly kind: 'review_conflict'; readonly reviewId: string }
  | {
      readonly kind: 'review_corrupt';
      readonly reviewId: string;
      readonly issues: readonly string[];
    };

const asJson = (value: unknown): JsonValue => JsonValueSchema.parse(value);
const aggregateIdFor = (planningEpisodeId: string): string => `plan-review:${planningEpisodeId}`;
const artifactIdFor = (planningEpisodeId: string, reviewId: string): string =>
  `plan-review-submission:${planningEpisodeId}:${reviewId}`;

const commandPayload = (command: PlanReviewCommand) => ({
  reviewId: command.reviewId,
  planArtifactId: command.planArtifactId,
  planAttempt: command.planAttempt,
  decision: command.decision,
  guidance: command.decision === 'request_changes' ? command.guidance : null,
  annotations: command.decision === 'request_changes' ? command.annotations : [],
});

const sameSubmission = (
  submission: z.infer<typeof PlanReviewSubmissionSchema>,
  planningEpisodeId: string,
  taskReference: string,
  command: PlanReviewCommand,
): boolean =>
  submission.planningEpisodeId === planningEpisodeId &&
  submission.taskReference === taskReference &&
  JSON.stringify({
    reviewId: submission.reviewId,
    planArtifactId: submission.planArtifactId,
    planAttempt: submission.planAttempt,
    decision: submission.decision,
    guidance: submission.guidance,
    annotations: submission.annotations,
  }) === JSON.stringify(commandPayload(command));

export const planReviewResolution = (commandValue: PlanReviewCommand) => {
  const command = PlanReviewCommandSchema.parse(commandValue);
  return command.decision === 'approve'
    ? ({ decision: 'approve' } as const)
    : ({ decision: 'request_changes', guidance: combinedReviewFeedback(command) } as const);
};

export class PlanReviewStore {
  public constructor(
    private readonly ledger: LedgerRepository,
    private readonly clock: Clock,
  ) {}

  public submit(
    planningEpisodeId: string,
    taskReference: string,
    commandValue: PlanReviewCommand,
  ): Outcome<PlanReviewRound, PlanReviewStoreError> {
    const command = PlanReviewCommandSchema.parse(commandValue);
    const artifactId = artifactIdFor(planningEpisodeId, command.reviewId);
    const existing = this.ledger.readArtifact(artifactId);
    if (existing !== null) {
      return this.restoreSubmission(planningEpisodeId, taskReference, command, existing.payload);
    }

    const submittedAt = this.clock.now();
    const submission = PlanReviewSubmissionSchema.parse({
      schemaVersion: 2,
      planningEpisodeId,
      taskReference,
      ...commandPayload(command),
      submittedAt,
    });
    const aggregateId = aggregateIdFor(planningEpisodeId);
    const expectedVersion = this.ledger.readAggregateHead(aggregateId)?.version ?? 0;
    const committed = this.ledger.transact({
      aggregate: {
        aggregateId,
        expectedVersion,
        events: [
          {
            eventId: `event:${artifactId}:submitted`,
            eventType: 'PlanReviewSubmitted',
            eventSchemaVersion: 1,
            payload: asJson({ artifactId, reviewId: command.reviewId }),
            actor: 'operator',
          },
        ],
      },
      artifacts: [
        {
          artifactId,
          artifactKind: 'plan_review_submission',
          storageUri: `ledger://artifacts/${artifactId}`,
          payload: asJson(submission),
          metadata: asJson({
            taskReference,
            planningEpisodeId,
            planArtifactId: command.planArtifactId,
            planAttempt: command.planAttempt,
            decision: command.decision,
          }),
          createdAt: submittedAt,
        },
      ],
      timestamp: submittedAt,
    });
    if (!committed.ok) {
      const concurrent = this.ledger.readArtifact(artifactId);
      return concurrent === null
        ? err({ kind: 'ledger_conflict' })
        : this.restoreSubmission(planningEpisodeId, taskReference, command, concurrent.payload);
    }
    return ok(PlanReviewRoundSchema.parse({ ...submission, status: 'submitted', appliedAt: null }));
  }

  public markApplied(
    planningEpisodeId: string,
    reviewId: string,
  ): Outcome<void, PlanReviewStoreError> {
    const aggregateId = aggregateIdFor(planningEpisodeId);
    const appliedEventId = `event:${artifactIdFor(planningEpisodeId, reviewId)}:applied`;
    if (this.ledger.listEvents(aggregateId).some((event) => event.eventId === appliedEventId)) {
      return ok(undefined);
    }
    const expectedVersion = this.ledger.readAggregateHead(aggregateId)?.version ?? 0;
    const appliedAt = this.clock.now();
    const committed = this.ledger.transact({
      aggregate: {
        aggregateId,
        expectedVersion,
        events: [
          {
            eventId: appliedEventId,
            eventType: 'PlanReviewApplied',
            eventSchemaVersion: 1,
            payload: asJson({ reviewId, appliedAt }),
            actor: 'kernel',
          },
        ],
      },
      timestamp: appliedAt,
    });
    if (committed.ok) return ok(undefined);
    return this.ledger.listEvents(aggregateId).some((event) => event.eventId === appliedEventId)
      ? ok(undefined)
      : err({ kind: 'ledger_conflict' });
  }

  public read(
    planningEpisodeId: string,
  ): Outcome<readonly PlanReviewRound[], PlanReviewStoreError> {
    const events = this.ledger.listEvents(aggregateIdFor(planningEpisodeId));
    const applied = new Map<string, string>();
    for (const event of events) {
      if (event.eventType !== 'PlanReviewApplied') continue;
      const parsed = z
        .object({ reviewId: z.string().min(1), appliedAt: z.iso.datetime() })
        .strict()
        .safeParse(event.payload);
      if (parsed.success) applied.set(parsed.data.reviewId, parsed.data.appliedAt);
    }
    const rounds: PlanReviewRound[] = [];
    for (const event of events) {
      if (event.eventType !== 'PlanReviewSubmitted') continue;
      const pointer = z
        .object({ artifactId: z.string().min(1), reviewId: z.string().min(1) })
        .strict()
        .safeParse(event.payload);
      if (!pointer.success) {
        return err({
          kind: 'review_corrupt',
          reviewId: event.eventId,
          issues: pointer.error.issues.map((issue) => issue.message),
        });
      }
      const artifact = this.ledger.readArtifact(pointer.data.artifactId);
      const submission = PlanReviewSubmissionSchema.safeParse(artifact?.payload);
      if (!submission.success) {
        return err({
          kind: 'review_corrupt',
          reviewId: pointer.data.reviewId,
          issues: submission.error.issues.map((issue) => issue.message),
        });
      }
      const appliedAt = applied.get(submission.data.reviewId) ?? null;
      rounds.push(
        PlanReviewRoundSchema.parse({
          ...submission.data,
          status: appliedAt === null ? 'submitted' : 'applied',
          appliedAt,
        }),
      );
    }
    return ok(rounds);
  }

  private restoreSubmission(
    planningEpisodeId: string,
    taskReference: string,
    command: PlanReviewCommand,
    payload: JsonValue,
  ): Outcome<PlanReviewRound, PlanReviewStoreError> {
    const parsed = PlanReviewSubmissionSchema.safeParse(payload);
    if (!parsed.success) {
      return err({
        kind: 'review_corrupt',
        reviewId: command.reviewId,
        issues: parsed.error.issues.map((issue) => issue.message),
      });
    }
    if (!sameSubmission(parsed.data, planningEpisodeId, taskReference, command)) {
      return err({ kind: 'review_conflict', reviewId: command.reviewId });
    }
    const applied = this.ledger
      .listEvents(aggregateIdFor(planningEpisodeId))
      .find(
        (event) =>
          event.eventType === 'PlanReviewApplied' &&
          typeof event.payload === 'object' &&
          event.payload !== null &&
          !Array.isArray(event.payload) &&
          event.payload.reviewId === command.reviewId,
      );
    const appliedAt =
      applied !== undefined &&
      typeof applied.payload === 'object' &&
      applied.payload !== null &&
      !Array.isArray(applied.payload) &&
      typeof applied.payload.appliedAt === 'string'
        ? applied.payload.appliedAt
        : null;
    return ok(
      PlanReviewRoundSchema.parse({
        ...parsed.data,
        status: appliedAt === null ? 'submitted' : 'applied',
        appliedAt,
      }),
    );
  }
}
