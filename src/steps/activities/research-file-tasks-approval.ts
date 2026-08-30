import type { TaskRunEvidence } from '../../integrations/index.js';

export type ResearchFileTasksApproval =
  | { readonly status: 'approved' }
  | { readonly status: 'waiting'; readonly pageUrl: string | null; readonly reason: string };

const publishedPageUrl = (evidence: TaskRunEvidence): string | null => {
  const publication = evidence.completedSteps
    .filter(
      ({ status, stepReference }) =>
        status === 'completed' && stepReference === 'research.publish@1',
    )
    .toSorted((left, right) => right.recordedAt.localeCompare(left.recordedAt))[0];
  const details = publication?.details;
  if (details === null || Array.isArray(details) || typeof details !== 'object') return null;
  const output = details.output;
  if (output === null || Array.isArray(output) || typeof output !== 'object') return null;
  return typeof output.pageUrl === 'string' && output.pageUrl.length > 0 ? output.pageUrl : null;
};

export const resolveResearchFileTasksApproval = (
  stepReference: string,
  waitResolution: unknown,
  evidence: TaskRunEvidence,
): ResearchFileTasksApproval => {
  if (stepReference !== 'research.file-tasks@1') return { status: 'approved' };
  if (
    waitResolution !== null &&
    typeof waitResolution === 'object' &&
    !Array.isArray(waitResolution) &&
    'decision' in waitResolution &&
    waitResolution.decision === 'approve'
  ) {
    return { status: 'approved' };
  }

  const pageUrl = publishedPageUrl(evidence);
  return {
    status: 'waiting',
    pageUrl,
    reason: `${pageUrl ?? 'Ссылка на СА недоступна'} — прочитайте СА и подтвердите заведение задач`,
  };
};
