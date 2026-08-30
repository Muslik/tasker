import type { TaskRunEvidence } from '../../integrations/index.js';

export type ResearchFileTasksAuthorization =
  { readonly status: 'authorized' } | { readonly status: 'missing_document_approval' };

const latestDocumentApprovalFact = (evidence: TaskRunEvidence): boolean | undefined => {
  let latest: boolean | undefined;
  let latestRecordedAt: string | null = null;
  for (const step of evidence.completedSteps) {
    if (step.status !== 'completed' || step.stepReference !== 'research.document-review@1') {
      continue;
    }
    const fact = step.predicateFacts['research.document_approved@1'];
    if (fact === undefined) continue;
    if (latestRecordedAt === null || step.recordedAt >= latestRecordedAt) {
      latestRecordedAt = step.recordedAt;
      latest = fact;
    }
  }
  return latest;
};

export const authorizeResearchFileTasksExecution = (
  stepReference: string,
  evidence: TaskRunEvidence,
): ResearchFileTasksAuthorization => {
  if (stepReference !== 'research.file-tasks@1') return { status: 'authorized' };
  return latestDocumentApprovalFact(evidence) === true
    ? { status: 'authorized' }
    : { status: 'missing_document_approval' };
};
