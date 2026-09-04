import { z } from 'zod';

import type { LedgerRepository } from '../store/repository.js';
import type { JsonValue } from '../store/types.js';
import type { Clock } from '../shared/clock.js';
import { err, ok, type Outcome } from '../shared/outcome.js';
import { JsonValueSchema } from '../graph/schema.js';
import {
  RetrospectiveFindingSchema,
  RetrospectiveAnalyzerProposalSchema,
  RetrospectiveProposalSchema,
  type RetrospectiveAnalyzerOutput,
} from '../shared/retrospective.js';
import {
  buildAnalyzerDigest,
  effortFor,
  outputArtifacts,
  type RetrospectiveDigestStep,
} from './retrospective-data.js';

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

const RetrospectiveEffortSchema = z
  .object({
    waitResolutions: z
      .object({
        count: z.number().int().nonnegative(),
        kinds: z.record(z.string(), z.number().int().nonnegative()),
      })
      .strict(),
    guidance: z
      .object({ count: z.number().int().nonnegative(), totalChars: z.number().int().nonnegative() })
      .strict(),
    planReviews: z
      .object({
        rounds: z.number().int().nonnegative(),
        annotations: z.number().int().nonnegative(),
      })
      .strict(),
    documentReviews: z
      .object({
        rounds: z.number().int().nonnegative(),
        annotations: z.number().int().nonnegative(),
      })
      .strict(),
    restarts: z.number().int().nonnegative(),
  })
  .strict();

export const RetrospectiveReportSchema = z
  .object({
    schemaVersion: z.literal(2),
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
        effort: RetrospectiveEffortSchema,
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

export const RetrospectivePatternsSchema = z
  .object({
    findings: z.array(
      z.object({ stepReference: z.string().min(1), count: z.number().int().positive() }).strict(),
    ),
    proposals: z.array(
      z.object({ target: z.string().min(1), count: z.number().int().positive() }).strict(),
    ),
  })
  .strict();

export type RetrospectiveResponse = z.infer<typeof RetrospectiveResponseSchema>;
export type RetrospectiveReport = z.infer<typeof RetrospectiveReportSchema>;
export type RetrospectivePatterns = z.infer<typeof RetrospectivePatternsSchema>;

export interface RetrospectiveRunIndex {
  readonly report: RetrospectiveReport;
  readonly blockRuns: Readonly<Record<string, number>>;
}

export type { RetrospectiveDigestStep } from './retrospective-data.js';

export type RetrospectiveStoreError =
  | { readonly kind: 'ledger_conflict' }
  | { readonly kind: 'report_corrupt'; readonly issues: readonly string[] }
  | { readonly kind: 'proposal_not_found' }
  | { readonly kind: 'proposal_conflict' };

const REPORT_DOCUMENT_KIND = 'retrospective_report';
const asJson = (value: unknown): JsonValue => JsonValueSchema.parse(value);
const reportId = (workflowId: string, workflowRunId: string): string =>
  `retrospective:${workflowId}:${workflowRunId}`;

const safeReport = (payload: unknown): Outcome<RetrospectiveReport, RetrospectiveStoreError> => {
  const parsed = RetrospectiveReportSchema.safeParse(payload);
  return parsed.success
    ? ok(parsed.data)
    : err({
        kind: 'report_corrupt',
        issues: parsed.error.issues.map(
          (issue) => `${issue.path.map(String).join('.')}: ${issue.message}`,
        ),
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
    const id = reportId(workflowId, workflowRunId);
    const document = this.ledger.readDocument(REPORT_DOCUMENT_KIND, id);
    if (document !== null) return safeReport(document.payload);
    const artifact = this.ledger.readArtifact(id);
    return artifact === null ? ok(null) : safeReport(artifact.payload);
  }

  public readLatest(
    taskReference: string,
  ): Outcome<RetrospectiveReport | null, RetrospectiveStoreError> {
    const documents = this.ledger.listDocuments(REPORT_DOCUMENT_KIND).toReversed();
    for (const document of documents) {
      const report = safeReport(document.payload);
      if (!report.ok) return report;
      if (report.value.taskReference === taskReference) return report;
    }
    for (const artifact of this.ledger
      .listArtifacts({ artifactKind: REPORT_DOCUMENT_KIND, taskReference })
      .toReversed()) {
      const report = safeReport(artifact.payload);
      if (!report.ok) return report;
      if (report.value.taskReference === taskReference) return report;
    }
    return ok(null);
  }

  public readLatestRun(
    taskReference: string,
  ): Outcome<RetrospectiveRunIndex | null, RetrospectiveStoreError> {
    const latest = this.readLatest(taskReference);
    if (!latest.ok || latest.value === null) return latest.ok ? ok(null) : latest;
    const blockRuns: Record<string, number> = {};
    for (const { output } of outputArtifacts(
      this.ledger,
      latest.value.workflowId,
      latest.value.workflowRunId,
    )) {
      blockRuns[output.nodeId] = Math.max(blockRuns[output.nodeId] ?? 0, output.stepAttempt);
    }
    return ok({ report: latest.value, blockRuns });
  }

  public generate(
    input: {
      readonly taskReference: string;
      readonly workflowId: string;
      readonly workflowRunId: string;
      readonly outcome: string;
    },
    analyzerOutput?: RetrospectiveAnalyzerOutput,
  ): Outcome<RetrospectiveReport, RetrospectiveStoreError> {
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
        if (output.usage.apiCost.source === 'price_table')
          current.estimatedCostUsd += output.usage.apiCost.amountUsd;
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
    const blocked = artifacts.filter(({ output }) => output.status === 'blocked');
    const findings = z.array(RetrospectiveFindingSchema).parse([
      ...(expensive === undefined || expensive.inputTokens === 0
        ? []
        : [
            {
              kind: 'cost',
              stepReference: expensive.stepReference,
              title: `${expensive.stepReference} dominated measured token usage`,
              detail: `${String(expensive.attempts)} attempts used ${String(expensive.inputTokens)} measured input tokens (${String(expensive.cachedInputTokens)} cached).`,
              evidenceReferences: artifacts
                .filter(({ output }) => output.stepReference === expensive.stepReference)
                .map(({ artifactId }) => artifactId),
            },
          ]),
      ...(blocked.length === 0
        ? []
        : [
            {
              kind: 'recovery',
              title: `${String(blocked.length)} attempts required recovery`,
              detail:
                'Review the blocked attempt reasons before changing prompts or runtime policy.',
              evidenceReferences: blocked.map(({ artifactId }) => artifactId),
            },
          ]),
      ...(analyzerOutput?.findings ?? []),
    ]);
    const proposals = z
      .array(RetrospectiveAnalyzerProposalSchema)
      .parse(analyzerOutput?.proposals ?? []);
    const generatedAt = this.clock.now();
    const report = RetrospectiveReportSchema.parse({
      schemaVersion: 2,
      ...input,
      metrics: { ...totals, effort: effortFor(this.ledger, input.taskReference), byStep: steps },
      findings,
      proposals,
      generatedAt,
    });
    const id = reportId(input.workflowId, input.workflowRunId);
    const committed = this.ledger.insertArtifact({
      artifactId: id,
      artifactKind: REPORT_DOCUMENT_KIND,
      taskReference: input.taskReference,
      storageUri: `ledger://artifacts/${id}`,
      payload: asJson(report),
      metadata: asJson({ taskReference: input.taskReference }),
      createdAt: generatedAt,
    });
    if (!committed) {
      const concurrent = this.read(input.workflowId, input.workflowRunId);
      return concurrent.ok && concurrent.value !== null
        ? ok(concurrent.value)
        : err({ kind: 'ledger_conflict' });
    }
    const documented = this.ledger.insertDocument({
      kind: REPORT_DOCUMENT_KIND,
      id,
      revision: 1,
      payload: asJson(report),
      createdAt: generatedAt,
      updatedAt: generatedAt,
    });
    if (documented) return ok(report);
    const concurrent = this.read(input.workflowId, input.workflowRunId);
    return concurrent.ok && concurrent.value !== null
      ? ok(concurrent.value)
      : err({ kind: 'ledger_conflict' });
  }

  public buildAnalyzerDigest(
    input: {
      readonly taskReference: string;
      readonly workflowId: string;
      readonly workflowRunId: string;
    },
    stepDefinitions: readonly RetrospectiveDigestStep[],
  ): string {
    return buildAnalyzerDigest(this.ledger, input, stepDefinitions);
  }

  public setProposalStatus(
    workflowId: string,
    workflowRunId: string,
    proposalId: string,
    status: 'approved' | 'dismissed',
  ): Outcome<RetrospectiveReport, RetrospectiveStoreError> {
    const current = this.read(workflowId, workflowRunId);
    if (!current.ok) return current;
    if (current.value === null) return err({ kind: 'proposal_not_found' });
    const proposal = current.value.proposals.find((candidate) => candidate.id === proposalId);
    if (proposal === undefined) return err({ kind: 'proposal_not_found' });
    const updated = RetrospectiveReportSchema.parse({
      ...current.value,
      proposals: current.value.proposals.map((candidate) =>
        candidate.id === proposalId ? { ...candidate, status } : candidate,
      ),
    });
    const document = this.ledger.readDocument(
      REPORT_DOCUMENT_KIND,
      reportId(workflowId, workflowRunId),
    );
    if (document === null) return err({ kind: 'proposal_conflict' });
    const saved = this.ledger.appendDocument(
      REPORT_DOCUMENT_KIND,
      document.id,
      document.revision,
      asJson(updated),
      this.clock.now(),
    );
    if (saved.ok) return ok(updated);
    const concurrent = this.read(workflowId, workflowRunId);
    return concurrent.ok && concurrent.value !== null
      ? ok(concurrent.value)
      : err({ kind: 'proposal_conflict' });
  }

  public patterns(): Outcome<RetrospectivePatterns, RetrospectiveStoreError> {
    const reports = new Map<string, RetrospectiveReport>();
    for (const document of this.ledger.listDocuments(REPORT_DOCUMENT_KIND)) {
      const parsed = safeReport(document.payload);
      if (!parsed.ok) return parsed;
      reports.set(document.id, parsed.value);
    }
    for (const artifact of this.ledger.listArtifacts({ artifactKind: REPORT_DOCUMENT_KIND })) {
      if (reports.has(artifact.artifactId)) continue;
      const parsed = safeReport(artifact.payload);
      if (!parsed.ok) return parsed;
      reports.set(artifact.artifactId, parsed.value);
    }
    const findings = new Map<string, number>();
    const proposals = new Map<string, number>();
    for (const report of reports.values()) {
      for (const finding of report.findings) {
        const step = finding.stepReference ?? finding.evidenceReferences[0] ?? 'unknown';
        findings.set(step, (findings.get(step) ?? 0) + 1);
      }
      for (const proposal of report.proposals)
        proposals.set(proposal.target, (proposals.get(proposal.target) ?? 0) + 1);
    }
    return ok({
      findings: [...findings]
        .map(([stepReference, count]) => ({ stepReference, count }))
        .sort((a, b) => b.count - a.count || a.stepReference.localeCompare(b.stepReference)),
      proposals: [...proposals]
        .map(([target, count]) => ({ target, count }))
        .sort((a, b) => b.count - a.count || a.target.localeCompare(b.target)),
    });
  }
}
