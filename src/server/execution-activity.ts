import { z } from 'zod';

import { BlockReceiptSchema, blockReceiptId } from '../steps/index.js';
import type { LedgerRepository } from '../store/repository.js';
import { TaskStepOutputArtifactSchema } from '../steps/task-step-output.js';
import type { ExecutionWorkflowPublicState, TaskRunLifecycle } from '../kernel/index.js';
import {
  executionOperationIdFor,
  TemporalTaskStepTraceStore,
} from '../steps/activities/block-execution.js';
import { TaskStepEvidenceStore } from '../steps/activities/task-step-evidence.js';
import { TaskStepEvidenceArtifactSchema } from '../steps/task-step-evidence-contracts.js';
import { systemClock } from '../shared/clock.js';
import { PlanningTranscriptStore, type PlanningTranscriptView } from './planning-transcript.js';
import {
  OperatorExecutionAttemptSchema,
  OperatorActivityEntrySchema,
  OperatorRunLogEntrySchema,
  OperatorRunLogResponseSchema,
  type OperatorExecutionAttempt,
  type OperatorActivityResponse,
  type OperatorRunLogResponse,
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

const DeliveryEvidenceSchema = z
  .object({
    outcome: z.enum(['accepted', 'repair_required']),
    ci: JenkinsEvidenceSchema,
  })
  .loose();

const deliveryEvidenceFrom = (details: unknown): z.infer<typeof DeliveryEvidenceSchema> | null => {
  const wrapped = z.object({ output: DeliveryEvidenceSchema }).loose().safeParse(details);
  return wrapped.success ? wrapped.data.output : null;
};

const jenkinsEvidenceFrom = (details: unknown): z.infer<typeof JenkinsEvidenceSchema> | null => {
  const direct = JenkinsEvidenceSchema.safeParse(details);
  if (direct.success) return direct.data;
  const wrapped = z.object({ output: JenkinsEvidenceSchema }).loose().safeParse(details);
  if (wrapped.success) return wrapped.data.output;
  const completedDelivery = deliveryEvidenceFrom(details);
  if (completedDelivery !== null) return completedDelivery.ci;
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
  readRunLog(lifecycle: TaskRunLifecycle): OperatorRunLogResponse;
  readEvidence(artifactId: string): ReturnType<TaskStepEvidenceStore['read']>;
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

  public readEvidence(artifactId: string): ReturnType<TaskStepEvidenceStore['read']> {
    return new TaskStepEvidenceStore(this.ledger, systemClock).read(artifactId);
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

  public readRunLog(lifecycle: TaskRunLifecycle): OperatorRunLogResponse {
    const entries = [];
    const planningOperationPrefix = `${lifecycle.bootstrap.workflowId}:${lifecycle.bootstrap.runId}:planning:`;
    const planningTranscriptPrefix = `planning-transcript:${planningOperationPrefix}`;
    const planningOperationIds = [
      ...new Set(
        this.ledger
          .listEvents()
          .filter(({ aggregateId }) => aggregateId.startsWith(planningTranscriptPrefix))
          .map(({ aggregateId }) => aggregateId.slice('planning-transcript:'.length)),
      ),
    ].sort();
    const planningTranscripts = new PlanningTranscriptStore(this.ledger, systemClock);
    for (const operationId of planningOperationIds) {
      const transcript = planningTranscripts.read(operationId);
      if (!transcript.ok) continue;
      const chunks = transcript.value.chunks;
      const blockRun = Number(operationId.slice(planningOperationPrefix.length));
      const running =
        lifecycle.bootstrap.status === 'running' &&
        lifecycle.bootstrap.currentNodeId === 'planning' &&
        lifecycle.bootstrap.activeTranscriptOperationId === operationId;
      entries.push(
        OperatorRunLogEntrySchema.parse({
          id: `bootstrap:${operationId}`,
          runtime: 'bootstrap',
          nodeId: 'planning',
          reference: 'implementation.plan',
          blockRun: Number.isSafeInteger(blockRun) && blockRun > 0 ? blockRun : 1,
          status: running ? 'running' : 'completed',
          startedAt: chunks[0]?.recordedAt ?? null,
          completedAt: running ? null : (chunks.at(-1)?.recordedAt ?? null),
          rawLog: chunks.map(({ content }) => content).join(''),
          truncated: transcript.value.truncated,
          runner: 'planner',
          resultSummary: null,
          usage: null,
          evidence: [],
          workspaceChanges: null,
        }),
      );
    }

    const execution = lifecycle.execution;
    if (execution !== null) {
      for (const [nodeId, attempts] of Object.entries(execution.blockRuns)) {
        for (let blockRun = 1; blockRun <= attempts; blockRun += 1) {
          const attempt = this.readAttempt(execution, nodeId, blockRun);
          if (attempt === null) continue;
          const output = attempt.output;
          const chunks = attempt.transcript?.chunks ?? [];
          const rawTranscript = chunks.map(({ content }) => content).join('');
          entries.push(
            OperatorRunLogEntrySchema.parse({
              id: `execution:${execution.runId}:${nodeId}:${String(blockRun)}`,
              runtime: 'execution',
              nodeId,
              reference: output?.stepReference ?? nodeId,
              blockRun,
              status: output?.status ?? 'running',
              startedAt: chunks[0]?.recordedAt ?? output?.recordedAt ?? null,
              completedAt: output?.recordedAt ?? null,
              rawLog:
                output === null
                  ? rawTranscript
                  : [output.stdout, output.stderr].filter((value) => value.length > 0).join('\n'),
              truncated: output === null ? (attempt.transcript?.truncated ?? false) : false,
              runner: output?.runner ?? null,
              resultSummary: output?.result?.summary ?? null,
              usage: output?.usage ?? null,
              evidence: attempt.evidence,
              workspaceChanges: attempt.workspaceChanges,
            }),
          );
        }
      }
    }

    return OperatorRunLogResponseSchema.parse({
      schemaVersion: 1,
      taskReference: lifecycle.bootstrap.taskReference,
      bootstrapRunId: lifecycle.bootstrap.runId,
      executionRunId: lifecycle.execution?.runId ?? null,
      entries: entries.sort((left, right) => {
        if (left.startedAt === null) return right.startedAt === null ? 0 : 1;
        if (right.startedAt === null) return -1;
        return left.startedAt.localeCompare(right.startedAt);
      }),
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
        const delivery = deliveryEvidenceFrom(output.data.details);
        return [
          OperatorActivityEntrySchema.parse({
            sequence: event.sequence,
            occurredAt: event.occurredAt,
            source: 'tool',
            level: output.data.status === 'completed' ? 'info' : 'warning',
            title: output.data.result?.summary ?? 'Jenkins observation recorded',
            detail:
              output.data.status === 'completed'
                ? delivery?.outcome === 'repair_required'
                  ? 'CI produced repair evidence; the frozen delivery feedback loop will repeat with the same worktree and pull request.'
                  : 'Jenkins verified the exact commit prepared by this task.'
                : 'The task is paused with its completed work preserved. Resume it after the CI condition is resolved.',
            ...(evidence === null ? {} : { externalUrl: evidence.build.url }),
          }),
        ];
      });
  }
}
