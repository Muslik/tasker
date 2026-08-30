import type { CodeReviewSyncResponse, ExecutionRunView } from '../../server/operator-contracts.js';
import { Button } from './ui/button.js';

export const CodeReviewControls = ({
  run,
  notice,
  pending,
  error,
  onSync,
  onComplete,
}: {
  readonly run: ExecutionRunView;
  readonly notice: string | null;
  readonly pending: boolean;
  readonly error: string | null;
  readonly onSync: () => void;
  readonly onComplete: () => void;
}) => {
  if (run.status !== 'waiting' || run.wait.waitKind !== 'code_review@1') return null;
  return (
    <section aria-label="Code review" className="rounded-xl border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">Code review</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Import actionable Bitbucket threads, or finish when review needs no revision.
          </p>
        </div>
        <div className="flex gap-2">
          <Button type="button" variant="outline" disabled={pending} onClick={onSync}>
            {pending ? 'Syncing…' : 'Sync review'}
          </Button>
          <Button type="button" disabled={pending} onClick={onComplete}>
            {pending ? 'Finishing…' : 'Mark done'}
          </Button>
        </div>
      </div>
      {notice === null ? null : <p className="mt-3 text-sm text-muted-foreground">{notice}</p>}
      {error === null ? null : <p className="mt-2 text-sm text-destructive">{error}</p>}
    </section>
  );
};

export const codeReviewNotice = (result: CodeReviewSyncResponse): string =>
  result.status === 'pending'
    ? 'No actionable review comments yet.'
    : result.status === 'changes_requested'
      ? 'Review imported. Revision is starting.'
      : 'Review completed.';
