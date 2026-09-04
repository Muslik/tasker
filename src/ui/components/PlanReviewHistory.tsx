import { Button } from './ui/button.js';
import type { PlanReviewRound } from '../../server/plan-review.js';
import { ActionAlert } from './ActionAlert.js';

export const PlanReviewHistory = ({
  history,
  pending,
  error,
  onRetry,
}: {
  readonly history: readonly PlanReviewRound[];
  readonly pending: boolean;
  readonly error: unknown;
  readonly onRetry: () => void;
}) => {
  if (history.length === 0 && !pending && (error === null || error === undefined)) return null;
  return (
    <details className="rounded-lg border bg-card p-4 text-sm" open={history.length > 0}>
      <summary className="cursor-pointer font-medium">
        Previous review rounds · {String(history.length)}
      </summary>
      {error === null || error === undefined ? null : (
        <div className="mt-3 flex flex-wrap items-start justify-between gap-3 rounded-md border border-destructive/40 bg-destructive/10 p-3">
          <ActionAlert error={error} className="min-w-0 flex-1 border-0 bg-transparent p-0" />
          <Button type="button" size="sm" variant="outline" onClick={onRetry}>
            Retry
          </Button>
        </div>
      )}
      {pending ? (
        <p className="mt-3 text-sm text-muted-foreground">Loading previous review rounds…</p>
      ) : null}
      {history.length === 0 ? null : (
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
      )}
    </details>
  );
};
