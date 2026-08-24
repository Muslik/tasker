import { z } from 'zod';

import type { LedgerRepository } from '../ledger/repository.js';
import type { JsonValue } from '../ledger/types.js';
import type { Clock } from '../shared/clock.js';
import { err, ok, type Outcome } from '../shared/outcome.js';
import { TaskStepOutputArtifactSchema } from '../temporal/task-step-output.js';
import { JsonValueSchema } from '../workflow/schema.js';

const RetrospectiveStepMetricsSchema = z
  .object({
    stepReference: z.string().min(1),
    attempts: z.number().int().nonnegative(),
    blockedAttempts: z.number().int().nonnegative(),
    inputTokens: z.number().int().nonnegative(),
    cachedInputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    durationMs: z.number().nonnegative(),
    estimatedCostUsd: z.number().nonnegative(),
  })
  .strict();

const RetrospectiveFindingSchema = z
  .object({
    kind: z.enum(['cost', 'recovery']),
    title: z.string().min(1),
    detail: z.string().min(1),
    evidenceReferences: z.array(z.string().min(1)),
  })
  .strict();

const RetrospectiveProposalSchema = z
  .object({
    id: z.string().min(1),
    target: z.enum(['harness', 'infrastructure']),
    title: z.string().min(1),
    rationale: z.string().min(1),
    status: z.literal('proposed'),
  })
  .strict();

export const RetrospectiveReportSchema = z
  .object({
    schemaVersion: z.literal(1),
    taskReference: z.string().min(1),
    workflowId: z.string().min(1),
    workflowRunId: z.string().min(1),
    outcome: z.string().min(1),
    metrics: z
      .object({
        attempts: z.number().int().nonnegative(),
        blockedAttempts: z.number().int().nonnegative(),
        inputTokens: z.number().int().nonnegative(),
        cachedInputTokens: z.number().int().nonnegative(),
        outputTokens: z.number().int().nonnegative(),
        durationMs: z.number().nonnegative(),
        estimatedCostUsd: z.number().nonnegative(),
        byStep: z.array(RetrospectiveStepMetricsSchema),
      })
      .strict(),
    findings: z.array(RetrospectiveFindingSchema),
    proposals: z.array(RetrospectiveProposalSchema),
    generatedAt: z.iso.datetime(),
  })
  .strict();

export const RetrospectiveResponseSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('pending') }).strict(),
  z.object({ status: z.literal('ready'), report: RetrospectiveReportSchema }).strict(),
]);

export type RetrospectiveResponse = z.infer<typeof RetrospectiveResponseSchema>;

export type RetrospectiveReport = z.infer<typeof RetrospectiveReportSchema>;

export type RetrospectiveStoreError =
  | { readonly kind: 'ledger_conflict' }
  | { readonly kind: 'report_corrupt'; readonly issues: readonly string[] };

const asJson = (value: unknown): JsonValue => JsonValueSchema.parse(value);
const reportId = (workflowId: string, workflowRunId: string): string =>
  `retrospective:${workflowId}:${workflowRunId}`;

const RetrospectiveGeneratedPayloadSchema = z
  .object({
    artifactId: z.string().min(1),
    taskReference: z.string().min(1),
  })
  .strict();

const outputArtifacts = (ledger: LedgerRepository, workflowId: string, workflowRunId: string) => {
  const prefix = `task-step-output:${workflowId}:${workflowRunId}:`;
  return ledger
    .listEvents()
    .filter(
      (event) =>
        event.eventType === 'TaskStepOutputRecorded' && event.aggregateId.startsWith(prefix),
    )
    .flatMap((event) => {
      const pointer = z.object({ artifactId: z.string().min(1) }).safeParse(event.payload);
      if (!pointer.success) return [];
      const artifact = ledger.readArtifact(pointer.data.artifactId);
      if (artifact === null) return [];
      const parsed = TaskStepOutputArtifactSchema.safeParse(artifact.payload);
      return parsed.success ? [{ artifactId: pointer.data.artifactId, output: parsed.data }] : [];
    });
};

export class RetrospectiveStore {
  public constructor(
    private readonly ledger: LedgerRepository,
    private readonly clock: Clock,
  ) {}

  public read(
    workflowId: string,
    workflowRunId: string,
  ): Outcome<RetrospectiveReport | null, RetrospectiveStoreError> {
    const artifact = this.ledger.readArtifact(reportId(workflowId, workflowRunId));
    if (artifact === null) return ok(null);
    const parsed = RetrospectiveReportSchema.safeParse(artifact.payload);
    return parsed.success
      ? ok(parsed.data)
      : err({
          kind: 'report_corrupt',
          issues: parsed.error.issues.map(
            (issue) => `${issue.path.map(String).join('.')}: ${issue.message}`,
          ),
        });
  }

  public readLatest(
    taskReference: string,
  ): Outcome<RetrospectiveReport | null, RetrospectiveStoreError> {
    const event = this.ledger
      .listEvents()
      .toReversed()
      .find((candidate) => {
        if (candidate.eventType !== 'RetrospectiveGenerated') return false;
        const payload = RetrospectiveGeneratedPayloadSchema.safeParse(candidate.payload);
        return payload.success && payload.data.taskReference === taskReference;
      });
    if (event === undefined) return ok(null);
    const payload = RetrospectiveGeneratedPayloadSchema.parse(event.payload);
    const artifact = this.ledger.readArtifact(payload.artifactId);
    if (artifact === null) return err({ kind: 'report_corrupt', issues: ['artifact: missing'] });
    const report = RetrospectiveReportSchema.safeParse(artifact.payload);
    return report.success
      ? ok(report.data)
      : err({
          kind: 'report_corrupt',
          issues: report.error.issues.map(
            (issue) => `${issue.path.map(String).join('.')}: ${issue.message}`,
          ),
        });
  }

  public generate(input: {
    readonly taskReference: string;
    readonly workflowId: string;
    readonly workflowRunId: string;
    readonly outcome: string;
  }): Outcome<RetrospectiveReport, RetrospectiveStoreError> {
    const existing = this.read(input.workflowId, input.workflowRunId);
    if (!existing.ok) return existing;
    if (existing.value !== null) return ok(existing.value);

    const artifacts = outputArtifacts(this.ledger, input.workflowId, input.workflowRunId);
    const byStep = new Map<string, z.infer<typeof RetrospectiveStepMetricsSchema>>();
    for (const { output } of artifacts) {
      const current = byStep.get(output.stepReference) ?? {
        stepReference: output.stepReference,
        attempts: 0,
        blockedAttempts: 0,
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        durationMs: 0,
        estimatedCostUsd: 0,
      };
      current.attempts += 1;
      if (output.status === 'blocked') current.blockedAttempts += 1;
      if (output.usage !== null) {
        current.inputTokens += output.usage.inputTokens;
        current.cachedInputTokens += output.usage.cachedInputTokens;
        current.outputTokens += output.usage.outputTokens;
        current.durationMs += output.usage.durationMs;
        if (output.usage.apiCost.source === 'price_table') {
          current.estimatedCostUsd += output.usage.apiCost.amountUsd;
        }
      }
      byStep.set(output.stepReference, current);
    }
    const steps = [...byStep.values()].sort((left, right) =>
      left.stepReference.localeCompare(right.stepReference),
    );
    const totals = steps.reduce(
      (total, step) => ({
        attempts: total.attempts + step.attempts,
        blockedAttempts: total.blockedAttempts + step.blockedAttempts,
        inputTokens: total.inputTokens + step.inputTokens,
        cachedInputTokens: total.cachedInputTokens + step.cachedInputTokens,
        outputTokens: total.outputTokens + step.outputTokens,
        durationMs: total.durationMs + step.durationMs,
        estimatedCostUsd: total.estimatedCostUsd + step.estimatedCostUsd,
      }),
      {
        attempts: 0,
        blockedAttempts: 0,
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        durationMs: 0,
        estimatedCostUsd: 0,
      },
    );
    const expensive = steps.toSorted((left, right) => right.inputTokens - left.inputTokens)[0];
    const blockedReferences = artifacts
      .filter(({ output }) => output.status === 'blocked')
      .map(({ artifactId }) => artifactId);
    const findings: z.infer<typeof RetrospectiveFindingSchema>[] = [];
    if (expensive !== undefined && expensive.inputTokens > 0) {
      findings.push({
        kind: 'cost',
        title: `${expensive.stepReference} dominated measured token usage`,
        detail: `${String(expensive.attempts)} attempts used ${String(expensive.inputTokens)} measured input tokens (${String(expensive.cachedInputTokens)} cached).`,
        evidenceReferences: artifacts
          .filter(({ output }) => output.stepReference === expensive.stepReference)
          .map(({ artifactId }) => artifactId),
      });
    }
    if (blockedReferences.length > 0) {
      findings.push({
        kind: 'recovery',
        title: `${String(blockedReferences.length)} attempts required recovery`,
        detail: 'Review the blocked attempt reasons before changing prompts or runtime policy.',
        evidenceReferences: blockedReferences,
      });
    }
    const proposals: z.infer<typeof RetrospectiveProposalSchema>[] = [];
    if (expensive !== undefined && expensive.attempts > 1) {
      proposals.push({
        id: 'compact-repeated-step-context',
        target: 'harness',
        title: `Reduce repeated ${expensive.stepReference} context`,
        rationale:
          'Later attempts should receive the latest accepted evidence and repair delta instead of replaying the full run history.',
        status: 'proposed',
      });
    }
    if (blockedReferences.length > 0) {
      proposals.push({
        id: 'harden-recovery-prerequisites',
        target: 'infrastructure',
        title: 'Harden recurring runtime and integration prerequisites',
        rationale:
          'Blocked attempts are retained as evidence and should be reviewed for reusable infrastructure fixes.',
        status: 'proposed',
      });
    }
    const generatedAt = this.clock.now();
    const report = RetrospectiveReportSchema.parse({
      schemaVersion: 1,
      ...input,
      metrics: { ...totals, byStep: steps },
      findings,
      proposals,
      generatedAt,
    });
    const id = reportId(input.workflowId, input.workflowRunId);
    const committed = this.ledger.transact({
      aggregate: {
        aggregateId: id,
        expectedVersion: 0,
        events: [
          {
            eventId: `event:${id}:generated`,
            eventType: 'RetrospectiveGenerated',
            eventSchemaVersion: 1,
            payload: asJson({ artifactId: id, taskReference: input.taskReference }),
            actor: 'retrospective',
          },
        ],
      },
      artifacts: [
        {
          artifactId: id,
          artifactKind: 'retrospective_report',
          storageUri: `ledger://artifacts/${id}`,
          payload: asJson(report),
          metadata: asJson({
            taskReference: input.taskReference,
            workflowId: input.workflowId,
            workflowRunId: input.workflowRunId,
            outcome: input.outcome,
          }),
          createdAt: generatedAt,
        },
      ],
      timestamp: generatedAt,
    });
    if (committed.ok) return ok(report);
    const concurrent = this.read(input.workflowId, input.workflowRunId);
    return concurrent.ok && concurrent.value !== null
      ? ok(concurrent.value)
      : err({ kind: 'ledger_conflict' });
  }
}
