import type { ImplementationPlanningRecord } from '../../server/implementation-planning-contracts.js';
import type { ExecutionRunView } from '../../server/operator-contracts.js';
import type { PlanReviewRound } from '../../server/plan-review.js';
import { implementationPlanMarkdownFrom } from '../lib/implementation-plan-markdown.js';
import type { PlanReviewAnnotationInput } from '../lib/plan-review-feedback.js';
import { planReviewDraftKey } from '../lib/plan-review-storage.js';
import { PlanReviewEditor } from './PlanReviewEditor.js';

export const PlanReviewSurface = ({
  run,
  plan,
  history,
  pending,
  error,
  onReview,
}: {
  readonly run: Extract<ExecutionRunView, { runtime: 'bootstrap' }>;
  readonly plan: Extract<ImplementationPlanningRecord, { status: 'ready' }> | null;
  readonly history: readonly PlanReviewRound[];
  readonly pending: boolean;
  readonly error: string | null;
  readonly onReview: (
    decision: 'approve' | 'request_changes',
    guidance: string,
    annotations: readonly PlanReviewAnnotationInput[],
  ) => void;
}) => {
  if (run.planning?.status !== 'ready' || plan === null) return null;
  const markdown = implementationPlanMarkdownFrom({
    plan: plan.decision.plan,
    strategy: plan.selectedStrategy,
    selectionReason: plan.decision.rationale,
  });
  const draftKey = planReviewDraftKey({
    taskReference: run.taskReference,
    runId: run.runId,
    planArtifactId: run.planning.artifactId,
    planAttempt: run.planning.attempt,
  });
  return (
    <PlanReviewEditor
      key={draftKey}
      draftKey={draftKey}
      error={error}
      history={history}
      markdown={markdown}
      onReview={onReview}
      pending={pending}
      planAttempt={plan.attempt}
      planTitle={plan.decision.plan.title}
    />
  );
};
