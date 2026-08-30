import { z } from 'zod';

import type { LedgerRepository } from '../store/repository.js';
import type { Clock } from '../shared/clock.js';
import { err, ok, type Outcome } from '../shared/outcome.js';
import { JsonValueSchema } from '../graph/schema.js';
import { AgentApiCostSchema } from './agent-usage.js';

export const AgentInvocationTokenUsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative().nullable(),
    cachedInputTokens: z.number().int().nonnegative().nullable(),
    outputTokens: z.number().int().nonnegative().nullable(),
    reasoningOutputTokens: z.number().int().nonnegative().nullable(),
  })
  .strict()
  .readonly();

export const AgentInvocationExitStatusSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('exited'), exitCode: z.number().int() }).strict(),
  z.object({ kind: z.literal('timed_out') }).strict(),
  z.object({ kind: z.literal('spawn_failed'), message: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('thrown'), message: z.string().min(1) }).strict(),
]);

const AgentInvocationReferenceBaseSchema = z.object({
  transcriptId: z.string().min(1),
  outputArtifactIds: z.array(z.string().min(1)),
  receiptArtifactId: z.string().min(1).nullable(),
});

export const AgentInvocationReferencesSchema = z.discriminatedUnion('kind', [
  AgentInvocationReferenceBaseSchema.extend({
    kind: z.literal('execution'),
    workflowId: z.string().min(1),
    runId: z.string().min(1),
    nodeId: z.string().min(1),
    blockRun: z.number().int().positive(),
    providerAttempt: z.number().int().positive(),
  }).strict(),
  AgentInvocationReferenceBaseSchema.extend({
    kind: z.literal('planning'),
    planningEpisodeId: z.string().min(1),
    planningAttempt: z.number().int().positive(),
    invocationNumber: z.number().int().positive(),
    operationId: z.string().min(1),
  }).strict(),
]);

export const AgentInvocationArtifactSchema = z
  .object({
    schemaVersion: z.literal(1),
    invocationId: z.string().min(1),
    taskReference: z.string().min(1),
    prompt: z.string(),
    promptBytes: z.number().int().nonnegative(),
    provider: z.enum(['codex', 'claude']),
    profile: z.string().min(1),
    profileSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    model: z.string().min(1),
    effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']),
    serviceTier: z.enum(['fast', 'flex']).nullable(),
    argv: z.array(z.string()).min(1),
    skills: z.array(z.string().min(1)),
    inputEvidenceArtifactIds: z.array(z.string().min(1)),
    startedAt: z.iso.datetime(),
    finishedAt: z.iso.datetime(),
    durationMs: z.number().nonnegative(),
    status: z.enum(['completed', 'waiting', 'failed']),
    exitStatus: AgentInvocationExitStatusSchema,
    usage: AgentInvocationTokenUsageSchema,
    cost: AgentApiCostSchema,
    references: AgentInvocationReferencesSchema,
  })
  .strict()
  .readonly();

export type AgentInvocationArtifact = z.infer<typeof AgentInvocationArtifactSchema>;
export type AgentInvocationTokenUsage = z.infer<typeof AgentInvocationTokenUsageSchema>;
export type AgentInvocationReferences = z.infer<typeof AgentInvocationReferencesSchema>;

export type AgentInvocationRecorderError =
  | { readonly kind: 'ledger_conflict' }
  | { readonly kind: 'artifact_corrupt'; readonly invocationId: string };

export interface AgentInvocationRecorder {
  now(): string;
  start(input: {
    readonly invocationId: string;
    readonly taskReference: string;
    readonly references: AgentInvocationReferences;
    readonly startedAt: string;
  }): Outcome<void, AgentInvocationRecorderError>;
  finish(
    artifact: AgentInvocationArtifact,
  ): Outcome<AgentInvocationArtifact, AgentInvocationRecorderError>;
}

const asJson = (value: unknown) => JsonValueSchema.parse(value);

export const executionAgentInvocationId = (operationId: string, providerAttempt: number): string =>
  `agent-invocation:${operationId}:provider-attempt-${String(providerAttempt)}`;

export const planningAgentInvocationId = (
  planningEpisodeId: string,
  planningAttempt: number,
  invocationNumber: number,
): string =>
  `agent-invocation:${planningEpisodeId}:attempt-${String(planningAttempt)}:invocation-${String(invocationNumber)}`;

export class LedgerAgentInvocationRecorder implements AgentInvocationRecorder {
  public constructor(
    private readonly ledger: LedgerRepository,
    private readonly clock: Clock,
  ) {}

  public now(): string {
    return this.clock.now();
  }

  public start(input: {
    readonly invocationId: string;
    readonly taskReference: string;
    readonly references: AgentInvocationReferences;
    readonly startedAt: string;
  }): Outcome<void, AgentInvocationRecorderError> {
    const current = this.ledger.readAggregateHead(input.invocationId);
    if (current !== null) return ok(undefined);
    const result = this.ledger.transact({
      aggregate: {
        aggregateId: input.invocationId,
        expectedVersion: 0,
        events: [
          {
            eventId: `event:${input.invocationId}:started`,
            eventType: 'AgentInvocationStarted',
            eventSchemaVersion: 1,
            payload: asJson({
              invocationId: input.invocationId,
              taskReference: input.taskReference,
              scope: input.references.kind,
              status: 'running',
              references: input.references,
            }),
            actor: 'provider',
          },
        ],
      },
      timestamp: input.startedAt,
    });
    return result.ok || this.ledger.readAggregateHead(input.invocationId) !== null
      ? ok(undefined)
      : err({ kind: 'ledger_conflict' });
  }

  public finish(
    artifactInput: AgentInvocationArtifact,
  ): Outcome<AgentInvocationArtifact, AgentInvocationRecorderError> {
    const artifact = AgentInvocationArtifactSchema.parse(artifactInput);
    const existing = this.ledger.readArtifact(artifact.invocationId);
    if (existing !== null) {
      const parsed = AgentInvocationArtifactSchema.safeParse(existing.payload);
      return parsed.success
        ? ok(parsed.data)
        : err({ kind: 'artifact_corrupt', invocationId: artifact.invocationId });
    }
    const expectedVersion = this.ledger.readAggregateHead(artifact.invocationId)?.version ?? 0;
    const result = this.ledger.transact({
      aggregate: {
        aggregateId: artifact.invocationId,
        expectedVersion,
        events: [
          {
            eventId: `event:${artifact.invocationId}:finished`,
            eventType: 'AgentInvocationFinished',
            eventSchemaVersion: 1,
            payload: asJson({
              invocationId: artifact.invocationId,
              taskReference: artifact.taskReference,
              scope: artifact.references.kind,
              status: artifact.status,
              references: artifact.references,
            }),
            actor: 'provider',
          },
        ],
      },
      artifacts: [
        {
          artifactId: artifact.invocationId,
          artifactKind: 'agent_invocation',
          storageUri: `ledger://artifacts/${encodeURIComponent(artifact.invocationId)}`,
          payload: asJson(artifact),
          metadata: asJson({
            taskReference: artifact.taskReference,
            scope: artifact.references.kind,
            status: artifact.status,
          }),
          createdAt: artifact.finishedAt,
        },
      ],
      timestamp: artifact.finishedAt,
    });
    if (result.ok) return ok(artifact);
    const concurrent = this.ledger.readArtifact(artifact.invocationId);
    const parsed = AgentInvocationArtifactSchema.safeParse(concurrent?.payload);
    return parsed.success ? ok(parsed.data) : err({ kind: 'ledger_conflict' });
  }
}
