import type { ArtifactRecord, EventRecord } from '../store/types.js';
import type { LedgerRepository } from '../store/repository.js';
import { z } from 'zod';
import {
  AgentInvocationArtifactSchema,
  AgentInvocationReferencesSchema,
} from '../steps/agent-invocation.js';
import {
  OperatorStreamEventSchema,
  OperatorTaskInvocationDetailSchema,
  OperatorTaskInvocationListResponseSchema,
  OperatorTaskInvocationListRowSchema,
  OperatorTaskInvocationTotalsSchema,
  type OperatorStreamEvent,
  type OperatorTaskInvocationDetail,
  type OperatorTaskInvocationListResponse,
  type OperatorTaskInvocationListRow,
  type OperatorTaskInvocationTotals,
} from './operator-contracts.js';

type InvocationArtifact = ReturnType<typeof AgentInvocationArtifactSchema.parse>;

const InvocationEventPayloadSchema = z
  .object({
    invocationId: z.string().min(1),
    taskReference: z.string().min(1),
    scope: z.enum(['execution', 'planning']),
    status: z.enum(['running', 'completed', 'waiting', 'failed']),
    references: AgentInvocationReferencesSchema,
  })
  .strict();

export interface CurrentAgentInvocationSummary {
  readonly invocationId: string;
  readonly blockRun: number;
  readonly startedAt: string;
  readonly finishedAt: string | null;
}

export interface AgentInvocationReader {
  list(taskReference: string): OperatorTaskInvocationListResponse;
  read(taskReference: string, invocationId: string): OperatorTaskInvocationDetail | null;
  listStreamEventsAfter(sequence: number): readonly OperatorStreamEvent[];
  readLatestExecutionInvocation(input: {
    readonly taskReference: string;
    readonly workflowId: string;
    readonly runId: string;
    readonly nodeId: string;
    readonly blockRun: number;
  }): CurrentAgentInvocationSummary | null;
  readLatestPlanningInvocation(input: {
    readonly taskReference: string;
    readonly planningEpisodeId: string;
    readonly planningAttempt: number;
  }): CurrentAgentInvocationSummary | null;
}

const invocationRowFrom = (artifact: InvocationArtifact): OperatorTaskInvocationListRow =>
  OperatorTaskInvocationListRowSchema.parse({
    invocationId: artifact.invocationId,
    taskReference: artifact.taskReference,
    scope: artifact.references.kind,
    nodeId: artifact.references.kind === 'execution' ? artifact.references.nodeId : null,
    planningEpisodeId:
      artifact.references.kind === 'planning' ? artifact.references.planningEpisodeId : null,
    blockRun: artifact.references.kind === 'execution' ? artifact.references.blockRun : null,
    provider: artifact.provider,
    profile: artifact.profile,
    model: artifact.model,
    effort: artifact.effort,
    serviceTier: artifact.serviceTier,
    promptBytes: artifact.promptBytes,
    durationMs: artifact.durationMs,
    status: artifact.status,
    startedAt: artifact.startedAt,
    finishedAt: artifact.finishedAt,
    usage: artifact.usage,
    cost: artifact.cost,
  });

const totalTokensFor = (artifact: InvocationArtifact): number =>
  (artifact.usage.inputTokens ?? 0) + (artifact.usage.outputTokens ?? 0);

const emptyTotals = (): OperatorTaskInvocationTotals =>
  OperatorTaskInvocationTotalsSchema.parse({
    invocationCount: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    unratedCount: 0,
  });

const mergeTotals = (
  totals: OperatorTaskInvocationTotals,
  artifact: InvocationArtifact,
): OperatorTaskInvocationTotals =>
  OperatorTaskInvocationTotalsSchema.parse({
    invocationCount: totals.invocationCount + 1,
    inputTokens: totals.inputTokens + (artifact.usage.inputTokens ?? 0),
    cachedInputTokens: totals.cachedInputTokens + (artifact.usage.cachedInputTokens ?? 0),
    outputTokens: totals.outputTokens + (artifact.usage.outputTokens ?? 0),
    reasoningOutputTokens:
      totals.reasoningOutputTokens + (artifact.usage.reasoningOutputTokens ?? 0),
    totalTokens: totals.totalTokens + totalTokensFor(artifact),
    costUsd: totals.costUsd + (artifact.cost.source === 'unrated' ? 0 : artifact.cost.amountUsd),
    unratedCount: totals.unratedCount + (artifact.cost.source === 'unrated' ? 1 : 0),
  });

const parseInvocationArtifact = (artifact: ArtifactRecord | null): InvocationArtifact | null => {
  if (artifact?.artifactKind !== 'agent_invocation') return null;
  const parsed = AgentInvocationArtifactSchema.safeParse(artifact.payload);
  return parsed.success ? parsed.data : null;
};

const startSummaryFrom = (event: EventRecord): CurrentAgentInvocationSummary | null => {
  const parsed = InvocationEventPayloadSchema.safeParse(event.payload);
  if (!parsed.success) return null;
  const references = parsed.data.references;
  return {
    invocationId: parsed.data.invocationId,
    blockRun: references.kind === 'execution' ? references.blockRun : references.planningAttempt,
    startedAt: event.occurredAt,
    finishedAt: null,
  };
};

const summaryFromArtifact = (artifact: InvocationArtifact): CurrentAgentInvocationSummary => ({
  invocationId: artifact.invocationId,
  blockRun:
    artifact.references.kind === 'execution'
      ? artifact.references.blockRun
      : artifact.references.planningAttempt,
  startedAt: artifact.startedAt,
  finishedAt: artifact.finishedAt,
});

const matchesExecution = (
  artifact: InvocationArtifact,
  input: {
    readonly taskReference: string;
    readonly workflowId: string;
    readonly runId: string;
    readonly nodeId: string;
    readonly blockRun: number;
  },
): boolean =>
  artifact.taskReference === input.taskReference &&
  artifact.references.kind === 'execution' &&
  artifact.references.workflowId === input.workflowId &&
  artifact.references.runId === input.runId &&
  artifact.references.nodeId === input.nodeId &&
  artifact.references.blockRun === input.blockRun;

const matchesExecutionStart = (
  event: EventRecord,
  input: {
    readonly taskReference: string;
    readonly workflowId: string;
    readonly runId: string;
    readonly nodeId: string;
    readonly blockRun: number;
  },
): boolean => {
  const parsed = InvocationEventPayloadSchema.safeParse(event.payload);
  return (
    parsed.success &&
    parsed.data.taskReference === input.taskReference &&
    parsed.data.references.kind === 'execution' &&
    parsed.data.references.workflowId === input.workflowId &&
    parsed.data.references.runId === input.runId &&
    parsed.data.references.nodeId === input.nodeId &&
    parsed.data.references.blockRun === input.blockRun
  );
};

const matchesPlanning = (
  artifact: InvocationArtifact,
  input: {
    readonly taskReference: string;
    readonly planningEpisodeId: string;
    readonly planningAttempt: number;
  },
): boolean =>
  artifact.taskReference === input.taskReference &&
  artifact.references.kind === 'planning' &&
  artifact.references.planningEpisodeId === input.planningEpisodeId &&
  artifact.references.planningAttempt === input.planningAttempt;

const matchesPlanningStart = (
  event: EventRecord,
  input: {
    readonly taskReference: string;
    readonly planningEpisodeId: string;
    readonly planningAttempt: number;
  },
): boolean => {
  const parsed = InvocationEventPayloadSchema.safeParse(event.payload);
  return (
    parsed.success &&
    parsed.data.taskReference === input.taskReference &&
    parsed.data.references.kind === 'planning' &&
    parsed.data.references.planningEpisodeId === input.planningEpisodeId &&
    parsed.data.references.planningAttempt === input.planningAttempt
  );
};

export class LedgerAgentInvocationReader implements AgentInvocationReader {
  public constructor(private readonly ledger: LedgerRepository) {}

  public list(taskReference: string): OperatorTaskInvocationListResponse {
    const invocations: OperatorTaskInvocationListRow[] = [];
    let totals = emptyTotals();
    for (const event of this.ledger.listEvents().toReversed()) {
      if (event.eventType !== 'AgentInvocationFinished') continue;
      const payload = InvocationEventPayloadSchema.safeParse(event.payload);
      if (!payload.success || payload.data.taskReference !== taskReference) continue;
      const artifact = parseInvocationArtifact(this.ledger.readArtifact(payload.data.invocationId));
      if (artifact === null) continue;
      invocations.push(invocationRowFrom(artifact));
      totals = mergeTotals(totals, artifact);
    }
    return OperatorTaskInvocationListResponseSchema.parse({
      schemaVersion: 1,
      taskReference,
      invocations,
      totals,
    });
  }

  public read(taskReference: string, invocationId: string): OperatorTaskInvocationDetail | null {
    const artifact = parseInvocationArtifact(this.ledger.readArtifact(invocationId));
    if (artifact === null || artifact.taskReference !== taskReference) return null;
    return OperatorTaskInvocationDetailSchema.parse({
      schemaVersion: 1,
      invocationId: artifact.invocationId,
      taskReference: artifact.taskReference,
      prompt: artifact.prompt,
      promptBytes: artifact.promptBytes,
      provider: artifact.provider,
      profile: artifact.profile,
      profileSha256: artifact.profileSha256,
      model: artifact.model,
      effort: artifact.effort,
      serviceTier: artifact.serviceTier,
      argv: artifact.argv,
      skills: artifact.skills,
      inputEvidenceArtifactIds: artifact.inputEvidenceArtifactIds,
      startedAt: artifact.startedAt,
      finishedAt: artifact.finishedAt,
      durationMs: artifact.durationMs,
      status: artifact.status,
      exitStatus: artifact.exitStatus,
      usage: artifact.usage,
      cost: artifact.cost,
      references: artifact.references,
    });
  }

  public listStreamEventsAfter(sequence: number): readonly OperatorStreamEvent[] {
    return this.ledger
      .listEvents()
      .filter(
        (event) =>
          event.sequence > sequence &&
          (event.eventType === 'AgentInvocationStarted' ||
            event.eventType === 'AgentInvocationFinished'),
      )
      .flatMap((event) => {
        const payload = InvocationEventPayloadSchema.safeParse(event.payload);
        return payload.success
          ? [
              OperatorStreamEventSchema.parse({
                sequence: event.sequence,
                taskReference: payload.data.taskReference,
                eventType: event.eventType,
              }),
            ]
          : [];
      });
  }

  public readLatestExecutionInvocation(input: {
    readonly taskReference: string;
    readonly workflowId: string;
    readonly runId: string;
    readonly nodeId: string;
    readonly blockRun: number;
  }): CurrentAgentInvocationSummary | null {
    if (input.blockRun < 1) return null;
    for (const event of this.ledger.listEvents().toReversed()) {
      if (event.eventType === 'AgentInvocationFinished') {
        const payload = InvocationEventPayloadSchema.safeParse(event.payload);
        if (!payload.success) continue;
        const artifact = parseInvocationArtifact(
          this.ledger.readArtifact(payload.data.invocationId),
        );
        if (artifact !== null && matchesExecution(artifact, input)) {
          return summaryFromArtifact(artifact);
        }
        continue;
      }
      if (event.eventType === 'AgentInvocationStarted' && matchesExecutionStart(event, input)) {
        return startSummaryFrom(event);
      }
    }
    return null;
  }

  public readLatestPlanningInvocation(input: {
    readonly taskReference: string;
    readonly planningEpisodeId: string;
    readonly planningAttempt: number;
  }): CurrentAgentInvocationSummary | null {
    for (const event of this.ledger.listEvents().toReversed()) {
      if (event.eventType === 'AgentInvocationFinished') {
        const payload = InvocationEventPayloadSchema.safeParse(event.payload);
        if (!payload.success) continue;
        const artifact = parseInvocationArtifact(
          this.ledger.readArtifact(payload.data.invocationId),
        );
        if (artifact !== null && matchesPlanning(artifact, input)) {
          return summaryFromArtifact(artifact);
        }
        continue;
      }
      if (event.eventType === 'AgentInvocationStarted' && matchesPlanningStart(event, input)) {
        return startSummaryFrom(event);
      }
    }
    return null;
  }
}
