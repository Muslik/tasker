import type {
  JsonValue as LedgerJsonValue,
  LedgerCommitResult,
  LedgerConflict,
  LedgerRepository,
} from '../ledger/index.js';
import {
  redactSourceValue,
  type SourceRedactionConfig,
  type SourceRedactionSummary,
} from '../observability/index.js';

export interface SafeEventCommitRequest {
  readonly aggregateId: string;
  readonly expectedVersion: number;
  readonly eventId: string;
  readonly eventType: string;
  readonly eventSchemaVersion: number;
  readonly source: unknown;
  readonly redaction: SourceRedactionConfig;
  readonly occurredAt?: string;
  readonly correlationId?: string;
  readonly causationId?: string;
  readonly actor?: string;
}

export type SafeEventCommitResult =
  | {
      readonly status: 'blocked';
      readonly redaction: Extract<SourceRedactionSummary, { status: 'blocked' }>;
    }
  | {
      readonly status: 'conflict';
      readonly conflict: LedgerConflict;
      readonly redaction: Exclude<SourceRedactionSummary, { status: 'blocked' }>;
    }
  | {
      readonly status: 'committed';
      readonly commit: LedgerCommitResult;
      readonly redaction: Exclude<SourceRedactionSummary, { status: 'blocked' }>;
    };

const makeSafeMetadata = (summary: SourceRedactionSummary): LedgerJsonValue => ({
  sourceRedaction: {
    status: summary.status,
    redactedCount: summary.redactedCount,
    blockedCount: summary.blockedCount,
    redactions: summary.redactions.map((entry) => ({
      path: entry.path,
      reason: entry.reason,
    })),
    blocked: summary.blocked.map((entry) => ({
      path: entry.path,
      reason: entry.reason,
      detail: entry.detail,
    })),
  },
});

export const commitSourceEvent = (
  repository: LedgerRepository,
  request: SafeEventCommitRequest,
): SafeEventCommitResult => {
  const redaction = redactSourceValue(request.source, request.redaction);

  if (redaction.status === 'blocked') {
    return {
      status: 'blocked',
      redaction: redaction.summary,
    };
  }

  const outcome = repository.transact({
    aggregate: {
      aggregateId: request.aggregateId,
      expectedVersion: request.expectedVersion,
      events: [
        {
          eventId: request.eventId,
          eventType: request.eventType,
          eventSchemaVersion: request.eventSchemaVersion,
          payload: redaction.value,
          metadata: makeSafeMetadata(redaction.summary),
          ...(request.occurredAt === undefined ? {} : { occurredAt: request.occurredAt }),
          ...(request.correlationId === undefined ? {} : { correlationId: request.correlationId }),
          ...(request.causationId === undefined ? {} : { causationId: request.causationId }),
          ...(request.actor === undefined ? {} : { actor: request.actor }),
        },
      ],
    },
  });

  if (!outcome.ok) {
    return {
      status: 'conflict',
      conflict: outcome.error,
      redaction: redaction.summary,
    };
  }

  return {
    status: 'committed',
    commit: outcome.value,
    redaction: redaction.summary,
  };
};
