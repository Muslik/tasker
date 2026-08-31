import type { ExecutionRunView } from '../../server/operator-contracts.js';
import type { OperatorTaskSummary } from '../../server/operator-contracts.js';
import { Button } from './ui/button.js';

export type TaskRunSettingsSummaryProps = {
  readonly task: OperatorTaskSummary;
  readonly run: ExecutionRunView;
  readonly productTitle?: string | null;
  readonly onClose: () => void;
};

export const TaskRunSettingsUnavailable = ({ onClose }: { readonly onClose: () => void }) => (
  <div className="fixed inset-0 z-50 grid place-items-center bg-black/55 p-4" role="presentation">
    <section
      className="w-full max-w-lg rounded-xl border bg-background p-5 shadow-2xl"
      role="dialog"
      aria-modal="true"
      aria-labelledby="task-run-settings-title"
    >
      <h2 id="task-run-settings-title" className="text-base font-semibold">
        Task settings
      </h2>
      <p className="mt-2 text-sm text-muted-foreground">Checking the current run settings…</p>
      <div className="mt-5 flex justify-end">
        <Button type="button" variant="ghost" onClick={onClose}>
          Close
        </Button>
      </div>
    </section>
  </div>
);

const valueOr = (value: string | undefined, fallback: string): string => value ?? fallback;

export const TaskRunSettingsSummary = ({
  task,
  run,
  productTitle,
  onClose,
}: TaskRunSettingsSummaryProps) => {
  const repository =
    task.origin.repositoryBinding.status === 'resolved'
      ? task.origin.repositoryBinding.reference
      : 'Not selected';
  const settings = run.settings;

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/55 p-4" role="presentation">
      <section
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl border bg-background p-5 shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="task-run-settings-title"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id="task-run-settings-title" className="text-base font-semibold">
              Task settings
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">Settings for the current run.</p>
          </div>
          <Button type="button" variant="ghost" size="icon-sm" onClick={onClose}>
            ×
          </Button>
        </div>
        <dl className="mt-5 space-y-3 text-sm">
          <div>
            <dt className="text-xs font-medium text-muted-foreground">Jira task</dt>
            <dd className="mt-1">
              {task.taskId} — {task.title}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-muted-foreground">Repository</dt>
            <dd className="mt-1">{repository}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-muted-foreground">Product</dt>
            <dd className="mt-1">{valueOr(productTitle ?? undefined, 'Not available')}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-muted-foreground">Branch</dt>
            <dd className="mt-1">{valueOr(settings?.branchName, 'Generated task branch')}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-muted-foreground">Planning strategy</dt>
            <dd className="mt-1">{valueOr(settings?.planningStrategy, 'Not available')}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-muted-foreground">Plan review</dt>
            <dd className="mt-1">
              {settings?.planReview === 'required' ? 'Required' : 'Automatic'}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-muted-foreground">Tracker updates</dt>
            <dd className="mt-1">
              {settings?.trackerStatusUpdates === 'disabled' ? 'Disabled' : 'Enabled'}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-muted-foreground">Бриф оператора</dt>
            <dd className="mt-1 whitespace-pre-wrap break-words rounded-md bg-muted/60 p-3">
              {valueOr(settings?.operatorBrief, 'No operator brief provided')}
            </dd>
          </div>
        </dl>
        <div className="mt-5 flex justify-end">
          <Button type="button" variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
      </section>
    </div>
  );
};
