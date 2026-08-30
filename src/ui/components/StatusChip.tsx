import type { OperatorTaskSummary } from '../../server/operator-contracts.js';
import { cn } from '../../cockpit/lib/utils.js';

type StatusPresentation = {
  readonly label: string;
  readonly className: string;
};

const STATUS_PRESENTATION: Record<OperatorTaskSummary['status'], StatusPresentation> = {
  backlog: {
    label: 'Backlog',
    className: 'border-border/70 bg-muted/70 text-muted-foreground',
  },
  planned: {
    label: 'Planned',
    className: 'border-border/70 bg-muted/70 text-muted-foreground',
  },
  workflow_rejected: {
    label: 'Rejected',
    className:
      'border-red-200/80 bg-red-500/10 text-red-700 dark:border-red-400/40 dark:bg-red-400/15 dark:text-red-200',
  },
  queued: {
    label: 'Queued',
    className:
      'border-border bg-background/80 text-muted-foreground dark:border-border/80 dark:bg-muted/20',
  },
  running: {
    label: 'Running',
    className:
      'border-sky-200/80 bg-sky-500/10 text-sky-700 dark:border-sky-400/40 dark:bg-sky-400/15 dark:text-sky-200',
  },
  plan_review: {
    label: 'Plan review',
    className:
      'border-amber-200/80 bg-amber-500/10 text-amber-700 dark:border-amber-400/40 dark:bg-amber-400/15 dark:text-amber-200',
  },
  waiting: {
    label: 'Waiting',
    className:
      'border-amber-200/80 bg-amber-500/10 text-amber-700 dark:border-amber-400/40 dark:bg-amber-400/15 dark:text-amber-200',
  },
  needs_attention: {
    label: 'Needs attention',
    className:
      'border-orange-200/80 bg-orange-500/10 text-orange-700 dark:border-orange-400/40 dark:bg-orange-400/15 dark:text-orange-200',
  },
  code_review: {
    label: 'Code review',
    className:
      'border-violet-200/80 bg-violet-500/10 text-violet-700 dark:border-violet-400/40 dark:bg-violet-400/15 dark:text-violet-200',
  },
  done: {
    label: 'Done',
    className:
      'border-emerald-200/80 bg-emerald-500/10 text-emerald-700 dark:border-emerald-400/40 dark:bg-emerald-400/15 dark:text-emerald-200',
  },
  failed: {
    label: 'Failed',
    className:
      'border-red-200/80 bg-red-500/10 text-red-700 dark:border-red-400/40 dark:bg-red-400/15 dark:text-red-200',
  },
};

export const getStatusChipPresentation = (
  status: OperatorTaskSummary['status'],
): StatusPresentation => STATUS_PRESENTATION[status];

export const StatusChip = ({ status }: { readonly status: OperatorTaskSummary['status'] }) => {
  const presentation = getStatusChipPresentation(status);

  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium tracking-tight',
        presentation.className,
      )}
      data-status={status}
    >
      {presentation.label}
    </span>
  );
};
