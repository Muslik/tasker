import { Bot, ChevronRight, Pause, Terminal } from 'lucide-react';
import { useState } from 'react';

import type {
  OperatorWorkflowStage,
  OperatorWorkflowStep,
  WorkflowNodeStatus,
} from '../control-plane/m1-contracts.js';
import { Tooltip, TooltipContent, TooltipTrigger } from './components/ui/tooltip.js';

const statusTone: Readonly<Record<WorkflowNodeStatus, string>> = {
  planned: 'bg-muted-foreground/50',
  running: 'bg-cyan-400',
  waiting: 'bg-amber-400',
  succeeded: 'bg-emerald-400',
  skipped: 'bg-muted-foreground/40',
  failed: 'bg-destructive',
};

const WorkflowStep = ({ step }: { readonly step: OperatorWorkflowStep }) => {
  const Icon = step.kind === 'agent' ? Bot : step.kind === 'process' ? Terminal : Pause;
  return (
    <li>
      <Tooltip>
        <TooltipTrigger
          render={
            <span className="group flex min-h-8 w-full items-center gap-2 rounded px-2 text-left hover:bg-muted/60" />
          }
        >
          <Icon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground group-hover:text-foreground">
            {step.label}
          </span>
          {step.kind !== 'wait' && step.attempts > 1 ? (
            <span className="text-[10px] text-muted-foreground">attempt {step.attempts}</span>
          ) : null}
          <span
            className={`size-1.5 shrink-0 rounded-full ${statusTone[step.status]}`}
            aria-label={step.status}
          />
        </TooltipTrigger>
        <TooltipContent side="left" align="center">
          <span className="font-mono">{step.reference}</span>
          {step.kind === 'agent' ? (
            <span className="opacity-60">
              {' '}
              · {step.profile}
              {step.skills.length === 0 ? '' : ` · ${step.skills.join(', ')}`}
            </span>
          ) : step.kind === 'process' ? (
            <span className="opacity-60"> · {step.executor}</span>
          ) : null}
        </TooltipContent>
      </Tooltip>
    </li>
  );
};

const StageHeader = ({
  stage,
  expandable,
}: {
  readonly stage: OperatorWorkflowStage;
  readonly expandable: boolean;
}) => {
  const actionRequired = stage.status === 'waiting';
  return (
    <>
      {expandable ? (
        <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-open/stage:rotate-90" />
      ) : (
        <span className="size-3.5 shrink-0" />
      )}
      <span
        className={
          actionRequired
            ? 'min-w-0 flex-1 truncate font-semibold text-amber-800 dark:text-amber-200'
            : 'min-w-0 flex-1 truncate font-medium text-foreground'
        }
      >
        {stage.label}
      </span>
      {actionRequired ? (
        <span className="rounded-full bg-amber-500/20 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-amber-800 dark:text-amber-200">
          Action
        </span>
      ) : null}
      <span
        className={`size-2 shrink-0 rounded-full ${statusTone[stage.status]}`}
        aria-label={`stage ${stage.status}`}
      />
    </>
  );
};

const Stage = ({ stage }: { readonly stage: OperatorWorkflowStage }) => {
  const [open, setOpen] = useState(true);
  const headerClass =
    stage.status === 'waiting'
      ? 'flex min-h-11 items-center gap-2 border-l-2 border-amber-500 bg-amber-500/10 px-2 text-sm'
      : 'flex min-h-10 items-center gap-2 px-2 text-sm';

  if (stage.steps.length === 0) {
    return (
      <section
        className="border-b border-border/70 last:border-b-0"
        data-testid={`workflow-stage-${stage.key}`}
      >
        <div className={headerClass}>
          <StageHeader stage={stage} expandable={false} />
        </div>
      </section>
    );
  }

  return (
    <details
      className="group/stage border-b border-border/70 last:border-b-0"
      data-testid={`workflow-stage-${stage.key}`}
      open={open}
      onToggle={(event) => {
        setOpen(event.currentTarget.open);
      }}
    >
      <summary
        className={`${headerClass} cursor-pointer list-none hover:bg-muted/40 [&::-webkit-details-marker]:hidden`}
      >
        <StageHeader stage={stage} expandable />
      </summary>
      <ol className="mb-2 ml-4 border-l border-border/70 pl-1.5" data-testid="workflow-stage-steps">
        {stage.steps.map((step) => (
          <WorkflowStep key={step.id} step={step} />
        ))}
      </ol>
    </details>
  );
};

export const WorkflowStages = ({
  stages,
}: {
  readonly stages: readonly OperatorWorkflowStage[];
}) => (
  <div className="border-y border-border/70" data-testid="workflow-stages">
    {stages.map((stage) => (
      <Stage key={stage.key} stage={stage} />
    ))}
  </div>
);
