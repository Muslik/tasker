import { z } from 'zod';

import { BlockReceiptSchema, blockReceiptId } from '../blocks/index.js';
import type { LedgerRepository } from '../ledger/repository.js';
import { TaskStepOutputArtifactSchema } from '../temporal/task-step-output.js';
import type { ExecutionWorkflowPublicState } from '../temporal/index.js';
import {
  executionOperationIdFor,
  TemporalTaskStepTraceStore,
} from '../temporal/activities/block-execution.js';
import { TaskStepEvidenceArtifactSchema } from '../temporal/task-step-evidence-contracts.js';
import { systemClock } from '../shared/clock.js';
import type { PlanningTranscriptView } from './planning-transcript.js';
import {
  OperatorExecutionAttemptSchema,
  OperatorActivityEntrySchema,
  type OperatorExecutionAttempt,
  type OperatorActivityResponse,
} from './operator-contracts.js';

const ArtifactPointerSchema = z.object({ artifactId: z.string().min(1) }).strict();

const JenkinsEvidenceSchema = z
  .object({
    build: z
      .object({
        url: z.httpUrl(),
      })
      .loose(),
  })
  .loose();

const jenkinsEvidenceFrom = (details: unknown): z.infer<typeof JenkinsEvidenceSchema> | null => {
  const direct = JenkinsEvidenceSchema.safeParse(details);
  if (direct.success) return direct.data;
  const wrapped = z.object({ output: JenkinsEvidenceSchema }).loose().safeParse(details);
  if (wrapped.success) return wrapped.data.output;
  const delivery = z.object({ ci: JenkinsEvidenceSchema }).loose().safeParse(details);
  if (delivery.success) return delivery.data.ci;
  const blocked = z.object({ details: JenkinsEvidenceSchema }).loose().safeParse(details);
  return blocked.success ? blocked.data.details : null;
};

export interface ExecutionActivityReader {
  readActivity(workflowId: string): OperatorActivityResponse['entries'];
  readCurrentTranscript(execution: ExecutionWorkflowPublicState): PlanningTranscriptView | null;
  readAttempt(
    execution: ExecutionWorkflowPublicState,
    nodeId: string,
    blockRun: number,
  ): OperatorExecutionAttempt | null;
}

export class LedgerExecutionActivityReader implements ExecutionActivityReader {
  public constructor(private readonly ledger: LedgerRepository) {}

  public readCurrentTranscript(
    execution: ExecutionWorkflowPublicState,
  ): PlanningTranscriptView | null {
    if (execution.currentNodeId === null) return null;
    const blockRun = execution.blockRuns[execution.currentNodeId] ?? 0;
    if (blockRun < 1) return null;
    const operationId = executionOperationIdFor(
      execution.workflowId,
      execution.runId,
      execution.currentNodeId,
      blockRun,
    );
    const transcript = new TemporalTaskStepTraceStore(this.ledger, systemClock).read(operationId);
    return transcript.ok ? transcript.value : null;
  }

  public readAttempt(
    execution: ExecutionWorkflowPublicState,
    nodeId: string,
    blockRun: number,
  ): OperatorExecutionAttempt | null {
    if (blockRun < 1 || blockRun > (execution.blockRuns[nodeId] ?? 0)) return null;
    const operationId = executionOperationIdFor(
      execution.workflowId,
      execution.runId,
      nodeId,
      blockRun,
    );
    const traces = new TemporalTaskStepTraceStore(this.ledger, systemClock);
    const transcript = traces.read(operationId);
    const output = traces.readOutputArtifact(operationId);
    if (!transcript.ok || !output.ok) return null;
    const evidence = (output.value?.result?.artifactIds ?? []).flatMap((artifactId) => {
      const artifact = this.ledger.readArtifact(artifactId);
      if (artifact?.artifactKind !== 'task_step_evidence') return [];
      const parsed = TaskStepEvidenceArtifactSchema.safeParse(artifact.payload);
      return parsed.success ? [{ artifactId, ...parsed.data }] : [];
    });
    const receiptId = blockReceiptId({
      workflowId: execution.workflowId,
      workflowRunId: execution.runId,
      nodeId,
      blockRun,
    });
    const receiptArtifact = this.ledger.readArtifact(receiptId);
    const receipt = BlockReceiptSchema.safeParse(receiptArtifact?.payload);
    const mutation = receipt.success
      ? receipt.data.evidence.find((item) => item.kind === 'workspace_mutation')
      : undefined;
    return OperatorExecutionAttemptSchema.parse({
      schemaVersion: 1,
      taskReference: execution.taskReference,
      workflowId: execution.workflowId,
      workflowRunId: execution.runId,
      nodeId,
      blockRun,
      transcript: transcript.value,
      output: output.value,
      evidence,
      workspaceChanges:
        mutation === undefined
          ? null
          : {
              changed: mutation.changed,
              fingerprint: mutation.fingerprint,
              trackedDiffSha256: mutation.trackedDiffSha256 ?? null,
              paths: mutation.changedPaths ?? [],
              truncated: mutation.changedPathsTruncated ?? false,
            },
    });
  }

  public readActivity(workflowId: string): OperatorActivityResponse['entries'] {
    const prefix = `task-step-output:${workflowId}:`;
    return this.ledger
      .listEvents()
      .filter(
        (event) =>
          event.eventType === 'TaskStepOutputRecorded' && event.aggregateId.startsWith(prefix),
      )
      .flatMap((event) => {
        const pointer = ArtifactPointerSchema.safeParse(event.payload);
        const artifact = pointer.success ? this.ledger.readArtifact(pointer.data.artifactId) : null;
        const output =
          artifact === null ? null : TaskStepOutputArtifactSchema.safeParse(artifact.payload);
        if (
          output === null ||
          !output.success ||
          output.data.stepReference !== 'deliver.pull-request@1'
        ) {
          return [];
        }
        const evidence = jenkinsEvidenceFrom(output.data.details);
        return [
          OperatorActivityEntrySchema.parse({
            sequence: event.sequence,
            occurredAt: event.occurredAt,
            source: 'tool',
            level: output.data.status === 'completed' ? 'info' : 'warning',
            title: output.data.result?.summary ?? 'Jenkins observation recorded',
            detail:
              output.data.status === 'completed'
                ? 'Jenkins verified the exact commit prepared by this task.'
                : 'The task is paused with its completed work preserved. Resume it after the CI condition is resolved.',
            ...(evidence === null ? {} : { externalUrl: evidence.build.url }),
          }),
        ];
      });
  }
}
