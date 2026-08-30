import {
  researchDraftOutputSchema,
  researchReviewOutputSchema,
} from '../../harness/step-contracts.js';
import { JsonValueSchema } from '../../graph/schema.js';
import {
  ResearchDocumentReviewOutputSchema,
  ResearchDocumentReviewResolutionSchema,
  ResearchDocumentReviewWaitDetailsSchema,
} from '../../shared/research-document-review.js';
import type {
  IntegrationStepAdapter,
  IntegrationStepExecutionRequest,
  IntegrationStepExecutionResult,
  TaskRunStepEvidence,
} from '../execution.js';

const blocked = (
  summary: string,
  details: unknown,
): Extract<IntegrationStepExecutionResult, { readonly status: 'blocked' }> => ({
  status: 'blocked',
  kind: 'invalid_request',
  summary,
  details: JsonValueSchema.parse(details),
  artifactIds: [],
});

const latestCompletedStep = (
  steps: readonly TaskRunStepEvidence[],
  stepReference: string,
): TaskRunStepEvidence | null => {
  let latest: TaskRunStepEvidence | null = null;
  for (const step of steps) {
    if (step.status !== 'completed' || step.stepReference !== stepReference) continue;
    if (latest === null || step.recordedAt >= latest.recordedAt) {
      latest = step;
    }
  }
  return latest;
};

const outputFromStep = <T>(
  step: TaskRunStepEvidence,
  parser: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
): T | null => {
  const details = step.details;
  if (details === null || Array.isArray(details) || typeof details !== 'object') return null;
  const output = 'output' in details ? details.output : undefined;
  const parsed = parser.safeParse(output);
  return parsed.success ? parsed.data : null;
};

const documentArtifactIdFor = (step: TaskRunStepEvidence): string =>
  `task-step-output:${step.operationId}:artifact`;

const completed = (
  decision: 'approved' | 'changes_requested',
  documentArtifactId: string,
  summary: string,
): Extract<IntegrationStepExecutionResult, { readonly status: 'completed' }> => ({
  status: 'completed',
  summary,
  output: ResearchDocumentReviewOutputSchema.parse({
    decision,
    documentArtifactId,
  }),
  artifactIds: [documentArtifactId],
});

export class ResearchDocumentReviewAdapter implements IntegrationStepAdapter {
  public readonly id = 'research.document-review@1';

  public execute(
    request: IntegrationStepExecutionRequest,
  ): Promise<IntegrationStepExecutionResult> {
    return Promise.resolve(this.executeRequest(request));
  }

  private executeRequest(request: IntegrationStepExecutionRequest): IntegrationStepExecutionResult {
    const draftStep = latestCompletedStep(request.evidence.completedSteps, 'research.draft@1');
    if (draftStep === null) {
      return blocked('Research document review requires a completed research.draft@1 step', {
        completedSteps: request.evidence.completedSteps.map(({ stepReference }) => stepReference),
      });
    }
    const draftOutput = outputFromStep(draftStep, researchDraftOutputSchema);
    if (draftOutput === null) {
      return blocked('Research draft output is invalid for operator document review', {
        operationId: draftStep.operationId,
      });
    }

    const reviewStep = latestCompletedStep(request.evidence.completedSteps, 'research.review@1');
    if (reviewStep === null) {
      return blocked('Research document review requires a completed research.review@1 step', {
        completedSteps: request.evidence.completedSteps.map(({ stepReference }) => stepReference),
      });
    }
    const reviewOutput = outputFromStep(reviewStep, researchReviewOutputSchema);
    if (reviewOutput === null) {
      return blocked('Research review output is invalid for operator document review', {
        operationId: reviewStep.operationId,
      });
    }

    const documentArtifactId = documentArtifactIdFor(draftStep);
    if (reviewOutput.decision === 'changes_requested') {
      return completed(
        'changes_requested',
        documentArtifactId,
        'Agent review requested changes before operator document review',
      );
    }

    if (request.waitResolution === null) {
      return {
        status: 'waiting',
        waitKind: 'research.document-review@1',
        summary: 'Research draft is waiting for operator document review before publication',
        category: 'authorization',
        retryable: false,
        details: ResearchDocumentReviewWaitDetailsSchema.parse({
          kind: 'research_document_review',
          documentArtifactId,
          documentStorageHtml: draftOutput.documentStorageHtml,
        }),
        artifactIds: [documentArtifactId],
      };
    }

    const resolution = ResearchDocumentReviewResolutionSchema.safeParse(request.waitResolution);
    if (!resolution.success) {
      return blocked('Research document review resolution is invalid', {
        issues: resolution.error.issues.map(
          (issue) => `${issue.path.map(String).join('.')}: ${issue.message}`,
        ),
      });
    }

    return resolution.data.decision === 'approve'
      ? completed(
          'approved',
          documentArtifactId,
          'Operator approved the research document and task breakdown',
        )
      : completed(
          'changes_requested',
          documentArtifactId,
          'Operator requested changes to the research document before publication',
        );
  }
}
