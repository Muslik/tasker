import type { OperatorWorkflowStage, WorkflowNodeStatus } from '../../server/operator-contracts.js';
import { cn } from '../lib/utils.js';

const statusTone = {
  planned: 'border-border bg-muted text-muted-foreground',
  running: 'border-sky-400 bg-sky-500/15 text-sky-700 dark:text-sky-200',
  waiting: 'border-amber-400 bg-amber-500/15 text-amber-700 dark:text-amber-200',
  succeeded: 'border-emerald-400 bg-emerald-500/15 text-emerald-700 dark:text-emerald-200',
  skipped: 'border-border bg-muted text-muted-foreground',
  failed: 'border-red-400 bg-red-500/15 text-red-700 dark:text-red-200',
} satisfies Record<WorkflowNodeStatus, string>;

const statusLabel = (status: WorkflowNodeStatus): string =>
  status === 'succeeded' ? 'Complete' : status.charAt(0).toUpperCase() + status.slice(1);

export type WorkflowRailProps = {
  readonly stages: readonly OperatorWorkflowStage[];
  readonly currentNodeId: string | null;
};

export const WorkflowRail = ({ stages, currentNodeId }: WorkflowRailProps) => (
  <section aria-label="Workflow stages" className="rounded-xl border bg-card">
    <header className="border-b px-4 py-3">
      <h2 className="text-sm font-semibold">Workflow</h2>
      <p className="mt-0.5 text-xs text-muted-foreground">Stages and executable steps</p>
    </header>
    {stages.length === 0 ? (
      <p className="px-4 py-6 text-sm text-muted-foreground">No workflow has been projected yet.</p>
    ) : (
      <ol className="divide-y">
        {stages.map((stage, stageIndex) => (
          <li className="grid grid-cols-[1.25rem_1fr] gap-3 px-4 py-3" key={stage.key}>
            <div className="relative flex justify-center pt-1">
              <span
                aria-hidden="true"
                className={cn(
                  'relative z-10 size-2.5 rounded-full border-2',
                  statusTone[stage.status],
                )}
              />
              {stageIndex < stages.length - 1 ? (
                <span
                  aria-hidden="true"
                  className="absolute top-3 h-[calc(100%+1.5rem)] w-px bg-border"
                />
              ) : null}
            </div>
            <div className="min-w-0">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-sm font-medium">{stage.label}</h3>
                <span className="text-[11px] text-muted-foreground">
                  {statusLabel(stage.status)}
                </span>
              </div>
              {stage.steps.length === 0 ? null : (
                <ol className="mt-2 space-y-1.5">
                  {stage.steps.map((step) => {
                    const active = step.id === currentNodeId;
                    return (
                      <li
                        className={cn(
                          'flex items-center justify-between gap-3 rounded-md border px-2.5 py-2 text-xs',
                          active ? statusTone[step.status] : 'border-transparent bg-muted/40',
                        )}
                        data-current={active || undefined}
                        key={step.id}
                      >
                        <span className="truncate">{step.label}</span>
                        <span className="shrink-0 tabular-nums text-muted-foreground">
                          {'attempts' in step && step.attempts > 0
                            ? `Attempt ${String(step.attempts)}`
                            : statusLabel(step.status)}
                        </span>
                      </li>
                    );
                  })}
                </ol>
              )}
            </div>
          </li>
        ))}
      </ol>
    )}
  </section>
);
