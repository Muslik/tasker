import { useState } from 'react';
import { LoaderCircle } from 'lucide-react';

import { Badge } from './ui/badge.js';
import { Button } from './ui/button.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from './ui/dialog.js';
import { ActionAlert } from './ActionAlert.js';

const textInputClassName =
  'h-9 w-full rounded-lg border border-input bg-transparent px-3 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50';

export const RemoveTaskDialog = ({
  task,
  pending,
  error,
  onClose,
  onConfirm,
}: {
  readonly task: { readonly taskId: string; readonly status: string };
  readonly pending: boolean;
  readonly error: unknown;
  readonly onClose: () => void;
  readonly onConfirm: () => void;
}) => {
  const [confirmation, setConfirmation] = useState('');
  const active = task.status === 'running' || task.status === 'queued';
  const valid = confirmation === task.taskId;

  return (
    <Dialog
      open
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !pending) onClose();
      }}
    >
      <DialogContent className="max-w-md gap-5 p-5 sm:max-w-md" showCloseButton={false}>
        <form
          className="space-y-5"
          onSubmit={(event) => {
            event.preventDefault();
            if (valid && !pending) onConfirm();
          }}
        >
          <DialogHeader>
            <div className="flex items-center justify-between gap-3">
              <DialogTitle>
                {active ? 'Stop and remove task' : 'Remove task from Tasker'}
              </DialogTitle>
              <Badge variant={active ? 'destructive' : 'outline'}>
                {active ? 'Active workflow' : 'Archived task'}
              </Badge>
            </div>
            <DialogDescription>
              {active
                ? 'Tasker will terminate the active workflow and remove its managed containers, volumes, worktree, and local branch.'
                : 'Tasker will hide this task and remove any remaining managed workspace resources.'}{' '}
              Jira, remote branches, and pull requests are not deleted.
            </DialogDescription>
          </DialogHeader>
          <label className="block space-y-1.5 text-xs font-medium">
            <span>Type {task.taskId} to confirm</span>
            <input
              aria-label="Removal confirmation"
              className={textInputClassName}
              value={confirmation}
              disabled={pending}
              onChange={(event) => {
                setConfirmation(event.target.value);
              }}
            />
          </label>
          <ActionAlert error={error} />
          <div className="flex justify-end gap-2 border-t pt-4">
            <Button type="button" variant="ghost" disabled={pending} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="destructive" disabled={!valid || pending}>
              {pending ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : null}
              {pending ? 'Removing…' : active ? 'Stop and remove' : 'Remove task'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
};
