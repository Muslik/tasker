import { ApplicationFailure, Context } from '@temporalio/activity';

import type { ImplementationPlanningRecord } from '../../control-plane/implementation-planning-contracts.js';
import type {
  PlanningQuestionAnswer,
  PlanningSnapshotReference,
  PlanningStrategyRequest,
} from '../../planning/index.js';
import type { CommandRequest, WorkspaceCommandRunner } from '../../providers/command-runner.js';
import type { Outcome } from '../../shared/outcome.js';
import type { CompiledWorkflow } from '../../workflow/index.js';
import type { EvidenceBundleReference } from '../../planning/evidence-bundle.js';
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
    commandId: string,
    planningEpisodeId: string,
    snapshotReference: PlanningSnapshotReference,
    evidenceReference: EvidenceBundleReference,
    operatorGuidance?: string | null,
  ): Promise<PlanningOutcome>;
  answer(
    taskReference: string,
    answers: readonly PlanningQuestionAnswer[],
    commandId: string,
    planningEpisodeId: string,
    snapshotReference: PlanningSnapshotReference,
    evidenceReference: EvidenceBundleReference,
  ): Promise<PlanningOutcome>;
  draftFor(record: Extract<ImplementationPlanningRecord, { readonly status: 'ready' }>): Outcome<
    {
      readonly workflowHash: string;
      readonly graph: CompiledWorkflow;
      readonly planningSnapshot: PlanningSnapshotReference;
      readonly evidenceBundle: EvidenceBundleReference;
    },
    { readonly kind: string }
  >;
}

const outcomeError = (outcome: Extract<PlanningOutcome, { readonly ok: false }>): Error =>
  new Error(`Implementation planning stopped: ${outcome.error.kind}`);

const planningResult = (
  record: ImplementationPlanningRecord,
  commandId: string,
  coordinator: TemporalImplementationPlanningCoordinator,
) => {
  if (record.status === 'planning') {
    throw new Error('Implementation planning returned before the provider attempt completed');
  }
  if (record.status === 'failed') {
    if (record.failure.retryable) {
      throw ApplicationFailure.create({
        message: record.failure.message,
        type: `implementation_planning.${record.failure.kind}`,
      });
    }
    return BootstrapPlanningStateSchema.parse({
      status: 'blocked',
      planningEpisodeId: record.planningEpisodeId,
      commandId,
      transcriptId: record.transcriptId,
      attempt: record.attempt,
      evidenceBundle: record.evidenceBundle,
      requestedStrategy: record.requestedStrategy,
      selectedStrategy: record.selectedStrategy,
      failure: record.failure,
      validationFeedback: record.validationFeedback,
      validationRevision: record.validationRevision,
    });
  }
  if (record.transcriptId === null) {
    throw new Error('Temporal planning result has no transcript reference');
  }

  const common = {
    status: record.status,
    planningEpisodeId: record.planningEpisodeId,
    commandId,
    transcriptId: record.transcriptId,
    attempt: record.attempt,
    artifactId: record.artifactId,
    evidenceBundle: record.evidenceBundle,
    requestedStrategy: record.requestedStrategy,
    selectedStrategy: record.selectedStrategy,
  } as const;

  switch (record.status) {
    case 'ready': {
      const draft = coordinator.draftFor(record);
      if (!draft.ok) throw new Error(`Validated workflow is unavailable: ${draft.error.kind}`);
      return BootstrapPlanningStateSchema.parse({
        ...common,
        workflowOperationId: record.workflowOperationId,
        draft: draft.value,
      });
    }
    case 'needs_clarification':
      return BootstrapPlanningStateSchema.parse({
        ...common,
        questions: record.decision.questions,
      });
    case 'investigation_required':
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
            input.commandId,
            input.planningEpisodeId,
            input.planningSnapshot,
            input.evidenceBundle,
            null,
          );
        case 'clarification':
          return coordinator.answer(
            input.taskReference,
            input.command.answers,
            input.commandId,
            input.planningEpisodeId,
            input.planningSnapshot,
            input.evidenceBundle,
          );
        case 'investigation_completed':
          return coordinator.prepare(
            input.taskReference,
            input.requestedStrategy,
            input.commandId,
            input.planningEpisodeId,
            input.planningSnapshot,
            input.evidenceBundle,
            'The requested pre-plan investigation completed. Use the appended evidence and produce the plan and execution workflow.',
          );
        case 'revision':
          return coordinator.prepare(
            input.taskReference,
            input.requestedStrategy,
            input.commandId,
            input.planningEpisodeId,
            input.planningSnapshot,
            input.evidenceBundle,
            input.command.guidance,
          );
      }
    })();

    context.cancellationSignal.throwIfAborted();
    if (!outcome.ok) throw outcomeError(outcome);
    return planningResult(outcome.value, input.commandId, coordinator);
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
