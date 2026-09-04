import type { ExecutionRunView } from '../../server/operator-contracts.js';
import type { OperatorTaskSummary } from '../../server/operator-contracts.js';
import { Button } from './ui/button.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog.js';

export type TaskRunSettingsSummaryProps = {
  readonly task: OperatorTaskSummary;
  readonly run: ExecutionRunView;
  readonly productTitle?: string | null;
  readonly onClose: () => void;
};

export const TaskRunSettingsUnavailable = ({ onClose }: { readonly onClose: () => void }) => (
  <Dialog
    defaultOpen
    onOpenChange={(open) => {
      if (!open) onClose();
    }}
  >
    <DialogContent className="max-w-lg" showCloseButton={false}>
      <DialogHeader>
        <DialogTitle>Task settings</DialogTitle>
        <DialogDescription>Checking the current run settings…</DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onClose}>
          Close
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
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
    <Dialog
      defaultOpen
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Task settings</DialogTitle>
          <DialogDescription>Settings for the current run.</DialogDescription>
        </DialogHeader>
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
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
