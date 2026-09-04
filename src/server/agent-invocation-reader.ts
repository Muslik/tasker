import type { ArtifactRecord, AgentInvocationRecord } from '../store/types.js';
import type { LedgerRepository } from '../store/repository.js';
import { AgentInvocationArtifactSchema } from '../steps/agent-invocation.js';
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
} from './operator-contracts.js';

type InvocationArtifact = ReturnType<typeof AgentInvocationArtifactSchema.parse>;

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

const parseInvocationArtifact = (artifact: ArtifactRecord | null): InvocationArtifact | null => {
  if (artifact?.artifactKind !== 'agent_invocation') return null;
  const parsed = AgentInvocationArtifactSchema.safeParse(artifact.payload);
  return parsed.success ? parsed.data : null;
};

const artifactFor = (
  ledger: LedgerRepository,
  row: Pick<AgentInvocationRecord, 'invocationId' | 'payloadArtifactId'>,
): InvocationArtifact | null =>
  parseInvocationArtifact(ledger.readArtifact(row.payloadArtifactId ?? row.invocationId));

const summaryFromRow = (row: AgentInvocationRecord): CurrentAgentInvocationSummary => ({
  invocationId: row.invocationId,
  blockRun: row.blockRun,
  startedAt: row.startedAt,
  finishedAt: row.finishedAt,
});

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

export class LedgerAgentInvocationReader implements AgentInvocationReader {
  public constructor(private readonly ledger: LedgerRepository) {}

  public list(taskReference: string): OperatorTaskInvocationListResponse {
    const invocations = this.ledger.listAgentInvocations(taskReference).flatMap((row) => {
      const artifact = artifactFor(this.ledger, row);
      return artifact === null ? [] : [invocationRowFrom(artifact)];
    });
    return OperatorTaskInvocationListResponseSchema.parse({
      schemaVersion: 1,
      taskReference,
      invocations,
      totals: OperatorTaskInvocationTotalsSchema.parse(
        this.ledger.readAgentInvocationTotals(taskReference),
      ),
    });
  }

  public read(taskReference: string, invocationId: string): OperatorTaskInvocationDetail | null {
    const row = this.ledger.readAgentInvocation(invocationId);
    if (row === null || row.taskReference !== taskReference) return null;
    const artifact = artifactFor(this.ledger, row);
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
    return this.ledger.listStreamEventsAfter(sequence).flatMap((row) =>
      row.eventType === 'AgentInvocationStarted' || row.eventType === 'AgentInvocationFinished'
        ? [
            OperatorStreamEventSchema.parse({
              sequence: row.seq,
              taskReference: row.taskReference,
              eventType: row.eventType,
            }),
          ]
        : [],
    );
  }

  public readLatestExecutionInvocation(input: {
    readonly taskReference: string;
    readonly workflowId: string;
    readonly runId: string;
    readonly nodeId: string;
    readonly blockRun: number;
  }): CurrentAgentInvocationSummary | null {
    if (input.blockRun < 1) return null;
    for (const row of this.ledger.listAgentInvocations(input.taskReference)) {
      if (
        row.nodeId !== input.nodeId ||
        row.blockRun !== input.blockRun ||
        row.episodeId !== input.runId
      ) {
        continue;
      }
      const artifact = artifactFor(this.ledger, row);
      if (artifact === null) {
        const operationPrefix = `agent-invocation:${input.workflowId}:${input.runId}:${input.nodeId}:attempt-${String(input.blockRun)}:provider-attempt-`;
        if (row.invocationId.startsWith(operationPrefix)) return summaryFromRow(row);
        continue;
      }
      if (matchesExecution(artifact, input)) return summaryFromArtifact(artifact);
    }
    return null;
  }

  public readLatestPlanningInvocation(input: {
    readonly taskReference: string;
    readonly planningEpisodeId: string;
    readonly planningAttempt: number;
  }): CurrentAgentInvocationSummary | null {
    for (const row of this.ledger.listAgentInvocations(input.taskReference)) {
      if (
        row.nodeId !== null ||
        row.episodeId !== input.planningEpisodeId ||
        row.blockRun !== input.planningAttempt
      ) {
        continue;
      }
      const artifact = artifactFor(this.ledger, row);
      if (artifact === null) return summaryFromRow(row);
      if (matchesPlanning(artifact, input)) return summaryFromArtifact(artifact);
    }
    return null;
  }
}
