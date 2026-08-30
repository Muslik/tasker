import { useState } from 'react';
import ReactMarkdown from 'react-markdown';

import type { ImplementationPlanningRecord } from '../../server/implementation-planning-contracts.js';
import type { ExecutionRunView } from '../../server/operator-contracts.js';
import type { PlanReviewRound } from '../../server/plan-review.js';
import { implementationPlanMarkdownFrom } from '../lib/implementation-plan-markdown.js';
import { Button } from './ui/button.js';

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
  readonly onReview: (decision: 'approve' | 'request_changes', guidance: string) => void;
}) => {
  const [guidance, setGuidance] = useState('');
  if (run.planning?.status !== 'ready' || plan === null) return null;
  const markdown = implementationPlanMarkdownFrom({
    plan: plan.decision.plan,
    strategy: plan.selectedStrategy,
    selectionReason: plan.decision.rationale,
  });
  return (
    <section
      aria-label="Review implementation plan"
      data-testid="plan-review-surface"
      className="rounded-xl border bg-card p-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-amber-600">
            Action required
          </p>
          <h2 className="mt-1 text-base font-semibold">Implementation plan</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {plan.decision.plan.title} · attempt {String(plan.attempt)}
          </p>
        </div>
        <span className="rounded-full border border-amber-400/50 bg-amber-500/10 px-2 py-1 text-xs">
          Review required
        </span>
      </div>
      <div className="prose prose-sm dark:prose-invert mt-4 max-w-none overflow-x-auto rounded-lg border bg-background p-4">
        <ReactMarkdown>{markdown}</ReactMarkdown>
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        Inline annotations are represented as guidance text in v1.
      </p>
      <textarea
        aria-label="Plan review guidance"
        className="mt-3 min-h-20 w-full resize-y"
        maxLength={10_000}
        placeholder="What should the planner change?"
        value={guidance}
        disabled={pending}
        onChange={(event) => {
          setGuidance(event.target.value);
        }}
      />
      {history.length > 0 ? (
        <details className="mt-3 text-xs">
          <summary className="cursor-pointer text-muted-foreground">
            Previous review rounds · {String(history.length)}
          </summary>
          <ol className="mt-2 space-y-2">
            {history.map((round) => (
              <li className="rounded-md bg-muted/50 p-2" key={round.reviewId}>
                {round.decision === 'approve' ? 'Approved' : round.guidance}
              </li>
            ))}
          </ol>
        </details>
      ) : null}
      {error === null ? null : <p className="mt-2 text-sm text-destructive">{error}</p>}
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={pending || guidance.trim().length === 0}
          onClick={() => {
            onReview('request_changes', guidance.trim());
          }}
        >
          {pending ? 'Sending…' : 'Request changes'}
        </Button>
        <Button
          type="button"
          disabled={pending || guidance.trim().length > 0}
          onClick={() => {
            onReview('approve', '');
          }}
        >
          {pending ? 'Approving…' : 'Approve plan'}
        </Button>
      </div>
    </section>
  );
};
