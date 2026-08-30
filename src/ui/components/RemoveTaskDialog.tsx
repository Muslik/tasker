import { useState } from 'react';

import { Button } from './ui/button.js';

export const RemoveTaskDialog = ({
  task,
  pending,
  error,
  onClose,
  onConfirm,
}: {
  readonly task: { readonly taskId: string; readonly status: string };
  readonly pending: boolean;
  readonly error: string | null;
  readonly onClose: () => void;
  readonly onConfirm: () => void;
}) => {
  const [confirmation, setConfirmation] = useState('');
  const active = task.status === 'running' || task.status === 'queued';
  const valid = confirmation === task.taskId;
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/55 p-4" role="presentation">
      <form
        className="w-full max-w-md rounded-xl border bg-background p-5 shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="remove-task-title"
        onSubmit={(event) => {
          event.preventDefault();
          if (valid) onConfirm();
        }}
      >
        <h2 id="remove-task-title" className="text-base font-semibold">
          {active ? 'Stop and remove task' : 'Remove task from Tasker'}
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          {active
            ? 'Tasker will terminate the active workflow and remove its managed containers, volumes, worktree, and local branch.'
            : 'Tasker will hide this task and remove any remaining managed workspace resources.'}{' '}
          Jira, remote branches, and pull requests are not deleted.
        </p>
        <label className="mt-4 block space-y-1.5 text-xs font-medium">
          Type {task.taskId} to confirm
          <input
            aria-label="Removal confirmation"
            value={confirmation}
            disabled={pending}
            onChange={(event) => {
              setConfirmation(event.target.value);
            }}
          />
        </label>
        {error === null ? null : <p className="mt-2 text-sm text-destructive">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <Button type="button" variant="ghost" disabled={pending} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="destructive" disabled={!valid || pending}>
            {pending ? 'Removing…' : active ? 'Stop and remove' : 'Remove task'}
          </Button>
        </div>
      </form>
    </div>
  );
};
