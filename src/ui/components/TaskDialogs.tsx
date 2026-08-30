import { useEffect, useState } from 'react';

import type { JiraIssueSnapshot } from '../../integrations/jira/contracts.js';
import type { RunStartCommand } from '../../server/operator-contracts.js';
import type { RepositoryCatalogEntry } from '../../workspace/contracts.js';
import { taskBranchName, taskBranchNameMatches } from '../../shared/git-branch.js';
import { Button } from './ui/button.js';

export type JiraTaskLaunchInput = {
  readonly issueKey: string;
  readonly repository: string;
  readonly startImmediately: boolean;
  readonly settings: RunStartCommand['settings'];
};

type JiraPreview =
  | { readonly status: 'idle' }
  | { readonly status: 'checking' }
  | { readonly status: 'invalid'; readonly message: string }
  | { readonly status: 'ready'; readonly issue: JiraIssueSnapshot };

export type JiraTaskLaunchDialogProps = {
  readonly open: boolean;
  readonly mode?: 'add' | 'start';
  readonly repositories: readonly RepositoryCatalogEntry[];
  readonly initialIssue?: JiraIssueSnapshot;
  readonly initialRepository?: string;
  readonly pending: boolean;
  readonly error: string | null;
  readonly onClose: () => void;
  readonly onResolveIssue: (issueKey: string) => Promise<JiraIssueSnapshot>;
  readonly onSubmit: (input: JiraTaskLaunchInput) => Promise<void>;
};

export const JiraTaskLaunchDialog = ({
  open,
  mode = 'add',
  repositories,
  initialIssue,
  initialRepository = '',
  pending,
  error,
  onClose,
  onResolveIssue,
  onSubmit,
}: JiraTaskLaunchDialogProps) => {
  const [issueKey, setIssueKey] = useState(initialIssue?.issueKey ?? '');
  const [preview, setPreview] = useState<JiraPreview>(
    initialIssue === undefined ? { status: 'idle' } : { status: 'ready', issue: initialIssue },
  );
  const [repository, setRepository] = useState(initialRepository);
  const [branchName, setBranchName] = useState(
    initialIssue === undefined ? '' : taskBranchName(initialIssue.issueKey, initialIssue.summary),
  );
  const [startImmediately, setStartImmediately] = useState(mode === 'start');
  const [planningStrategy, setPlanningStrategy] = useState<'auto' | 'fast' | 'ralplan'>('auto');
  const [planReview, setPlanReview] = useState(true);
  const [trackerStatusUpdates, setTrackerStatusUpdates] = useState(true);

  useEffect(() => {
    if (!open || initialIssue === undefined) return;
    setIssueKey(initialIssue.issueKey);
    setPreview({ status: 'ready', issue: initialIssue });
    setBranchName(taskBranchName(initialIssue.issueKey, initialIssue.summary));
  }, [initialIssue, open]);

  useEffect(() => {
    if (!open || mode === 'start') return;
    const normalized = issueKey.trim().toUpperCase();
    if (normalized.length === 0) {
      setPreview({ status: 'idle' });
      return;
    }
    if (!/^[A-Z][A-Z0-9_]*-[1-9][0-9]*$/u.test(normalized)) {
      setPreview({ status: 'invalid', message: 'Enter a Jira key such as FC-2244.' });
      return;
    }
    setPreview({ status: 'checking' });
    const timer = window.setTimeout(() => {
      void onResolveIssue(normalized)
        .then((issue) => {
          setPreview({ status: 'ready', issue });
          setBranchName(taskBranchName(issue.issueKey, issue.summary));
        })
        .catch((cause: unknown) => {
          setPreview({
            status: 'invalid',
            message: cause instanceof Error ? cause.message : 'Jira task could not be loaded.',
          });
        });
    }, 350);
    return () => {
      window.clearTimeout(timer);
    };
  }, [issueKey, mode, onResolveIssue, open]);

  if (!open) return null;
  const normalized = issueKey.trim().toUpperCase();
  const ready = preview.status === 'ready' && preview.issue.issueKey === normalized;
  const branchValid = ready && taskBranchNameMatches(branchName, normalized);

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/55 p-4" role="presentation">
      <form
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl border bg-background p-5 shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="task-launch-title"
        onSubmit={(event) => {
          event.preventDefault();
          if (!ready || pending || (startImmediately && (!branchValid || repository.length === 0)))
            return;
          void onSubmit({
            issueKey: normalized,
            repository,
            startImmediately,
            settings: {
              planReview: planReview ? 'required' : 'automatic',
              planningStrategy,
              trackerStatusUpdates: trackerStatusUpdates ? 'enabled' : 'disabled',
              ...(branchName.length === 0 ? {} : { branchName }),
            },
          });
        }}
      >
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
        <div className="mt-5 space-y-4">
          <label className="block space-y-1.5 text-xs font-medium">
            Jira task
            <input
              autoFocus
              aria-label="Jira task"
              className="h-9 w-full uppercase"
              placeholder="FC-2244"
              value={issueKey}
              disabled={pending || mode === 'start'}
              onChange={(event) => {
                setIssueKey(event.target.value);
              }}
            />
            {preview.status === 'checking' ? (
              <span className="text-muted-foreground">Checking Jira…</span>
            ) : null}
            {preview.status === 'invalid' ? (
              <span className="text-destructive">{preview.message}</span>
            ) : null}
            {ready ? (
              <span className="block text-muted-foreground">{preview.issue.summary}</span>
            ) : null}
          </label>
          <label className="block space-y-1.5 text-xs font-medium">
            Working repository
            <select
              aria-label="Working repository"
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
              value={repository}
              disabled={pending}
              onChange={(event) => {
                setRepository(event.target.value);
              }}
            >
              <option value="">Select a repository</option>
              {repositories.map((entry) => (
                <option key={entry.repositoryId} value={entry.repositoryId}>
                  {entry.repositoryId}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={startImmediately}
              disabled={pending}
              onChange={(event) => {
                setStartImmediately(event.target.checked);
              }}
            />
            Start immediately
          </label>
          {startImmediately ? (
            <label className="block space-y-1.5 text-xs font-medium">
              Branch name
              <input
                aria-label="Branch name"
                className="w-full"
                value={branchName}
                disabled={pending}
                onChange={(event) => {
                  setBranchName(event.target.value);
                }}
              />
              {!branchValid ? (
                <span className="text-destructive">
                  Use a branch beginning with {normalized || 'the Jira key'}.
                </span>
              ) : null}
            </label>
          ) : null}
          <fieldset className="space-y-2 rounded-lg border p-3">
            <legend className="px-1 text-xs font-semibold">Settings</legend>
            <label className="flex items-center justify-between gap-3 text-sm">
              <span>Planning strategy</span>
              <select
                className="rounded-md border bg-background px-2 py-1"
                value={planningStrategy}
                onChange={(event) => {
                  setPlanningStrategy(event.target.value as typeof planningStrategy);
                }}
              >
                <option value="auto">Automatic</option>
                <option value="fast">Fast</option>
                <option value="ralplan">Consensus plan</option>
              </select>
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={planReview}
                onChange={(event) => {
                  setPlanReview(event.target.checked);
                }}
              />
              Require plan review
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={trackerStatusUpdates}
                onChange={(event) => {
                  setTrackerStatusUpdates(event.target.checked);
                }}
              />
              Update Jira statuses
            </label>
            <p className="text-xs text-muted-foreground">
              Failure never blocks implementation, evidence, or comments.
            </p>
          </fieldset>
          {error === null ? null : <p className="text-sm text-destructive">{error}</p>}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button type="button" variant="ghost" disabled={pending} onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={
              pending || !ready || (startImmediately && (!branchValid || repository.length === 0))
            }
          >
            {pending ? 'Starting…' : startImmediately ? 'Start task' : 'Add task'}
          </Button>
        </div>
      </form>
    </div>
  );
};
