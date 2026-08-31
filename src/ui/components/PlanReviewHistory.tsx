import type { PlanReviewRound } from '../../server/plan-review.js';

export const PlanReviewHistory = ({
  history,
}: {
  readonly history: readonly PlanReviewRound[];
}) => {
  if (history.length === 0) return null;
  return (
    <details className="rounded-lg border bg-background p-4 text-sm">
      <summary className="cursor-pointer font-medium">
        Previous review rounds · {String(history.length)}
      </summary>
      <ol className="mt-3 space-y-3">
        {history.map((round, index) => (
          <li className="rounded-md border p-3" key={round.reviewId}>
            <p className="text-xs font-medium text-muted-foreground">
              Round {String(index + 1)} ·{' '}
              {round.decision === 'approve' ? 'Approved' : 'Requested changes'}
            </p>
            {round.guidance === null ? null : (
              <p className="mt-2 whitespace-pre-wrap text-sm">{round.guidance}</p>
            )}
            {round.annotations.length === 0 ? null : (
              <p className="mt-2 text-xs text-muted-foreground">
                {String(round.annotations.length)} inline annotation
                {round.annotations.length === 1 ? '' : 's'}
              </p>
            )}
          </li>
        ))}
      </ol>
    </details>
  );
};
