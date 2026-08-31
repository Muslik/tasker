import type { ImplementationPlanningRecord } from '../../server/implementation-planning-contracts.js';
import type { ExecutionRunView } from '../../server/operator-contracts.js';
import type { PlanReviewRound } from '../../server/plan-review.js';
import { implementationPlanMarkdownFrom } from '../lib/implementation-plan-markdown.js';
import type { PlanReviewAnnotationInput } from '../lib/plan-review-feedback.js';
import { planReviewDraftKey } from '../lib/plan-review-storage.js';
import { PlanReviewEditor } from './PlanReviewEditor.js';
import { ActionAlert } from './ActionAlert.js';
import { Badge } from './ui/badge.js';
import { Button } from './ui/button.js';

export const PlanReviewSurface = ({
  run,
  plan,
  planPending,
  planError,
  onRetryPlan,
  history,
  historyPending,
  historyError,
  onRetryHistory,
  pending,
  error,
  onReview,
}: {
  readonly run: Extract<ExecutionRunView, { runtime: 'bootstrap' }>;
  readonly plan: Extract<ImplementationPlanningRecord, { status: 'ready' }> | null;
  readonly planPending: boolean;
  readonly planError: unknown;
  readonly onRetryPlan: () => void;
  readonly history: readonly PlanReviewRound[];
  readonly historyPending: boolean;
  readonly historyError: unknown;
  readonly onRetryHistory: () => void;
  readonly pending: boolean;
  readonly error: unknown;
  readonly onReview: (
    decision: 'approve' | 'request_changes',
    guidance: string,
    annotations: readonly PlanReviewAnnotationInput[],
  ) => void;
}) => {
  if (run.planning?.status !== 'ready') return null;
  const draftKey = planReviewDraftKey({
    taskReference: run.taskReference,
    runId: run.runId,
    planArtifactId: run.planning.artifactId,
    planAttempt: run.planning.attempt,
  });
  return (
    <section
      aria-label="Review implementation plan"
      data-testid="plan-review-surface"
      className="rounded-xl border bg-card"
    >
      <div className="flex flex-wrap items-start justify-between gap-3 border-b px-4 py-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-amber-600">
            Action required
          </p>
          <h2 className="mt-1 text-base font-semibold">Implementation plan</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {plan?.decision.plan.title ?? 'Current planning attempt'} · attempt{' '}
            {String(run.planning.attempt)}
          </p>
        </div>
        <Badge variant="outline">Review required</Badge>
      </div>
      <div className="p-4">
        {planError === null ? null : (
          <PlanReviewFetchAlert
            title="Plan data unavailable"
            error={planError}
            actionLabel="Retry plan fetch"
            onRetry={onRetryPlan}
          />
        )}
        {plan === null ? (
          <div className="rounded-lg border bg-background px-4 py-5 text-sm text-muted-foreground">
            {planPending ? 'Loading the current implementation plan…' : 'Plan data is unavailable.'}
          </div>
        ) : (
          <PlanReviewEditor
            key={draftKey}
            draftKey={draftKey}
            error={error}
            history={history}
            historyPending={historyPending}
            historyError={historyError}
            markdown={implementationPlanMarkdownFrom({
              plan: plan.decision.plan,
              strategy: plan.selectedStrategy,
              selectionReason: plan.decision.rationale,
            })}
            onRetryHistory={onRetryHistory}
            onReview={onReview}
            pending={pending}
            planAttempt={plan.attempt}
            planTitle={plan.decision.plan.title}
          />
        )}
      </div>
    </section>
  );
};

const PlanReviewFetchAlert = ({
  title,
  error,
  actionLabel,
  onRetry,
}: {
  readonly title: string;
  readonly error: unknown;
  readonly actionLabel: string;
  readonly onRetry: () => void;
}) => (
  <div className="mb-4 flex flex-wrap items-start justify-between gap-3 rounded-lg border border-destructive/40 bg-destructive/10 p-4">
    <ActionAlert
      error={error}
      fallback={{ title, message: 'Plan data is unavailable. Retry the current plan fetch.' }}
      className="min-w-0 flex-1 border-0 bg-transparent p-0"
    />
    <Button type="button" variant="outline" onClick={onRetry}>
      {actionLabel}
    </Button>
  </div>
);
