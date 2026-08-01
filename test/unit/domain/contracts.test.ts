import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';

import {
  commandEnvelopeSchema,
  eventEnvelopeSchema,
  intakeRequestSchema,
  manualTakeoverSchema,
  mutationEffectOutcomeSchema,
  operationalFailureSchema,
  providerAttemptSchema,
  reviewCycleSchema,
  runSchema,
  waitSchema,
} from '../../../src/domain/index.js';

const validTimestamp = '2026-08-01T12:00:00.000Z';

describe('domain contracts', () => {
  it('guards the generic command envelope and its supported schema version', () => {
    const command = commandEnvelopeSchema.parse({
      commandId: 'command-1',
      commandType: 'run.start@1',
      target: { kind: 'Run', id: 'run-1' },
      schemaVersion: 1,
      expectedAggregateVersion: 0,
      correlationId: 'correlation-1',
      actor: { kind: 'system', id: 'scheduler' },
      issuedAt: validTimestamp,
      payload: { workflowHash: 'abc123' },
    });

    expect(command.schemaVersion).toBe(1);
    expect(() => commandEnvelopeSchema.parse({ ...command, schemaVersion: 2 })).toThrow(ZodError);
  });

  it('accepts a valid event envelope with supported version metadata', () => {
    const envelope = eventEnvelopeSchema.parse({
      eventId: 'evt_1',
      eventType: 'run.created@1',
      aggregate: { kind: 'Run', id: 'run_1' },
      version: {
        schema: 1,
        aggregateVersion: 2,
        expectedAggregateVersion: 1,
      },
      correlationId: 'corr_1',
      causationId: 'cause_1',
      actor: { kind: 'system', id: 'scheduler' },
      occurredAt: validTimestamp,
      redaction: {
        status: 'redacted',
        policyRef: 'event.redaction@1',
        redactedFieldPaths: ['payload.secret'],
        diagnosticArtifactId: 'artifact_1',
      },
      artifactReferences: [
        {
          artifactId: 'artifact_2',
          role: 'debug_bundle',
          mediaType: 'application/json',
          redaction: {
            status: 'clean',
            policyRef: 'artifact.redaction@1',
          },
        },
      ],
      payload: {
        ok: true,
      },
    });

    expect(envelope.version.schema).toBe(1);
    expect(envelope.aggregate.kind).toBe('Run');
    expect(envelope.redaction.status).toBe('redacted');
  });

  it('rejects unsupported event schema versions', () => {
    expect(() =>
      eventEnvelopeSchema.parse({
        eventId: 'evt_1',
        eventType: 'run.created@1',
        aggregate: { kind: 'Run', id: 'run_1' },
        version: {
          schema: 2,
          aggregateVersion: 0,
        },
        correlationId: 'corr_1',
        actor: { kind: 'system', id: 'scheduler' },
        occurredAt: validTimestamp,
        redaction: {
          status: 'clean',
          policyRef: 'event.redaction@1',
        },
        artifactReferences: [],
        payload: null,
      }),
    ).toThrow(ZodError);
  });

  it('accepts intake requests that fail before any task or run exists', () => {
    const request = intakeRequestSchema.parse({
      id: 'intake_1',
      source: 'jira',
      externalRef: 'TASK-1',
      createdAt: validTimestamp,
      state: {
        status: 'waiting_for_intake_repair',
        repairAction: 'fix_credentials',
        failure: {
          kind: 'invalid_input',
          code: 'jira_400',
          safeMessage: 'Jira rejected the request payload',
          source: 'integration',
          occurredAt: validTimestamp,
          retryEvidence: { kind: 'none' },
          correlationId: 'corr_2',
          repairAction: 'fix_credentials',
        },
      },
    });

    expect(request.state.status).toBe('waiting_for_intake_repair');
  });

  it('rejects waiting runs that do not carry their wait reference', () => {
    expect(() =>
      runSchema.parse({
        id: 'run_1',
        taskId: 'task_1',
        createdAt: validTimestamp,
        fenceToken: 3,
        status: 'waiting',
      }),
    ).toThrow(ZodError);
  });

  it('classifies failure and effect outcome variants without invalid combinations', () => {
    const failure = operationalFailureSchema.parse({
      kind: 'quota_exhausted',
      code: 'quota_reset',
      safeMessage: 'Provider quota exhausted',
      source: 'provider',
      occurredAt: validTimestamp,
      retryEvidence: {
        kind: 'server_hint',
        retryAt: '2026-08-01T12:05:00.000Z',
      },
      correlationId: 'corr_3',
      resetAt: '2026-08-01T12:10:00.000Z',
    });

    const outcome = mutationEffectOutcomeSchema.parse({
      status: 'unknown_outcome',
      failure,
      probe: {
        probe: 'git.push_probe@1',
        correlationId: 'corr_3',
        target: 'refs/heads/main',
      },
    });

    expect(failure.kind).toBe('quota_exhausted');
    expect(outcome.status).toBe('unknown_outcome');
  });

  it('rejects unknown outcomes without a reconciliation probe', () => {
    const failure = operationalFailureSchema.parse({
      kind: 'unknown_outcome',
      code: 'push_connection_lost',
      safeMessage: 'Connection dropped after dispatch',
      source: 'provider',
      occurredAt: validTimestamp,
      retryEvidence: {
        kind: 'probe_required',
        detail: 'Inspect remote ref before retrying',
      },
      correlationId: 'corr_4',
      probe: {
        probe: 'git.push_probe@1',
        correlationId: 'corr_4',
        target: 'refs/heads/main',
      },
    });

    expect(() =>
      mutationEffectOutcomeSchema.parse({
        status: 'unknown_outcome',
        failure,
      }),
    ).toThrow(ZodError);
  });

  it('rejects open waits that already carry a resolution event', () => {
    expect(() =>
      waitSchema.parse({
        id: 'wait_1',
        runId: 'run_1',
        scope: 'provider',
        kind: 'quota_reset',
        resumeCursor: 'attempt:1',
        resolutionSchema: 'wait.resolve@1',
        slotPolicy: 'release',
        openedByEventId: 'evt_open',
        status: 'open',
        correlationId: 'corr_wait',
        resolvedByEventId: 'evt_resolved',
      }),
    ).toThrow(ZodError);
  });

  it('rejects resolved waits without the resolving event id', () => {
    expect(() =>
      waitSchema.parse({
        id: 'wait_1',
        runId: 'run_1',
        scope: 'provider',
        kind: 'quota_reset',
        resumeCursor: 'attempt:1',
        resolutionSchema: 'wait.resolve@1',
        slotPolicy: 'release',
        openedByEventId: 'evt_open',
        status: 'resolved',
        correlationId: 'corr_wait',
      }),
    ).toThrow(ZodError);
  });

  it('rejects wait slot policies outside the closed capacity contract', () => {
    expect(() =>
      waitSchema.parse({
        id: 'wait_1',
        runId: 'run_1',
        scope: 'provider',
        kind: 'quota_reset',
        resumeCursor: 'attempt:1',
        resolutionSchema: 'wait.resolve@1',
        slotPolicy: 'drop_database',
        openedByEventId: 'evt_open',
        status: 'open',
        correlationId: 'corr_wait',
      }),
    ).toThrow(ZodError);
  });

  it('rejects open review cycles that already have closedAt metadata', () => {
    expect(() =>
      reviewCycleSchema.parse({
        id: 'review_1',
        taskId: 'task_1',
        runId: 'run_1',
        status: 'open',
        openedAt: validTimestamp,
        closedAt: '2026-08-01T12:05:00.000Z',
      }),
    ).toThrow(ZodError);
  });

  it('rejects completed provider attempts without finishedAt evidence', () => {
    expect(() =>
      providerAttemptSchema.parse({
        id: 'provider_attempt_1',
        attemptId: 'attempt_1',
        provider: 'codex',
        startedAt: validTimestamp,
        status: 'completed',
      }),
    ).toThrow(ZodError);
  });

  it('rejects failed provider attempts without failure evidence', () => {
    expect(() =>
      providerAttemptSchema.parse({
        id: 'provider_attempt_1',
        attemptId: 'attempt_1',
        provider: 'codex',
        startedAt: validTimestamp,
        status: 'failed',
        finishedAt: '2026-08-01T12:05:00.000Z',
      }),
    ).toThrow(ZodError);
  });

  it('rejects requested manual takeovers that already contain release metadata', () => {
    expect(() =>
      manualTakeoverSchema.parse({
        id: 'manual_takeover_1',
        runId: 'run_1',
        requestedBy: { kind: 'operator', id: 'alice' },
        requestedAt: validTimestamp,
        cursor: 'step:repair',
        status: 'requested',
        releasedFenceToken: 9,
      }),
    ).toThrow(ZodError);
  });

  it('rejects released manual takeovers without reconciliation metadata', () => {
    expect(() =>
      manualTakeoverSchema.parse({
        id: 'manual_takeover_1',
        runId: 'run_1',
        requestedBy: { kind: 'operator', id: 'alice' },
        requestedAt: validTimestamp,
        cursor: 'step:repair',
        status: 'released',
        releasedAt: '2026-08-01T12:05:00.000Z',
        releasedFenceToken: 9,
      }),
    ).toThrow(ZodError);
  });
});
