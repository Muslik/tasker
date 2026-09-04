import { z } from 'zod';

import type { LedgerRepository } from '../store/repository.js';
import type { Clock } from '../shared/clock.js';
import { err, ok, type Outcome } from '../shared/outcome.js';
import {
  ResearchDocumentReviewAnnotationSchema,
  type ResearchDocumentReviewAnnotation,
} from '../shared/research-document-review.js';
import { combinePlannerGuidance } from './research-document-review.js';

export const PlanReviewAnnotationSchema = ResearchDocumentReviewAnnotationSchema;

const combinedReviewFeedback = (command: {
  readonly guidance: string | undefined;
  readonly annotations: readonly ResearchDocumentReviewAnnotation[];
}): string =>
  combinePlannerGuidance({
    annotations: [...command.annotations],
    ...(command.guidance === undefined ? {} : { guidance: command.guidance }),
  });

const PlanReviewContextSchema = z
  .object({
    expectedRunId: z.string().min(1),
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
  guidance: z.string().trim().min(1).max(10_000).optional(),
  annotations: z.array(PlanReviewAnnotationSchema).max(50),
})
  .strict()
  .refine(
    (command) => command.guidance !== undefined || command.annotations.length > 0,
    'Plan review requires guidance or at least one annotation',
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

export type PlanReviewAnnotation = ResearchDocumentReviewAnnotation;
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

const DOCUMENT_KIND = 'plan_review';

const documentIdFor = (planningEpisodeId: string, reviewId: string): string =>
  `${planningEpisodeId}:${reviewId}`;

const commandPayload = (command: PlanReviewCommand) => ({
  reviewId: command.reviewId,
  planArtifactId: command.planArtifactId,
  planAttempt: command.planAttempt,
  decision: command.decision,
  guidance: command.decision === 'request_changes' ? (command.guidance ?? null) : null,
  annotations: command.decision === 'request_changes' ? command.annotations : [],
});

const sameSubmission = (
  submission: z.infer<typeof PlanReviewRoundSchema>,
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
    : ({
        decision: 'request_changes',
        guidance: combinedReviewFeedback({
          guidance: command.guidance,
          annotations: command.annotations,
        }),
      } as const);
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
    const documentId = documentIdFor(planningEpisodeId, command.reviewId);
    const existing = this.ledger.readDocument(DOCUMENT_KIND, documentId);
    if (existing !== null) {
      return this.restoreSubmission(planningEpisodeId, taskReference, command, existing.payload);
    }

    const submittedAt = this.clock.now();
    const submission = PlanReviewRoundSchema.parse({
      schemaVersion: 2,
      planningEpisodeId,
      taskReference,
      ...commandPayload(command),
      submittedAt,
      status: 'submitted',
      appliedAt: null,
    });
    const committed = this.ledger.appendDocument(
      DOCUMENT_KIND,
      documentId,
      0,
      submission,
      submittedAt,
    );
    if (committed.ok) return ok(submission);

    const concurrent = this.ledger.readDocument(DOCUMENT_KIND, documentId);
    return concurrent === null
      ? err({ kind: 'ledger_conflict' })
      : this.restoreSubmission(planningEpisodeId, taskReference, command, concurrent.payload);
  }

  public markApplied(
    planningEpisodeId: string,
    reviewId: string,
  ): Outcome<void, PlanReviewStoreError> {
    const documentId = documentIdFor(planningEpisodeId, reviewId);
    const existing = this.ledger.readDocument(DOCUMENT_KIND, documentId);
    if (existing === null) return ok(undefined);
    const current = PlanReviewRoundSchema.safeParse(existing.payload);
    if (!current.success) {
      return err({
        kind: 'review_corrupt',
        reviewId,
        issues: current.error.issues.map((issue) => issue.message),
      });
    }
    if (current.data.status === 'applied') return ok(undefined);

    const appliedAt = this.clock.now();
    const committed = this.ledger.appendDocument(
      DOCUMENT_KIND,
      documentId,
      existing.revision,
      PlanReviewRoundSchema.parse({
        ...current.data,
        status: 'applied',
        appliedAt,
      }),
      appliedAt,
    );
    if (committed.ok) return ok(undefined);

    const concurrent = this.ledger.readDocument(DOCUMENT_KIND, documentId);
    if (concurrent === null) return err({ kind: 'ledger_conflict' });
    const parsed = PlanReviewRoundSchema.safeParse(concurrent.payload);
    if (!parsed.success) {
      return err({
        kind: 'review_corrupt',
        reviewId,
        issues: parsed.error.issues.map((issue) => issue.message),
      });
    }
    return parsed.data.status === 'applied' ? ok(undefined) : err({ kind: 'ledger_conflict' });
  }

  public read(
    planningEpisodeId: string,
  ): Outcome<readonly PlanReviewRound[], PlanReviewStoreError> {
    const rounds: PlanReviewRound[] = [];
    for (const document of this.ledger.listDocuments(DOCUMENT_KIND)) {
      const round = PlanReviewRoundSchema.safeParse(document.payload);
      if (!round.success) {
        return err({
          kind: 'review_corrupt',
          reviewId: document.id,
          issues: round.error.issues.map((issue) => issue.message),
        });
      }
      if (round.data.planningEpisodeId === planningEpisodeId) rounds.push(round.data);
    }
    return ok(
      rounds.sort(
        (left, right) =>
          left.submittedAt.localeCompare(right.submittedAt) ||
          left.reviewId.localeCompare(right.reviewId),
      ),
    );
  }

  private restoreSubmission(
    planningEpisodeId: string,
    taskReference: string,
    command: PlanReviewCommand,
    payload: unknown,
  ): Outcome<PlanReviewRound, PlanReviewStoreError> {
    const parsed = PlanReviewRoundSchema.safeParse(payload);
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
    return ok(parsed.data);
  }
}
