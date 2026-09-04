import type { LedgerRepository } from '../store/repository.js';
import type { JsonValue } from '../store/types.js';
import { BlockReceiptSchema } from '../steps/contracts.js';
import { AgentInvocationArtifactSchema } from '../steps/agent-invocation.js';
import { TaskStepOutputArtifactSchema } from '../steps/task-step-output.js';
import { PlanReviewRoundSchema } from './plan-review.js';

const MAX_DIGEST_BYTES = 60_000;
const takeUtf8 = (value: string, maximumBytes: number): string => {
  let result = '';
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (bytes + characterBytes > maximumBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
};

export interface RetrospectiveDigestStep {
  readonly reference: string;
  readonly promptFile: string | null;
}

export const outputArtifacts = (
  ledger: LedgerRepository,
  workflowId: string,
  workflowRunId: string,
) =>
  ledger.listArtifacts({ artifactKind: 'task_step_output' }).flatMap((artifact) => {
    const parsed = TaskStepOutputArtifactSchema.safeParse(artifact.payload);
    return parsed.success &&
      parsed.data.workflowId === workflowId &&
      parsed.data.workflowRunId === workflowRunId
      ? [{ artifactId: artifact.artifactId, output: parsed.data }]
      : [];
  });

const recordObject = (value: JsonValue): Record<string, JsonValue> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};

const numberOfAnnotations = (value: JsonValue): number => {
  const annotations = recordObject(value).annotations;
  return Array.isArray(annotations) ? annotations.length : 0;
};

const guidanceFrom = (value: JsonValue): string | null => {
  const guidance = recordObject(value).guidance;
  return typeof guidance === 'string' && guidance.length > 0 ? guidance : null;
};

export const effortFor = (ledger: LedgerRepository, taskReference: string) => {
  const events = ledger.listStreamEventsForTask(taskReference);
  const kinds: Record<string, number> = {};
  let guidanceCount = 0;
  let guidanceChars = 0;
  let documentReviews = 0;
  let documentAnnotations = 0;
  for (const event of events) {
    const payload = recordObject(event.payload);
    if (event.eventType === 'OperatorWaitResolved') {
      const waitKind = typeof payload.waitKind === 'string' ? payload.waitKind : 'unknown';
      kinds[waitKind] = (kinds[waitKind] ?? 0) + 1;
      if (!['plan.approved@1', 'research.document-review@1'].includes(waitKind)) {
        const guidance = guidanceFrom(recordObject(payload.resolution ?? null));
        if (guidance !== null) {
          guidanceCount += 1;
          guidanceChars += guidance.length;
        }
      }
    }
    if (event.eventType === 'OperatorDocumentReviewSubmitted') {
      documentReviews += 1;
      documentAnnotations += numberOfAnnotations(payload.resolution ?? null);
      const guidance = guidanceFrom(recordObject(payload.resolution ?? null));
      if (guidance !== null) {
        guidanceCount += 1;
        guidanceChars += guidance.length;
      }
    }
  }
  let planReviews = 0;
  let planAnnotations = 0;
  for (const document of ledger.listDocuments('plan_review')) {
    const parsed = PlanReviewRoundSchema.safeParse(document.payload);
    if (!parsed.success || parsed.data.taskReference !== taskReference) continue;
    planReviews += 1;
    planAnnotations += parsed.data.annotations.length;
    if (parsed.data.guidance !== null) {
      guidanceCount += 1;
      guidanceChars += parsed.data.guidance.length;
    }
  }
  return {
    waitResolutions: { count: Object.values(kinds).reduce((sum, count) => sum + count, 0), kinds },
    guidance: { count: guidanceCount, totalChars: guidanceChars },
    planReviews: { rounds: planReviews, annotations: planAnnotations },
    documentReviews: { rounds: documentReviews, annotations: documentAnnotations },
    restarts: events.filter((event) => event.eventType === 'OperatorRestarted').length,
  };
};

const readMetrics = (
  ledger: LedgerRepository,
  workflowId: string,
  workflowRunId: string,
): JsonValue => {
  const artifacts = outputArtifacts(ledger, workflowId, workflowRunId);
  return {
    attempts: artifacts.length,
    blockedAttempts: artifacts.filter(({ output }) => output.status === 'blocked').length,
    inputTokens: artifacts.reduce((sum, { output }) => sum + (output.usage?.inputTokens ?? 0), 0),
    cachedInputTokens: artifacts.reduce(
      (sum, { output }) => sum + (output.usage?.cachedInputTokens ?? 0),
      0,
    ),
    outputTokens: artifacts.reduce((sum, { output }) => sum + (output.usage?.outputTokens ?? 0), 0),
    durationMs: artifacts.reduce((sum, { output }) => sum + (output.usage?.durationMs ?? 0), 0),
    estimatedCostUsd: artifacts.reduce(
      (sum, { output }) =>
        sum + (output.usage?.apiCost.source === 'price_table' ? output.usage.apiCost.amountUsd : 0),
      0,
    ),
  };
};

const interventionDigest = (ledger: LedgerRepository, taskReference: string): JsonValue[] => {
  const interventions = ledger
    .listStreamEventsForTask(taskReference)
    .filter(
      (event) =>
        event.eventType === 'OperatorWaitResolved' ||
        event.eventType === 'OperatorDocumentReviewSubmitted',
    )
    .map((event) => ({
      eventType: event.eventType,
      occurredAt: event.occurredAt,
      payload: event.payload,
    }));
  for (const document of ledger.listDocuments('plan_review')) {
    const review = PlanReviewRoundSchema.safeParse(document.payload);
    if (review.success && review.data.taskReference === taskReference) {
      interventions.push({
        eventType: 'PlanReviewSubmitted',
        occurredAt: review.data.submittedAt,
        payload: review.data,
      });
    }
  }
  return interventions;
};

export const buildAnalyzerDigest = (
  ledger: LedgerRepository,
  input: {
    readonly taskReference: string;
    readonly workflowId: string;
    readonly workflowRunId: string;
  },
  stepDefinitions: readonly RetrospectiveDigestStep[],
): string => {
  const artifacts = outputArtifacts(ledger, input.workflowId, input.workflowRunId);
  const receipts = new Map(
    ledger
      .listReceiptsByWorkflowRun(input.workflowId, input.workflowRunId)
      .map((receipt) => [`${receipt.nodeId}:${String(receipt.blockRun)}`, receipt]),
  );
  const invocations = ledger
    .listArtifacts({ artifactKind: 'agent_invocation', taskReference: input.taskReference })
    .flatMap((artifact) => {
      const parsed = AgentInvocationArtifactSchema.safeParse(artifact.payload);
      return parsed.success &&
        parsed.data.references.kind === 'execution' &&
        parsed.data.references.runId === input.workflowRunId
        ? [
            {
              nodeId: parsed.data.references.nodeId,
              blockRun: parsed.data.references.blockRun,
              promptBytes: parsed.data.promptBytes,
            },
          ]
        : [];
    });
  const attempts = artifacts.map(({ artifactId, output }) => {
    const details = recordObject(output.details);
    const agentOutput = recordObject(details.output ?? null);
    const receipt = receipts.get(`${output.nodeId}:${String(output.stepAttempt)}`);
    const parsedReceipt =
      receipt === undefined ? null : BlockReceiptSchema.safeParse(receipt.payload);
    const verdict = parsedReceipt?.success ? parsedReceipt.data.verdict : null;
    return {
      artifactId,
      nodeId: output.nodeId,
      stepReference: output.stepReference,
      attempt: output.stepAttempt,
      status: output.status,
      summary: output.result?.summary ?? null,
      waitKind: output.result?.status === 'blocked' ? output.result.waitKind : null,
      waitingReason: typeof agentOutput.reason === 'string' ? agentOutput.reason : null,
      failureDetail: typeof agentOutput.detail === 'string' ? agentOutput.detail : null,
      verdict: verdict?.status ?? null,
      rejectionReasons: verdict?.status === 'rejected' ? verdict.reasons : [],
      promptBytes:
        invocations.find(
          (item) => item.nodeId === output.nodeId && item.blockRun === output.stepAttempt,
        )?.promptBytes ?? null,
    };
  });
  const digest = JSON.stringify(
    {
      policy: 'bounded retrospective digest; raw transcripts and stdout/stderr are excluded',
      run: input,
      steps: stepDefinitions,
      interventions: interventionDigest(ledger, input.taskReference),
      attempts,
      totals: {
        ...recordObject(readMetrics(ledger, input.workflowId, input.workflowRunId)),
        effort: effortFor(ledger, input.taskReference),
      },
    },
    null,
    2,
  );
  return Buffer.byteLength(digest, 'utf8') <= MAX_DIGEST_BYTES
    ? digest
    : `${takeUtf8(digest, MAX_DIGEST_BYTES - 35)}\n[retrospective digest truncated]`;
};
