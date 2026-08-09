import { Context } from '@temporalio/activity';

import type { ImplementationPlanningRecord } from '../../control-plane/implementation-planning-contracts.js';
import type {
  PlanningQuestionAnswer,
  PlanningSnapshotReference,
  PlanningStrategyRequest,
} from '../../planning/index.js';
import type { CommandRequest, WorkspaceCommandRunner } from '../../providers/command-runner.js';
import type { Outcome } from '../../shared/outcome.js';
import {
  PlanTaskImplementationInputSchema,
  BootstrapPlanningStateSchema,
  type PlanTaskImplementationInput,
  type BootstrapWorkflowActivities,
} from '../bootstrap-kernel/contracts.js';

type PlanningOutcome = Outcome<ImplementationPlanningRecord, { readonly kind: string }>;

export interface PlanningTranscriptSink {
  append(
    operationId: string,
    providerAttempt: number,
    stream: 'stdout' | 'stderr',
    content: string,
  ): Outcome<unknown, { readonly kind: string }>;
}

export interface TemporalImplementationPlanningCoordinator {
  prepare(
    taskReference: string,
    requestedStrategy: PlanningStrategyRequest,
    operatorGuidance?: string | null,
    commandId?: string | null,
    expectedWorkflowHash?: string | null,
    snapshotReference?: PlanningSnapshotReference | null,
  ): Promise<PlanningOutcome>;
  answer(
    taskReference: string,
    answers: readonly PlanningQuestionAnswer[],
    commandId?: string | null,
    expectedWorkflowHash?: string | null,
    snapshotReference?: PlanningSnapshotReference | null,
  ): Promise<PlanningOutcome>;
}

const outcomeError = (outcome: Extract<PlanningOutcome, { readonly ok: false }>): Error =>
  new Error(`Implementation planning stopped: ${outcome.error.kind}`);

const planningResult = (record: ImplementationPlanningRecord, commandId: string) => {
  if (record.status === 'planning') {
    throw new Error('Implementation planning returned before the provider attempt completed');
  }
  if (record.status === 'failed') {
    throw new Error(record.failure.message);
  }
  if (record.transcriptId === null) {
    throw new Error('Temporal planning result has no transcript reference');
  }

  const common = {
    status: record.status,
    commandId,
    transcriptId: record.transcriptId,
    attempt: record.attempt,
    artifactId: record.artifactId,
    evidenceBundle: record.evidenceBundle,
    requestedStrategy: record.requestedStrategy,
    selectedStrategy: record.selectedStrategy,
    receipt: record.receipt,
  } as const;

  switch (record.status) {
    case 'ready':
      return BootstrapPlanningStateSchema.parse(common);
    case 'needs_clarification':
      return BootstrapPlanningStateSchema.parse({
        ...common,
        questions: record.decision.questions,
      });
    case 'workflow_change_required':
      return BootstrapPlanningStateSchema.parse({
        ...common,
        request: record.decision.request,
      });
  }
};

export const createPlanningActivity = (
  coordinator: TemporalImplementationPlanningCoordinator,
): Pick<BootstrapWorkflowActivities, 'planTaskImplementation'> => ({
  planTaskImplementation: async (inputValue: PlanTaskImplementationInput) => {
    const input = PlanTaskImplementationInputSchema.parse(inputValue);
    const context = Context.current();
    context.heartbeat({ phase: 'planning', commandId: input.commandId });

    const outcome = await (() => {
      switch (input.command.kind) {
        case 'initial':
          return coordinator.prepare(
            input.taskReference,
            input.requestedStrategy,
            null,
            input.commandId,
            input.workflowHash,
            input.planningSnapshot,
          );
        case 'clarification':
          return coordinator.answer(
            input.taskReference,
            input.command.answers,
            input.commandId,
            input.workflowHash,
            input.planningSnapshot,
          );
        case 'revision':
          return coordinator.prepare(
            input.taskReference,
            input.requestedStrategy,
            input.command.guidance,
            input.commandId,
            input.workflowHash,
            input.planningSnapshot,
          );
      }
    })();

    context.cancellationSignal.throwIfAborted();
    if (!outcome.ok) throw outcomeError(outcome);
    return planningResult(outcome.value, input.commandId);
  },
});

export const createTemporalActivityCommandRunner = (
  delegate: WorkspaceCommandRunner,
  transcripts?: PlanningTranscriptSink,
): WorkspaceCommandRunner => ({
  executionEnvironment: 'docker_workspace',
  run: async (request: CommandRequest) => {
    const context = Context.current();
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const reportProgress = (): void => {
      context.heartbeat({ phase: 'provider', stdoutBytes, stderrBytes });
    };
    const heartbeatTimer = setInterval(reportProgress, 10_000);
    heartbeatTimer.unref();

    try {
      reportProgress();
      const result = await delegate.run({
        ...request,
        cancellationSignal: context.cancellationSignal,
        onOutput: (stream, chunk) => {
          if (request.operationId !== undefined && transcripts !== undefined) {
            const persisted = transcripts.append(
              request.operationId,
              context.info.attempt,
              stream,
              chunk,
            );
            if (!persisted.ok) {
              throw new Error(`Planning transcript persistence failed: ${persisted.error.kind}`);
            }
          }
          if (stream === 'stdout') stdoutBytes += Buffer.byteLength(chunk, 'utf8');
          else stderrBytes += Buffer.byteLength(chunk, 'utf8');
          request.onOutput?.(stream, chunk);
          reportProgress();
        },
      });
      context.cancellationSignal.throwIfAborted();
      return result;
    } finally {
      clearInterval(heartbeatTimer);
    }
  },
});
