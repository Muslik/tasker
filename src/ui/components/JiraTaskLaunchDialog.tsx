import { useEffect, useRef, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import type { JiraIssueSnapshot } from '../../integrations/jira/contracts.js';
import type * as OperatorContracts from '../../server/operator-contracts.js';
import type { RepositoryCatalogEntry } from '../../workspace/contracts.js';
import type { JiraProductResolution } from '../../shared/product.js';
import { taskBranchName, taskBranchNameMatches } from '../../shared/git-branch.js';
import { TaskLaunchSettingsFields } from './TaskLaunchSettingsFields.js';
import { TaskLaunchDialogHeader } from './TaskLaunchDialogHeader.js';
import { TaskRunSettingsSummary, TaskRunSettingsUnavailable } from './TaskRunSettingsSummary.js';
import { Checkbox } from './ui/checkbox.js';
import { Dialog, DialogContent } from './ui/dialog.js';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select.js';
import { Button } from './ui/button.js';
import { ActionAlert } from './ActionAlert.js';

export type JiraTaskLaunchInput = {
  readonly issueKey: string;
  readonly repository: string;
  readonly startImmediately: boolean;
  readonly settings: OperatorContracts.RunStartCommand['settings'];
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
  readonly task?: OperatorContracts.OperatorTaskSummary;
  readonly run?: OperatorContracts.ExecutionRunView | null;
  readonly productTitle?: string | null;
  readonly pending: boolean;
  readonly error: unknown;
  readonly onClose: () => void;
  readonly onResolveIssue: (issueKey: string) => Promise<JiraIssueSnapshot>;
  readonly onResolveProduct: (issueKey: string) => Promise<JiraProductResolution>;
  readonly onSubmit: (input: JiraTaskLaunchInput) => Promise<void>;
};

const repositoryPlaceholder = '__unselected__';
const textInputClassName =
  'h-9 w-full rounded-lg border border-input bg-transparent px-3 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50';

export const repositorySelectionForProduct = (
  current: string,
  primaryRepository: string,
  autoSelected: boolean,
): { readonly repository: string; readonly autoSelected: boolean } =>
  current.length === 0 || autoSelected
    ? { repository: primaryRepository, autoSelected: true }
    : { repository: current, autoSelected: false };

export const JiraTaskLaunchDialog = ({
  open,
  mode = 'add',
  repositories,
  initialIssue,
  initialRepository = '',
  task,
  run,
  productTitle,
  pending,
  error,
  onClose,
  onResolveIssue,
  onResolveProduct,
  onSubmit,
}: JiraTaskLaunchDialogProps) => {
  const [issueKey, setIssueKey] = useState(initialIssue?.issueKey ?? '');
  const [preview, setPreview] = useState<JiraPreview>(
    initialIssue === undefined ? { status: 'idle' } : { status: 'ready', issue: initialIssue },
  );
  const [repository, setRepository] = useState(initialRepository);
  const [product, setProduct] = useState<JiraProductResolution['product']>(null);
  const repositoryAutoSelected = useRef(false);
  const [branchName, setBranchName] = useState(
    initialIssue === undefined ? '' : taskBranchName(initialIssue.issueKey, initialIssue.summary),
  );
  const [startImmediately, setStartImmediately] = useState(mode === 'start');
  const [planningStrategy, setPlanningStrategy] = useState<'auto' | 'fast' | 'ralplan'>('auto');
  const [planReview, setPlanReview] = useState(true);
  const [trackerStatusUpdates, setTrackerStatusUpdates] = useState(true);
  const [operatorBrief, setOperatorBrief] = useState('');

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
          void onResolveProduct(issue.issueKey)
            .then((resolved) => {
              const resolvedProduct = resolved.product;
              setProduct(resolvedProduct);
              if (resolvedProduct === null) return;
              setRepository((current) => {
                const selection = repositorySelectionForProduct(
                  current,
                  resolvedProduct.primaryRepository,
                  repositoryAutoSelected.current,
                );
                repositoryAutoSelected.current = selection.autoSelected;
                return selection.repository;
              });
            })
            .catch(() => {
              setProduct(null);
            });
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
  }, [issueKey, mode, onResolveIssue, onResolveProduct, open]);

  if (!open) return null;
  if (mode === 'start' && task !== undefined && run === undefined)
    return <TaskRunSettingsUnavailable onClose={onClose} />;
  if (mode === 'start' && task !== undefined && run) {
    return (
      <TaskRunSettingsSummary
        task={task}
        run={run}
        productTitle={productTitle ?? null}
        onClose={onClose}
      />
    );
  }

  const normalized = issueKey.trim().toUpperCase();
  const ready = preview.status === 'ready' && preview.issue.issueKey === normalized;
  const branchValid = ready && taskBranchNameMatches(branchName, normalized);
  const launchDisabled =
    pending || !ready || (startImmediately && (!branchValid || repository.length === 0));
  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen && !pending) onClose();
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-lg gap-0 p-5 sm:max-w-lg" showCloseButton={false}>
        <form
          className="max-h-[calc(90vh-2.5rem)] space-y-5 overflow-y-auto"
          onSubmit={(event) => {
            event.preventDefault();
            if (launchDisabled) return;
            void onSubmit({
              issueKey: normalized,
              repository,
              startImmediately,
              settings: {
                planReview: planReview ? 'required' : 'automatic',
                planningStrategy,
                trackerStatusUpdates: trackerStatusUpdates ? 'enabled' : 'disabled',
                ...(operatorBrief.length === 0 ? {} : { operatorBrief }),
                ...(branchName.length === 0 ? {} : { branchName }),
              },
            });
          }}
        >
          <TaskLaunchDialogHeader mode={mode} pending={pending} onClose={onClose} />
          <div className="space-y-4">
            <label className="block space-y-1.5 text-xs font-medium">
              <span>Jira task</span>
              <input
                autoFocus
                aria-label="Jira task"
                className={`${textInputClassName} uppercase`}
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
              <span>Working repository</span>
              <Select
                value={repository.length === 0 ? repositoryPlaceholder : repository}
                disabled={pending}
                onValueChange={(value) => {
                  if (value === null) return;
                  repositoryAutoSelected.current = false;
                  setRepository(value === repositoryPlaceholder ? '' : value);
                }}
              >
                <SelectTrigger className="w-full" aria-label="Working repository">
                  <SelectValue placeholder="Select a repository" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={repositoryPlaceholder}>Select a repository</SelectItem>
                  {repositories.map((entry) => (
                    <SelectItem key={entry.repositoryId} value={entry.repositoryId}>
                      {entry.repositoryId}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            <label className="flex items-start gap-3 rounded-lg border px-3 py-2 text-sm">
              <Checkbox
                checked={startImmediately}
                disabled={pending}
                onCheckedChange={setStartImmediately}
              />
              <span className="space-y-1">
                <span className="block font-medium">Start immediately</span>
                <span className="block text-xs text-muted-foreground">
                  Queue the task right after it is added to Tasker.
                </span>
              </span>
            </label>
            {startImmediately ? (
              <label className="block space-y-1.5 text-xs font-medium">
                <span>Branch name</span>
                <input
                  aria-label="Branch name"
                  className={textInputClassName}
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
            <TaskLaunchSettingsFields
              product={product}
              operatorBrief={operatorBrief}
              planningStrategy={planningStrategy}
              planReview={planReview}
              trackerStatusUpdates={trackerStatusUpdates}
              pending={pending}
              onOperatorBriefChange={setOperatorBrief}
              onPlanningStrategyChange={setPlanningStrategy}
              onPlanReviewChange={setPlanReview}
              onTrackerStatusUpdatesChange={setTrackerStatusUpdates}
            />
            <ActionAlert error={error} />
          </div>
          <div className="flex justify-end gap-2 border-t pt-4">
            <Button type="button" variant="ghost" disabled={pending} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={launchDisabled}>
              {pending ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : null}
              {pending ? 'Starting…' : startImmediately ? 'Start task' : 'Add task'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
};
