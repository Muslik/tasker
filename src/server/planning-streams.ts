import { z } from 'zod';

import { PlanningStrategySchema } from '../planning/implementation-plan.js';
import type { EventRecord } from '../store/types.js';
import {
  OperatorActivityEntrySchema,
  OperatorStreamEventSchema,
  type OperatorActivityResponse,
  type OperatorStreamEvent,
} from './operator-contracts.js';

const PlanningActivityEventPayloadSchema = z.looseObject({
  attempt: z.number().int().positive(),
  episodeId: z.string().min(1),
  selectedStrategy: PlanningStrategySchema,
});

type PlanningActivityStatus =
  'running' | 'ready' | 'needs_clarification' | 'investigation_required' | 'paused';

interface PlanningActivityEpisode {
  readonly attempts: Set<number>;
  strategy: z.infer<typeof PlanningStrategySchema>;
  status: PlanningActivityStatus;
  sequence: number;
  occurredAt: string;
}

const planningActivityDetail = (episode: PlanningActivityEpisode): string => {
  const status =
    episode.status === 'running'
      ? 'Running'
      : episode.status === 'ready'
        ? 'Ready'
        : episode.status === 'needs_clarification'
          ? 'Waiting for clarification'
          : episode.status === 'investigation_required'
            ? 'Investigation required'
            : 'Paused after provider failure';
  const attempts = episode.attempts.size;
  return `${status} · ${episode.strategy} · ${String(attempts)} provider ${attempts === 1 ? 'attempt' : 'attempts'}.`;
};

export const readImplementationPlanningActivity = (
  planningEvents: readonly EventRecord[],
): OperatorActivityResponse['entries'] => {
  const entries: Array<OperatorActivityResponse['entries'][number]> = [];
  const episodes = new Map<string, PlanningActivityEpisode>();

  const recordEpisode = (event: EventRecord, status: PlanningActivityStatus): void => {
    const payload = PlanningActivityEventPayloadSchema.safeParse(event.payload);
    if (!payload.success) {
      throw new Error(`Invalid implementation planning event payload: ${event.eventType}`);
    }
    const { episodeId, selectedStrategy } = payload.data;
    const existing = episodes.get(episodeId);
    if (existing === undefined) {
      episodes.set(episodeId, {
        attempts: new Set([payload.data.attempt]),
        strategy: selectedStrategy,
        status,
        sequence: event.sequence,
        occurredAt: event.occurredAt,
      });
    } else {
      existing.attempts.add(payload.data.attempt);
      existing.strategy = selectedStrategy;
      existing.status = status;
      existing.sequence = event.sequence;
      existing.occurredAt = event.occurredAt;
    }
  };

  for (const event of planningEvents) {
    switch (event.eventType) {
      case 'ImplementationPlanningStarted':
        recordEpisode(event, 'running');
        continue;
      case 'ImplementationPlanReady':
        recordEpisode(event, 'ready');
        continue;
      case 'ImplementationPlanNeedsClarification':
        recordEpisode(event, 'needs_clarification');
        continue;
      case 'ImplementationPlanInvestigationRequired':
        recordEpisode(event, 'investigation_required');
        continue;
      case 'ImplementationPlanningFailed':
        recordEpisode(event, 'paused');
        continue;
      case 'ImplementationWorkflowCandidateValidated':
        continue;
    }

    const common = {
      sequence: event.sequence,
      occurredAt: event.occurredAt,
      source: 'planner' as const,
      level: 'info' as const,
    };
    switch (event.eventType) {
      case 'PlanningEvidenceRequested':
        entries.push(
          OperatorActivityEntrySchema.parse({
            ...common,
            title: 'Planner requested additional evidence',
            detail:
              'The request and provider cost receipt were persisted before the external read.',
          }),
        );
        break;
      case 'PlanningEvidenceAppended':
        entries.push(
          OperatorActivityEntrySchema.parse({
            ...common,
            title: 'Planning evidence appended',
            detail:
              'Tasker recorded the mediated result with provenance and resumed the same plan.',
          }),
        );
        break;
      case 'PlanningClarificationAnswered':
        entries.push(
          OperatorActivityEntrySchema.parse({
            ...common,
            source: 'operator',
            title: 'Planning clarification answered',
            detail: 'The typed answers were persisted and the same planning episode resumed.',
          }),
        );
        break;
      case 'ImplementationWorkflowCandidateRejected': {
        const corrected = planningEvents.some(
          (candidate) =>
            candidate.sequence > event.sequence &&
            candidate.eventType === 'ImplementationWorkflowCandidateValidated',
        );
        entries.push(
          OperatorActivityEntrySchema.parse({
            ...common,
            level: corrected ? 'info' : 'warning',
            title: corrected ? 'Workflow candidate corrected' : 'Workflow candidate rejected',
            detail: corrected
              ? 'The validator returned exact feedback, and the same planner produced a valid candidate.'
              : 'The deterministic validator returned exact feedback to the same planner.',
          }),
        );
        break;
      }
      default:
        throw new Error(`Unmapped implementation planning event: ${event.eventType}`);
    }
  }

  for (const episode of episodes.values()) {
    entries.push(
      OperatorActivityEntrySchema.parse({
        sequence: episode.sequence,
        occurredAt: episode.occurredAt,
        source: 'planner',
        level:
          episode.status === 'paused' ||
          episode.status === 'needs_clarification' ||
          episode.status === 'investigation_required'
            ? 'warning'
            : 'info',
        title: 'Implementation planning',
        detail: planningActivityDetail(episode),
      }),
    );
  }

  return entries.sort((left, right) => left.sequence - right.sequence);
};

export const listImplementationPlanningStreamEventsAfter = (
  planningEvents: readonly EventRecord[],
  sequence: number,
): readonly OperatorStreamEvent[] =>
  planningEvents
    .filter((event) => event.sequence > sequence)
    .flatMap((event) => {
      const payload = z.looseObject({ taskReference: z.string().min(1) }).safeParse(event.payload);
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
