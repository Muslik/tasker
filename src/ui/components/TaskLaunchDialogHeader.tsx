import { Button } from './ui/button.js';

export const TaskLaunchDialogHeader = ({
  mode,
  pending,
  onClose,
}: {
  readonly mode: 'add' | 'start';
  readonly pending: boolean;
  readonly onClose: () => void;
}) => (
  <div className="flex items-start justify-between gap-4">
    <div>
      <h2 id="task-launch-title" className="text-base font-semibold">
        {mode === 'start' ? 'Task settings' : 'Add Jira task'}
      </h2>
      <p className="mt-1 text-xs text-muted-foreground">
        {mode === 'start'
          ? 'Review the workspace and planning settings before starting work.'
          : 'Add an existing Jira issue to Tasker, with optional immediate start.'}
      </p>
    </div>
    <Button type="button" variant="ghost" size="icon-sm" disabled={pending} onClick={onClose}>
      ×
    </Button>
  </div>
);
